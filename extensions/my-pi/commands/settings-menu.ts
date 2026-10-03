import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import type { SettingsStore } from "../settings.ts";
import type { SettingSchema } from "../types.ts";

type Notify = (message: string, type?: "info" | "warning" | "error") => void;

function truncate(text: string, width: number): string {
	if (width <= 0) return text;
	return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function createInputSubmenu(
	schema: SettingSchema,
	store: SettingsStore,
	notify: Notify,
	done: (selectedValue?: string) => void,
) {
	const input = new Input({ prompt: `${schema.label}: ` });
	input.setValue(store.displayValue(schema.key));
	input.onSubmit = (value) => {
		try {
			store.set(schema.key, store.coerce(schema.key, value));
		} catch (error) {
			// Stay in the submenu so the value can be corrected.
			notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		done(store.displayValue(schema.key));
	};
	input.onEscape = () => done();

	const container = new Container();
	container.addChild(
		new (class {
			render(width: number): string[] {
				return [schema.description ? truncate(schema.description, width) : `Set ${schema.label}`, ""];
			}

			invalidate(): void {}
		})(),
	);
	container.addChild(input);

	return {
		render(width: number): string[] {
			return container.render(width);
		},
		invalidate(): void {
			container.invalidate();
		},
		handleInput(data: string): void {
			input.handleInput(data);
		},
	};
}

function buildItems(store: SettingsStore, notify: Notify): SettingItem[] {
	return store.schemas().map((schema) => {
		const item: SettingItem = {
			id: schema.key,
			label: schema.label,
			description: schema.description,
			currentValue: store.displayValue(schema.key),
		};
		if (schema.type === "boolean") {
			item.values = ["on", "off"];
		} else if (schema.type === "enum") {
			item.values = schema.values;
		} else {
			// number / string: free-form entry via an input submenu
			item.submenu = (_currentValue, done) => createInputSubmenu(schema, store, notify, done);
		}
		return item;
	});
}

function listText(store: SettingsStore): string {
	return store
		.schemas()
		.map((schema) => `${schema.key} = ${store.displayValue(schema.key)}`)
		.join("\n");
}

async function openMenu(store: SettingsStore, ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`/my-pi requires TUI mode. Current values:\n${listText(store)}`, "warning");
		return;
	}

	const notify: Notify = (message, type) => ctx.ui.notify(message, type);
	await ctx.ui.custom((_tui, theme, _keybindings, done) => {
		const settingsList = new SettingsList(
			buildItems(store, notify),
			Math.min(store.schemas().length + 2, 15),
			getSettingsListTheme(),
			(id, newValue) => {
				try {
					store.set(id, store.coerce(id, newValue));
				} catch (error) {
					notify(error instanceof Error ? error.message : String(error), "error");
				}
			},
			() => done(undefined),
		);

		const container = new Container();
		container.addChild(
			new (class {
				render(_width: number): string[] {
					return [theme.fg("accent", theme.bold("my-pi settings")), ""];
				}

				invalidate(): void {}
			})(),
		);
		container.addChild(settingsList);

		return {
			render(width: number): string[] {
				return container.render(width);
			},
			invalidate(): void {
				container.invalidate();
			},
			handleInput(data: string): void {
				settingsList.handleInput(data);
			},
		};
	});
}

export function registerMyPiCommand(pi: ExtensionAPI, store: SettingsStore): void {
	pi.registerCommand("my-pi", {
		description: "my-pi settings",
		getArgumentCompletions: (prefix) => {
			const candidates = ["list", ...store.schemas().map((schema) => schema.key)];
			const matches = candidates.filter((candidate) => candidate.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);

			if (!subcommand) {
				await openMenu(store, ctx);
				return;
			}

			if (subcommand === "list") {
				ctx.ui.notify(`my-pi settings:\n${listText(store)}`, "info");
				return;
			}

			// /my-pi <key> <value>
			const value = rest.join(" ");
			if (!store.has(subcommand)) {
				ctx.ui.notify(`Unknown setting "${subcommand}". Use /my-pi list to see available keys.`, "error");
				return;
			}
			if (!value) {
				ctx.ui.notify(`Usage: /my-pi ${subcommand} <value> (current: ${store.displayValue(subcommand)})`, "info");
				return;
			}
			try {
				store.set(subcommand, store.coerce(subcommand, value));
				ctx.ui.notify(`${subcommand} = ${store.displayValue(subcommand)}`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
