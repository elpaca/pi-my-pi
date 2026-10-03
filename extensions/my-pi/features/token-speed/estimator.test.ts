import { describe, expect, it } from "vitest";
import { countChars, countTotalChars, DEFAULT_CALIBRATION, estimateTokens, isCjkCodePoint } from "./estimator.ts";

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

describe("countChars", () => {
	it("counts CJK and non-CJK code points", () => {
		expect(countChars("hello world")).toEqual({ cjk: 0, nonCjk: 11 });
		expect(countChars("你好，世界")).toEqual({ cjk: 5, nonCjk: 0 }); // fullwidth comma counts as CJK
		expect(countChars("使用 TypeScript 写代码")).toEqual({ cjk: 5, nonCjk: 12 });
	});

	it("counts astral (surrogate pair) characters once", () => {
		expect(countChars("𝄞𝄞")).toEqual({ cjk: 0, nonCjk: 2 });
		expect(countChars("\u{20000}\u{20000}")).toEqual({ cjk: 2, nonCjk: 0 }); // Ext B
	});

	it("handles empty strings", () => {
		expect(countChars("")).toEqual({ cjk: 0, nonCjk: 0 });
		expect(countTotalChars({ cjk: 0, nonCjk: 0 })).toBe(0);
	});
});

describe("estimateTokens", () => {
	it("uses default calibration ratios", () => {
		// 13 CJK / 1.3 = 10 tokens; 38 non-CJK / 3.8 = 10 tokens
		expect(estimateTokens({ cjk: 13, nonCjk: 38 })).toBeCloseTo(20, 5);
		expect(estimateTokens({ cjk: 0, nonCjk: 0 })).toBe(0);
	});

	it("applies a custom calibration", () => {
		const calibration = { cjkCharsPerToken: 1.0, nonCjkCharsPerToken: 4.0 };
		expect(estimateTokens({ cjk: 10, nonCjk: 40 }, calibration)).toBeCloseTo(20, 5);
	});

	it("falls back to defaults for invalid calibration ratios", () => {
		const broken = { cjkCharsPerToken: 0, nonCjkCharsPerToken: -1 };
		expect(estimateTokens({ cjk: 13, nonCjk: 38 }, broken)).toBe(
			estimateTokens({ cjk: 13, nonCjk: 38 }, DEFAULT_CALIBRATION),
		);
	});
});
