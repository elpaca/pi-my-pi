import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Read and parse a JSON file. Returns undefined when missing or unreadable. */
export function readJsonFile(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Atomic file write: content lands at `file` either completely or not at all
 * (write to a sibling temp file, then rename over the target). Throws on
 * failure — callers decide whether that is tolerable.
 */
export function writeFileAtomic(file: string, contents: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tempFile = `${file}.tmp-${process.pid}`;
	writeFileSync(tempFile, contents, "utf8");
	renameSync(tempFile, file);
}
