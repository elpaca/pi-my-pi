import { describe, expect, it } from "vitest";
import type { Calibration } from "./estimator.ts";
import { parseLastStats, StreamMetrics } from "./metrics.ts";

const CALIBRATION = { cjkCharsPerToken: 1.0, nonCjkCharsPerToken: 4.0 } as const satisfies Calibration;
const T0 = 1_000_000;

function feedCompleteMessage(
	metrics: StreamMetrics,
	options?: {
		withRequestAnchor?: boolean;
		deltaMs?: number[];
		usage?: { output: number; reasoning?: number };
	},
) {
	const withAnchor = options?.withRequestAnchor ?? true;
	const deltas = options?.deltaMs ?? [1000, 2000, 3000, 4000];
	if (withAnchor) metrics.onRequestStart(T0 + 500);
	metrics.onMessageStart(T0 + 900);
	for (const at of deltas) {
		metrics.onDelta("hello ", "text", T0 + at);
	}
	return metrics.onMessageEnd(options?.usage ?? { output: 20 }, "prov", "model", T0 + 5000, CALIBRATION);
}

describe("StreamMetrics", () => {
	it("computes ttft, decode window and visible-token average speed", () => {
		const metrics = new StreamMetrics();
		const stats = feedCompleteMessage(metrics, { usage: { output: 20, reasoning: 4 } });
		expect(stats).toBeDefined();
		expect(stats?.ttftMs).toBe(500); // first delta − request start
		expect(stats?.decodeMs).toBe(3000); // last delta − first delta
		expect(stats?.outputTokens).toBe(20);
		expect(stats?.reasoningTokens).toBe(4);
		expect(stats?.avgTps).toBeCloseTo(16 / 3, 5); // (output − hidden reasoning) / decode window
		expect(stats?.estimated).toBe(false);
		expect(stats?.chars).toEqual({ cjk: 0, nonCjk: 24 }); // 4 deltas × "hello "
		expect(metrics.stats).toBe(stats);
	});

	it("counts all output when the provider reports no hidden reasoning", () => {
		const metrics = new StreamMetrics();
		const stats = feedCompleteMessage(metrics, { usage: { output: 20 } });
		expect(stats?.reasoningTokens).toBe(0);
		expect(stats?.avgTps).toBeCloseTo(20 / 3, 5);
	});

	it("falls back to message start when there is no request anchor", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0 + 1000);
		metrics.onDelta("hi", "text", T0 + 1500);
		const stats = metrics.onMessageEnd({ output: 4 }, "prov", "model", T0 + 1600);
		expect(stats?.ttftMs).toBe(500); // 1500 − 1000
	});

	it("falls back to message start when the anchor is stale", () => {
		const metrics = new StreamMetrics();
		metrics.onRequestStart(T0); // more than 60s before message start
		metrics.onMessageStart(T0 + 120_000);
		metrics.onDelta("hi", "text", T0 + 120_500);
		const stats = metrics.onMessageEnd({ output: 4 }, "prov", "model", T0 + 120_600);
		expect(stats?.ttftMs).toBe(500);
	});

	it("uses authoritative usage over estimates at message end", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		metrics.onDelta("你好世界", "text", T0 + 100); // 4 CJK chars → 4 tokens at 1.0 chars/token
		const stats = metrics.onMessageEnd({ output: 99, reasoning: 3 }, "prov", "model", T0 + 200, CALIBRATION);
		expect(stats?.outputTokens).toBe(99);
		expect(stats?.reasoningTokens).toBe(3);
		expect(stats?.estimated).toBe(false);
	});

	it("estimates tokens when usage is missing", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		metrics.onDelta("hello", "text", T0 + 100);
		const stats = metrics.onMessageEnd(undefined, "prov", "model", T0 + 200, CALIBRATION);
		expect(stats?.outputTokens).toBe(1); // 5/4 rounded
		expect(stats?.reasoningTokens).toBe(0);
		expect(stats?.estimated).toBe(true);
	});

	it("returns undefined for messages without any content", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		expect(metrics.onMessageEnd({ output: 0 }, "prov", "model", T0 + 100)).toBeUndefined();
		expect(metrics.onMessageEnd(undefined, "prov", "model", T0 + 100)).toBeUndefined();
	});

	it("reports no average when the burst flushes the whole message at once", () => {
		// Real-world pathology: provider generates server-side for ~19.5s, then
		// delivers everything within 39ms. The decode window cannot support a rate.
		const metrics = new StreamMetrics();
		metrics.onRequestStart(T0);
		metrics.onMessageStart(T0 + 100);
		metrics.onDelta("x".repeat(1872), "text", T0 + 19475);
		metrics.onDelta(".", "text", T0 + 19514); // last tail chunk
		const stats = metrics.onMessageEnd({ output: 503 }, "prov", "model", T0 + 19530);
		expect(stats?.ttftMs).toBe(19475);
		expect(stats?.decodeMs).toBe(39);
		expect(stats?.avgTps).toBeNull(); // not 12897
	});

	it("averages over a healthy decode window", () => {
		const metrics = new StreamMetrics();
		metrics.onRequestStart(T0);
		metrics.onMessageStart(T0);
		for (let i = 1; i <= 5; i++) {
			metrics.onDelta("hello ", "text", T0 + i * 500);
		}
		const stats = metrics.onMessageEnd({ output: 24 }, "prov", "model", T0 + 3100);
		expect(stats?.decodeMs).toBe(2000);
		expect(stats?.avgTps).toBe(12); // 24 tokens / 2s
	});

	it("liveSample needs a minimum elapsed time for the rate, counters work from the first delta", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		expect(metrics.liveSample(T0 + 1000)).toBeUndefined(); // no delta yet

		metrics.onDelta("x", "text", T0 + 500);
		const young = metrics.liveSample(T0 + 600);
		expect(young?.tps).toBeNull(); // < 250ms since first delta: no rate yet
		expect(young?.estimatedTokens).toBeCloseTo(1 / 3.8, 5); // cumulative estimate still valid

		metrics.onDelta("x".repeat(32), "text", T0 + 600); // 33 chars total → ~8 tokens
		const sample = metrics.liveSample(T0 + 1500, CALIBRATION);
		expect(sample?.elapsedMs).toBe(1000);
		expect(sample?.ttftMs).toBe(500); // first delta − message start anchor
		expect(sample?.estimatedTokens).toBeCloseTo(33 / 4, 5);
		// Actual-span denominator while the window is not full: 8.25 tokens over
		// 1.0s of data → the true average immediately, no warm-up ramp.
		expect(sample?.tps).toBeCloseTo(8.25, 5);
	});

	it("liveSample is exact during warm-up: steady rate from the first sample", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		for (let i = 0; i < 3; i++) {
			metrics.onDelta("hello ", "text", T0 + i * 500); // 12 chars/s = 3 tokens/s
		}
		const sample = metrics.liveSample(T0 + 1500, CALIBRATION);
		// Window holds all 1.5s of data → 4.5 tokens / 1.5s = 3 TPS (not 4.5/3 = 1.5).
		expect(sample?.tps).toBe(3);
	});

	it("liveSample is exact once the sliding window is full", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		for (let i = 0; i <= 10; i++) {
			metrics.onDelta("hello ", "text", T0 + i * 500); // 12 chars/s = 3 tokens/s
		}
		const sample = metrics.liveSample(T0 + 5000, CALIBRATION);
		// Window covers the last 3s exactly: 6 deltas × 6 chars = 36 chars = 9 tokens.
		expect(sample?.tps).toBe(3);
	});

	it("liveSample reports the actual-span average for an early burst", () => {
		const metrics = new StreamMetrics();
		metrics.onRequestStart(T0);
		metrics.onMessageStart(T0);
		metrics.onDelta("x".repeat(1872), "text", T0 + 19475); // everything at once after 19.5s
		const sample = metrics.liveSample(T0 + 19775, CALIBRATION);
		expect(sample?.ttftMs).toBe(19475);
		expect(sample?.tps).toBe(1560); // 468 tokens over the observed 0.3s span
	});

	it("liveSample recovers exactly after the window slides past a burst", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		metrics.onDelta("x".repeat(1872), "text", T0 + 19475);
		for (let i = 0; i <= 6; i++) {
			metrics.onDelta("hello ", "text", T0 + 20000 + i * 500); // steady 3 tokens/s
		}
		const sample = metrics.liveSample(T0 + 23000, CALIBRATION);
		expect(sample?.tps).toBe(3);
	});

	it("liveSample starts a fresh measurement segment after a delivery gap of one window", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		metrics.onDelta("x".repeat(380), "text", T0 + 1000); // 100 tokens, then a 9s stall
		metrics.onDelta("xx", "text", T0 + 10000); // trickle resumes
		const sample = metrics.liveSample(T0 + 10250, CALIBRATION);
		// Segment restarted at the first post-gap delta: 0.5 tokens over 0.25s.
		// Without the reset the 3s denominator would span the stall → ~0.17 TPS.
		expect(sample?.elapsedMs).toBe(250);
		expect(sample?.tps).toBe(2);
	});

	it("liveSample keeps the window across gaps smaller than one window span", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		metrics.onDelta("x".repeat(380), "text", T0 + 1000); // 100 tokens
		metrics.onDelta("xx", "text", T0 + 3000); // 2s gap (< 3s window): no segment reset
		const sample = metrics.liveSample(T0 + 3250, CALIBRATION);
		expect(sample?.elapsedMs).toBe(2250);
		expect(sample?.tps).toBeCloseTo(95.5 / 2.25, 5); // 380 chars + "xx" over the 2.25s span
	});

	it("onDelta ignores empty deltas", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		metrics.onDelta("", "text", T0 + 100);
		expect(metrics.liveSample(T0 + 2000, CALIBRATION)).toBeUndefined(); // nothing anchored
		metrics.onDelta("x".repeat(8), "text", T0 + 300);
		const sample = metrics.liveSample(T0 + 560, CALIBRATION);
		expect(sample?.ttftMs).toBe(300); // anchored at the first non-empty delta
	});

	it("liveSample uses authoritative partial usage only for the rate numerator, never for O", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		metrics.onDelta("x", "text", T0 + 100);
		const sample = metrics.liveSample(T0 + 1100, CALIBRATION, 42);
		expect(sample?.estimatedTokens).toBe(42);
		expect(sample?.estimatedOutputTokens).toBeCloseTo(0.25, 5); // 1 char → 0.25 tokens
		expect(sample?.tps).toBeCloseTo(0.25, 5); // over the observed 1.0s
	});

	it("liveSample never counts mid-stream output usage as O while only thinking streamed", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		metrics.onDelta("思考", "thinking", T0 + 100); // 2 CJK chars → 2 tokens
		// Anthropic-style providers report usage.output cumulatively including
		// hidden thinking; O must stay at the char estimate (zero text deltas).
		const sample = metrics.liveSample(T0 + 1100, CALIBRATION, 438);
		expect(sample?.estimatedTokens).toBe(438); // rate numerator floors to usage
		expect(sample?.estimatedThinkingTokens).toBe(2);
		expect(sample?.estimatedOutputTokens).toBe(0);
	});

	it("reset clears everything including restored stats", () => {
		const metrics = new StreamMetrics();
		feedCompleteMessage(metrics);
		metrics.setInputEstimate(1234);
		metrics.reset();
		expect(metrics.stats).toBeUndefined();
		expect(metrics.liveSample(T0 + 9999)).toBeUndefined();
		expect(metrics.inputTokensEstimate).toBeNull();
	});

	it("liveSample reports streamed thinking and the request context estimate", () => {
		const metrics = new StreamMetrics();
		metrics.setInputEstimate(115_000);
		metrics.onMessageStart(T0);
		metrics.onDelta("思考", "thinking", T0 + 100); // 2 CJK chars → 2 tokens
		metrics.onDelta("hello ", "text", T0 + 600); // 6 chars → 1.5 tokens
		const sample = metrics.liveSample(T0 + 1100, CALIBRATION);
		expect(sample?.estimatedThinkingTokens).toBe(2);
		expect(sample?.inputTokens).toBe(115_000);
		expect(sample?.estimatedTokens).toBeCloseTo(3.5, 5); // thinking + text
		expect(sample?.estimatedOutputTokens).toBeCloseTo(1.5, 5); // text only: O excludes thinking
	});

	it("liveSample omits thinking and context when neither is known", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		metrics.onDelta("hello ", "text", T0 + 100);
		const sample = metrics.liveSample(T0 + 600, CALIBRATION);
		expect(sample?.estimatedThinkingTokens).toBeNull();
		expect(sample?.inputTokens).toBeNull();
	});

	it("onMessageEnd prefers the reported total input over the request estimate", () => {
		const metrics = new StreamMetrics();
		metrics.setInputEstimate(115_000);
		metrics.onMessageStart(T0);
		metrics.onDelta("hello ", "text", T0 + 100);
		const stats = metrics.onMessageEnd(
			{ output: 10, input: 500, cacheRead: 1000, cacheWrite: 200 },
			"prov",
			"model",
			T0 + 200,
			CALIBRATION,
		);
		// pi-ai reports uncached input separately from cache read/write; the
		// total prompt is their sum.
		expect(stats?.inputTokens).toBe(1700);
		expect(stats?.inputEstimated).toBe(false);
	});

	it("onMessageEnd falls back to the request estimate without reported input", () => {
		const metrics = new StreamMetrics();
		metrics.setInputEstimate(900);
		metrics.onMessageStart(T0);
		metrics.onDelta("思考", "thinking", T0 + 100);
		const estimated = metrics.onMessageEnd({ output: 10 }, "prov", "model", T0 + 200, CALIBRATION);
		expect(estimated?.inputTokens).toBe(900);
		expect(estimated?.inputEstimated).toBe(true);
		// Streamed thinking was recorded as an estimate; reasoning was not reported.
		expect(estimated?.reasoningTokens).toBe(0);
		expect(estimated?.thinkingEstimatedTokens).toBe(2);

		// Reported reasoning is the reliable count; reported zero input still
		// falls back to the request estimate.
		// falls back to the request estimate.
		const reliable = metrics.onMessageEnd(
			{ output: 10, reasoning: 7, cacheRead: 0, cacheWrite: 0 },
			"prov",
			"model",
			T0 + 300,
			CALIBRATION,
		);
		expect(reliable?.reasoningTokens).toBe(7);
		expect(reliable?.inputTokens).toBe(900);
		expect(reliable?.inputEstimated).toBe(true);

		// Without any request context and without reported input there is no data.
		const bare = new StreamMetrics();
		bare.onMessageStart(T0);
		bare.onDelta("x", "text", T0 + 100);
		const noCache = bare.onMessageEnd({ output: 3, cacheRead: 0, cacheWrite: 0 }, "prov", "model", T0 + 200);
		expect(noCache?.inputTokens).toBeUndefined();
		expect(noCache?.inputEstimated).toBeUndefined();
	});
});

describe("parseLastStats", () => {
	it("accepts valid persisted stats", () => {
		const metrics = new StreamMetrics();
		const stats = feedCompleteMessage(metrics);
		const parsed = parseLastStats(JSON.parse(JSON.stringify(stats)));
		expect(parsed).toEqual(stats);
	});

	it("repairs legacy entries with degenerate decode windows", () => {
		// Persisted by the old algorithm: full output (incl. hidden reasoning)
		// divided by a 39ms burst window.
		const parsed = parseLastStats({
			provider: "openai",
			model: "gpt-6.1-sol",
			ttftMs: 19475,
			decodeMs: 39,
			avgTps: 12897.4,
			outputTokens: 503,
			estimated: false,
			chars: { cjk: 0, nonCjk: 1872 },
			endedAt: 1,
		});
		expect(parsed?.avgTps).toBeNull();
		expect(parsed?.reasoningTokens).toBe(0); // absent in legacy entries
	});

	it("keeps healthy legacy values", () => {
		const parsed = parseLastStats({
			provider: "p",
			model: "m",
			ttftMs: 500,
			decodeMs: 3000,
			avgTps: 6.7,
			outputTokens: 20,
			reasoningTokens: 2,
			estimated: false,
			chars: { cjk: 0, nonCjk: 80 },
			endedAt: 1,
		});
		expect(parsed?.avgTps).toBe(6.7);
		expect(parsed?.reasoningTokens).toBe(2);
	});

	it("parses optional thinking and input fields and ignores garbage", () => {
		const base = {
			provider: "p",
			model: "m",
			ttftMs: 500,
			decodeMs: 2000,
			avgTps: 5,
			outputTokens: 10,
			reasoningTokens: 0,
			estimated: false,
			chars: { cjk: 0, nonCjk: 40 },
			endedAt: 1,
		};
		const parsed = parseLastStats({ ...base, thinkingEstimatedTokens: 30, inputTokens: 1200, inputEstimated: true });
		expect(parsed?.thinkingEstimatedTokens).toBe(30);
		expect(parsed?.inputTokens).toBe(1200);
		expect(parsed?.inputEstimated).toBe(true);
		const legacy = parseLastStats(base);
		expect(legacy?.thinkingEstimatedTokens).toBeUndefined();
		expect(legacy?.inputTokens).toBeUndefined();
		expect(legacy?.inputEstimated).toBeUndefined();
		const garbage = parseLastStats({ ...base, inputTokens: "many", thinkingEstimatedTokens: -5 });
		expect(garbage?.inputTokens).toBeUndefined();
		expect(garbage?.thinkingEstimatedTokens).toBeUndefined();
		// Entries from the brief "cacheTokens" naming still parse as input.
		const oldNaming = parseLastStats({ ...base, cacheTokens: 800, cacheEstimated: true });
		expect(oldNaming?.inputTokens).toBe(800);
		expect(oldNaming?.inputEstimated).toBe(true);
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
		metrics.onMessageStart(T0);
		metrics.onDelta("x", "text", T0 + 100);
		const stats = metrics.onMessageEnd({ output: 3 }, "prov", "model", T0 + 150);
		const parsed = parseLastStats(JSON.parse(JSON.stringify(stats)));
		expect(parsed?.decodeMs).toBe(0);
		expect(parsed?.ttftMs).toBe(100);
	});
});
