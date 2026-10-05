import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CalibrationCache } from "../../../../extensions/my-pi/features/token-speed/calibration.ts";
import type { CharCounts } from "../../../../extensions/my-pi/features/token-speed/estimator.ts";
import type { LastMessageStats } from "../../../../extensions/my-pi/features/token-speed/metrics.ts";
import { CalibrationTrainer } from "../../../../extensions/my-pi/features/token-speed/training.ts";

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
	it("feeds only visible streamed output into the calibration pool", () => {
		const { cache, trainer } = mkTrainer();
		trainer.onMessageEnd(KEY, mkStats(), new Date(T0));
		expect(cache.stats(KEY)?.n).toBe(1);
		expect(cache.stats(KEY)?.sums).toEqual([0, 50, 0, 0, 0]);
		expect(cache.stats(KEY)?.sumTokens).toBe(50);

		// Hidden reasoning never streamed: excluded from the sample.
		trainer.onMessageEnd(KEY, mkStats({ reasoningTokens: 20 }), new Date(T0));
		expect(cache.stats(KEY)?.sumTokens).toBe(30 + 50);
		// Estimated output would poison the ratios: never recorded.
		trainer.onMessageEnd(KEY, mkStats({ estimated: true }), new Date(T0));
		expect(cache.stats(KEY)?.n).toBe(2);
	});

	it("anchors on authoritative prompt totals and trains the Δ between requests", () => {
		const { cache, trainer } = mkTrainer();
		// Request 1: no anchor yet — only the output sample lands, then the
		// authoritative prompt total becomes the session anchor.
		trainer.onRequestStart(mkCounts(1000, 200));
		trainer.onMessageEnd(KEY, mkStats({ chars: mkCounts(10), inputTokens: 500, inputEstimated: false }), new Date(T0));
		expect(trainer.lastAuthoritative).toEqual({ tokens: 500, chars: mkCounts(1000, 200) });
		expect(cache.stats(KEY)?.n).toBe(1);

		// Request 2 grows the payload by 400 word + 60 punct chars and is billed
		// +200 prompt tokens: that increment is the Δ sample (constant parts cancel).
		trainer.onRequestStart(mkCounts(1400, 260));
		trainer.onMessageEnd(KEY, mkStats({ chars: mkCounts(60), inputTokens: 700, inputEstimated: false }), new Date(T0));
		const stats = cache.stats(KEY);
		expect(stats?.n).toBe(3);
		expect(stats?.sums).toEqual([0, 10 + 60 + 400, 0, 60, 0]);
		expect(stats?.sumTokens).toBe(50 + 50 + 200);

		// Estimated input teaches nothing: no anchor, no Δ sample.
		const fresh = mkTrainer();
		fresh.trainer.onRequestStart(mkCounts(1000));
		fresh.trainer.onMessageEnd(KEY, mkStats({ inputTokens: 900, inputEstimated: true }), new Date(T0));
		expect(fresh.trainer.lastAuthoritative).toBeUndefined();

		// A Δ of zero tokens (same prompt total) and zero Δ chars (same payload)
		// are both uninformative: nothing recorded beyond the output samples.
		fresh.trainer.onRequestStart(mkCounts(1000));
		fresh.trainer.onMessageEnd(KEY, mkStats({ inputTokens: 500, inputEstimated: false }), new Date(T0));
		fresh.trainer.onRequestStart(mkCounts(1000));
		fresh.trainer.onMessageEnd(KEY, mkStats({ inputTokens: 500, inputEstimated: false }), new Date(T0));
		expect(fresh.cache.stats(KEY)?.n).toBe(3);

		// The request pairing is forgotten after each message end (a second end
		// without a request records no Δ, keeps the anchor) and reset() drops
		// the session anchor entirely.
		fresh.trainer.onMessageEnd(KEY, mkStats({ inputTokens: 700, inputEstimated: false }), new Date(T0));
		expect(fresh.trainer.lastAuthoritative).toEqual({ tokens: 500, chars: mkCounts(1000) });
		expect(fresh.cache.stats(KEY)?.n).toBe(4);
		fresh.trainer.reset();
		expect(fresh.trainer.lastAuthoritative).toBeUndefined();
	});
});
