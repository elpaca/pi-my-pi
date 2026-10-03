import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerMyPiCommand } from "./commands/settings-menu.ts";
import { tokenSpeedFeature } from "./features/token-speed/index.ts";
import { SettingsStore } from "./settings.ts";
import type { Feature } from "./types.ts";

const features: readonly Feature[] = [tokenSpeedFeature];

export default function myPi(pi: ExtensionAPI): void {
	const settings = new SettingsStore({ file: join(getAgentDir(), "my-pi.json") });
	for (const feature of features) {
		feature.register({ pi, settings });
	}
	registerMyPiCommand(pi, settings);
}
