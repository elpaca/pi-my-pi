import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "./settings.ts";
import type { SettingSchema } from "./types.ts";

describe("SettingsStore", () => {
	let dir: string;
	let file: string;

	const booleanSchema: SettingSchema = {
		key: "tokenSpeed.enabled",
		label: "Token speed",
		type: "boolean",
		default: true,
	};

	const enumSchema: SettingSchema = {
		key: "tokenSpeed.style",
		label: "Style",
		type: "enum",
		values: ["compact", "detailed"],
		default: "compact",
	};

	const numberSchema: SettingSchema = {
		key: "tokenSpeed.refreshMs",
		label: "Refresh",
		type: "number",
		default: 1000,
	};

	const stringSchema: SettingSchema = {
		key: "tokenSpeed.label",
		label: "Label",
		type: "string",
		default: "TPS",
	};

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-my-pi-test-"));
		file = join(dir, "my-pi.json");
	});

	function createStore(): SettingsStore {
		const store = new SettingsStore({ file });
		store.register(booleanSchema);
		store.register(enumSchema);
		store.register(numberSchema);
		store.register(stringSchema);
		return store;
	}

	it("returns schema defaults when no file exists", () => {
		const store = createStore();
		expect(store.get("tokenSpeed.enabled")).toBe(true);
		expect(store.get("tokenSpeed.style")).toBe("compact");
		expect(store.get("tokenSpeed.refreshMs")).toBe(1000);
		expect(store.get("tokenSpeed.label")).toBe("TPS");
		expect(store.all()).toEqual({
			"tokenSpeed.enabled": true,
			"tokenSpeed.style": "compact",
			"tokenSpeed.refreshMs": 1000,
			"tokenSpeed.label": "TPS",
		});
	});

	it("persists set values and reloads them", () => {
		const first = createStore();
		first.set("tokenSpeed.enabled", false);
		first.set("tokenSpeed.refreshMs", 250);

		expect(readFileSync(file, "utf8")).toContain("tokenSpeed.enabled");

		const second = new SettingsStore({ file });
		second.register(booleanSchema);
		second.register(numberSchema);
		expect(second.get("tokenSpeed.enabled")).toBe(false);
		expect(second.get("tokenSpeed.refreshMs")).toBe(250);
	});

	it("user override wins over default, and defaults fill gaps", () => {
		writeFileSync(file, JSON.stringify({ version: 1, settings: { "tokenSpeed.enabled": false } }), "utf8");
		const store = createStore();
		expect(store.get("tokenSpeed.enabled")).toBe(false);
		expect(store.get("tokenSpeed.style")).toBe("compact");
	});

	it("ignores corrupt or incompatible files", () => {
		writeFileSync(file, "{not json", "utf8");
		expect(() => createStore()).not.toThrow();

		writeFileSync(file, JSON.stringify({ version: 99, settings: {} }), "utf8");
		const store = createStore();
		expect(store.get("tokenSpeed.enabled")).toBe(true);
	});

	it("drops values of the wrong type from file", () => {
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				settings: { "tokenSpeed.enabled": "yes", "tokenSpeed.label": 42, "tokenSpeed.label2": "ok" },
			}),
			"utf8",
		);
		const store = createStore();
		expect(store.get("tokenSpeed.enabled")).toBe(true);
		expect(store.get("tokenSpeed.label")).toBe("TPS");
	});

	it("notifies listeners on change and supports unsubscribe", () => {
		const store = createStore();
		const listener = vi.fn();
		const unsubscribe = store.onChange(listener);

		store.set("tokenSpeed.enabled", false);
		expect(listener).toHaveBeenCalledWith("tokenSpeed.enabled", false);

		listener.mockClear();
		unsubscribe();
		store.set("tokenSpeed.enabled", true);
		expect(listener).not.toHaveBeenCalled();
	});

	it("rejects invalid values", () => {
		const store = createStore();
		expect(() => store.set("tokenSpeed.enabled", "yes")).toThrow(/expects a boolean/);
		expect(() => store.set("tokenSpeed.style", "fancy")).toThrow(/one of/);
		expect(() => store.set("tokenSpeed.refreshMs", "fast")).toThrow(/finite number/);
		expect(() => store.set("tokenSpeed.label", 42)).toThrow(/expects a string/);
		expect(() => store.set("unknown.key", true)).toThrow(/Unknown setting/);
		// Values remain unchanged after rejected writes.
		expect(store.get("tokenSpeed.enabled")).toBe(true);
	});

	it("rejects duplicate registration and enum without values", () => {
		const store = createStore();
		expect(() => store.register(booleanSchema)).toThrow(/already registered/);
		expect(() => store.register({ key: "x.y", label: "X", type: "enum", default: "a" })).toThrow(/requires values/);
	});

	it("coerces CLI strings per schema type", () => {
		const store = createStore();
		expect(store.coerce("tokenSpeed.enabled", "on")).toBe(true);
		expect(store.coerce("tokenSpeed.enabled", "false")).toBe(false);
		expect(store.coerce("tokenSpeed.enabled", "1")).toBe(true);
		expect(store.coerce("tokenSpeed.refreshMs", " 250 ")).toBe(250);
		expect(store.coerce("tokenSpeed.style", "detailed")).toBe("detailed");
		expect(store.coerce("tokenSpeed.label", "hello world")).toBe("hello world");
		expect(() => store.coerce("tokenSpeed.enabled", "maybe")).toThrow(/Invalid boolean/);
		expect(() => store.coerce("tokenSpeed.refreshMs", "abc")).toThrow(/Invalid number/);
		expect(() => store.coerce("tokenSpeed.style", "fancy")).toThrow(/Invalid value/);
	});

	it("preserves unknown keys from the file when persisting", () => {
		writeFileSync(
			file,
			JSON.stringify({ version: 1, settings: { "futureFeature.key": "keep-me", "tokenSpeed.enabled": false } }),
			"utf8",
		);
		const store = createStore();
		store.set("tokenSpeed.style", "detailed");

		const raw = JSON.parse(readFileSync(file, "utf8")) as { settings: Record<string, unknown> };
		expect(raw.settings["futureFeature.key"]).toBe("keep-me");
		expect(raw.settings["tokenSpeed.style"]).toBe("detailed");
		expect(store.userValue("futureFeature.key")).toBe("keep-me");
	});

	it("displayValue formats booleans as on/off", () => {
		const store = createStore();
		expect(store.displayValue("tokenSpeed.enabled")).toBe("on");
		store.set("tokenSpeed.enabled", false);
		expect(store.displayValue("tokenSpeed.enabled")).toBe("off");
		expect(store.displayValue("tokenSpeed.refreshMs")).toBe("1000");
	});
});
