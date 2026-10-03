import { type Calibration, type CharCounts, countChars, countTotalChars, estimateTokens } from "./estimator.ts";

/** Stats of the most recently completed assistant message; persisted and restored across sessions. */
export interface LastMessageStats {
	provider: string;
	model: string;
	/** Time to first delta, in ms. Null when no delta was observed. */
	ttftMs: number | null;
	/** Duration from first to last delta, in ms. */
	decodeMs: number | null;
	/** outputTokens / decode seconds. Null when decode duration is unknown. */
	avgTps: number | null;
	/** Authoritative usage.output, or an estimate when usage was unavailable. */
	outputTokens: number;
	/** True when outputTokens is estimated from characters (no authoritative usage). */
	estimated: boolean;
	chars: CharCounts;
	endedAt: number;
}

/** A point-in-time sample of the currently streaming message. */
export interface LiveSample {
	estimatedTokens: number;
	/** Elapsed time since the first delta, ms. */
	elapsedMs: number;
	tps: number;
}

/** Streams produce their first delta quickly; before that the TPS estimate is pure noise. */
export const MIN_LIVE_ELAPSED_MS = 250;

/** Ignore request anchors that predate the message start by more than this (stale anchor from an aborted request). */
const MAX_ANCHOR_SKEW_MS = 60_000;

/**
 * Timing/counter state machine for one streaming assistant message.
 * Pure logic (no I/O, no clocks of its own) so it is fully testable.
 */
export class StreamMetrics {
	private requestStartMs: number | null = null;
	private messageStartMs: number | null = null;
	private firstDeltaMs: number | null = null;
	private lastDeltaMs: number | null = null;
	private chars: CharCounts = { cjk: 0, nonCjk: 0 };
	private hasDelta = false;
	private lastStats: LastMessageStats | undefined;

	/** Drop all state, including the restored last-message stats. */
	reset(): void {
		this.requestStartMs = null;
		this.messageStartMs = null;
		this.firstDeltaMs = null;
		this.lastDeltaMs = null;
		this.chars = { cjk: 0, nonCjk: 0 };
		this.hasDelta = false;
		this.lastStats = undefined;
	}

	/** Restore only the last-message stats (session load / branch switch). */
	restoreLast(stats: LastMessageStats): void {
		this.lastStats = stats;
	}

	get stats(): LastMessageStats | undefined {
		return this.lastStats;
	}

	/** Anchor the start of a provider request. Fired before each LLM call. */
	onRequestStart(now: number): void {
		this.requestStartMs = now;
	}

	/** A new assistant message is about to stream. Resets per-message counters but keeps the request anchor. */
	onMessageStart(now: number): void {
		this.messageStartMs = now;
		this.firstDeltaMs = null;
		this.lastDeltaMs = null;
		this.chars = { cjk: 0, nonCjk: 0 };
		this.hasDelta = false;
	}

	/** Account one streamed delta of any kind (text / thinking / toolcall). */
	onDelta(text: string, now: number): void {
		if (!this.hasDelta) {
			this.firstDeltaMs = now;
			this.hasDelta = true;
		}
		this.lastDeltaMs = now;
		const counts = countChars(text);
		this.chars.cjk += counts.cjk;
		this.chars.nonCjk += counts.nonCjk;
	}

	/**
	 * Current live throughput estimate, or undefined before the stream is long
	 * enough to be meaningful. `authoritativeTokens` (partial usage.output from
	 * the provider, when available) always wins over the character estimate.
	 */
	liveSample(now: number, calibration?: Calibration, authoritativeTokens = 0): LiveSample | undefined {
		if (this.firstDeltaMs === null) return undefined;
		const elapsedMs = now - this.firstDeltaMs;
		if (elapsedMs < MIN_LIVE_ELAPSED_MS) return undefined;
		const estimatedTokens = Math.max(estimateTokens(this.chars, calibration), authoritativeTokens);
		if (!(estimatedTokens > 0)) return undefined;
		return {
			estimatedTokens,
			elapsedMs,
			tps: estimatedTokens / (elapsedMs / 1000),
		};
	}

	/**
	 * Finalize the current message. Returns stats, or undefined when there is
	 * nothing to report (no deltas, no authoritative tokens, no chars).
	 */
	onMessageEnd(
		usage: { output: number } | undefined,
		provider: string,
		model: string,
		now: number,
		calibration?: Calibration,
	): LastMessageStats | undefined {
		const output = usage?.output ?? 0;
		const hasAuthoritative = Number.isFinite(output) && output > 0;
		const totalChars = countTotalChars(this.chars);
		if (!this.hasDelta && !hasAuthoritative && totalChars === 0) return undefined;

		const ttftMs = this.firstDeltaMs !== null ? Math.max(0, this.firstDeltaMs - this.resolveRequestStart()) : null;
		const decodeMs =
			this.firstDeltaMs !== null && this.lastDeltaMs !== null
				? Math.max(0, this.lastDeltaMs - this.firstDeltaMs)
				: null;
		const outputTokens = hasAuthoritative ? output : Math.round(estimateTokens(this.chars, calibration));
		const avgTps = decodeMs !== null && decodeMs > 0 && outputTokens > 0 ? outputTokens / (decodeMs / 1000) : null;

		const stats: LastMessageStats = {
			provider,
			model,
			ttftMs,
			decodeMs,
			avgTps,
			outputTokens,
			estimated: !hasAuthoritative,
			chars: { ...this.chars },
			endedAt: now,
		};
		this.lastStats = stats;
		return stats;
	}

	private resolveRequestStart(): number {
		if (this.requestStartMs === null) {
			return this.messageStartMs ?? 0;
		}
		if (this.messageStartMs !== null && this.requestStartMs < this.messageStartMs - MAX_ANCHOR_SKEW_MS) {
			return this.messageStartMs;
		}
		return this.requestStartMs;
	}
}

/** Validate persisted stats before trusting them. */
export function parseLastStats(data: unknown): LastMessageStats | undefined {
	if (!data || typeof data !== "object") return undefined;
	const d = data as Record<string, unknown>;
	const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
	const nullableNum = (value: unknown): value is number | null => value === null || num(value);
	if (typeof d.provider !== "string" || typeof d.model !== "string") return undefined;
	if (!nullableNum(d.ttftMs) || !nullableNum(d.decodeMs) || !nullableNum(d.avgTps)) return undefined;
	if (!num(d.outputTokens) || !num(d.endedAt)) return undefined;
	if (typeof d.estimated !== "boolean") return undefined;
	const chars = d.chars as Record<string, unknown> | undefined;
	if (!chars || !num(chars.cjk) || !num(chars.nonCjk)) return undefined;
	return {
		provider: d.provider,
		model: d.model,
		ttftMs: d.ttftMs,
		decodeMs: d.decodeMs,
		avgTps: d.avgTps,
		outputTokens: d.outputTokens,
		estimated: d.estimated,
		chars: { cjk: chars.cjk, nonCjk: chars.nonCjk },
		endedAt: d.endedAt,
	};
}
