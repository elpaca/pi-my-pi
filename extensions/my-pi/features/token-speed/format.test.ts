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
			{ text: "I115.0k", live: false },
			{ text: "F1.2s", live: true },
		]);
	});

	it("omits the context when it is unknown", () => {
		expect(formatWaitSegments(300, null)).toEqual([{ text: "F0.3s", live: true }]);
	});

	it("appends the previous message's average as a frozen speed reference", () => {
		expect(formatWaitSegments(1234, 115_000, 45.26)).toEqual([
			{ text: "I115.0k", live: false },
			{ text: "F1.2s", live: true },
			{ text: "~45.3 TPS", live: false },
		]);
		// No measurable previous message: no reference.
		expect(formatWaitSegments(300, null, null)).toEqual([{ text: "F0.3s", live: true }]);
	});
});

describe("formatStreamingSegments", () => {
	const sample = (overrides: Partial<LiveSample>): LiveSample => ({
		estimatedTokens: 8200,
		estimatedOutputTokens: 3700,
		estimatedThinkingTokens: 4500,
		inputTokens: 115_000,
		ttftMs: 1300,
		elapsedMs: 5000,
		tps: 45.26,
		...overrides,
	});

	it("renders I F T O ~TPS in temporal order with live flags on the updating parts", () => {
		expect(formatStreamingSegments(sample({}))).toEqual([
			{ text: "I115.0k", live: false },
			{ text: "F1.3s", live: false },
			{ text: "T4.5k", live: true },
			{ text: "O3.7k", live: true },
			{ text: "~45.3 TPS", live: true },
		]);
	});

	it("carries the ttft prefix over from the wait phase and marks N/A without an anchor", () => {
		expect(formatStreamingSegments(sample({ ttftMs: 0, tps: 1560.4 }))).toContainEqual({
			text: "F0.0s",
			live: false,
		});
		expect(formatStreamingSegments(sample({ ttftMs: null }))).toContainEqual({ text: "FN/A", live: false });
	});

	it("omits unstreamed thinking, unknown context and a too-young rate", () => {
		expect(formatStreamingSegments(sample({ estimatedThinkingTokens: null, inputTokens: null, tps: null }))).toEqual([
			{ text: "F1.3s", live: false },
			{ text: "O3.7k", live: true },
		]);
	});

	it("omits O until the non-thinking output is measurable", () => {
		// Thinking phase: no O0 placeholder.
		expect(formatStreamingSegments(sample({ estimatedOutputTokens: 0 }))).toEqual([
			{ text: "I115.0k", live: false },
			{ text: "F1.3s", live: false },
			{ text: "T4.5k", live: true },
			{ text: "~45.3 TPS", live: true },
		]);
		// Sub-token output still rounds to zero: no slot yet.
		expect(
			formatStreamingSegments(
				sample({ estimatedOutputTokens: 0.4, estimatedThinkingTokens: null, inputTokens: null, tps: null }),
			),
		).toEqual([{ text: "F1.3s", live: false }]);
		// As soon as it rounds to one token, the slot appears.
		expect(
			formatStreamingSegments(
				sample({ estimatedOutputTokens: 0.6, estimatedThinkingTokens: null, inputTokens: null, tps: null }),
			),
		).toEqual([
			{ text: "F1.3s", live: false },
			{ text: "O1", live: true },
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
		inputTokens: 115_000,
		inputEstimated: false,
		chars: { cjk: 0, word: 0, digit: 0, punct: 0, space: 0 },
		endedAt: 0,
		...overrides,
	});

	it("renders I F T O TPS in temporal order, all static", () => {
		expect(formatIdleSegments(stats())).toEqual([
			{ text: "I115.0k", live: false },
			{ text: "F1.2s", live: false },
			{ text: "T4.5k", live: false },
			{ text: "O3.7k", live: false },
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
		expect(formatIdleSegments(stats({ inputEstimated: true, inputTokens: 900 }))).toContainEqual({
			text: "I900",
			live: false,
		});
	});

	it("shows N/A for unmeasurable slots and omits empty fields", () => {
		// Burst flush: speed unmeasurable.
		expect(formatIdleSegments(stats({ avgTps: null }))).toContainEqual({ text: "N/A", live: false });
		// No anchor: ttft slot N/A.
		expect(formatIdleSegments(stats({ ttftMs: null }))).toContainEqual({ text: "FN/A", live: false });
		// Nothing streamable and no thinking: I/T slots gone.
		expect(
			formatIdleSegments(stats({ reasoningTokens: 0, inputTokens: undefined, inputEstimated: undefined })),
		).toEqual([
			{ text: "F1.2s", live: false },
			{ text: "O8.2k", live: false },
			{ text: "45.3TPS", live: false },
		]);
	});

	it("appends a single N/A tail when ttft and tps are both gone", () => {
		expect(formatIdleSegments(stats({ ttftMs: null, avgTps: null }))).toEqual([
			{ text: "I115.0k", live: false },
			{ text: "T4.5k", live: false },
			{ text: "O3.7k", live: false },
			{ text: "N/A", live: false },
		]);
	});

	it("omits O when every output token is thinking", () => {
		const segments = formatIdleSegments(stats({ outputTokens: 500, reasoningTokens: 500 }));
		expect(segments).toContainEqual({ text: "T500", live: false });
		expect(segments.find((segment) => segment.text.startsWith("O"))).toBeUndefined();
	});

	it("returns no segments when nothing about the message is measurable", () => {
		expect(
			formatIdleSegments(
				stats({
					ttftMs: null,
					avgTps: null,
					outputTokens: 0,
					reasoningTokens: 0,
					inputTokens: undefined,
					inputEstimated: undefined,
				}),
			),
		).toEqual([]);
	});
});
