import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Feature } from "../../types.ts";
import { CalibrationCache, calibrationKey } from "./calibration.ts";
import {
	type Calibration,
	type CharCounts,
	countPayloadChars,
	countTotalChars,
	DEFAULT_CALIBRATION,
	estimateTokens,
} from "./estimator.ts";
import { formatIdleSegments, formatStreamingSegments, formatWaitSegments, type StatusSegment } from "./format.ts";
import { type LiveSample, parseLastStats, StreamMetrics } from "./metrics.ts";

const STATUS_KEY = "my-pi";
const CUSTOM_TYPE = "my-pi.token-speed";
/** Live status refresh throttle: at most once per second (event-driven, no timers). */
const LIVE_UPDATE_INTERVAL_MS = 1000;
/** Tick rate of the wait-phase elapsed counter (no stream events fire before the first delta). */
const WAIT_TICK_MS = 100;

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

		let lastCtx: ExtensionContext | undefined;
		let lastLiveUpdateMs = 0;
		let lastSample: LiveSample | undefined;
		let persistedEndedAt = 0;
		/** Request-time payload chars, paired with the response's authoritative prompt total. */
		let requestChars: CharCounts | undefined;

		const isEnabled = (): boolean => settings.getBoolean("tokenSpeed.enabled");
		const showDuringStream = (): boolean => settings.getBoolean("tokenSpeed.showDuringStream");

		let waitTimer: ReturnType<typeof setInterval> | undefined;

		const clearStatus = (ctx: ExtensionContext): void => {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		};

		/** Segments that update in real time highlight; static ones stay dim. */
		const renderSegments = (ctx: ExtensionContext, segments: StatusSegment[]): string =>
			segments.map((segment) => ctx.ui.theme.fg(segment.live ? "accent" : "dim", segment.text)).join(" ");

		/** Tear down the wait-phase ticker; safe to call repeatedly. */
		const stopWaitTimer = (): void => {
			if (waitTimer === undefined) return;
			clearInterval(waitTimer);
			waitTimer = undefined;
		};

		/**
		 * While waiting for the first delta no stream events fire, so the elapsed
		 * counter needs its own ticker. It self-disarms when settings change
		 * mid-wait, and is stopped on first delta / message end / shutdown.
		 */
		const startWaitTimer = (ctx: ExtensionContext, anchorMs: number): void => {
			stopWaitTimer();
			if (!isEnabled() || !showDuringStream()) return;
			waitTimer = setInterval(() => {
				if (!isEnabled() || !showDuringStream()) {
					stopWaitTimer();
					clearStatus(ctx);
					return;
				}
				ctx.ui.setStatus(
					STATUS_KEY,
					renderSegments(
						ctx,
						// The previous message's average is the best speed
						// reference available before the first token arrives.
						formatWaitSegments(Date.now() - anchorMs, metrics.inputTokensEstimate, metrics.stats?.avgTps ?? null),
					),
				);
			}, WAIT_TICK_MS);
		};

		const renderIdle = (ctx: ExtensionContext): void => {
			if (!isEnabled()) return;
			const stats = metrics.stats;
			const segments = stats ? formatIdleSegments(stats) : [];
			if (segments.length === 0) {
				clearStatus(ctx);
				return;
			}
			ctx.ui.setStatus(STATUS_KEY, renderSegments(ctx, segments));
		};

		const renderLive = (
			ctx: ExtensionContext,
			now: number,
			calibration: Calibration | undefined,
			partialUsage: number,
		): void => {
			if (!isEnabled() || !showDuringStream()) return;
			const sample = metrics.liveSample(now, calibration, partialUsage);
			if (!sample) return; // no deltas yet: the wait counter still owns the status
			const rateJustBecameMeasurable = lastSample !== undefined && lastSample.tps === null && sample.tps !== null;
			if (
				!lastSample ||
				lastLiveUpdateMs === 0 ||
				rateJustBecameMeasurable ||
				now - lastLiveUpdateMs >= LIVE_UPDATE_INTERVAL_MS
			) {
				lastSample = sample;
				lastLiveUpdateMs = now;
			}
			// Token counters (C/T/O) refresh on every delta; ttft and the window
			// rate come from the throttled sample so the speed figure stays put.
			const throttled = lastSample;
			const shown: LiveSample = { ...sample, ttftMs: throttled.ttftMs, tps: throttled.tps };
			ctx.ui.setStatus(STATUS_KEY, renderSegments(ctx, formatStreamingSegments(shown)));
		};

		pi.on("before_provider_request", (event, ctx) => {
			lastCtx = ctx;
			const now = Date.now();
			metrics.onRequestStart(now);
			// Estimate the total input size (system + tools + messages) from the
			// outgoing payload once per request. The char→token mapping uses the
			// INPUT calibration — learned from authoritative prompt totals against
			// payload chars, because the input text mix (tool schemas, results,
			// code) tokenizes differently from assistant output.
			const model = ctx.model;
			const requestKey = model ? calibrationKey(model.provider, model.id) : undefined;
			const calibration = requestKey ? cache.getInput(requestKey) : undefined;
			const chars = countPayloadChars(event.payload);
			requestChars = chars;
			metrics.setInputEstimate(
				countTotalChars(chars) > 0 ? Math.round(estimateTokens(chars, calibration ?? DEFAULT_CALIBRATION)) : null,
			);
			startWaitTimer(ctx, now);
		});

		pi.on("message_start", (event, ctx) => {
			lastCtx = ctx;
			if (event.message.role !== "assistant") return;
			lastSample = undefined;
			lastLiveUpdateMs = 0;
			metrics.onMessageStart(Date.now());
		});

		pi.on("message_update", (event, ctx) => {
			lastCtx = ctx;
			const message = event.message;
			if (message.role !== "assistant") return;
			const streamEvent = event.assistantMessageEvent;
			const delta = extractDelta(streamEvent);
			const now = Date.now();
			if (delta) {
				if (waitTimer !== undefined) {
					stopWaitTimer();
					lastLiveUpdateMs = 0; // render the first live sample immediately
				}
				metrics.onDelta(delta.text, delta.kind, now);
			}
			const key = calibrationKey(message.provider, message.model);
			renderLive(ctx, now, cache.get(key), message.usage?.output ?? 0);
		});

		pi.on("message_end", (event, ctx) => {
			lastCtx = ctx;
			const message = event.message;
			if (message.role !== "assistant") return;
			stopWaitTimer();
			const now = Date.now();
			const key = calibrationKey(message.provider, message.model);
			const calibration = cache.get(key);
			const stats = metrics.onMessageEnd(message.usage, message.provider, message.model, now, calibration);
			if (!stats) return;
			// Only authoritative usage teaches the estimator anything, and only
			// visible (streamed) tokens: hidden reasoning would poison the ratios.
			const visibleTokens = stats.outputTokens - stats.reasoningTokens;
			if (!stats.estimated && visibleTokens > 0 && countTotalChars(stats.chars) > 0) {
				cache.record(key, stats.chars.cjk, stats.chars.nonCjk, visibleTokens, new Date(now));
			}
			// The authoritative prompt total (input + cacheRead + cacheWrite)
			// against the request-time payload chars feeds the input calibration
			// for future wait/streaming input estimates.
			if (stats.inputEstimated === false && requestChars && countTotalChars(requestChars) > 0) {
				cache.recordInput(key, requestChars.cjk, requestChars.nonCjk, stats.inputTokens ?? 0, new Date(now));
			}
			requestChars = undefined;
			renderIdle(ctx);
		});

		pi.on("agent_end", (_event, ctx) => {
			lastCtx = ctx;
			stopWaitTimer();
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
			stopWaitTimer();
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
			stopWaitTimer();
			clearStatus(ctx);
		});

		settings.onChange((key) => {
			if (key !== "tokenSpeed.enabled" && key !== "tokenSpeed.showDuringStream") return;
			const ctx = lastCtx;
			if (!ctx) return;
			const active = isEnabled() && (ctx.isIdle() || showDuringStream());
			if (!active) {
				stopWaitTimer();
				clearStatus(ctx);
				return;
			}
			if (ctx.isIdle()) {
				renderIdle(ctx);
			}
		});
	},
};
