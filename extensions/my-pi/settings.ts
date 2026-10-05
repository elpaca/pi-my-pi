import { readJsonFile, writeFileAtomic } from "./lib/fs.ts";
import type { SettingSchema, SettingType } from "./types.ts";

export type SettingValue = string | number | boolean;

export type SettingListener = (key: string, value: SettingValue) => void;

interface PersistedFile {
	version: number;
	settings: Record<string, SettingValue>;
}

const FILE_VERSION = 1;

function isSettingValue(value: unknown): value is SettingValue {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Per-type behavior of one setting type: parsing and validation. */
interface TypeSpec {
	/** Parse a raw CLI/menu string into a value; throws on invalid input. */
	parse(key: string, raw: string, schema: SettingSchema): SettingValue;
	/** Whether a value (from set() or a persisted file) is acceptable. */
	accepts(schema: SettingSchema, value: SettingValue): boolean;
	/** Error message for set() with an unacceptable value. */
	rejection(schema: SettingSchema): string;
}

/**
 * Adding a setting type means adding one entry here — parsing, validation,
 * and error messages live together instead of in three parallel switches.
 */
const TYPE_SPECS: Record<SettingType, TypeSpec> = {
	boolean: {
		parse(key, raw) {
			const normalized = raw.trim().toLowerCase();
			if (["on", "true", "1", "yes"].includes(normalized)) return true;
			if (["off", "false", "0", "no"].includes(normalized)) return false;
			throw new Error(`Invalid boolean value "${raw}" for ${key} (expected on/off)`);
		},
		accepts: (_schema, value) => typeof value === "boolean",
		rejection: (schema) => `Setting ${schema.key} expects a boolean`,
	},
	number: {
		parse(key, raw) {
			const parsed = Number(raw.trim());
			if (!Number.isFinite(parsed)) {
				throw new Error(`Invalid number "${raw}" for ${key}`);
			}
			return parsed;
		},
		accepts: (_schema, value) => typeof value === "number" && Number.isFinite(value),
		rejection: (schema) => `Setting ${schema.key} expects a finite number`,
	},
	enum: {
		parse(key, raw, schema) {
			const trimmed = raw.trim();
			if (schema.values?.includes(trimmed)) return trimmed;
			throw new Error(`Invalid value "${raw}" for ${key} (expected one of: ${schema.values?.join(", ")})`);
		},
		accepts: (schema, value) => typeof value === "string" && schema.values?.includes(value) === true,
		rejection: (schema) => `Setting ${schema.key} expects one of: ${schema.values?.join(", ")}`,
	},
	string: {
		parse: (_key, raw) => raw.trim(),
		accepts: (_schema, value) => typeof value === "string",
		rejection: (schema) => `Setting ${schema.key} expects a string`,
	},
};

/**
 * Global settings store for all features in this package.
 *
 * Values are persisted to a single JSON file (by default `<agentDir>/my-pi.json`).
 * Feature defaults come from registered schemas; user overrides win until cleared.
 */
export class SettingsStore {
	private readonly schemaMap = new Map<string, SettingSchema>();
	private readonly userValues = new Map<string, SettingValue>();
	private readonly listeners = new Set<SettingListener>();
	private readonly file: string;

	constructor(options: { file: string }) {
		this.file = options.file;
		this.loadUser();
	}

	/** Register a setting schema. Throws on duplicate keys. */
	register(schema: SettingSchema): void {
		if (this.schemaMap.has(schema.key)) {
			throw new Error(`Setting already registered: ${schema.key}`);
		}
		if (schema.type === "enum" && (!schema.values || schema.values.length === 0)) {
			throw new Error(`Enum setting requires values: ${schema.key}`);
		}
		this.schemaMap.set(schema.key, schema);
	}

	/** All registered schemas in registration order. */
	schemas(): SettingSchema[] {
		return [...this.schemaMap.values()];
	}

	schema(key: string): SettingSchema {
		const schema = this.schemaMap.get(key);
		if (!schema) {
			throw new Error(`Unknown setting: ${key}`);
		}
		return schema;
	}

	has(key: string): boolean {
		return this.schemaMap.has(key);
	}

	/**
	 * Effective value: user override if present, otherwise the schema default.
	 * Overrides whose runtime type does not match the schema are ignored.
	 */
	get(key: string): SettingValue {
		const schema = this.schema(key);
		const user = this.userValues.get(key);
		return user !== undefined && TYPE_SPECS[schema.type].accepts(schema, user) ? user : schema.default;
	}

	getBoolean(key: string): boolean {
		return this.get(key) === true;
	}

	/**
	 * Validate, store, persist, and notify a new value.
	 * Throws if the key is unknown or the value does not match the schema.
	 */
	set(key: string, value: SettingValue): void {
		const schema = this.schema(key);
		const spec = TYPE_SPECS[schema.type];
		if (!spec.accepts(schema, value)) {
			throw new Error(spec.rejection(schema));
		}
		this.userValues.set(key, value);
		this.persist();
		for (const listener of this.listeners) {
			listener(key, value);
		}
	}

	/** Subscribe to changes. Returns an unsubscribe function. */
	onChange(listener: SettingListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Effective values for all registered settings. */
	all(): Record<string, SettingValue> {
		const result: Record<string, SettingValue> = {};
		for (const schema of this.schemaMap.values()) {
			result[schema.key] = this.get(schema.key);
		}
		return result;
	}

	/** User override, or undefined when the default is in effect. */
	userValue(key: string): SettingValue | undefined {
		return this.userValues.get(key);
	}

	/** Human-readable value for menus and listings. */
	displayValue(key: string): string {
		const value = this.get(key);
		if (typeof value === "boolean") {
			return value ? "on" : "off";
		}
		return String(value);
	}

	/** Parse a raw CLI/menu string into a typed value. Throws on invalid input. */
	coerce(key: string, raw: string): SettingValue {
		const schema = this.schema(key);
		return TYPE_SPECS[schema.type].parse(key, raw, schema);
	}

	private loadUser(): void {
		const parsed = readJsonFile(this.file) as PersistedFile | undefined;
		if (!parsed || parsed.version !== FILE_VERSION || typeof parsed.settings !== "object" || parsed.settings === null) {
			return;
		}
		for (const [key, value] of Object.entries(parsed.settings)) {
			if (isSettingValue(value)) {
				this.userValues.set(key, value);
			}
		}
	}

	private persist(): void {
		// Preserve unknown keys so hand-edits or entries from older versions survive.
		const settings: Record<string, SettingValue> = {};
		for (const [key, value] of this.userValues) {
			settings[key] = value;
		}
		const data: PersistedFile = { version: FILE_VERSION, settings };
		try {
			writeFileAtomic(this.file, `${JSON.stringify(data, null, "\t")}\n`);
		} catch {
			// Persistence is best-effort; in-memory value still applies for this session.
		}
	}
}
