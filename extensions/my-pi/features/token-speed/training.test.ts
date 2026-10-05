import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CalibrationCache } from "./calibration.ts";
import type { CharCounts } from "./estimator.ts";
import type { LastMessageStats } from "./metrics.ts";
import { CalibrationTrainer } from "./training.ts";

const T0 = 1_000_000;
const KEY = "prov/model-x";

function mkCounts(word: number, punct = 0): CharCounts {
	return { cjk: 0, word, digit: 0, punct, space: 0 };
}

function mkStats(overrides: Partial<LastMessageStats> = {}): LastMessageStats {
	return {
		provider: "prov",
		model: "model-x",
		ttftMs: 100,
		decodeMs: 2000,
		avgTps: 5,
		outputTokens: 50,
		reasoningTokens: 0,
		estimated: false,
		chars: mkCounts(50),
		endedAt: T0,
		...overrides,
	};
}

function mkTrainer() {
	const cache = new CalibrationCache({ dir: mkdtempSync(join(tmpdir(), "pi-my-pi-trainer-")) });
	return { cache, trainer: new CalibrationTrainer(cache) };
}

describe("CalibrationTrainer", () => {
	it("records one visible-output sample per completed message", () => {
		const { cache, trainer } = mkTrainer();
		trainer.onMessageEnd(KEY, mkStats(), new Date(T0));
		const stats = cache.stats(KEY);
		expect(stats?.n).toBe(1);
		expect(stats?.sums).toEqual([0, 50, 0, 0, 0]);
		expect(stats?.sumTokens).toBe(50);
	});

	it("excludes hidden reasoning from output samples and skips estimated messages", () => {
		const { cache, trainer } = mkTrainer();
		trainer.onMessageEnd(KEY, mkStats({ reasoningTokens: 20 }), new Date(T0));
		expect(cache.stats(KEY)?.sumTokens).toBe(30);
		// Estimated output would poison the ratios: never recorded.
		trainer.onMessageEnd(KEY, mkStats({ estimated: true }), new Date(T0));
		expect(cache.stats(KEY)?.n).toBe(1);
	});

	it("anchors on authoritative prompt totals and trains the Δ between requests", () => {
		const { cache, trainer } = mkTrainer();
		trainer.onRequestStart(mkCounts(1000, 200));
		trainer.onMessageEnd(KEY, mkStats({ chars: mkCounts(10), inputTokens: 500, inputEstimated: false }), new Date(T0));
		expect(trainer.lastAuthoritative).toEqual({ tokens: 500, chars: mkCounts(1000, 200) });
		expect(cache.stats(KEY)?.n).toBe(1); // output sample only

		// Second request grows the payload by 400 word + 60 punct chars and is
		// billed +200 prompt tokens: that increment is the Δ sample.
		trainer.onRequestStart(mkCounts(1400, 260));
		trainer.onMessageEnd(KEY, mkStats({ chars: mkCounts(60), inputTokens: 700, inputEstimated: false }), new Date(T0));
		const stats = cache.stats(KEY);
		expect(stats?.n).toBe(3);
		expect(stats?.sums).toEqual([0, 10 + 60 + 400, 0, 60, 0]);
		expect(stats?.sumTokens).toBe(50 + 50 + 200);
	});

	it("ignores estimated input, zero-token deltas, and zero-char deltas", () => {
		const { cache, trainer } = mkTrainer();
		// Estimated input: no anchor, no Δ sample.
		trainer.onRequestStart(mkCounts(1000));
		trainer.onMessageEnd(KEY, mkStats({ inputTokens: 900, inputEstimated: true }), new Date(T0));
		expect(trainer.lastAuthoritative).toBeUndefined();
		// Same prompt total as before: a Δ of zero tokens records nothing.
		trainer.onRequestStart(mkCounts(1000));
		trainer.onMessageEnd(KEY, mkStats({ inputTokens: 500, inputEstimated: false }), new Date(T0));
		expect(trainer.lastAuthoritative).toEqual({ tokens: 500, chars: mkCounts(1000) });
		// Identical payload after that anchor: Δ chars are all zero → no sample.
		trainer.onRequestStart(mkCounts(1000));
		trainer.onMessageEnd(KEY, mkStats({ inputTokens: 500, inputEstimated: false }), new Date(T0));
		expect(cache.stats(KEY)?.n).toBe(3); // three output samples, no Δ
	});

	it("forgets the request pairing after message end and on reset", () => {
		const { cache, trainer } = mkTrainer();
		trainer.onRequestStart(mkCounts(1000));
		trainer.onMessageEnd(KEY, mkStats({ inputTokens: 500, inputEstimated: false }), new Date(T0));
		// A second message end without a new request: no Δ sample, anchor kept.
		trainer.onMessageEnd(KEY, mkStats({ inputTokens: 700, inputEstimated: false }), new Date(T0));
		expect(trainer.lastAuthoritative).toEqual({ tokens: 500, chars: mkCounts(1000) });
		expect(cache.stats(KEY)?.n).toBe(2);
		trainer.reset();
		expect(trainer.lastAuthoritative).toBeUndefined();
	});
});
