import { describe, expect, it } from "vitest";
import {
	BUCKET_KEYS,
	classifyCodePoint,
	countPayloadChars,
	countTextChars,
	countTotalChars,
	DEFAULT_CALIBRATION,
	estimateInputTokens,
	estimateTokens,
	isCjkCodePoint,
	isZeroCounts,
	subCounts,
	zeroCounts,
} from "../../../../extensions/my-pi/features/token-speed/estimator.ts";

describe("estimator", () => {
	it("classifies code points into the five buckets across block boundaries", () => {
		// The canonical order defines the calibration matrix layout.
		expect(BUCKET_KEYS).toEqual(["cjk", "word", "digit", "punct", "space"]);

		// CJK ideographs, Ext A, kana, hangul, CJK punctuation, fullwidth forms.
		for (const cp of [0x4e00, 0x9fff, 0x3400, 0x3042, 0x30a2, 0xac00, 0x3001, 0xff08, 0xff10]) {
			expect(classifyCodePoint(cp)).toBe("cjk");
			expect(isCjkCodePoint(cp)).toBe(true);
		}
		// Letters (incl. _ as identifier glue, accented, cyrillic), digits, spaces, punctuation.
		const others: Array<[number, "word" | "digit" | "space" | "punct"]> = [
			[0x41, "word"],
			[0x5f, "word"],
			[0x00e9, "word"],
			[0x0431, "word"],
			[0x30, "digit"],
			[0x39, "digit"],
			[0x20, "space"],
			[0x0a, "space"],
			[0x3d, "punct"],
			[0x7b, "punct"],
			[0x22, "punct"],
		];
		for (const [cp, bucket] of others) {
			expect(classifyCodePoint(cp)).toBe(bucket);
			expect(isCjkCodePoint(cp)).toBe(false);
		}
		// Just below the CJK block, emoji and latin-1 are not CJK.
		for (const cp of [0x4e0, 0x1f600, 0x00e9]) {
			expect(isCjkCodePoint(cp)).toBe(false);
		}

		// Whole strings: mixed scripts and fullwidth punctuation as CJK.
		expect(countTextChars("hello world")).toEqual({ cjk: 0, word: 10, digit: 0, punct: 0, space: 1 });
		expect(countTextChars("你好，世界")).toEqual({ cjk: 5, word: 0, digit: 0, punct: 0, space: 0 });
		// 使用(2) + space + TypeScript(10) + space + 写(1) + 代码(2)
		expect(countTextChars("使用 TypeScript 写代码")).toEqual({ cjk: 5, word: 10, digit: 0, punct: 0, space: 2 });
		// v(1) 1(2).(3) 2(4) space {(5) a(6) :(7) 1(8) }(9)
		expect(countTextChars("v1.2 {a:1}")).toEqual({ cjk: 0, word: 2, digit: 3, punct: 4, space: 1 });
		// Astral (surrogate pair) characters count once.
		expect(countTextChars("𝄞𝄞")).toEqual({ cjk: 0, word: 2, digit: 0, punct: 0, space: 0 });
		expect(countTextChars("\u{20000}\u{20000}")).toEqual({ cjk: 2, word: 0, digit: 0, punct: 0, space: 0 });
		expect(countTotalChars(countTextChars(""))).toBe(0);
	});

	it("counts payload chars (values, keys, JSON syntax) and blanks binary blobs", () => {
		// {"role":"user","content":"hi"} — 17 letters ("role","user","content","hi") + 13 syntax chars.
		const counts = countPayloadChars({ role: "user", content: "hi" });
		expect(counts.word).toBe(17);
		expect(counts.punct).toBe(13);
		expect(countTotalChars(counts)).toBe(30);

		// Inline images and base64 blobs carry no char→token signal and are
		// blanked before counting → {"type":"image","data":"","url":""}.
		const blob = countPayloadChars({ type: "image", data: "A".repeat(2048), url: "data:image/png;base64,AAAA" });
		expect(blob.word).toBe(16);
		expect(blob.punct).toBe(19);
		expect(countTotalChars(blob)).toBe(35);

		// Nullish payloads carry nothing countable.
		expect(isZeroCounts(countPayloadChars(undefined))).toBe(true);
		expect(isZeroCounts(countPayloadChars(null))).toBe(true);
	});

	it("estimates tokens per bucket and stays linear in signed counts", () => {
		// Default ratios: 13 CJK / 1.3 = 10 tokens; each other bucket contributes 10.
		const counts = { cjk: 13, word: 40, digit: 25, punct: 22, space: 50 };
		expect(estimateTokens(counts)).toBeCloseTo(50, 5);
		expect(estimateTokens(zeroCounts())).toBe(0);

		const calibration = { cjk: 1.0, word: 4.0, digit: 2.5, punct: 2.2, space: 5.0 };
		expect(estimateTokens({ cjk: 10, word: 40, digit: 0, punct: 0, space: 0 }, calibration)).toBeCloseTo(20, 5);

		// Non-positive ratios are invalid: the default ratio applies instead.
		const broken = { cjk: 0, word: -1, digit: 2.5, punct: 2.2, space: 5.0 };
		expect(estimateTokens({ cjk: 13, word: 40, digit: 0, punct: 0, space: 0 }, broken)).toBe(
			estimateTokens({ cjk: 13, word: 40, digit: 0, punct: 0, space: 0 }, DEFAULT_CALIBRATION),
		);

		// Linearity: signed (delta) counts estimate request-to-request increments.
		const a = { cjk: 100, word: 400, digit: 0, punct: 0, space: 0 };
		const b = { cjk: 60, word: 250, digit: 0, punct: 0, space: 0 };
		const delta = subCounts(a, b);
		expect(estimateTokens(delta)).toBeCloseTo(estimateTokens(a) - estimateTokens(b), 6);
		expect(estimateTokens(delta)).toBeGreaterThan(0);
	});

	it("estimates the prompt size and rebases on the authoritative anchor", () => {
		// Without an anchor: full-payload estimate. "hello world" = 10 word
		// chars + 1 space: 10/4.0 + 1/5.0 = 2.7 → 3.
		expect(estimateInputTokens(countTextChars("hello world"), undefined)).toBe(3);

		// With an anchor: only the char delta is estimated on top of the
		// authoritative total — the constant parts (system, tools) cancel.
		const anchor = { tokens: 1000, chars: { cjk: 0, word: 4000, digit: 0, punct: 0, space: 0 } };
		expect(estimateInputTokens({ cjk: 0, word: 4400, digit: 0, punct: 0, space: 0 }, anchor)).toBe(1100); // Δ +400 word chars → +100
		const ratios = { cjk: 1.0, word: 2.0, digit: 2.5, punct: 2.2, space: 5.0 };
		expect(estimateInputTokens({ cjk: 0, word: 4400, digit: 0, punct: 0, space: 0 }, anchor, ratios)).toBe(1200);

		// Payloads with nothing countable: no estimate.
		expect(estimateInputTokens(zeroCounts(), anchor)).toBeNull();
		expect(estimateInputTokens(zeroCounts(), undefined)).toBeNull();
	});
});
