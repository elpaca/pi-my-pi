import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CalibrationCache,
	calibrationKey,
	MIN_SAMPLES,
} from "../../../../extensions/my-pi/features/token-speed/calibration.ts";
import { tokenSpeedFeature } from "../../../../extensions/my-pi/features/token-speed/index.ts";
import { SettingsStore } from "../../../../extensions/my-pi/settings.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => void;

const START = 1_000_000;

type TestTheme = { fg: (color: string, text: string) => string };

function makeHarness(theme?: TestTheme) {
	const handlers = new Map<string, Handler[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const statuses = new Map<string, string | undefined>();

	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ customType, data });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		mode: "tui",
		isIdle: () => true,
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				statuses.set(key, text);
			},
			theme: theme ?? { fg: (_color: string, text: string) => text },
			notify: () => {},
		},
		sessionManager: { getBranch: () => [] as unknown[] },
	} as unknown as ExtensionContext;

	const emit = (event: string, payload: unknown = { type: event }) => {
		for (const handler of handlers.get(event) ?? []) {
			handler(payload, ctx);
		}
	};

	return { pi, ctx, emit, entries, statuses };
}

const assistantMessage = (overrides: Record<string, unknown> = {}) => ({
	role: "assistant",
	provider: "prov",
	model: "model-x",
	...overrides,
});

describe("token-speed feature wiring", () => {
	let cacheDir: string;
	let settingsFile: string;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(START);
		cacheDir = mkdtempSync(join(tmpdir(), "pi-my-pi-feature-"));
		vi.stubEnv("PI_MY_PI_CACHE_DIR", cacheDir);
		settingsFile = join(mkdtempSync(join(tmpdir(), "pi-my-pi-feature-")), "my-pi.json");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	function registerFeature(settingsFileOverride?: string) {
		const settings = new SettingsStore({ file: settingsFileOverride ?? settingsFile });
		const harness = makeHarness();
		tokenSpeedFeature.register({ pi: harness.pi, settings });
		return { settings, ...harness };
	}

	it("renders live TPS while streaming and idle stats after the message", () => {
		const h = registerFeature();

		h.emit("before_provider_request");
		h.emit("message_start", { message: assistantMessage() });

		// First delta anchors the stream clock at "now"; advance before expecting a render.
		vi.setSystemTime(START + 100);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(10) },
		});
		vi.setSystemTime(START + 500);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
		});
		const live = h.statuses.get("my-pi");
		expect(live).toMatch(/^F\d+(\.\d+)?s O\d+ ~\d+(\.\d+)? TPS$/);

		// Token counters refresh on every delta even inside the 1s throttle;
		// only the rate figure itself stays frozen.
		vi.setSystemTime(START + 900);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "y".repeat(400) },
		});
		const updated = h.statuses.get("my-pi");
		expect(updated).not.toBe(live); // O grew
		const rate = (live?.match(/~\d+(\.\d+)? TPS$/) ?? [""])[0];
		expect(rate).not.toBe("");
		expect(updated).toContain(rate); // throttled rate unchanged

		// After 1s the value updates again.
		vi.setSystemTime(START + 1600);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "z".repeat(400) },
		});
		expect(h.statuses.get("my-pi")).not.toBe(live);

		// Message ends: idle stats with authoritative usage.
		vi.setSystemTime(START + 2000);
		h.emit("message_end", {
			message: assistantMessage({ usage: { output: 300 } }),
		});
		const idle = h.statuses.get("my-pi");
		expect(idle).toMatch(/^F\d+(\.\d+)s O\d+ \d+(\.\d+)?TPS$/);

		// Turn ends: stats persisted exactly once.
		h.emit("turn_end");
		expect(h.entries).toHaveLength(1);
		expect(h.entries[0]?.customType).toBe("my-pi.token-speed");
		h.emit("turn_end");
		expect(h.entries).toHaveLength(1);
	});

	it("counts thinking and toolcall deltas and records calibration", () => {
		const h = registerFeature();

		h.emit("before_provider_request");
		h.emit("message_start", { message: assistantMessage() });
		vi.setSystemTime(START + 1000);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "thinking_delta", delta: "思考" },
		});
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "toolcall_delta", delta: "{}" },
		});
		h.emit("message_end", { message: assistantMessage({ usage: { output: 50 } }) });

		// Calibration cache file was written for provider/model with the samples.
		const raw = JSON.parse(readFileSync(join(cacheDir, "token-ratio.json"), "utf8")) as {
			models: Record<string, { n: number }>;
		};
		expect(raw.models["prov/model-x"]?.n).toBe(1);
	});

	it("restores idle status from the session branch", () => {
		const h = registerFeature();
		const stats = {
			provider: "prov",
			model: "model-x",
			ttftMs: 800,
			decodeMs: 2000,
			avgTps: 33.3,
			outputTokens: 67,
			estimated: false,
			chars: { cjk: 10, nonCjk: 100 },
			endedAt: 123,
		};
		h.ctx.sessionManager.getBranch = () =>
			[{ type: "custom", customType: "my-pi.token-speed", data: stats }] as never[];

		h.emit("session_start", { type: "session_start", reason: "resume" });
		expect(h.statuses.get("my-pi")).toBe("F0.8s O67 33.3TPS");

		// No duplicate persistence for restored stats.
		h.emit("turn_end");
		expect(h.entries).toHaveLength(0);
	});

	it("clears the status when the feature is disabled and stays dark", () => {
		const h = registerFeature();
		h.settings.set("tokenSpeed.enabled", false);
		expect(h.statuses.get("my-pi")).toBeUndefined();

		h.emit("before_provider_request");
		h.emit("message_start", { message: assistantMessage() });
		vi.setSystemTime(START + 5000);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(1000) },
		});
		h.emit("message_end", { message: assistantMessage({ usage: { output: 10 } }) });
		h.emit("turn_end");
		expect(h.statuses.get("my-pi")).toBeUndefined();
		// Stats are still tracked for the session, just not shown.
		expect(h.entries).toHaveLength(0);
	});

	it("keeps idle stats but skips live TPS when showDuringStream is off", () => {
		const h = registerFeature();
		h.settings.set("tokenSpeed.showDuringStream", false);

		h.emit("before_provider_request");
		h.emit("message_start", { message: assistantMessage() });
		vi.setSystemTime(START + 2000);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(1000) },
		});
		expect(h.statuses.get("my-pi")).toBeUndefined();

		h.emit("message_end", { message: assistantMessage({ usage: { output: 50 } }) });
		expect(h.statuses.get("my-pi")).toMatch(/^F\d*\.\ds O\d+/);
	});

	it("shows a live elapsed counter while waiting for the first token", () => {
		const h = registerFeature();
		h.emit("before_provider_request");

		vi.advanceTimersByTime(300);
		expect(h.statuses.get("my-pi")).toBe("F0.3s");
		vi.advanceTimersByTime(700);
		expect(h.statuses.get("my-pi")).toBe("F1.0s");

		// The first delta stops the counter; the live TPS display takes over
		// and no further ticks happen (timer is gone).
		h.emit("message_start", { message: assistantMessage() });
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(10) },
		});
		vi.advanceTimersByTime(500);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(400) },
		});
		const live = h.statuses.get("my-pi");
		expect(live).toMatch(/^F\d+(\.\d+)?s O\d+ ~\d+(\.\d+)? TPS$/);
		vi.advanceTimersByTime(2000);
		expect(h.statuses.get("my-pi")).toBe(live);
	});

	it("stops the wait counter and shows N/A when the message ends without deltas", () => {
		const h = registerFeature();
		h.emit("before_provider_request");
		vi.advanceTimersByTime(500);
		expect(h.statuses.get("my-pi")).toBe("F0.5s");

		h.emit("message_start", { message: assistantMessage() });
		h.emit("message_end", { message: assistantMessage({ usage: { output: 10 } }) });
		// Nothing was streamable (no deltas → no ttft, no measurable speed).
		expect(h.statuses.get("my-pi")).toBe("O10 N/A");
		vi.advanceTimersByTime(500); // timer gone: no updates, no crash
		expect(h.statuses.get("my-pi")).toBe("O10 N/A");
	});

	it("does not show the wait counter when showDuringStream is off", () => {
		const h = registerFeature();
		h.settings.set("tokenSpeed.showDuringStream", false);
		h.emit("before_provider_request");
		vi.advanceTimersByTime(1000);
		expect(h.statuses.get("my-pi")).toBeUndefined();
	});

	it("stops the wait counter on session shutdown", () => {
		const h = registerFeature();
		h.emit("before_provider_request");
		vi.advanceTimersByTime(200);
		expect(h.statuses.get("my-pi")).toBe("F0.2s");
		h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(h.statuses.get("my-pi")).toBeUndefined();
		vi.advanceTimersByTime(500);
		expect(h.statuses.get("my-pi")).toBeUndefined();
	});

	it("clears the status on session shutdown", () => {
		const h = registerFeature();
		h.emit("before_provider_request");
		h.emit("message_start", { message: assistantMessage() });
		vi.setSystemTime(START + 100);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(10) },
		});
		vi.setSystemTime(START + 500);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(500) },
		});
		expect(h.statuses.get("my-pi")).toBeDefined();
		h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(h.statuses.get("my-pi")).toBeUndefined();
	});

	it("shows the estimated cache size during the wait and streaming phases", () => {
		const h = registerFeature();
		h.emit("before_provider_request", {
			type: "before_provider_request",
			payload: { model: "model-x", messages: [{ role: "user", content: "x.".repeat(1900) }] },
		});
		vi.advanceTimersByTime(100);
		expect(h.statuses.get("my-pi")).toBe("I1.4k F0.1s");

		h.emit("message_start", { message: assistantMessage() });
		vi.setSystemTime(START + 300);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(380) },
		});
		// First delta: counters live, rate still inside its minimum window.
		expect(h.statuses.get("my-pi")).toBe("I1.4k F0.3s O95");

		vi.setSystemTime(START + 600);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(380) },
		});
		// O: 760 chars / 4 = 190; rate: 190 tokens over the 0.3s of data so far.
		expect(h.statuses.get("my-pi")).toBe("I1.4k F0.3s O190 ~633 TPS");
	});

	it("updates thinking and output counts on every delta while the rate stays throttled", () => {
		const h = registerFeature();
		h.emit("before_provider_request");
		h.emit("message_start", { message: assistantMessage() });
		vi.setSystemTime(START + 100);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(38) },
		});
		expect(h.statuses.get("my-pi")).toBe("F0.1s T10");

		vi.setSystemTime(START + 300);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(380) },
		});
		expect(h.statuses.get("my-pi")).toBe("F0.1s T10 O95");

		vi.setSystemTime(START + 500);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(38) },
		});
		// T/O grew on every delta; the rate appeared as soon as it was measurable.
		// T: 76/4 = 19, O: 380/4 = 95; rate: 456/4 = 114 tokens over 0.4s.
		expect(h.statuses.get("my-pi")).toBe("F0.1s T19 O95 ~285 TPS");
	});

	it("shows reliable cache, thinking and output counts when the message ends", () => {
		const h = registerFeature();
		h.emit("before_provider_request");
		h.emit("message_start", { message: assistantMessage() });
		vi.setSystemTime(START + 100);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
		});
		vi.setSystemTime(START + 1200);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(380) },
		});
		h.emit("message_end", {
			message: assistantMessage({ usage: { output: 300, reasoning: 100, cacheRead: 1000, cacheWrite: 200 } }),
		});
		expect(h.statuses.get("my-pi")).toBe("I1.2k F0.1s T100 O200 182TPS");
	});

	it("never shows O while only thinking has streamed, even with mid-stream usage", () => {
		const h = registerFeature();
		h.emit("before_provider_request");
		h.emit("message_start", { message: assistantMessage() });
		// Providers like Anthropic report usage.output cumulatively including
		// hidden thinking while streaming; O must not follow T.
		vi.setSystemTime(START + 200);
		h.emit("message_update", {
			message: assistantMessage({ usage: { output: 100 } }),
			assistantMessageEvent: { type: "thinking_delta", delta: "思".repeat(130) },
		});
		expect(h.statuses.get("my-pi")).toBe("F0.2s T100");
		vi.setSystemTime(START + 400);
		h.emit("message_update", {
			message: assistantMessage({ usage: { output: 300 } }),
			assistantMessageEvent: { type: "thinking_delta", delta: "思".repeat(260) },
		});
		expect(h.statuses.get("my-pi")).toBe("F0.2s T300");
		// First non-thinking delta: O appears from the streamed chars.
		vi.setSystemTime(START + 1200);
		h.emit("message_update", {
			message: assistantMessage({ usage: { output: 350 } }),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(10) },
		});
		expect(h.statuses.get("my-pi")).toBe("F0.2s T300 O3 ~303 TPS");
	});

	it("estimates the first request with the learned shared calibration", () => {
		// Seed the shared calibration so the punct ratio is clearly distinct
		// from the default (2.2): tokens = Σ bucket / ratio, exactly.
		const writer = new CalibrationCache({ dir: cacheDir });
		const key = calibrationKey("prov", "model-x");
		for (let i = 0; i < MIN_SAMPLES + 5; i++) {
			const counts = {
				cjk: 5 + (i % 30),
				word: 100 + ((i * 37) % 900),
				digit: 3 + (i % 7),
				punct: 10 + ((i * 11) % 40),
				space: 8 + (i % 15),
			};
			const tokens =
				counts.cjk / 1.2 + counts.word / 4.0 + counts.digit / 2.5 + counts.punct / 6.0 + counts.space / 5.0;
			writer.record(key, counts, tokens);
		}

		const h = registerFeature();
		(h.ctx as { model?: unknown }).model = { provider: "prov", id: "model-x" };
		h.emit("before_provider_request", {
			type: "before_provider_request",
			payload: { model: "model-x", messages: [{ role: "user", content: "x.".repeat(1900) }] },
		});
		vi.advanceTimersByTime(100);
		// Payload counts: 1934 word chars + 1928 punct chars (keys + JSON syntax
		// included) → 1934/4.0 + 1928/6.0 ≈ 805, not the default ≈ 1360.
		expect(h.statuses.get("my-pi")).toBe("I805 F0.1s");
	});

	it("rebases the input estimate on the authoritative prompt total and records Δ samples", () => {
		const h = registerFeature();
		// Request 1: no anchor yet → full-payload estimate on defaults.
		h.emit("before_provider_request", {
			type: "before_provider_request",
			payload: { model: "model-x", messages: [{ role: "user", content: "hi" }] },
		});
		h.emit("message_start", { message: assistantMessage() });
		vi.setSystemTime(START + 100);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x" },
		});
		h.emit("message_end", {
			message: assistantMessage({ usage: { output: 10, input: 400, cacheRead: 600 } }),
		});

		// Request 2: grows the payload by a second message with 3800 chars.
		h.emit("before_provider_request", {
			type: "before_provider_request",
			payload: {
				model: "model-x",
				messages: [
					{ role: "user", content: "hi" },
					{ role: "user", content: "x.".repeat(1900) },
				],
			},
		});
		vi.advanceTimersByTime(100);
		// Rebased: 1000 (authoritative) + Δ: 1915 word/4.0 + 1911 punct/2.2 ≈
		// 1000 + 478.75 + 868.64 = 2347.
		expect(h.statuses.get("my-pi")).toBe("I2.3k F0.1s");
		h.emit("message_start", { message: assistantMessage() });
		vi.setSystemTime(START + 200);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x" },
		});
		h.emit("message_end", {
			message: assistantMessage({ usage: { output: 10, input: 1400, cacheRead: 600 } }),
		});

		// The Δ pair (second message's chars vs +1000 tokens) trains the shared
		// calibration; the first authoritative request only anchors. The two
		// visible-output samples (1 streamed "x" each) land in the same pool.
		const reader = new CalibrationCache({ dir: cacheDir });
		reader.load();
		const stats = reader.stats(calibrationKey("prov", "model-x"));
		expect(stats?.n).toBe(3);
		expect(stats?.sums[1]).toBe(1917); // word: Δ 1915 + 2 streamed chars
		expect(stats?.sums[3]).toBe(1914); // punct: Δ JSON syntax + 1900 dots
		expect(stats?.sumTokens).toBe(1020); // Δ +1000, outputs +10 each
	});

	it("shows the previous message's average speed while waiting for the first token", () => {
		const h = registerFeature();
		h.emit("before_provider_request");
		h.emit("message_start", { message: assistantMessage() });
		vi.setSystemTime(START + 100);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
		});
		vi.setSystemTime(START + 1200);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(380) },
		});
		h.emit("message_end", {
			message: assistantMessage({ usage: { output: 300, reasoning: 100, cacheRead: 1000, cacheWrite: 200 } }),
		});

		// Next request: the wait phase references the measured average.
		h.emit("before_provider_request", {
			type: "before_provider_request",
			payload: { model: "model-x", messages: [{ role: "user", content: "x.".repeat(1900) }] },
		});
		vi.advanceTimersByTime(100);
		expect(h.statuses.get("my-pi")).toBe("I1.4k F0.1s ~182 TPS");
	});

	it("highlights live parts and dims static parts", () => {
		const settings = new SettingsStore({ file: settingsFile });
		const harness = makeHarness({ fg: (color, text) => `<${color}>${text}</${color}>` });
		tokenSpeedFeature.register({ pi: harness.pi, settings });
		const { emit, statuses } = harness;

		emit("before_provider_request", {
			type: "before_provider_request",
			payload: { messages: [{ content: "x.".repeat(1900) }] },
		});
		vi.advanceTimersByTime(100);
		expect(statuses.get("my-pi")).toBe("<dim>I1.3k</dim> <accent>F0.1s</accent>");

		emit("message_start", { message: assistantMessage() });
		vi.setSystemTime(START + 100);
		emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(380) },
		});
		vi.setSystemTime(START + 400);
		emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "x".repeat(380) },
		});
		expect(statuses.get("my-pi")).toBe(
			"<dim>I1.3k</dim> <dim>F0.1s</dim> <accent>O190</accent> <accent>~633 TPS</accent>",
		);
	});

	it("ignores non-assistant messages", () => {
		const h = registerFeature();
		h.emit("message_start", { message: { role: "user" } });
		h.emit("message_update", {
			message: { role: "user" },
			assistantMessageEvent: { type: "text_delta", delta: "x" },
		});
		h.emit("message_end", { message: { role: "user" } });
		h.emit("turn_end");
		expect(h.statuses.get("my-pi")).toBeUndefined();
		expect(h.entries).toHaveLength(0);
	});
});
