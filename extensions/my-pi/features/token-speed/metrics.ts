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
	/**
	 * Estimated tokens of thinking content that was actually streamed (visible
	 * thinking), char-based. Undefined when nothing was streamed or in legacy
	 * entries. Reliable thinking counts live in `reasoningTokens`.
	 */
	thinkingEstimatedTokens?: number;
	/**
	 * Total input tokens (uncached input + cacheRead + cacheWrite): the same
	 * quantity the payload estimate approximates. Reliable when the provider
	 * reported any input usage (inputEstimated false), else the request-context
	 * estimate (inputEstimated true). Undefined when neither is available.
	 */
	inputTokens?: number;
	inputEstimated?: boolean;
	chars: CharCounts;
	endedAt: number;
}

/** A point-in-time sample of the currently streaming message. */
export interface LiveSample {
	/** Estimated cumulative generated tokens (text + thinking + toolcall); the rate numerator. */
	estimatedTokens: number;
	/**
	 * Estimated cumulative non-thinking output tokens (text + toolcall); the O
	 * slot. Derived from the streamed deltas only — mid-stream usage.output
	 * mixes in hidden thinking for providers that count it as output (and
	 * reasoning is not reliably reported mid-stream), so authoritative data
	 * would put thinking into O before any visible output exists.
	 */
	estimatedOutputTokens: number;
	/** Estimated thinking tokens streamed so far; null while no thinking deltas arrived. */
	estimatedThinkingTokens: number | null;
	/** Estimated total input tokens (system + tools + messages) for the current request; null when unknown. */
	inputTokens: number | null;
	/** Time to first delta, ms; null when no request/message anchor exists. */
	ttftMs: number | null;
	/** Elapsed time since the start of the current measurement segment, ms. */
	elapsedMs: number;
	/** Window rate; null while the window is younger than MIN_LIVE_ELAPSED_MS. */
	tps: number | null;
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
	private thinkingChars: CharCounts = { cjk: 0, nonCjk: 0 };
	/** Non-thinking (text + toolcall) streamed chars: the O slot excludes thinking. */
	private outputChars: CharCounts = { cjk: 0, nonCjk: 0 };
	private hasDelta = false;
	/** Estimated cached-context tokens of the current request; set per request, survives message starts. */
	private requestInputTokens: number | null = null;
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
		this.thinkingChars = { cjk: 0, nonCjk: 0 };
		this.outputChars = { cjk: 0, nonCjk: 0 };
		this.hasDelta = false;
		this.requestInputTokens = null;
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

	/**
	 * Estimated cached-context size of the outgoing request (computed by the
	 * caller from the request payload). Null when the payload carried nothing
	 * countable. Stays stable for the whole request so the wait counter and
	 * the live display agree.
	 */
	setInputEstimate(tokens: number | null): void {
		this.requestInputTokens = tokens;
	}

	get inputTokensEstimate(): number | null {
		return this.requestInputTokens;
	}

	/** Anchor the start of a provider request. Fired before each LLM call. */
	onRequestStart(now: number): void {
		this.requestStartMs = now;
	}

	/** A new assistant message is about to stream. Resets per-message counters but keeps the request anchor and context. */
	onMessageStart(now: number): void {
		this.messageStartMs = now;
		this.firstDeltaMs = null;
		this.lastDeltaMs = null;
		this.chars = { cjk: 0, nonCjk: 0 };
		this.thinkingChars = { cjk: 0, nonCjk: 0 };
		this.outputChars = { cjk: 0, nonCjk: 0 };
		this.hasDelta = false;
		this.liveAnchorMs = null;
		this.segmentBase = { cjk: 0, nonCjk: 0 };
		this.charLog = [];
	}

	/** Account one streamed delta. Kind separates visible thinking from other output. */
	onDelta(text: string, kind: "text" | "thinking" | "toolcall", now: number): void {
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
		if (kind === "thinking") {
			this.thinkingChars.cjk += counts.cjk;
			this.thinkingChars.nonCjk += counts.nonCjk;
		} else {
			this.outputChars.cjk += counts.cjk;
			this.outputChars.nonCjk += counts.nonCjk;
		}
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
	 * reported cumulative rate numerator — never the O slot, which stays a
	 * pure non-thinking char estimate.
	 */
	liveSample(now: number, calibration?: Calibration, authoritativeTokens = 0): LiveSample | undefined {
		if (this.firstDeltaMs === null || this.liveAnchorMs === null || this.charLog.length === 0) return undefined;
		const elapsedMs = now - this.liveAnchorMs;
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
		const anchor = this.resolveRequestStart();
		// The rate needs a minimum integration window; the cumulative counters
		// (C/T/O) are valid from the first delta on.
		const tps =
			elapsedMs >= MIN_LIVE_ELAPSED_MS && windowTokens > 0
				? windowTokens / (Math.min(elapsedMs, LIVE_WINDOW_MS) / 1000)
				: null;
		// The O slot counts non-thinking output only, measured from the deltas
		// actually received. Mid-stream usage.output includes hidden thinking for
		// several providers while reasoning is not reliably reported mid-stream,
		// so an authoritative floor here would surface thinking as O during the
		// thinking phase (the T438 O438 bug). Hidden reasoning stays invisible
		// until the reliable end-of-message split.
		return {
			estimatedTokens: Math.max(estimateTokens(this.chars, calibration), authoritativeTokens),
			estimatedOutputTokens: estimateTokens(this.outputChars, calibration),
			estimatedThinkingTokens:
				countTotalChars(this.thinkingChars) > 0 ? estimateTokens(this.thinkingChars, calibration) : null,
			inputTokens: this.requestInputTokens,
			ttftMs: anchor !== null ? Math.max(0, this.firstDeltaMs - anchor) : null,
			elapsedMs,
			tps,
		};
	}

	/**
	 * Finalize the current message. Returns stats, or undefined when there is
	 * nothing to report (no deltas, no authoritative tokens, no chars).
	 */
	onMessageEnd(
		usage: { output: number; input?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number } | undefined,
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

		// Input: pi-ai normalizes usage.input to the *uncached* input across
		// providers (OpenAI subtracts cached_tokens from prompt_tokens; Anthropic's
		// input_tokens excludes cache read/write). The total prompt the model saw
		// is input + cacheRead + cacheWrite — the quantity the payload estimate
		// approximates. Provider data is authoritative; otherwise fall back to
		// the request-time estimate.
		const input = Number.isFinite(usage?.input) ? Math.max(0, usage?.input ?? 0) : 0;
		const cacheRead = Number.isFinite(usage?.cacheRead) ? Math.max(0, usage?.cacheRead ?? 0) : 0;
		const cacheWrite = Number.isFinite(usage?.cacheWrite) ? Math.max(0, usage?.cacheWrite ?? 0) : 0;
		const reportedInput = input + cacheRead + cacheWrite;
		let inputTokens: number | undefined;
		let inputEstimated: boolean | undefined;
		if (reportedInput > 0) {
			inputTokens = reportedInput;
			inputEstimated = false;
		} else if (this.requestInputTokens !== null && this.requestInputTokens > 0) {
			inputTokens = this.requestInputTokens;
			inputEstimated = true;
		}
		// Visible thinking is measured from streamed thinking deltas; only shown
		// when the provider did not report an authoritative reasoning count.
		const thinkingEstimatedTokens =
			countTotalChars(this.thinkingChars) > 0 ? Math.round(estimateTokens(this.thinkingChars, calibration)) : undefined;

		const stats: LastMessageStats = {
			provider,
			model,
			ttftMs,
			decodeMs,
			avgTps,
			outputTokens,
			reasoningTokens,
			estimated: !hasAuthoritative,
			thinkingEstimatedTokens,
			inputTokens,
			inputEstimated,
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
	const optNum = (value: unknown): number | undefined => (num(value) && value >= 0 ? value : undefined);
	const thinkingEstimatedTokens = optNum(d.thinkingEstimatedTokens);
	// "inputTokens" replaced the brief "cacheTokens" naming; accept both.
	const inputTokens = optNum(d.inputTokens ?? d.cacheTokens);
	const inputEstimated = d.inputEstimated === true || d.cacheEstimated === true;
	const stats: LastMessageStats = {
		provider: d.provider,
		model: d.model,
		ttftMs: d.ttftMs,
		decodeMs: d.decodeMs,
		avgTps: d.avgTps,
		outputTokens: d.outputTokens,
		reasoningTokens,
		estimated: d.estimated,
		...(thinkingEstimatedTokens !== undefined ? { thinkingEstimatedTokens } : {}),
		...(inputTokens !== undefined ? { inputTokens, inputEstimated } : {}),
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
