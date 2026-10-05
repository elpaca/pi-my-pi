import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	addSample,
	CalibrationCache,
	calibrationKey,
	emptyStats,
	MIN_SAMPLES,
	parseCalibrationFile,
	solveCalibration,
} from "./calibration.ts";

/** Generate samples whose token counts follow tokens = cjk/R1 + nonCjk/R2 exactly. */
function generateSamples(count: number, r1: number, r2: number) {
	const stats = emptyStats();
	for (let i = 0; i < count; i++) {
		const cjk = 5 + (i % 30);
		const nonCjk = 20 + ((i * 37) % 500);
		const tokens = Math.round(cjk / r1 + nonCjk / r2);
		addSample(stats, cjk, nonCjk, tokens);
	}
	return stats;
}

describe("solveCalibration", () => {
	it("recovers exact ratios from well-conditioned samples", () => {
		const stats = generateSamples(200, 1.2, 4.0);
		const solved = solveCalibration(stats);
		expect(solved).toBeDefined();
		expect(solved?.cjkCharsPerToken).toBeCloseTo(1.2, 2);
		expect(solved?.nonCjkCharsPerToken).toBeCloseTo(4.0, 2);
	});

	it("returns undefined below the minimum sample count", () => {
		const stats = generateSamples(MIN_SAMPLES - 1, 1.2, 4.0);
		expect(solveCalibration(stats)).toBeUndefined();
		const empty = emptyStats();
		expect(solveCalibration(empty)).toBeUndefined();
		expect(solveCalibration(undefined)).toBeUndefined();
	});

	it("returns undefined for degenerate (collinear or constant) data", () => {
		// Perfectly collinear regressors
		const collinear = emptyStats();
		for (let i = 0; i < 100; i++) {
			addSample(collinear, 10, 20, 15);
		}
		expect(solveCalibration(collinear)).toBeUndefined();

		// Zero variance in both regressors
		const constant = emptyStats();
		for (let i = 0; i < 100; i++) {
			addSample(constant, 0, 0, 10);
		}
		expect(solveCalibration(constant)).toBeUndefined();

		// Negative slope: tokens decrease as CJK chars increase → no positive fit exists
		const negative = emptyStats();
		for (let i = 0; i < 100; i++) {
			const cjk = 10 + i;
			addSample(negative, cjk, 50, 200 - cjk);
		}
		expect(solveCalibration(negative)).toBeUndefined();
	});
});

describe("addSample", () => {
	it("accumulates sufficient statistics", () => {
		const stats = emptyStats();
		addSample(stats, 10, 40, 20, new Date("2026-01-01T00:00:00Z"));
		addSample(stats, 0, 80, 20, new Date("2026-01-02T00:00:00Z"));
		expect(stats.n).toBe(2);
		expect(stats.s11).toBe(100);
		expect(stats.s12).toBe(10 * 40 + 0 * 80);
		expect(stats.s22).toBe(40 * 40 + 80 * 80);
		expect(stats.s1y).toBe(10 * 20 + 0 * 20);
		expect(stats.s2y).toBe(40 * 20 + 80 * 20);
		expect(stats.sumCjk).toBe(10);
		expect(stats.sumNonCjk).toBe(120);
		expect(stats.sumOut).toBe(40);
		expect(stats.updatedAt).toBe("2026-01-02T00:00:00.000Z");
	});
});

describe("parseCalibrationFile", () => {
	it("accepts valid data and skips corrupt entries", () => {
		const stats = generateSamples(MIN_SAMPLES + 1, 1.2, 4.0);
		const valid = parseCalibrationFile({ version: 1, models: { "p/m": stats } });
		expect(valid?.models["p/m"]).toEqual(stats);

		// Corrupt entries are skipped, valid structure is kept
		const lenient = parseCalibrationFile({ version: 1, models: { bad: { n: "x" } } });
		expect(lenient).toBeDefined();
		expect(Object.keys(lenient?.models ?? {})).toHaveLength(0);

		expect(parseCalibrationFile(null)).toBeUndefined();
		expect(parseCalibrationFile({})).toBeUndefined();
		expect(parseCalibrationFile({ version: 3, models: {} })).toBeUndefined();
	});

	it("migrates version 1 files: output stats kept, input calibration empty", () => {
		const stats = generateSamples(MIN_SAMPLES + 1, 1.2, 4.0);
		const legacy = parseCalibrationFile({ version: 1, models: { "p/m": stats } });
		expect(legacy?.version).toBe(2);
		expect(legacy?.models["p/m"]).toEqual(stats);
		expect(legacy?.inputs).toEqual({});
		// Unknown version is still rejected.
		expect(parseCalibrationFile({ version: 2, models: {} })).toBeDefined();
		expect(parseCalibrationFile({ version: 1, inputs: {} })).toBeUndefined();
	});

	it("accepts version 2 files with input calibration", () => {
		const out = generateSamples(MIN_SAMPLES, 1.2, 4.0);
		const input = generateSamples(MIN_SAMPLES, 5.0, 5.0);
		const parsed = parseCalibrationFile({ version: 2, models: { "p/m": out }, inputs: { "p/m": input } });
		expect(parsed?.models["p/m"]).toEqual(out);
		expect(parsed?.inputs["p/m"]).toEqual(input);
	});
});

describe("CalibrationCache", () => {
	it("round-trips recorded stats through the cache file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-my-pi-cache-"));
		const key = calibrationKey("provider-a", "model-x");

		const writer = new CalibrationCache({ dir });
		expect(writer.get(key)).toBeUndefined();
		for (let i = 0; i < MIN_SAMPLES + 15; i++) {
			const cjk = 4 + (i % 20);
			const nonCjk = 30 + ((i * 53) % 400);
			writer.record(key, cjk, nonCjk, Math.round(cjk / 1.25 + nonCjk / 3.9));
		}
		expect(writer.get(key)?.cjkCharsPerToken).toBeCloseTo(1.25, 1);

		const reader = new CalibrationCache({ dir });
		reader.load();
		expect(reader.get(key)?.cjkCharsPerToken).toBeCloseTo(1.25, 1);
		expect(reader.get(calibrationKey("provider-a", "model-y"))).toBeUndefined();

		const raw = JSON.parse(readFileSync(join(dir, "token-ratio.json"), "utf8")) as { version: number };
		expect(raw.version).toBe(2);
	});

	it("round-trips input calibration through the cache file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-my-pi-cache-"));
		const key = calibrationKey("provider-a", "model-x");

		const writer = new CalibrationCache({ dir });
		expect(writer.getInput(key)).toBeUndefined();
		for (let i = 0; i < MIN_SAMPLES + 15; i++) {
			const cjk = 2 + (i % 10);
			const nonCjk = 100 + ((i * 71) % 900);
			writer.recordInput(key, cjk, nonCjk, Math.round(cjk / 1.3 + nonCjk / 4.7));
		}
		expect(writer.getInput(key)?.nonCjkCharsPerToken).toBeCloseTo(4.7, 1);
		// Output calibration is untouched by input samples.
		expect(writer.get(key)).toBeUndefined();

		const reader = new CalibrationCache({ dir });
		reader.load();
		expect(reader.getInput(key)?.nonCjkCharsPerToken).toBeCloseTo(4.7, 1);
	});

	it("keeps the version 1 output stats when loading a legacy file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-my-pi-cache-"));
		const stats = generateSamples(MIN_SAMPLES + 1, 1.25, 3.9);
		writeFileSync(join(dir, "token-ratio.json"), JSON.stringify({ version: 1, models: { "p/m": stats } }), "utf8");
		const cache = new CalibrationCache({ dir });
		cache.load();
		expect(cache.get("p/m")?.cjkCharsPerToken).toBeCloseTo(1.25, 1);
		expect(cache.getInput("p/m")).toBeUndefined();
	});

	it("ignores records with no tokens or no characters", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-my-pi-cache-"));
		const cache = new CalibrationCache({ dir });
		const key = calibrationKey("p", "m");
		cache.record(key, 0, 0, 100);
		cache.record(key, 10, 20, 0);
		expect(cache.stats(key)).toBeUndefined();
	});

	it("tolerates a missing or corrupt cache file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-my-pi-cache-"));
		const missing = new CalibrationCache({ dir });
		expect(() => missing.load()).not.toThrow();
		expect(missing.get("p/m")).toBeUndefined();

		writeFileSync(join(dir, "token-ratio.json"), "{{{", "utf8");
		const corrupt = new CalibrationCache({ dir });
		expect(() => corrupt.load()).not.toThrow();
		expect(corrupt.get("p/m")).toBeUndefined();
	});

	it("calibrationKey joins provider and model", () => {
		expect(calibrationKey("Volcengine Coding Plan", "glm-5.3")).toBe("Volcengine Coding Plan/glm-5.3");
	});
});
