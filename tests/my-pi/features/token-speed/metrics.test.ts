import { describe, expect, it } from "vitest";
import type { Calibration } from "../../../../extensions/my-pi/features/token-speed/estimator.ts";
import { parseLastStats, StreamMetrics } from "../../../../extensions/my-pi/features/token-speed/metrics.ts";

const CALIBRATION = { cjk: 1.0, word: 4.0, digit: 4.0, punct: 4.0, space: 4.0 } as const satisfies Calibration;
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
		metrics.onDelta("hello ", "text_delta", T0 + at);
	}
	return metrics.onMessageEnd(options?.usage ?? { output: 20 }, "prov", "model", T0 + 5000, CALIBRATION);
}

describe("StreamMetrics", () => {
	it("measures a complete message: ttft, decode window, hidden-reasoning split, average speed", () => {
		const metrics = new StreamMetrics();
		const stats = feedCompleteMessage(metrics, { usage: { output: 20, reasoning: 4 } });
		expect(stats).toBeDefined();
		expect(stats?.ttftMs).toBe(500); // first delta − request start
		expect(stats?.decodeMs).toBe(3000); // last delta − first delta
		expect(stats?.outputTokens).toBe(20);
		expect(stats?.reasoningTokens).toBe(4);
		// Hidden reasoning is excluded from the decode-speed numerator.
		expect(stats?.avgTps).toBeCloseTo(16 / 3, 5);
		expect(stats?.estimated).toBe(false);
		expect(stats?.chars).toEqual({ cjk: 0, word: 20, digit: 0, punct: 0, space: 4 }); // 4 deltas × "hello "
		expect(metrics.stats).toBe(stats);

		// Without reported reasoning the whole output counts as visible.
		const plain = feedCompleteMessage(new StreamMetrics(), { usage: { output: 20 } });
		expect(plain?.reasoningTokens).toBe(0);
		expect(plain?.avgTps).toBeCloseTo(20 / 3, 5);

		// reset() drops everything, including restored stats and the request context.
		metrics.setInputEstimate(1234);
		metrics.reset();
		expect(metrics.stats).toBeUndefined();
		expect(metrics.liveSample(T0 + 9999)).toBeUndefined();
		expect(metrics.inputTokensEstimate).toBeNull();
	});

	it("falls back to the message start when the request anchor is missing or stale", () => {
		const noAnchor = new StreamMetrics();
		noAnchor.onMessageStart(T0 + 1000);
		noAnchor.onDelta("hi", "text_delta", T0 + 1500);
		expect(noAnchor.onMessageEnd({ output: 4 }, "prov", "model", T0 + 1600)?.ttftMs).toBe(500);

		// An anchor more than 60s before the message start is a leftover from an
		// aborted request: ignored.
		const stale = new StreamMetrics();
		stale.onRequestStart(T0);
		stale.onMessageStart(T0 + 120_000);
		stale.onDelta("hi", "text_delta", T0 + 120_500);
		expect(stale.onMessageEnd({ output: 4 }, "prov", "model", T0 + 120_600)?.ttftMs).toBe(500);
	});

	it("prefers authoritative usage, estimates without it, and skips contentless messages", () => {
		// Authoritative output wins over the char estimate.
		const authoritative = new StreamMetrics();
		authoritative.onMessageStart(T0);
		authoritative.onDelta("你好世界", "text_delta", T0 + 100); // 4 CJK chars → 4 tokens at 1.0 chars/token
		const stats = authoritative.onMessageEnd({ output: 99, reasoning: 3 }, "prov", "model", T0 + 200, CALIBRATION);
		expect(stats?.outputTokens).toBe(99);
		expect(stats?.reasoningTokens).toBe(3);
		expect(stats?.estimated).toBe(false);

		// No usage at all: char-based estimate.
		const estimated = new StreamMetrics();
		estimated.onMessageStart(T0);
		estimated.onDelta("hello", "text_delta", T0 + 100);
		const fallback = estimated.onMessageEnd(undefined, "prov", "model", T0 + 200, CALIBRATION);
		expect(fallback?.outputTokens).toBe(1); // 5/4 rounded
		expect(fallback?.reasoningTokens).toBe(0);
		expect(fallback?.estimated).toBe(true);

		// Nothing streamed and nothing reported: no stats.
		const empty = new StreamMetrics();
		empty.onMessageStart(T0);
		expect(empty.onMessageEnd({ output: 0 }, "prov", "model", T0 + 100)).toBeUndefined();
		expect(empty.onMessageEnd(undefined, "prov", "model", T0 + 100)).toBeUndefined();
	});

	it("a burst that flushes the whole message cannot support a rate", () => {
		// Real-world pathology: provider generates server-side for ~19.5s, then
		// delivers everything within 39ms. The decode window cannot support a rate.
		const metrics = new StreamMetrics();
		metrics.onRequestStart(T0);
		metrics.onMessageStart(T0 + 100);
		metrics.onDelta("x".repeat(1872), "text_delta", T0 + 19475);
		metrics.onDelta(".", "text_delta", T0 + 19514); // last tail chunk
		const stats = metrics.onMessageEnd({ output: 503 }, "prov", "model", T0 + 19530);
		expect(stats?.ttftMs).toBe(19475);
		expect(stats?.decodeMs).toBe(39);
		expect(stats?.avgTps).toBeNull(); // not 12897
	});

	it("the live rate needs a minimum window; counters are valid from the first delta", () => {
		const metrics = new StreamMetrics();
		metrics.onMessageStart(T0);
		expect(metrics.liveSample(T0 + 1000)).toBeUndefined(); // no delta yet

		metrics.onDelta("x", "text_delta", T0 + 500);
		const young = metrics.liveSample(T0 + 600);
		expect(young?.tps).toBeNull(); // < 250ms since first delta: no rate yet
		expect(young?.estimatedTokens).toBeCloseTo(1 / 4, 5); // cumulative estimate still valid

		metrics.onDelta("x".repeat(32), "text_delta", T0 + 600); // 33 chars total → ~8 tokens
		const sample = metrics.liveSample(T0 + 1500, CALIBRATION);
		expect(sample?.elapsedMs).toBe(1000);
		expect(sample?.ttftMs).toBe(500); // first delta − message start anchor
		expect(sample?.estimatedTokens).toBeCloseTo(33 / 4, 5);
		// Actual-span denominator while the window is not full: 8.25 tokens over
		// 1.0s of data → the true average immediately, no warm-up ramp.
		expect(sample?.tps).toBeCloseTo(8.25, 5);
	});

	it("the live rate is exact during warm-up, once the window is full, and after an early burst", () => {
		// Warm-up: the denominator is the actual span of window data, so a steady
		// stream shows its true rate from the first sample (no warm-up ramp).
		const warmup = new StreamMetrics();
		warmup.onMessageStart(T0);
		for (let i = 0; i < 3; i++) {
			warmup.onDelta("hello ", "text_delta", T0 + i * 500); // 12 chars/s = 3 tokens/s
		}
		expect(warmup.liveSample(T0 + 1500, CALIBRATION)?.tps).toBe(3); // 4.5 tokens / 1.5s

		// Full window: covers the last 3s exactly — 6 deltas × 6 chars = 9 tokens.
		const full = new StreamMetrics();
		full.onMessageStart(T0);
		for (let i = 0; i <= 10; i++) {
			full.onDelta("hello ", "text_delta", T0 + i * 500);
		}
		expect(full.liveSample(T0 + 5000, CALIBRATION)?.tps).toBe(3);

		// An early burst reports over its own observed span, not a diluted window.
		const burst = new StreamMetrics();
		burst.onRequestStart(T0);
		burst.onMessageStart(T0);
		burst.onDelta("x".repeat(1872), "text_delta", T0 + 19475); // everything at once after 19.5s
		const sample = burst.liveSample(T0 + 19775, CALIBRATION);
		expect(sample?.ttftMs).toBe(19475);
		expect(sample?.tps).toBe(1560); // 468 tokens over the observed 0.3s span
	});

	it("delivery gaps: fresh segment after a full-window stall, window kept across small gaps", () => {
		// A stall of one full window (hidden reasoning, buffering relay)
		// invalidates the running window: measurement restarts at the resume.
		const stalled = new StreamMetrics();
		stalled.onMessageStart(T0);
		stalled.onDelta("x".repeat(380), "text_delta", T0 + 1000); // 100 tokens, then a 9s stall
		stalled.onDelta("xx", "text_delta", T0 + 10000); // trickle resumes
		const afterStall = stalled.liveSample(T0 + 10250, CALIBRATION);
		// Segment restarted at the first post-gap delta: 0.5 tokens over 0.25s.
		// Without the reset the 3s denominator would span the stall → ~0.17 TPS.
		expect(afterStall?.elapsedMs).toBe(250);
		expect(afterStall?.tps).toBe(2);

		// A gap smaller than the window span keeps the running window.
		const smallGap = new StreamMetrics();
		smallGap.onMessageStart(T0);
		smallGap.onDelta("x".repeat(380), "text_delta", T0 + 1000); // 100 tokens
		smallGap.onDelta("xx", "text_delta", T0 + 3000); // 2s gap (< 3s window): no segment reset
		const kept = smallGap.liveSample(T0 + 3250, CALIBRATION);
		expect(kept?.elapsedMs).toBe(2250);
		expect(kept?.tps).toBeCloseTo(95.5 / 2.25, 5); // 380 chars + "xx" over the 2.25s span

		// Empty deltas are degenerate events: no timing anchor, no counts.
		const emptyDeltas = new StreamMetrics();
		emptyDeltas.onMessageStart(T0);
		emptyDeltas.onDelta("", "text_delta", T0 + 100);
		expect(emptyDeltas.liveSample(T0 + 2000, CALIBRATION)).toBeUndefined(); // nothing anchored
		emptyDeltas.onDelta("x".repeat(8), "text_delta", T0 + 300);
		expect(emptyDeltas.liveSample(T0 + 560, CALIBRATION)?.ttftMs).toBe(300); // anchored at the first non-empty delta
	});

	it("live counters: channels split T/O, the usage floor never leaks into O", () => {
		// Authoritative partial usage floors only the rate numerator; the O slot
		// stays a pure non-thinking char estimate.
		const floored = new StreamMetrics();
		floored.onMessageStart(T0);
		floored.onDelta("x", "text_delta", T0 + 100);
		const floorSample = floored.liveSample(T0 + 1100, CALIBRATION, 42);
		expect(floorSample?.estimatedTokens).toBe(42);
		expect(floorSample?.estimatedOutputTokens).toBeCloseTo(0.25, 5); // 1 char → 0.25 tokens
		expect(floorSample?.tps).toBeCloseTo(0.25, 5); // over the observed 1.0s

		// Providers like Anthropic report usage.output cumulatively including
		// hidden thinking; while only thinking streamed, O must stay at the
		// char estimate (zero text deltas) — never follow usage.
		const thinkingOnly = new StreamMetrics();
		thinkingOnly.onMessageStart(T0);
		thinkingOnly.onDelta("思考", "thinking_delta", T0 + 100); // 2 CJK chars → 2 tokens
		const thinkingSample = thinkingOnly.liveSample(T0 + 1100, CALIBRATION, 438);
		expect(thinkingSample?.estimatedTokens).toBe(438); // rate numerator floors to usage
		expect(thinkingSample?.estimatedThinkingTokens).toBe(2);
		expect(thinkingSample?.estimatedOutputTokens).toBe(0);

		// Streamed thinking and the request context estimate appear when known.
		const withContext = new StreamMetrics();
		withContext.setInputEstimate(115_000);
		withContext.onMessageStart(T0);
		withContext.onDelta("思考", "thinking_delta", T0 + 100);
		withContext.onDelta("hello ", "text_delta", T0 + 600); // 6 chars → 1.5 tokens
		const contextSample = withContext.liveSample(T0 + 1100, CALIBRATION);
		expect(contextSample?.estimatedThinkingTokens).toBe(2);
		expect(contextSample?.inputTokens).toBe(115_000);
		expect(contextSample?.estimatedTokens).toBeCloseTo(3.5, 5); // thinking + text
		expect(contextSample?.estimatedOutputTokens).toBeCloseTo(1.5, 5); // text only: O excludes thinking

		// …and are omitted when neither is known.
		const bare = new StreamMetrics();
		bare.onMessageStart(T0);
		bare.onDelta("hello ", "text_delta", T0 + 100);
		const bareSample = bare.liveSample(T0 + 600, CALIBRATION);
		expect(bareSample?.estimatedThinkingTokens).toBeNull();
		expect(bareSample?.inputTokens).toBeNull();
	});

	it("message-end input: reported prompt total wins, else the request estimate, else nothing", () => {
		// pi-ai reports uncached input separately from cache read/write; the
		// total prompt the model saw is their sum.
		const reported = new StreamMetrics();
		reported.setInputEstimate(115_000);
		reported.onMessageStart(T0);
		reported.onDelta("hello ", "text_delta", T0 + 100);
		const authoritative = reported.onMessageEnd(
			{ output: 10, input: 500, cacheRead: 1000, cacheWrite: 200 },
			"prov",
			"model",
			T0 + 200,
			CALIBRATION,
		);
		expect(authoritative?.inputTokens).toBe(1700);
		expect(authoritative?.inputEstimated).toBe(false);

		// No reported input: fall back to the request-time estimate; streamed
		// thinking is recorded as the (only available) estimate.
		const fallback = new StreamMetrics();
		fallback.setInputEstimate(900);
		fallback.onMessageStart(T0);
		fallback.onDelta("思考", "thinking_delta", T0 + 100);
		const estimated = fallback.onMessageEnd({ output: 10 }, "prov", "model", T0 + 200, CALIBRATION);
		expect(estimated?.inputTokens).toBe(900);
		expect(estimated?.inputEstimated).toBe(true);
		expect(estimated?.reasoningTokens).toBe(0);
		expect(estimated?.thinkingEstimatedTokens).toBe(2);

		// Reported zero input still falls back; reported reasoning is reliable.
		const zeroInput = fallback.onMessageEnd(
			{ output: 10, reasoning: 7, cacheRead: 0, cacheWrite: 0 },
			"prov",
			"model",
			T0 + 300,
			CALIBRATION,
		);
		expect(zeroInput?.reasoningTokens).toBe(7);
		expect(zeroInput?.inputTokens).toBe(900);
		expect(zeroInput?.inputEstimated).toBe(true);

		// Without any request context and without reported input there is no data.
		const bare = new StreamMetrics();
		bare.onMessageStart(T0);
		bare.onDelta("x", "text_delta", T0 + 100);
		const noData = bare.onMessageEnd({ output: 3, cacheRead: 0, cacheWrite: 0 }, "prov", "model", T0 + 200);
		expect(noData?.inputTokens).toBeUndefined();
		expect(noData?.inputEstimated).toBeUndefined();
	});
});

describe("parseLastStats", () => {
	const legacyBase = {
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

	it("accepts persisted stats, repairs legacy degenerate windows, and keeps optional fields", () => {
		// Round-trip of a freshly persisted entry.
		const stats = feedCompleteMessage(new StreamMetrics());
		expect(parseLastStats(JSON.parse(JSON.stringify(stats)))).toEqual(stats);

		// Entries persisted before hidden-reasoning handling divided the full
		// output by a possibly degenerate decode window; repair those locally.
		const degenerate = parseLastStats({
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
		expect(degenerate?.avgTps).toBeNull();
		expect(degenerate?.reasoningTokens).toBe(0); // absent in legacy entries

		// Healthy legacy values survive as-is.
		const healthy = parseLastStats({ ...legacyBase, decodeMs: 3000, avgTps: 6.7, reasoningTokens: 2 });
		expect(healthy?.avgTps).toBe(6.7);
		expect(healthy?.reasoningTokens).toBe(2);

		// Optional fields parse when present and stay absent in legacy entries;
		// the brief "cacheTokens" naming still parses as input.
		const withOptional = parseLastStats({
			...legacyBase,
			thinkingEstimatedTokens: 30,
			inputTokens: 1200,
			inputEstimated: true,
		});
		expect(withOptional?.thinkingEstimatedTokens).toBe(30);
		expect(withOptional?.inputTokens).toBe(1200);
		expect(withOptional?.inputEstimated).toBe(true);
		const legacy = parseLastStats(legacyBase);
		expect(legacy?.thinkingEstimatedTokens).toBeUndefined();
		expect(legacy?.inputTokens).toBeUndefined();
		expect(legacy?.inputEstimated).toBeUndefined();
		const oldNaming = parseLastStats({ ...legacyBase, cacheTokens: 800, cacheEstimated: true });
		expect(oldNaming?.inputTokens).toBe(800);
		expect(oldNaming?.inputEstimated).toBe(true);

		// Null fields round-trip.
		const short = new StreamMetrics();
		short.onMessageStart(T0);
		short.onDelta("x", "text_delta", T0 + 100);
		const parsed = parseLastStats(
			JSON.parse(JSON.stringify(short.onMessageEnd({ output: 3 }, "prov", "model", T0 + 150))),
		);
		expect(parsed?.decodeMs).toBe(0);
		expect(parsed?.ttftMs).toBe(100);
	});

	it("rejects malformed payloads and out-of-range optional fields", () => {
		expect(parseLastStats(undefined)).toBeUndefined();
		expect(parseLastStats(null)).toBeUndefined();
		expect(parseLastStats("nope")).toBeUndefined();
		expect(parseLastStats({})).toBeUndefined();
		expect(parseLastStats({ provider: "p", model: "m" })).toBeUndefined();
		expect(
			parseLastStats({
				...legacyBase,
				ttftMs: null,
				decodeMs: null,
				avgTps: null,
				outputTokens: "10",
			}),
		).toBeUndefined();
		expect(parseLastStats({ ...legacyBase, chars: { cjk: "0", nonCjk: 0 } })).toBeUndefined();

		// Garbage optional values are dropped, but the entry still parses.
		const garbage = parseLastStats({ ...legacyBase, inputTokens: "many", thinkingEstimatedTokens: -5 });
		expect(garbage?.inputTokens).toBeUndefined();
		expect(garbage?.thinkingEstimatedTokens).toBeUndefined();
		expect(garbage?.outputTokens).toBe(10);
	});
});
