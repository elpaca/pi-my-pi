import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../settings.ts";
import { tokenSpeedFeature } from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => void;

const START = 1_000_000;

function makeHarness() {
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
			theme: { fg: (_color: string, text: string) => text },
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
		expect(live).toMatch(/^~\d+ TPS$/);

		// A second render within 1s must not overwrite (throttled).
		vi.setSystemTime(START + 900);
		h.emit("message_update", {
			message: assistantMessage(),
			assistantMessageEvent: { type: "text_delta", delta: "y".repeat(400) },
		});
		expect(h.statuses.get("my-pi")).toBe(live);

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
		expect(idle).toMatch(/^⇢\d+(\.\d+)s\/\d+(\.\d+)?TPS$/);

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
		expect(h.statuses.get("my-pi")).toBe("⇢0.8s/33.3TPS");

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
		expect(h.statuses.get("my-pi")).toMatch(/^⇢/);
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
