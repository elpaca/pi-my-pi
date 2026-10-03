import { describe, expect, it } from "vitest";
import { formatIdleStats, formatStreamingTps, formatWaitElapsed } from "./format.ts";
import type { LastMessageStats } from "./metrics.ts";

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
	it("formats ttft and tps", () => {
		expect(formatIdleStats(stats())).toBe("⇢1.2s/45.3TPS");
	});

	it("formats ttft only", () => {
		expect(formatIdleStats(stats({ avgTps: null }))).toBe("⇢1.2s");
	});

	it("formats tps only", () => {
		expect(formatIdleStats(stats({ ttftMs: null }))).toBe("⇢45.3TPS");
	});

	it("rounds tps to whole numbers at 100 and above", () => {
		expect(formatIdleStats(stats({ ttftMs: null, avgTps: 234.5 }))).toBe("⇢235TPS");
	});

	it("returns undefined when there is nothing to show", () => {
		expect(formatIdleStats(stats({ ttftMs: null, avgTps: null }))).toBeUndefined();
	});
});
