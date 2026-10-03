import type { LastMessageStats } from "./metrics.ts";

/** Format a TPS value: one decimal below 100, whole numbers at or above. */
function formatTps(tps: number): string {
	return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
}

/** Streaming status text, e.g. "~45.3 TPS". The "~" marks it as an estimate. */
export function formatStreamingTps(tps: number): string {
	return `~${formatTps(tps)} TPS`;
}

/**
 * Idle status text for the last completed message, e.g. "⇢1.2s/45.3TPS".
 * Returns undefined when there is nothing worth showing.
 */
export function formatIdleStats(stats: LastMessageStats): string | undefined {
	const parts: string[] = [];
	if (stats.ttftMs !== null) {
		parts.push(`${(stats.ttftMs / 1000).toFixed(1)}s`);
	}
	if (stats.avgTps !== null) {
		parts.push(`${formatTps(stats.avgTps)}TPS`);
	}
	if (parts.length === 0) {
		return undefined;
	}
	return `⇢${parts.join("/")}`;
}
