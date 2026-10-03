import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SettingsStore } from "./settings.ts";

/** Data types a setting value can take. */
export type SettingType = "boolean" | "enum" | "number" | "string";

/** Declaration of one setting, registered by a feature. */
export interface SettingSchema {
	/** Namespaced key, e.g. "tokenSpeed.enabled". */
	key: string;
	/** Short display label used in the /my-pi menu. */
	label: string;
	/** Longer explanation shown when the item is selected. */
	description?: string;
	type: SettingType;
	/** Allowed values; required for enum settings. */
	values?: string[];
	default: string | number | boolean;
}

/** A feature bundled in this package. Each feature wires itself up on register(). */
export interface Feature {
	/** Stable identifier, e.g. "token-speed". */
	id: string;
	register(context: FeatureContext): void;
}

export interface FeatureContext {
	pi: ExtensionAPI;
	settings: SettingsStore;
}
