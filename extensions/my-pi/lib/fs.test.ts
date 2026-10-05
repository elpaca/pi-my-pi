import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonFile, writeFileAtomic } from "./fs.ts";

describe("readJsonFile", () => {
	it("parses existing files and returns undefined for missing or invalid ones", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-my-pi-fs-"));
		const file = join(dir, "data.json");
		expect(readJsonFile(file)).toBeUndefined();
		writeFileSync(file, '{"a":1}', "utf8");
		expect(readJsonFile(file)).toEqual({ a: 1 });
		writeFileSync(file, "{not json", "utf8");
		expect(readJsonFile(file)).toBeUndefined();
	});
});

describe("writeFileAtomic", () => {
	it("creates parent directories, replaces existing content, and leaves no temp files", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-my-pi-fs-"));
		const file = join(dir, "nested", "dir", "data.json");
		writeFileAtomic(file, "first\n");
		expect(readFileSync(file, "utf8")).toBe("first\n");
		writeFileAtomic(file, "second\n");
		expect(readFileSync(file, "utf8")).toBe("second\n");
		expect(readdirSync(join(dir, "nested", "dir"))).toEqual(["data.json"]);
	});
});
