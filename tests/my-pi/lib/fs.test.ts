import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile, writeFileAtomic } from "../../../extensions/my-pi/lib/fs.ts";

describe("lib/fs", () => {
	it("reads JSON leniently and writes files atomically (no temp leftovers)", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-my-pi-fs-"));

		// readJsonFile: parsed content for valid files, undefined for missing or invalid ones.
		const file = join(dir, "data.json");
		expect(readJsonFile(file)).toBeUndefined();
		writeFileSync(file, '{"a":1}', "utf8");
		expect(readJsonFile(file)).toEqual({ a: 1 });
		writeFileSync(file, "{not json", "utf8");
		expect(readJsonFile(file)).toBeUndefined();

		// writeFileAtomic: creates parent directories, replaces content, leaves no temp files.
		const target = join(dir, "nested", "dir", "data.json");
		writeFileAtomic(target, "first\n");
		expect(readFileSync(target, "utf8")).toBe("first\n");
		writeFileAtomic(target, "second\n");
		expect(readFileSync(target, "utf8")).toBe("second\n");
		expect(readdirSync(join(dir, "nested", "dir"))).toEqual(["data.json"]);
	});
});
