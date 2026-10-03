import { describe, expect, it } from "vitest";
import { parseLastStats, StreamMetrics } from "./metrics.ts";

const CALIBRATION = { cjkCharsPerToken: 1.0, nonCjkCharsPerToken: 4.0 };

function feedCompleteMessage(metrics: StreamMetrics, options?: { withRequestAnchor?: boolean; deltaMs?: number[] }) {
	const withAnchor = options?.withRequestAnchor ?? true;
	const deltas = options?.deltaMs ?? [1000, 2000, 3000, 4000];
	if (withAnchor) metrics.onRequestStart(500);
	metrics.onMessageStart(900);
	for (const at of deltas) {
		metrics.onDelta("hello ", at);
	}
	return metrics.onMessageEnd({ output: 20 }, "prov", "model", 5000, CALIBRATION);
}

describe("StreamMetrics", () => {
	it("computes ttft, decode duration and average TPS", () => {
		const metrics = new StreamMetrics();
		const stats = feedCompleteMessage(metrics);
		expect(stats).toBeDefined();
		expect(stats?.ttftMs).toBe(1000 - 500); // first delta − request start
		expect(stats?.decodeMs).toBe(4000 - 1000); // last delta − first delta
		expect(stats?.avgTps).toBeCloseTo(20 / 3, 5);
		expect(stats?.outputTokens).toBe(20);
		expect(stats?.estimated).toBe(false);
		expect(stats?.chars).toEqual({ cjk: 0, nonCjk: 24 }); // 4 deltas × "hello "
		expect(metrics.stats).toBe(stats);
	});

	it("falls back to message start when there is no request anchor", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(1000);
		metrics.onDelta("hi", 1500);
		const stats = metrics.onMessageEnd({ output: 4 }, "prov", "model", 1600);
		expect(stats?.ttftMs).toBe(500); // 1500 − 1000
	});

	it("falls back to message start when the anchor is stale", () => {
		const metrics = new StreamMetrics();
		metrics.onRequestStart(0); // more than 60s before message start
		metrics.onMessageStart(120_000);
		metrics.onDelta("hi", 120_500);
		const stats = metrics.onMessageEnd({ output: 4 }, "prov", "model", 120_600);
		expect(stats?.ttftMs).toBe(500);
	});

	it("uses authoritative usage over estimates at message end", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(0);
		metrics.onDelta("你好世界", 100); // 4 CJK chars → 4 tokens at 1.0 chars/token
		const stats = metrics.onMessageEnd({ output: 99 }, "prov", "model", 200, CALIBRATION);
		expect(stats?.outputTokens).toBe(99);
		expect(stats?.estimated).toBe(false);
	});

	it("estimates tokens when usage is missing", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(0);
		metrics.onDelta("hello", 100);
		const stats = metrics.onMessageEnd(undefined, "prov", "model", 200, CALIBRATION);
		expect(stats?.outputTokens).toBe(1); // 5/4 rounded
		expect(stats?.estimated).toBe(true);
	});

	it("returns undefined for messages without any content", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(0);
		expect(metrics.onMessageEnd({ output: 0 }, "prov", "model", 100)).toBeUndefined();
		expect(metrics.onMessageEnd(undefined, "prov", "model", 100)).toBeUndefined();
	});

	it("reports null avgTps when decode duration is zero", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(0);
		metrics.onDelta("only", 100);
		const stats = metrics.onMessageEnd({ output: 5 }, "prov", "model", 150);
		expect(stats?.decodeMs).toBe(0);
		expect(stats?.avgTps).toBeNull();
	});

	it("liveSample needs a minimum elapsed time and nonzero estimate", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(0);
		expect(metrics.liveSample(1000)).toBeUndefined(); // no delta yet

		metrics.onDelta("x", 500);
		expect(metrics.liveSample(600)).toBeUndefined(); // < 250ms since first delta

		metrics.onDelta("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", 600); // 33 chars → ~8 tokens
		const sample = metrics.liveSample(1500, CALIBRATION);
		expect(sample?.elapsedMs).toBe(1000);
		expect(sample?.estimatedTokens).toBeCloseTo(33 / 4, 5);
		expect(sample?.tps).toBeCloseTo(8.25, 5);
	});

	it("liveSample prefers authoritative partial usage over the estimate", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(0);
		metrics.onDelta("x", 0);
		const sample = metrics.liveSample(1000, CALIBRATION, 42);
		expect(sample?.estimatedTokens).toBe(42);
		expect(sample?.tps).toBe(42);
	});

	it("reset clears everything including restored stats", () => {
		const metrics = new StreamMetrics();
		feedCompleteMessage(metrics);
		metrics.reset();
		expect(metrics.stats).toBeUndefined();
		expect(metrics.liveSample(Date.now())).toBeUndefined();
	});
});

describe("parseLastStats", () => {
	it("accepts valid persisted stats", () => {
		const metrics = new StreamMetrics();
		const stats = feedCompleteMessage(metrics);
		const parsed = parseLastStats(JSON.parse(JSON.stringify(stats)));
		expect(parsed).toEqual(stats);
	});

	it("rejects malformed payloads", () => {
		expect(parseLastStats(undefined)).toBeUndefined();
		expect(parseLastStats(null)).toBeUndefined();
		expect(parseLastStats("nope")).toBeUndefined();
		expect(parseLastStats({})).toBeUndefined();
		expect(parseLastStats({ provider: "p", model: "m" })).toBeUndefined();
		expect(
			parseLastStats({
				provider: "p",
				model: "m",
				ttftMs: null,
				decodeMs: null,
				avgTps: null,
				outputTokens: "10",
				estimated: false,
				chars: { cjk: 0, nonCjk: 0 },
				endedAt: 1,
			}),
		).toBeUndefined();
		expect(
			parseLastStats({
				provider: "p",
				model: "m",
				ttftMs: 1,
				decodeMs: 1,
				avgTps: 1,
				outputTokens: 1,
				estimated: false,
				chars: { cjk: "0", nonCjk: 0 },
				endedAt: 1,
			}),
		).toBeUndefined();
	});

	it("round-trips null fields", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(0);
		metrics.onDelta("x", 100);
		const stats = metrics.onMessageEnd({ output: 3 }, "prov", "model", 150);
		const parsed = parseLastStats(JSON.parse(JSON.stringify(stats)));
		expect(parsed?.decodeMs).toBe(0);
		expect(parsed?.ttftMs).toBe(100);
	});
});
