import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Feature } from "../../types.ts";
import { CalibrationCache, calibrationKey } from "./calibration.ts";
import { countPayloadChars, estimateInputTokens } from "./estimator.ts";
import { LiveStatus } from "./live-status.ts";
import { parseLastStats, StreamMetrics } from "./metrics.ts";
import { CalibrationTrainer } from "./training.ts";

const CUSTOM_TYPE = "my-pi.token-speed";

type DeltaKind = "text" | "thinking" | "toolcall";

function extractDelta(event: AssistantMessageEvent): { text: string; kind: DeltaKind } | undefined {
	switch (event.type) {
		case "text_delta":
			return { text: event.delta, kind: "text" };
		case "thinking_delta":
			return { text: event.delta, kind: "thinking" };
		case "toolcall_delta":
			return { text: event.delta, kind: "toolcall" };
		default:
			return undefined;
	}
}

export const tokenSpeedFeature: Feature = {
	id: "token-speed",
	register({ pi, settings }) {
		settings.register({
			key: "tokenSpeed.enabled",
			label: "Token speed",
			description: "Show token throughput in the status bar (footer)",
			type: "boolean",
			default: true,
		});
		settings.register({
			key: "tokenSpeed.showDuringStream",
			label: "Live stream speed",
			description: "Show live TPS while streaming; when off, only idle stats for the last message",
			type: "boolean",
			default: true,
		});

		const metrics = new StreamMetrics();
		const cache = new CalibrationCache();
		cache.load();
		const trainer = new CalibrationTrainer(cache);
		const isEnabled = (): boolean => settings.getBoolean("tokenSpeed.enabled");
		const status = new LiveStatus({
			metrics,
			isEnabled,
			showDuringStream: () => settings.getBoolean("tokenSpeed.showDuringStream"),
		});

		let lastCtx: ExtensionContext | undefined;
		/** endedAt of the stats already persisted as a custom entry this session. */
		let persistedEndedAt = 0;

		pi.on("before_provider_request", (event, ctx) => {
			lastCtx = ctx;
			const now = Date.now();
			metrics.onRequestStart(now);
			// Estimate the total input size (system + tools + messages) from the
			// outgoing payload once per request; static for the whole request
			// (rebasing math lives in estimateInputTokens).
			const model = ctx.model;
			const requestKey = model ? calibrationKey(model.provider, model.id) : undefined;
			const chars = countPayloadChars(event.payload);
			trainer.onRequestStart(chars);
			metrics.setInputEstimate(
				estimateInputTokens(chars, trainer.lastAuthoritative, requestKey ? cache.get(requestKey) : undefined),
			);
			status.startWait(ctx, now);
		});

		pi.on("message_start", (event, ctx) => {
			lastCtx = ctx;
			if (event.message.role !== "assistant") return;
			status.onMessageStart();
			metrics.onMessageStart(Date.now());
		});

		pi.on("message_update", (event, ctx) => {
			lastCtx = ctx;
			const message = event.message;
			if (message.role !== "assistant") return;
			const delta = extractDelta(event.assistantMessageEvent);
			const now = Date.now();
			if (delta) {
				status.endWait(); // first delta: the live display takes over
				metrics.onDelta(delta.text, delta.kind, now);
			}
			const key = calibrationKey(message.provider, message.model);
			status.renderLive(ctx, now, cache.get(key), message.usage?.output ?? 0);
		});

		pi.on("message_end", (event, ctx) => {
			lastCtx = ctx;
			const message = event.message;
			if (message.role !== "assistant") return;
			status.stopWait();
			const now = Date.now();
			const key = calibrationKey(message.provider, message.model);
			const stats = metrics.onMessageEnd(message.usage, message.provider, message.model, now, cache.get(key));
			if (!stats) return;
			trainer.onMessageEnd(key, stats, new Date(now));
			status.renderIdle(ctx);
		});

		pi.on("agent_end", (_event, ctx) => {
			lastCtx = ctx;
			status.stopWait();
		});

		pi.on("turn_end", (_event, ctx) => {
			lastCtx = ctx;
			if (!isEnabled()) return;
			const stats = metrics.stats;
			if (!stats || stats.endedAt === persistedEndedAt) return;
			persistedEndedAt = stats.endedAt;
			pi.appendEntry(CUSTOM_TYPE, stats);
		});

		const restore = (ctx: ExtensionContext): void => {
			lastCtx = ctx;
			status.stopWait();
			// A (new) session context has no authoritative prompt anchor yet.
			trainer.reset();
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry?.type !== "custom" || entry.customType !== CUSTOM_TYPE) continue;
				const stats = parseLastStats(entry.data);
				if (stats) {
					metrics.restoreLast(stats);
					persistedEndedAt = stats.endedAt;
				}
				break;
			}
			status.renderIdle(ctx);
		};

		pi.on("session_start", (_event, ctx) => {
			restore(ctx);
		});

		pi.on("session_tree", (_event, ctx) => {
			restore(ctx);
		});

		pi.on("session_shutdown", (_event, ctx) => {
			status.shutdown(ctx);
		});

		settings.onChange((key) => {
			const ctx = lastCtx;
			if (ctx) status.onSettingsChange(ctx, key);
		});
	},
};
