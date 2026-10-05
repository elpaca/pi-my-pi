import { describe, expect, it } from "vitest";
import {
	formatIdleSegments,
	formatStreamingSegments,
	formatStreamingTps,
	formatTokenCount,
	formatWaitSegments,
} from "../../../../extensions/my-pi/features/token-speed/format.ts";
import type { LastMessageStats, LiveSample } from "../../../../extensions/my-pi/features/token-speed/metrics.ts";

const liveSample = (overrides: Partial<LiveSample> = {}): LiveSample => ({
	estimatedTokens: 8200,
	estimatedOutputTokens: 3700,
	estimatedThinkingTokens: 4500,
	inputTokens: 115_000,
	ttftMs: 1300,
	elapsedMs: 5000,
	tps: 45.26,
	...overrides,
});

const idleStats = (overrides: Partial<LastMessageStats> = {}): LastMessageStats => ({
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

describe("status formatting", () => {
	it("wait phase: context estimate static, elapsed counter live, previous average frozen", () => {
		expect(formatWaitSegments(1234, 115_000)).toEqual([
			{ text: "I115.0k", live: false },
			{ text: "F1.2s", live: true },
		]);
		// Unknown context: the estimate slot is omitted.
		expect(formatWaitSegments(300, null)).toEqual([{ text: "F0.3s", live: true }]);
		// The previous message's average is a static speed reference.
		expect(formatWaitSegments(1234, 115_000, 45.26)).toEqual([
			{ text: "I115.0k", live: false },
			{ text: "F1.2s", live: true },
			{ text: "~45.3 TPS", live: false },
		]);
		expect(formatWaitSegments(300, null, null)).toEqual([{ text: "F0.3s", live: true }]);
	});

	it("streaming phase: temporal order with live flags, omissions, and slot thresholds", () => {
		expect(formatStreamingSegments(liveSample())).toEqual([
			{ text: "I115.0k", live: false },
			{ text: "F1.3s", live: false },
			{ text: "T4.5k", live: true },
			{ text: "O3.7k", live: true },
			{ text: "~45.3 TPS", live: true },
		]);
		// The ttft slot carries the wait-phase F prefix over; without any
		// anchor it degrades to FN/A.
		expect(formatStreamingSegments(liveSample({ ttftMs: 0, tps: 1560.4 }))).toContainEqual({
			text: "F0.0s",
			live: false,
		});
		expect(formatStreamingSegments(liveSample({ ttftMs: null }))).toContainEqual({ text: "FN/A", live: false });
		// Unstreamed thinking, unknown context and a too-young rate are omitted.
		expect(
			formatStreamingSegments(liveSample({ estimatedThinkingTokens: null, inputTokens: null, tps: null })),
		).toEqual([
			{ text: "F1.3s", live: false },
			{ text: "O3.7k", live: true },
		]);
		// No O0 placeholder during the thinking phase…
		expect(formatStreamingSegments(liveSample({ estimatedOutputTokens: 0 }))).toEqual([
			{ text: "I115.0k", live: false },
			{ text: "F1.3s", live: false },
			{ text: "T4.5k", live: true },
			{ text: "~45.3 TPS", live: true },
		]);
		// …sub-token output still rounds to zero: no slot yet…
		expect(
			formatStreamingSegments(
				liveSample({ estimatedOutputTokens: 0.4, estimatedThinkingTokens: null, inputTokens: null, tps: null }),
			),
		).toEqual([{ text: "F1.3s", live: false }]);
		// …and as soon as it rounds to one token, the slot appears.
		expect(
			formatStreamingSegments(
				liveSample({ estimatedOutputTokens: 0.6, estimatedThinkingTokens: null, inputTokens: null, tps: null }),
			),
		).toEqual([
			{ text: "F1.3s", live: false },
			{ text: "O1", live: true },
		]);
	});

	it("idle phase: full matrix in temporal order with reliable values", () => {
		expect(formatIdleSegments(idleStats())).toEqual([
			{ text: "I115.0k", live: false },
			{ text: "F1.2s", live: false },
			{ text: "T4.5k", live: false },
			{ text: "O3.7k", live: false },
			{ text: "45.3TPS", live: false },
		]);
		// Without a reported reasoning count, the streamed-thinking estimate
		// fills the T slot; a reliable report wins over the estimate.
		expect(formatIdleSegments(idleStats({ reasoningTokens: 0, thinkingEstimatedTokens: 380 }))).toContainEqual({
			text: "T380",
			live: false,
		});
		expect(formatIdleSegments(idleStats({ reasoningTokens: 12, thinkingEstimatedTokens: 380 }))).toContainEqual({
			text: "T12",
			live: false,
		});
		// Estimated and reported input render identically.
		expect(formatIdleSegments(idleStats({ inputEstimated: true, inputTokens: 900 }))).toContainEqual({
			text: "I900",
			live: false,
		});
		// All-thinking output: T shown, O omitted.
		const allThinking = formatIdleSegments(idleStats({ outputTokens: 500, reasoningTokens: 500 }));
		expect(allThinking).toContainEqual({ text: "T500", live: false });
		expect(allThinking.find((segment) => segment.text.startsWith("O"))).toBeUndefined();
	});

	it("idle phase: N/A fallbacks for unmeasurable slots, nothing measurable → no segments", () => {
		// Burst flush: speed unmeasurable; no anchor: ttft slot N/A.
		expect(formatIdleSegments(idleStats({ avgTps: null }))).toContainEqual({ text: "N/A", live: false });
		expect(formatIdleSegments(idleStats({ ttftMs: null }))).toContainEqual({ text: "FN/A", live: false });
		// Nothing streamable and no thinking: I/T slots gone.
		expect(
			formatIdleSegments(idleStats({ reasoningTokens: 0, inputTokens: undefined, inputEstimated: undefined })),
		).toEqual([
			{ text: "F1.2s", live: false },
			{ text: "O8.2k", live: false },
			{ text: "45.3TPS", live: false },
		]);
		// Both speed slots gone: a single N/A tail instead of FN/A … N/A pairs.
		expect(formatIdleSegments(idleStats({ ttftMs: null, avgTps: null }))).toEqual([
			{ text: "I115.0k", live: false },
			{ text: "T4.5k", live: false },
			{ text: "O3.7k", live: false },
			{ text: "N/A", live: false },
		]);
		// A message about which nothing is measurable renders nothing.
		expect(
			formatIdleSegments(
				idleStats({
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

	it("count and speed formatting boundaries (round before scaling, ~tilde, whole numbers ≥ 100)", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(42.4)).toBe("42");
		expect(formatTokenCount(999.6)).toBe("1000"); // rounds before scaling
		expect(formatTokenCount(1000)).toBe("1.0k");
		expect(formatTokenCount(123456)).toBe("123.5k");
		expect(formatTokenCount(1_234_567)).toBe("1.23M");
		expect(formatStreamingTps(45.26)).toBe("~45.3 TPS");
		expect(formatStreamingTps(0.5)).toBe("~0.5 TPS");
		expect(formatStreamingTps(99.96)).toBe("~100.0 TPS"); // still < 100: one decimal
		expect(formatStreamingTps(100)).toBe("~100 TPS"); // ≥ 100: whole numbers
		expect(formatStreamingTps(123.4)).toBe("~123 TPS");
	});
});
