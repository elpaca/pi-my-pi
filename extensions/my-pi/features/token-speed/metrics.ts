import { type Calibration, type CharCounts, countChars, countTotalChars, estimateTokens } from "./estimator.ts";

/** Stats of the most recently completed assistant message; persisted and restored across sessions. */
export interface LastMessageStats {
	provider: string;
	model: string;
	/** Time to first delta, in ms. Null when no delta was observed. */
	ttftMs: number | null;
	/** Duration from first to last delta, in ms. */
	decodeMs: number | null;
	/**
	 * Average decode speed over the visible stream: visible output tokens
	 * (usage.output minus unstreamed reasoning) divided by the decode window.
	 * Null when the decode window is too short to measure a rate
	 * (< MIN_DECODE_MS). TTFT is waiting time, not producing time, so it is
	 * never part of the denominator.
	 */
	avgTps: number | null;
	/** Authoritative usage.output (including hidden reasoning), or an estimate when usage was unavailable. */
	outputTokens: number;
	/** Reasoning tokens the provider generated but never streamed (hidden reasoning). */
	reasoningTokens: number;
	/** True when outputTokens is estimated from characters (no authoritative usage). */
	estimated: boolean;
	chars: CharCounts;
	endedAt: number;
}

/** A point-in-time sample of the currently streaming message. */
export interface LiveSample {
	estimatedTokens: number;
	/** Time to first delta, ms; null when no request/message anchor exists. */
	ttftMs: number | null;
	/** Elapsed time since the first delta, ms. */
	elapsedMs: number;
	tps: number;
}

/** Display warm-up: don't flash a live rate for messages that finish almost instantly. */
export const MIN_LIVE_ELAPSED_MS = 250;

/**
 * Span of the sliding window behind the live rate. The denominator is the
 * actual span of window data: min(elapsed, LIVE_WINDOW_MS) — the usual
 * "recent speed" readout of progress UIs and bandwidth monitors. A steady
 * stream therefore shows its true rate immediately (no warm-up ramp), and
 * once the window is full a burst ages out over exactly LIVE_WINDOW_MS; a
 * burst of N tokens arriving at once can lift the rate by at most
 * N / (its own span), bounded by N / MIN_LIVE_ELAPSED_MS, and the figure
 * decays as the window slides past it.
 */
export const LIVE_WINDOW_MS = 3000;

/**
 * Minimum decode window for reporting the final average speed. A rate is a
 * ratio over an integration window; below this the window is dominated by
 * delivery jitter (or is a single burst flush) and the ratio is meaningless.
 * Same measurement-validity principle as MIN_LIVE_ELAPSED_MS.
 */
export const MIN_DECODE_MS = 500;

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
	/**
	 * Start of the current live measurement segment: the first delta, or the
	 * first delta after a delivery gap of at least LIVE_WINDOW_MS (a stall —
	 * e.g. hidden server-side reasoning — invalidates the running window).
	 */
	private liveAnchorMs: number | null = null;
	/** Cumulative char counts at liveAnchorMs; window fallback when no entry precedes the cutoff. */
	private segmentBase: CharCounts = { cjk: 0, nonCjk: 0 };
	/** Cumulative char counts at each delta, pruned to the live window; feeds the sliding-window rate. */
	private charLog: Array<{ t: number; cjk: number; nonCjk: number }> = [];
	private lastStats: LastMessageStats | undefined;

	/** Drop all state, including the restored last-message stats. */
	reset(): void {
		this.requestStartMs = null;
		this.messageStartMs = null;
		this.firstDeltaMs = null;
		this.lastDeltaMs = null;
		this.chars = { cjk: 0, nonCjk: 0 };
		this.hasDelta = false;
		this.liveAnchorMs = null;
		this.segmentBase = { cjk: 0, nonCjk: 0 };
		this.charLog = [];
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
		this.liveAnchorMs = null;
		this.segmentBase = { cjk: 0, nonCjk: 0 };
		this.charLog = [];
	}

	/** Account one streamed delta of any kind (text / thinking / toolcall). */
	onDelta(text: string, now: number): void {
		if (text.length === 0) return; // degenerate event: no content, no timing
		if (!this.hasDelta) {
			this.firstDeltaMs = now;
			this.hasDelta = true;
			this.liveAnchorMs = now;
			this.segmentBase = { cjk: 0, nonCjk: 0 };
		} else if (this.lastDeltaMs !== null && now - this.lastDeltaMs >= LIVE_WINDOW_MS) {
			// Delivery gap of at least one full window (hidden reasoning stall,
			// buffering relay): the running window cannot describe the resumed
			// stream, so start a fresh measurement segment here.
			this.liveAnchorMs = now;
			this.segmentBase = { ...this.chars };
			this.charLog = [{ t: now, cjk: this.chars.cjk, nonCjk: this.chars.nonCjk }];
		}
		this.lastDeltaMs = now;
		const counts = countChars(text);
		this.chars.cjk += counts.cjk;
		this.chars.nonCjk += counts.nonCjk;
		this.charLog.push({ t: now, cjk: this.chars.cjk, nonCjk: this.chars.nonCjk });
		// Keep at most one entry at or before the window start; it serves as the baseline.
		while (this.charLog.length >= 2 && (this.charLog[1]?.t ?? Infinity) <= now - LIVE_WINDOW_MS) {
			this.charLog.shift();
		}
	}

	/**
	 * Current live throughput: tokens streamed over the last LIVE_WINDOW_MS of
	 * wall time, divided by the actual span of that window data (min(elapsed,
	 * LIVE_WINDOW_MS)) so early samples show their true average instead of a
	 * warm-up ramp. Because the estimator is linear in char counts, the window
	 * content is computed exactly from char deltas. `authoritativeTokens`
	 * (partial usage.output from the provider, when available) only floors the
	 * reported cumulative estimate.
	 */
	liveSample(now: number, calibration?: Calibration, authoritativeTokens = 0): LiveSample | undefined {
		if (this.firstDeltaMs === null || this.liveAnchorMs === null || this.charLog.length === 0) return undefined;
		const elapsedMs = now - this.liveAnchorMs;
		if (elapsedMs < MIN_LIVE_ELAPSED_MS) return undefined;
		const last = this.charLog[this.charLog.length - 1];
		if (!last) return undefined;
		const cutoff = now - LIVE_WINDOW_MS;
		// Window baseline: last cumulative entry at or before the cutoff; when the
		// window reaches back to the segment start (warm-up or fresh segment), the
		// cumulative counts at the segment anchor.
		let baseCjk = this.segmentBase.cjk;
		let baseNonCjk = this.segmentBase.nonCjk;
		for (let i = this.charLog.length - 1; i >= 0; i--) {
			const entry = this.charLog[i];
			if (entry && entry.t <= cutoff) {
				baseCjk = entry.cjk;
				baseNonCjk = entry.nonCjk;
				break;
			}
		}
		const windowTokens = estimateTokens({ cjk: last.cjk - baseCjk, nonCjk: last.nonCjk - baseNonCjk }, calibration);
		if (!(windowTokens > 0)) return undefined;
		const anchor = this.resolveRequestStart();
		const windowMs = Math.min(elapsedMs, LIVE_WINDOW_MS);
		return {
			estimatedTokens: Math.max(estimateTokens(this.chars, calibration), authoritativeTokens),
			ttftMs: anchor !== null ? Math.max(0, this.firstDeltaMs - anchor) : null,
			elapsedMs,
			tps: windowTokens / (windowMs / 1000),
		};
	}

	/**
	 * Finalize the current message. Returns stats, or undefined when there is
	 * nothing to report (no deltas, no authoritative tokens, no chars).
	 */
	onMessageEnd(
		usage: { output: number; reasoning?: number } | undefined,
		provider: string,
		model: string,
		now: number,
		calibration?: Calibration,
	): LastMessageStats | undefined {
		const output = usage?.output ?? 0;
		const hasAuthoritative = Number.isFinite(output) && output > 0;
		const totalChars = countTotalChars(this.chars);
		if (!this.hasDelta && !hasAuthoritative && totalChars === 0) return undefined;

		const anchor = this.resolveRequestStart();
		const ttftMs = this.firstDeltaMs !== null && anchor !== null ? Math.max(0, this.firstDeltaMs - anchor) : null;
		const decodeMs =
			this.firstDeltaMs !== null && this.lastDeltaMs !== null
				? Math.max(0, this.lastDeltaMs - this.firstDeltaMs)
				: null;
		const reasoningTokens = hasAuthoritative ? Math.max(0, usage?.reasoning ?? 0) : 0;
		const outputTokens = hasAuthoritative ? output : Math.round(estimateTokens(this.chars, calibration));
		// Tokens generated but never streamed (hidden reasoning) do not belong in
		// a decode-speed numerator: they make short visible tails look absurdly
		// fast. The decode window below MIN_DECODE_MS cannot support a rate.
		const visibleTokens = Math.max(0, outputTokens - reasoningTokens);
		const avgTps =
			decodeMs !== null && decodeMs >= MIN_DECODE_MS && visibleTokens > 0 ? visibleTokens / (decodeMs / 1000) : null;

		const stats: LastMessageStats = {
			provider,
			model,
			ttftMs,
			decodeMs,
			avgTps,
			outputTokens,
			reasoningTokens,
			estimated: !hasAuthoritative,
			chars: { ...this.chars },
			endedAt: now,
		};
		this.lastStats = stats;
		return stats;
	}

	/** Request anchor for spans: requestStart, or messageStart when missing/stale. Null when neither exists. */
	private resolveRequestStart(): number | null {
		if (this.requestStartMs !== null) {
			if (this.messageStartMs !== null && this.requestStartMs < this.messageStartMs - MAX_ANCHOR_SKEW_MS) {
				return this.messageStartMs;
			}
			return this.requestStartMs;
		}
		return this.messageStartMs;
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
	const reasoningTokens = num(d.reasoningTokens) ? d.reasoningTokens : 0;
	const stats: LastMessageStats = {
		provider: d.provider,
		model: d.model,
		ttftMs: d.ttftMs,
		decodeMs: d.decodeMs,
		avgTps: d.avgTps,
		outputTokens: d.outputTokens,
		reasoningTokens,
		estimated: d.estimated,
		chars: { cjk: chars.cjk, nonCjk: chars.nonCjk },
		endedAt: d.endedAt,
	};
	// Entries persisted before hidden-reasoning handling divided the full
	// output (including unstreamed reasoning) by a possibly degenerate decode
	// window. Window validity is all we can re-check locally; repair those.
	if (stats.decodeMs !== null && stats.decodeMs < MIN_DECODE_MS) {
		stats.avgTps = null;
	}
	return stats;
}
