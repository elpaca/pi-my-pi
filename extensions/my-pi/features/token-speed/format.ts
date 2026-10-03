import type { LastMessageStats, LiveSample } from "./metrics.ts";

/** Format a TPS value: one decimal below 100, whole numbers at or above. */
function formatTps(tps: number): string {
	return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
}

/** Format a duration in seconds with one decimal, e.g. "1.3s". */
function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** The speed part of the streaming status, e.g. "~45.3 TPS". The "~" marks it as an estimate. */
export function formatStreamingTps(tps: number): string {
	return `~${formatTps(tps)} TPS`;
}

/**
 * Streaming status text: "⇢1.3s ~45.3 TPS" — the time-to-first-token prefix
 * carries over seamlessly from the wait-phase counter. Unknown slots show N/A.
 */
export function formatStreamingStats(sample: LiveSample): string {
	const ttft = sample.ttftMs !== null ? formatSeconds(sample.ttftMs) : "N/A";
	return `⇢${ttft} ${formatStreamingTps(sample.tps)}`;
}

/** Live time-to-first-token readout while waiting for the first delta, e.g. "⇢1.3s". */
export function formatWaitElapsed(elapsedMs: number): string {
	return `⇢${formatSeconds(elapsedMs)}`;
}

/**
 * Idle status text for the last completed message, e.g. "⇢1.2s 45.3TPS".
 * Unmeasurable slots show N/A (burst-flush decode window, no anchor, no
 * visible tokens); "N/A" alone when nothing about the message is measurable.
 */
export function formatIdleStats(stats: LastMessageStats): string {
	const ttft = stats.ttftMs !== null ? formatSeconds(stats.ttftMs) : null;
	const tps = stats.avgTps !== null ? `${formatTps(stats.avgTps)}TPS` : null;
	if (ttft === null && tps === null) {
		return "N/A";
	}
	return `⇢${[ttft ?? "N/A", tps ?? "N/A"].join(" ")}`;
}
