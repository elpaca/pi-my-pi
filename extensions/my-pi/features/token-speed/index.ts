import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Feature } from "../../types.ts";
import { CalibrationCache, calibrationKey } from "./calibration.ts";
import { type Calibration, countTotalChars } from "./estimator.ts";
import { formatIdleStats, formatStreamingTps } from "./format.ts";
import { parseLastStats, StreamMetrics } from "./metrics.ts";

const STATUS_KEY = "my-pi";
const CUSTOM_TYPE = "my-pi.token-speed";
/** Live status refresh throttle: at most once per second (event-driven, no timers). */
const LIVE_UPDATE_INTERVAL_MS = 1000;

function extractDelta(event: AssistantMessageEvent): string | undefined {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta;
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

		let lastCtx: ExtensionContext | undefined;
		let lastLiveUpdateMs = 0;
		let persistedEndedAt = 0;

		const isEnabled = (): boolean => settings.getBoolean("tokenSpeed.enabled");
		const showDuringStream = (): boolean => settings.getBoolean("tokenSpeed.showDuringStream");

		const clearStatus = (ctx: ExtensionContext): void => {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		};

		const renderIdle = (ctx: ExtensionContext): void => {
			if (!isEnabled()) return;
			const stats = metrics.stats;
			if (!stats) return;
			const text = formatIdleStats(stats);
			if (!text) return;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", text));
		};

		const renderLive = (
			ctx: ExtensionContext,
			now: number,
			calibration: Calibration | undefined,
			partialUsage: number,
		): void => {
			if (!isEnabled() || !showDuringStream()) return;
			const sample = metrics.liveSample(now, calibration, partialUsage);
			if (!sample) return;
			if (now - lastLiveUpdateMs < LIVE_UPDATE_INTERVAL_MS) return;
			lastLiveUpdateMs = now;
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", formatStreamingTps(sample.tps)));
		};

		pi.on("before_provider_request", (_event, ctx) => {
			lastCtx = ctx;
			metrics.onRequestStart(Date.now());
		});

		pi.on("message_start", (event, ctx) => {
			lastCtx = ctx;
			if (event.message.role !== "assistant") return;
			metrics.onMessageStart(Date.now());
		});

		pi.on("message_update", (event, ctx) => {
			lastCtx = ctx;
			const message = event.message;
			if (message.role !== "assistant") return;
			const streamEvent = event.assistantMessageEvent;
			const delta = extractDelta(streamEvent);
			const now = Date.now();
			if (delta !== undefined) {
				metrics.onDelta(delta, now);
			}
			const key = calibrationKey(message.provider, message.model);
			renderLive(ctx, now, cache.get(key), message.usage?.output ?? 0);
		});

		pi.on("message_end", (event, ctx) => {
			lastCtx = ctx;
			const message = event.message;
			if (message.role !== "assistant") return;
			const now = Date.now();
			const key = calibrationKey(message.provider, message.model);
			const calibration = cache.get(key);
			const stats = metrics.onMessageEnd(message.usage, message.provider, message.model, now, calibration);
			if (!stats) return;
			// Only authoritative usage teaches the estimator anything.
			if (!stats.estimated && countTotalChars(stats.chars) > 0) {
				cache.record(key, stats.chars.cjk, stats.chars.nonCjk, stats.outputTokens, new Date(now));
			}
			renderIdle(ctx);
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
			renderIdle(ctx);
		};

		pi.on("session_start", (_event, ctx) => {
			restore(ctx);
		});

		pi.on("session_tree", (_event, ctx) => {
			restore(ctx);
		});

		pi.on("session_shutdown", (_event, ctx) => {
			clearStatus(ctx);
		});

		settings.onChange((key) => {
			if (key !== "tokenSpeed.enabled") return;
			const ctx = lastCtx;
			if (!ctx) return;
			if (!isEnabled()) {
				clearStatus(ctx);
				return;
			}
			if (ctx.isIdle()) {
				renderIdle(ctx);
			}
		});
	},
};
