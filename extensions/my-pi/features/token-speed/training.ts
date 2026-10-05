import type { CalibrationCache } from "./calibration.ts";
import { type CharCounts, countTotalChars, type InputAnchor, isZeroCounts, subCounts } from "./estimator.ts";
import type { LastMessageStats } from "./metrics.ts";

/**
 * Owns the session-scoped calibration training state — the payload chars of
 * the outgoing request (paired with the response's authoritative prompt total
 * at message end) and the last authoritative prompt anchor — and decides which
 * samples a completed message contributes to the calibration cache.
 */
export class CalibrationTrainer {
	private readonly cache: CalibrationCache;
	/** Payload chars of the current request, paired with its response at message end. */
	private requestChars: CharCounts | undefined;
	/**
	 * Last authoritative prompt total of this session with the payload chars it
	 * billed: the anchor for rebased input estimates and for Δ training
	 * samples. Session-scoped on purpose — system prompt and tool schemas are
	 * constant within a session and cancel in the increment.
	 */
	private authoritative: InputAnchor | undefined;

	constructor(cache: CalibrationCache) {
		this.cache = cache;
	}

	/** The anchor for rebased input estimates, if one exists this session. */
	get lastAuthoritative(): InputAnchor | undefined {
		return this.authoritative;
	}

	/** A provider request is going out with these payload chars. */
	onRequestStart(chars: CharCounts): void {
		this.requestChars = chars;
	}

	/**
	 * Feed a completed assistant message into the calibration: the visible
	 * output sample and the prompt-increment (Δ) sample are recorded, and an
	 * authoritative prompt total becomes the new rebasing anchor.
	 */
	onMessageEnd(key: string, stats: LastMessageStats, now: Date): void {
		// Only authoritative usage teaches the estimator anything, and only
		// visible (streamed) tokens: hidden reasoning would poison the ratios.
		const visibleTokens = stats.outputTokens - stats.reasoningTokens;
		if (!stats.estimated && visibleTokens > 0 && countTotalChars(stats.chars) > 0) {
			this.cache.record(key, stats.chars, visibleTokens, now);
		}
		// The authoritative prompt total (input + cacheRead + cacheWrite)
		// anchors rebasing for the rest of the session, and its increment
		// against the previous authoritative request trains the shared
		// calibration (the constant parts cancel in the increment).
		if (stats.inputEstimated === false && this.requestChars && countTotalChars(this.requestChars) > 0) {
			const promptTokens = stats.inputTokens ?? 0;
			if (this.authoritative) {
				const deltaChars = subCounts(this.requestChars, this.authoritative.chars);
				const deltaTokens = promptTokens - this.authoritative.tokens;
				if (deltaTokens !== 0 && !isZeroCounts(deltaChars)) {
					this.cache.record(key, deltaChars, deltaTokens, now);
				}
			}
			this.authoritative = { tokens: promptTokens, chars: this.requestChars };
		}
		this.requestChars = undefined;
	}

	/** Session change: drop the request pairing and the anchor. */
	reset(): void {
		this.requestChars = undefined;
		this.authoritative = undefined;
	}
}
