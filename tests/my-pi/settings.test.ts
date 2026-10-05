import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../extensions/my-pi/settings.ts";
import type { SettingSchema } from "../../extensions/my-pi/types.ts";

describe("SettingsStore", () => {
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
	const numberSchema: SettingSchema = { key: "tokenSpeed.refreshMs", label: "Refresh", type: "number", default: 1000 };
	const stringSchema: SettingSchema = { key: "tokenSpeed.label", label: "Label", type: "string", default: "TPS" };

	beforeEach(() => {
		file = join(mkdtempSync(join(tmpdir(), "pi-my-pi-test-")), "my-pi.json");
	});

	function createStore(): SettingsStore {
		const store = new SettingsStore({ file });
		store.register(booleanSchema);
		store.register(enumSchema);
		store.register(numberSchema);
		store.register(stringSchema);
		return store;
	}

	it("loads defaults, persists changes and keeps unknown keys for forward compatibility", () => {
		// No file: schema defaults everywhere.
		const store = createStore();
		expect(store.all()).toEqual({
			"tokenSpeed.enabled": true,
			"tokenSpeed.style": "compact",
			"tokenSpeed.refreshMs": 1000,
			"tokenSpeed.label": "TPS",
		});

		// Changes are persisted and survive a reload; unknown keys written by
		// other (future or foreign) versions are preserved.
		writeFileSync(
			file,
			JSON.stringify({ version: 1, settings: { "futureFeature.key": "keep-me", "tokenSpeed.enabled": false } }),
			"utf8",
		);
		const next = createStore();
		expect(next.get("tokenSpeed.enabled")).toBe(false); // user override wins
		expect(next.get("tokenSpeed.style")).toBe("compact"); // defaults fill gaps
		next.set("tokenSpeed.style", "detailed");

		const raw = JSON.parse(readFileSync(file, "utf8")) as { settings: Record<string, unknown> };
		expect(raw.settings["futureFeature.key"]).toBe("keep-me");
		expect(raw.settings["tokenSpeed.style"]).toBe("detailed");
		expect(next.userValue("futureFeature.key")).toBe("keep-me");
	});

	it("tolerates corrupt or incompatible files and drops wrong-typed persisted values", () => {
		writeFileSync(file, "{not json", "utf8");
		expect(() => createStore()).not.toThrow();

		// Wrong file version: ignored entirely.
		writeFileSync(file, JSON.stringify({ version: 99, settings: { "tokenSpeed.enabled": false } }), "utf8");
		const store = createStore();
		expect(store.get("tokenSpeed.enabled")).toBe(true);

		// Values that no longer match the schema type fall back to defaults.
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				settings: { "tokenSpeed.enabled": "yes", "tokenSpeed.label": 42, "unknown.key": "ok" },
			}),
			"utf8",
		);
		const filtered = createStore();
		expect(filtered.get("tokenSpeed.enabled")).toBe(true);
		expect(filtered.get("tokenSpeed.label")).toBe("TPS");
	});

	it("validates writes and coerces CLI strings per schema type", () => {
		const store = createStore();
		expect(() => store.set("tokenSpeed.enabled", "yes")).toThrow(/expects a boolean/);
		expect(() => store.set("tokenSpeed.style", "fancy")).toThrow(/one of/);
		expect(() => store.set("tokenSpeed.refreshMs", "fast")).toThrow(/finite number/);
		expect(() => store.set("tokenSpeed.label", 42)).toThrow(/expects a string/);
		expect(() => store.set("unknown.key", true)).toThrow(/Unknown setting/);
		// Rejected writes leave values unchanged.
		expect(store.get("tokenSpeed.enabled")).toBe(true);

		expect(() => store.register(booleanSchema)).toThrow(/already registered/);
		expect(() => store.register({ key: "x.y", label: "X", type: "enum", default: "a" })).toThrow(/requires values/);

		expect(store.coerce("tokenSpeed.enabled", "on")).toBe(true);
		expect(store.coerce("tokenSpeed.enabled", "false")).toBe(false);
		expect(store.coerce("tokenSpeed.refreshMs", " 250 ")).toBe(250);
		expect(store.coerce("tokenSpeed.style", "detailed")).toBe("detailed");
		expect(store.coerce("tokenSpeed.label", "hello world")).toBe("hello world");
		expect(() => store.coerce("tokenSpeed.enabled", "maybe")).toThrow(/Invalid boolean/);
		expect(() => store.coerce("tokenSpeed.refreshMs", "abc")).toThrow(/Invalid number/);
		expect(() => store.coerce("tokenSpeed.style", "fancy")).toThrow(/Invalid value/);
	});

	it("notifies listeners on change and renders values for display", () => {
		const store = createStore();
		const listener = vi.fn();
		const unsubscribe = store.onChange(listener);

		store.set("tokenSpeed.enabled", false);
		expect(listener).toHaveBeenCalledWith("tokenSpeed.enabled", false);
		unsubscribe();
		store.set("tokenSpeed.enabled", true);
		expect(listener).toHaveBeenCalledTimes(1); // unsubscribed: no second call

		expect(store.displayValue("tokenSpeed.enabled")).toBe("on");
		store.set("tokenSpeed.enabled", false);
		expect(store.displayValue("tokenSpeed.enabled")).toBe("off");
		expect(store.displayValue("tokenSpeed.refreshMs")).toBe("1000");
	});
});
