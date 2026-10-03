import { describe, expect, it } from "vitest";
import {
	formatIdleSegments,
	formatStreamingSegments,
	formatStreamingTps,
	formatTokenCount,
	formatWaitSegments,
} from "./format.ts";
import type { LastMessageStats, LiveSample } from "./metrics.ts";

describe("formatTokenCount", () => {
	it("keeps small counts plain and scales thousands and millions", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(42.4)).toBe("42");
		expect(formatTokenCount(999.6)).toBe("1000");
		expect(formatTokenCount(1000)).toBe("1.0k");
		expect(formatTokenCount(123456)).toBe("123.5k");
		expect(formatTokenCount(1_234_567)).toBe("1.23M");
	});
});

describe("formatWaitSegments", () => {
	it("shows the context estimate static and the counter live", () => {
		expect(formatWaitSegments(1234, 115_000)).toEqual([
			{ text: "C115.0k", live: false },
			{ text: "⇢1.2s", live: true },
		]);
	});

	it("omits the context when it is unknown", () => {
		expect(formatWaitSegments(300, null)).toEqual([{ text: "⇢0.3s", live: true }]);
	});
});

describe("formatStreamingSegments", () => {
	const sample = (overrides: Partial<LiveSample>): LiveSample => ({
		estimatedTokens: 8200,
		estimatedThinkingTokens: 4500,
		cacheTokens: 115_000,
		ttftMs: 1300,
		elapsedMs: 5000,
		tps: 45.26,
		...overrides,
	});

	it("renders C T O ⇢ ~TPS with live flags on the updating parts", () => {
		expect(formatStreamingSegments(sample({}))).toEqual([
			{ text: "C115.0k", live: false },
			{ text: "T4.5k", live: true },
			{ text: "O8.2k", live: true },
			{ text: "⇢1.3s", live: false },
			{ text: "~45.3 TPS", live: true },
		]);
	});

	it("carries the ttft prefix over from the wait phase and marks N/A without an anchor", () => {
		expect(formatStreamingSegments(sample({ ttftMs: 0, tps: 1560.4 }))).toContainEqual({
			text: "⇢0.0s",
			live: false,
		});
		expect(formatStreamingSegments(sample({ ttftMs: null }))).toContainEqual({ text: "⇢N/A", live: false });
	});

	it("omits unstreamed thinking, unknown context and a too-young rate", () => {
		expect(formatStreamingSegments(sample({ estimatedThinkingTokens: null, cacheTokens: null, tps: null }))).toEqual([
			{ text: "O8.2k", live: true },
			{ text: "⇢1.3s", live: false },
		]);
	});
});

describe("formatStreamingTps", () => {
	it("formats with a tilde and one decimal", () => {
		expect(formatStreamingTps(45.26)).toBe("~45.3 TPS");
		expect(formatStreamingTps(7.04)).toBe("~7.0 TPS");
		expect(formatStreamingTps(0.5)).toBe("~0.5 TPS");
	});

	it("switches to whole numbers at 100 and above", () => {
		expect(formatStreamingTps(123.4)).toBe("~123 TPS");
		expect(formatStreamingTps(100)).toBe("~100 TPS");
		expect(formatStreamingTps(99.96)).toBe("~100.0 TPS");
	});
});

describe("formatIdleSegments", () => {
	const stats = (overrides: Partial<LastMessageStats> = {}): LastMessageStats => ({
		provider: "prov",
		model: "model-x",
		ttftMs: 1200,
		decodeMs: 3000,
		avgTps: 45.3,
		outputTokens: 8200,
		reasoningTokens: 4500,
		estimated: false,
		cacheTokens: 115_000,
		cacheEstimated: false,
		chars: { cjk: 0, nonCjk: 0 },
		endedAt: 0,
		...overrides,
	});

	it("renders C T O ⇢ TPS, all static", () => {
		expect(formatIdleSegments(stats())).toEqual([
			{ text: "C115.0k", live: false },
			{ text: "T4.5k", live: false },
			{ text: "O8.2k", live: false },
			{ text: "⇢1.2s", live: false },
			{ text: "45.3TPS", live: false },
		]);
	});

	it("falls back to the streamed-thinking estimate when the provider reports no reasoning", () => {
		expect(formatIdleSegments(stats({ reasoningTokens: 0, thinkingEstimatedTokens: 380 }))).toContainEqual({
			text: "T380",
			live: false,
		});
		// Reliable reasoning wins over the estimate.
		expect(formatIdleSegments(stats({ reasoningTokens: 12, thinkingEstimatedTokens: 380 }))).toContainEqual({
			text: "T12",
			live: false,
		});
	});

	it("shows estimated cache the same way as reported cache", () => {
		expect(formatIdleSegments(stats({ cacheEstimated: true, cacheTokens: 900 }))).toContainEqual({
			text: "C900",
			live: false,
		});
	});

	it("shows N/A for unmeasurable slots and omits empty fields", () => {
		// Burst flush: speed unmeasurable.
		expect(formatIdleSegments(stats({ avgTps: null }))).toContainEqual({ text: "N/A", live: false });
		// No anchor: ttft slot N/A.
		expect(formatIdleSegments(stats({ ttftMs: null }))).toContainEqual({ text: "⇢N/A", live: false });
		// Nothing streamable and no thinking: C/T slots gone.
		expect(
			formatIdleSegments(stats({ reasoningTokens: 0, cacheTokens: undefined, cacheEstimated: undefined })),
		).toEqual([
			{ text: "O8.2k", live: false },
			{ text: "⇢1.2s", live: false },
			{ text: "45.3TPS", live: false },
		]);
	});

	it("appends a single N/A tail when ttft and tps are both gone", () => {
		expect(formatIdleSegments(stats({ ttftMs: null, avgTps: null }))).toEqual([
			{ text: "C115.0k", live: false },
			{ text: "T4.5k", live: false },
			{ text: "O8.2k", live: false },
			{ text: "N/A", live: false },
		]);
	});

	it("returns no segments when nothing about the message is measurable", () => {
		expect(
			formatIdleSegments(
				stats({
					ttftMs: null,
					avgTps: null,
					outputTokens: 0,
					reasoningTokens: 0,
					cacheTokens: undefined,
					cacheEstimated: undefined,
				}),
			),
		).toEqual([]);
	});
});
