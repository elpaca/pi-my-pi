import { describe, expect, it } from "vitest";
import { formatIdleStats, formatStreamingStats, formatStreamingTps, formatWaitElapsed } from "./format.ts";
import type { LastMessageStats, LiveSample } from "./metrics.ts";

function stats(overrides: Partial<LastMessageStats> = {}): LastMessageStats {
	return {
		provider: "prov",
		model: "model",
		ttftMs: 1200,
		decodeMs: 3000,
		avgTps: 45.26,
		outputTokens: 136,
		reasoningTokens: 0,
		estimated: false,
		chars: { cjk: 0, nonCjk: 500 },
		endedAt: 0,
		...overrides,
	};
}

describe("formatStreamingStats", () => {
	const sample = (overrides: Partial<LiveSample>): LiveSample => ({
		estimatedTokens: 0,
		ttftMs: null,
		elapsedMs: 0,
		tps: 0,
		...overrides,
	});

	it("carries the ttft prefix over from the wait phase", () => {
		expect(formatStreamingStats(sample({ ttftMs: 1300, tps: 45.26 }))).toBe("⇢1.3s ~45.3 TPS");
		expect(formatStreamingStats(sample({ ttftMs: 0, tps: 1560.4 }))).toBe("⇢0.0s ~1560 TPS");
	});

	it("shows N/A when the ttft anchor is unknown", () => {
		expect(formatStreamingStats(sample({ ttftMs: null, tps: 45.26 }))).toBe("⇢N/A ~45.3 TPS");
	});
});

describe("formatWaitElapsed", () => {
	it("formats the live ttft counter", () => {
		expect(formatWaitElapsed(0)).toBe("⇢0.0s");
		expect(formatWaitElapsed(1234)).toBe("⇢1.2s");
		expect(formatWaitElapsed(12_345)).toBe("⇢12.3s");
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

describe("formatIdleStats", () => {
	it("formats ttft and tps separated by a space", () => {
		expect(formatIdleStats(stats())).toBe("⇢1.2s 45.3TPS");
	});

	it("shows N/A for an unmeasurable speed (e.g. burst flush)", () => {
		expect(formatIdleStats(stats({ avgTps: null }))).toBe("⇢1.2s N/A");
	});

	it("shows N/A for an unknown ttft", () => {
		expect(formatIdleStats(stats({ ttftMs: null }))).toBe("⇢N/A 45.3TPS");
	});

	it("rounds tps to whole numbers at 100 and above", () => {
		expect(formatIdleStats(stats({ ttftMs: null, avgTps: 234.5 }))).toBe("⇢N/A 235TPS");
	});

	it("shows plain N/A when nothing about the message is measurable", () => {
		expect(formatIdleStats(stats({ ttftMs: null, avgTps: null }))).toBe("N/A");
	});
});
