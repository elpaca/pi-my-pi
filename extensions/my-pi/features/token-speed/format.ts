import type { LastMessageStats, LiveSample } from "./metrics.ts";

/** One renderable piece of the status line. `live` parts highlight in the accent color while they update; static parts render dim. */
export interface StatusSegment {
	text: string;
	live: boolean;
}

/** Format a TPS value: one decimal below 100, whole numbers at or above. */
function formatTps(tps: number): string {
	return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
}

/** Format a duration in seconds with one decimal, e.g. "1.3s". */
function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Format a token count compactly: "980", "12.3k", "1.23M". */
export function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(2)}M`;
	}
	if (tokens >= 1000) {
		return `${(tokens / 1000).toFixed(1)}k`;
	}
	return String(Math.round(tokens));
}

function inputSegment(tokens: number | null | undefined): StatusSegment | null {
	if (tokens === null || tokens === undefined || tokens <= 0) return null;
	return { text: `I${formatTokenCount(tokens)}`, live: false };
}

/** The speed part of the streaming status, e.g. "~45.3 TPS". The "~" marks it as an estimate. */
export function formatStreamingTps(tps: number): string {
	return `~${formatTps(tps)} TPS`;
}

/**
 * Wait-phase segments: the estimated total input size (static for the
 * whole request) plus the live elapsed counter, e.g. `I115.0k ⇢1.3s`.
 */
export function formatWaitSegments(elapsedMs: number, inputTokens: number | null): StatusSegment[] {
	const segments: StatusSegment[] = [];
	const cache = inputSegment(inputTokens);
	if (cache) segments.push(cache);
	segments.push({ text: `⇢${formatSeconds(elapsedMs)}`, live: true });
	return segments;
}

/**
 * Streaming segments in temporal order: `I… ⇢… T… O… ~… TPS` — input goes
 * out, the first token arrives (ttft), thinking streams, then the visible
 * output, and the rate describes the whole generation. O (non-thinking
 * output) and T update on every delta while streaming; T appears only while
 * thinking content is actually streamed (hidden reasoning stays invisible
 * until the reliable end-of-message count); O appears once non-thinking
 * output is measurable (≥ 1 token equivalent) — the thinking phase shows no
 * O0 placeholder. The ttft slot is frozen after the first token; the window
 * rate is throttled upstream. Unmeasurable slots show N/A or are omitted.
 */
export function formatStreamingSegments(sample: LiveSample): StatusSegment[] {
	const segments: StatusSegment[] = [];
	const input = inputSegment(sample.inputTokens);
	if (input) segments.push(input);
	segments.push({ text: sample.ttftMs !== null ? `⇢${formatSeconds(sample.ttftMs)}` : "⇢N/A", live: false });
	if (sample.estimatedThinkingTokens !== null) {
		segments.push({ text: `T${formatTokenCount(sample.estimatedThinkingTokens)}`, live: true });
	}
	if (Math.round(sample.estimatedOutputTokens) >= 1) {
		segments.push({ text: `O${formatTokenCount(sample.estimatedOutputTokens)}`, live: true });
	}
	if (sample.tps !== null) {
		segments.push({ text: formatStreamingTps(sample.tps), live: true });
	}
	return segments;
}

/**
 * Idle segments for the last completed message, e.g. `I115.0k ⇢1.2s T4.5k
 * O8.2k 45.3TPS`, in the same temporal order as the streaming display;
 * everything is final, so nothing highlights. Reliable data wins over
 * estimates (provider reasoning over streamed-thinking estimate); O shows
 * the non-thinking output (T + O ≈ output); fields with neither reliable
 * data nor an estimate are omitted, and a missing ttft/tps slot shows N/A.
 * Returns [] when nothing about the message could be measured at all.
 */
export function formatIdleSegments(stats: LastMessageStats): StatusSegment[] {
	const segments: StatusSegment[] = [];
	const input = inputSegment(stats.inputTokens);
	if (input) segments.push(input);
	const ttft = stats.ttftMs !== null ? `⇢${formatSeconds(stats.ttftMs)}` : null;
	const tps = stats.avgTps !== null ? `${formatTps(stats.avgTps)}TPS` : null;
	if (ttft !== null || tps !== null) {
		segments.push({ text: ttft ?? "⇢N/A", live: false });
	}
	const thinking = stats.reasoningTokens > 0 ? stats.reasoningTokens : (stats.thinkingEstimatedTokens ?? 0);
	if (thinking > 0) {
		segments.push({ text: `T${formatTokenCount(thinking)}`, live: false });
	}
	// O is the non-thinking output only (T + O ≈ output); hidden reasoning
	// belongs to T, never to O.
	const output = stats.outputTokens - thinking;
	if (output > 0) {
		segments.push({ text: `O${formatTokenCount(output)}`, live: false });
	}
	if (ttft !== null || tps !== null) {
		segments.push({ text: tps ?? "N/A", live: false });
	} else if (segments.length > 0) {
		// No speed slot at all: a single N/A tail says the message ended
		// without anything measurable beyond the counters above.
		segments.push({ text: "N/A", live: false });
	}
	return segments;
}
