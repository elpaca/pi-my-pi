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

function cacheSegment(tokens: number | null | undefined): StatusSegment | null {
	if (tokens === null || tokens === undefined || tokens <= 0) return null;
	return { text: `C${formatTokenCount(tokens)}`, live: false };
}

/** The speed part of the streaming status, e.g. "~45.3 TPS". The "~" marks it as an estimate. */
export function formatStreamingTps(tps: number): string {
	return `~${formatTps(tps)} TPS`;
}

/**
 * Wait-phase segments: the estimated cached-context size (static for the
 * whole request) plus the live elapsed counter, e.g. `C115.0k ⇢1.3s`.
 */
export function formatWaitSegments(elapsedMs: number, cacheTokens: number | null): StatusSegment[] {
	const segments: StatusSegment[] = [];
	const cache = cacheSegment(cacheTokens);
	if (cache) segments.push(cache);
	segments.push({ text: `⇢${formatSeconds(elapsedMs)}`, live: true });
	return segments;
}

/**
 * Streaming segments: `C… T… O… ⇢… ~… TPS`. O updates on every delta while
 * streaming; T appears only while thinking content is actually streamed
 * (hidden reasoning stays invisible until the reliable end-of-message count);
 * the ttft prefix is frozen after the first token; the window rate is
 * throttled upstream. Unmeasurable slots show N/A or are omitted.
 */
export function formatStreamingSegments(sample: LiveSample): StatusSegment[] {
	const segments: StatusSegment[] = [];
	const cache = cacheSegment(sample.cacheTokens);
	if (cache) segments.push(cache);
	if (sample.estimatedThinkingTokens !== null) {
		segments.push({ text: `T${formatTokenCount(sample.estimatedThinkingTokens)}`, live: true });
	}
	segments.push({ text: `O${formatTokenCount(sample.estimatedTokens)}`, live: true });
	segments.push({ text: sample.ttftMs !== null ? `⇢${formatSeconds(sample.ttftMs)}` : "⇢N/A", live: false });
	if (sample.tps !== null) {
		segments.push({ text: formatStreamingTps(sample.tps), live: true });
	}
	return segments;
}

/**
 * Idle segments for the last completed message, e.g. `C115.0k T4.5k O8.2k
 * ⇢1.2s 45.3TPS`; everything is final, so nothing highlights. Reliable data
 * wins over estimates (provider reasoning over streamed-thinking estimate);
 * fields with neither are omitted, and a missing ttft/tps slot shows N/A.
 * Returns [] when nothing about the message could be measured at all.
 */
export function formatIdleSegments(stats: LastMessageStats): StatusSegment[] {
	const segments: StatusSegment[] = [];
	const cache = cacheSegment(stats.cacheTokens);
	if (cache) segments.push(cache);
	const thinking = stats.reasoningTokens > 0 ? stats.reasoningTokens : (stats.thinkingEstimatedTokens ?? 0);
	if (thinking > 0) {
		segments.push({ text: `T${formatTokenCount(thinking)}`, live: false });
	}
	if (stats.outputTokens > 0) {
		segments.push({ text: `O${formatTokenCount(stats.outputTokens)}`, live: false });
	}
	const ttft = stats.ttftMs !== null ? `⇢${formatSeconds(stats.ttftMs)}` : null;
	const tps = stats.avgTps !== null ? `${formatTps(stats.avgTps)}TPS` : null;
	if (ttft === null && tps === null) {
		if (segments.length > 0) {
			segments.push({ text: "N/A", live: false });
		}
		return segments;
	}
	segments.push({ text: ttft ?? "⇢N/A", live: false });
	segments.push({ text: tps ?? "N/A", live: false });
	return segments;
}
