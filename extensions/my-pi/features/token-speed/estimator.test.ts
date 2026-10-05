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
} from "./estimator.ts";

describe("isCjkCodePoint", () => {
	it.each([
		[0x4e00, true], // 一
		[0x9fff, true],
		[0x3400, true], // Ext A
		[0x3042, true], // あ hiragana
		[0x30a2, true], // ア katakana
		[0xac00, true], // 가 hangul
		[0x3001, true], // 、 CJK punctuation
		[0xff08, true], // （ fullwidth paren
		[0x41, false], // A
		[0x20, false], // space
		[0x1f600, false], // emoji
		[0x00e9, false], // é
		[0x4e0, false], // below CJK block
	])("classifies U+%s as %s", (cp, expected) => {
		expect(isCjkCodePoint(cp)).toBe(expected);
	});
});

describe("classifyCodePoint", () => {
	it.each([
		[0x41, "word"], // A
		[0x5f, "word"], // _ (identifier glue tokenizes like letters)
		[0x30, "digit"], // 0
		[0x39, "digit"], // 9
		[0x20, "space"],
		[0x0a, "space"], // newline
		[0x3d, "punct"], // =
		[0x7b, "punct"], // {
		[0x22, "punct"], // "
		[0x4e00, "cjk"], // 一
		[0xff10, "cjk"], // ０ fullwidth digit (CJK block)
		[0x00e9, "word"], // é
		[0x0431, "word"], // б cyrillic
	])("classifies U+%s as %s", (cp, expected) => {
		expect(classifyCodePoint(cp)).toBe(expected);
	});
});

describe("countTextChars", () => {
	it("classifies code points into the five buckets", () => {
		expect(countTextChars("hello world")).toEqual({ cjk: 0, word: 10, digit: 0, punct: 0, space: 1 });
		// fullwidth comma counts as CJK
		expect(countTextChars("你好，世界")).toEqual({ cjk: 5, word: 0, digit: 0, punct: 0, space: 0 });
		// 使用(2) + space + TypeScript(10) + space + 写(1) + 代码(2)
		expect(countTextChars("使用 TypeScript 写代码")).toEqual({
			cjk: 5,
			word: 10,
			digit: 0,
			punct: 0,
			space: 2,
		});
		// v(1) 1(2).(3) 2(4) space {(5) a(6) :(7) 1(8) }(9)
		expect(countTextChars("v1.2 {a:1}")).toEqual({ cjk: 0, word: 2, digit: 3, punct: 4, space: 1 });
	});

	it("counts astral (surrogate pair) characters once", () => {
		expect(countTextChars("𝄞𝄞")).toEqual({ cjk: 0, word: 2, digit: 0, punct: 0, space: 0 });
		expect(countTextChars("\u{20000}\u{20000}")).toEqual({ cjk: 2, word: 0, digit: 0, punct: 0, space: 0 });
	});

	it("handles empty strings", () => {
		expect(countTextChars("")).toEqual({ cjk: 0, word: 0, digit: 0, punct: 0, space: 0 });
		expect(countTotalChars(countTextChars(""))).toBe(0);
	});
});

describe("countPayloadChars", () => {
	it("counts values, keys, and JSON syntax of the serialized payload", () => {
		const counts = countPayloadChars({ role: "user", content: "hi" });
		// {"role":"user","content":"hi"} — 17 letters ("role","user","content","hi") + 13 syntax chars
		expect(counts.word).toBe(17);
		expect(counts.punct).toBe(13);
		expect(countTotalChars(counts)).toBe(30);
	});

	it("blanks out data URLs and base64 blobs", () => {
		const base64 = "A".repeat(2048);
		const counts = countPayloadChars({ type: "image", data: base64, url: "data:image/png;base64,AAAA" });
		// → {"type":"image","data":"","url":""}: 16 letters + 19 syntax chars
		expect(counts.word).toBe(16);
		expect(counts.punct).toBe(19);
		expect(countTotalChars(counts)).toBe(35);
	});

	it("returns zero counts for null/undefined payloads", () => {
		expect(isZeroCounts(countPayloadChars(undefined))).toBe(true);
		expect(isZeroCounts(countPayloadChars(null))).toBe(true);
	});
});

describe("estimateTokens", () => {
	it("uses default calibration ratios", () => {
		// 13 CJK / 1.3 = 10 tokens; each other bucket contributes 10 tokens
		const counts = { cjk: 13, word: 40, digit: 25, punct: 22, space: 50 };
		expect(estimateTokens(counts)).toBeCloseTo(50, 5);
		expect(estimateTokens({ cjk: 0, word: 0, digit: 0, punct: 0, space: 0 })).toBe(0);
	});

	it("applies a custom calibration", () => {
		const calibration = { cjk: 1.0, word: 4.0, digit: 2.5, punct: 2.2, space: 5.0 };
		expect(estimateTokens({ cjk: 10, word: 40, digit: 0, punct: 0, space: 0 }, calibration)).toBeCloseTo(20, 5);
	});

	it("falls back to defaults for invalid calibration ratios", () => {
		const broken = { cjk: 0, word: -1, digit: 2.5, punct: 2.2, space: 5.0 };
		expect(estimateTokens({ cjk: 13, word: 40, digit: 0, punct: 0, space: 0 }, broken)).toBe(
			estimateTokens({ cjk: 13, word: 40, digit: 0, punct: 0, space: 0 }, DEFAULT_CALIBRATION),
		);
	});

	it("is linear, so signed (delta) counts estimate increments", () => {
		const a = { cjk: 100, word: 400, digit: 0, punct: 0, space: 0 };
		const b = { cjk: 60, word: 250, digit: 0, punct: 0, space: 0 };
		const delta = subCounts(a, b);
		expect(estimateTokens(delta)).toBeCloseTo(estimateTokens(a) - estimateTokens(b), 6);
		expect(estimateTokens(delta)).toBeGreaterThan(0);
	});

	it("covers every bucket key exactly", () => {
		expect(BUCKET_KEYS).toEqual(["cjk", "word", "digit", "punct", "space"]);
	});
});

describe("estimateInputTokens", () => {
	const anchor = { tokens: 1000, chars: { cjk: 0, word: 4000, digit: 0, punct: 0, space: 0 } };

	it("estimates the full payload without an anchor", () => {
		// "hello world" = 10 word chars + 1 space: 10/4.0 + 1/5.0 = 2.7 → 3.
		expect(estimateInputTokens(countTextChars("hello world"), undefined)).toBe(3);
	});

	it("rebases on the authoritative prompt total via the char delta", () => {
		// Δ = +400 word chars → +100 tokens on top of the anchor's 1000.
		expect(estimateInputTokens({ cjk: 0, word: 4400, digit: 0, punct: 0, space: 0 }, anchor)).toBe(1100);
		// A custom calibration applies to the increment.
		const ratios = { cjk: 1.0, word: 2.0, digit: 2.5, punct: 2.2, space: 5.0 };
		expect(estimateInputTokens({ cjk: 0, word: 4400, digit: 0, punct: 0, space: 0 }, anchor, ratios)).toBe(1200);
	});

	it("returns null for payloads with nothing countable", () => {
		expect(estimateInputTokens(zeroCounts(), anchor)).toBeNull();
		expect(estimateInputTokens(zeroCounts(), undefined)).toBeNull();
	});
});
