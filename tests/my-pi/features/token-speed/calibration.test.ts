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
} from "../../../../extensions/my-pi/features/token-speed/calibration.ts";
import type { Calibration, CharCounts } from "../../../../extensions/my-pi/features/token-speed/estimator.ts";

function mk(cjk: number, word: number, digit: number, punct: number, space: number): CharCounts {
	return { cjk, word, digit, punct, space };
}

/** Generate samples whose token counts follow tokens = Σ bucket/ratio exactly. */
function generateSamples(count: number, ratios: Calibration) {
	const stats = emptyStats();
	for (let i = 0; i < count; i++) {
		const counts = mk(5 + (i % 30), 20 + ((i * 37) % 500), 3 + (i % 7), 10 + ((i * 11) % 40), 8 + (i % 15));
		const tokens =
			counts.cjk / ratios.cjk +
			counts.word / ratios.word +
			counts.digit / ratios.digit +
			counts.punct / ratios.punct +
			counts.space / ratios.space;
		addSample(stats, counts, tokens);
	}
	return stats;
}

const RATIOS: Calibration = { cjk: 1.2, word: 4.0, digit: 2.5, punct: 2.0, space: 5.0 };

describe("calibration", () => {
	it("solves exact ratios from well-conditioned samples, including signed (shrinking-context) deltas", () => {
		const solved = solveCalibration(generateSamples(200, RATIOS));
		expect(solved).toBeDefined();
		expect(solved?.cjk).toBeCloseTo(1.2, 2);
		expect(solved?.word).toBeCloseTo(4.0, 2);
		expect(solved?.digit).toBeCloseTo(2.5, 2);
		expect(solved?.punct).toBeCloseTo(2.0, 2);
		expect(solved?.space).toBeCloseTo(5.0, 2);

		// Δ training samples are signed: every third request shrinks the
		// context, and the regression must still recover positive ratios.
		const signed = emptyStats();
		for (let i = 0; i < MIN_SAMPLES + 10; i++) {
			const sign = i % 3 === 0 ? -1 : 1;
			const counts = mk(
				sign * (5 + (i % 30)),
				sign * (100 + ((i * 37) % 500)),
				sign * (3 + (i % 7)),
				sign * (10 + ((i * 11) % 40)),
				sign * (8 + (i % 15)),
			);
			addSample(
				signed,
				counts,
				sign *
					(counts.cjk / 1.2 + counts.word / 4.0 + counts.digit / 2.5 + counts.punct / 2.0 + counts.space / 5.0) *
					sign,
			);
		}
		expect(solveCalibration(signed)?.word).toBeCloseTo(4.0, 2);
	});

	it("rejects insufficient or degenerate sample data", () => {
		expect(solveCalibration(generateSamples(MIN_SAMPLES - 1, RATIOS))).toBeUndefined();
		expect(solveCalibration(emptyStats())).toBeUndefined();
		expect(solveCalibration(undefined)).toBeUndefined();

		// Perfectly collinear buckets: word = 2·cjk, others zero.
		const collinear = emptyStats();
		for (let i = 0; i < 100; i++) {
			addSample(collinear, mk(10 + i, 2 * (10 + i), 0, 0, 0), 30);
		}
		expect(solveCalibration(collinear)).toBeUndefined();

		// Zero variance in every bucket.
		const constant = emptyStats();
		for (let i = 0; i < 100; i++) {
			addSample(constant, mk(10, 20, 0, 0, 0), 10);
		}
		expect(solveCalibration(constant)).toBeUndefined();
	});

	it("accumulates the Gram matrix and projections per sample", () => {
		const stats = emptyStats();
		addSample(stats, mk(2, 10, 0, 4, 0), 20, new Date("2026-01-01T00:00:00Z"));
		addSample(stats, mk(0, 20, 3, 0, 5), 30, new Date("2026-01-02T00:00:00Z"));
		expect(stats.n).toBe(2);
		expect(stats.gram[0]).toEqual([4, 20, 0, 8, 0]); // cjk row
		expect(stats.gram[1]).toEqual([20, 100 + 400, 60, 40, 100]); // word row
		expect(stats.sy[0]).toBe(2 * 20);
		expect(stats.sy[1]).toBe(10 * 20 + 20 * 30);
		expect(stats.sums[0]).toBe(2);
		expect(stats.sumTokens).toBe(50);
		expect(stats.updatedAt).toBe("2026-01-02T00:00:00.000Z");
	});

	it("parses v3 files leniently and rejects incompatible legacy formats", () => {
		const stats = generateSamples(MIN_SAMPLES + 1, RATIOS);
		const valid = parseCalibrationFile({ version: 3, models: { "p/m": stats } });
		expect(valid?.models["p/m"]).toEqual(stats);

		// Corrupt entries are skipped, not fatal.
		const lenient = parseCalibrationFile({ version: 3, models: { bad: { n: "x" } } });
		expect(lenient).toBeDefined();
		expect(Object.keys(lenient?.models ?? {})).toHaveLength(0);

		expect(parseCalibrationFile(null)).toBeUndefined();
		expect(parseCalibrationFile({})).toBeUndefined();
		// Legacy formats (v1/v2 two-bucket stats) are not compatible with the
		// pooled five-bucket regression; the disposable cache starts over.
		expect(parseCalibrationFile({ version: 1, models: {} })).toBeUndefined();
		expect(parseCalibrationFile({ version: 2, models: {}, inputs: {} })).toBeUndefined();
	});

	it("records, round-trips and filters samples through the cache file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-my-pi-cache-"));
		const key = calibrationKey("provider-a", "model-x");
		expect(key).toBe("provider-a/model-x");

		const writer = new CalibrationCache({ dir });
		expect(writer.get(key)).toBeUndefined();
		for (let i = 0; i < MIN_SAMPLES + 15; i++) {
			const counts = mk(4 + (i % 20), 30 + ((i * 53) % 400), 2 + (i % 5), 8 + ((i * 13) % 30), 5 + (i % 12));
			writer.record(
				key,
				counts,
				counts.cjk / 1.25 + counts.word / 3.9 + counts.digit / 2.5 + counts.punct / 2.0 + counts.space / 5.0,
			);
		}
		expect(writer.get(key)?.word).toBeCloseTo(3.9, 1);
		expect(writer.get(key)?.cjk).toBeCloseTo(1.25, 1);

		// The cache file survives a reload in a fresh instance.
		const reader = new CalibrationCache({ dir });
		reader.load();
		expect(reader.get(key)?.word).toBeCloseTo(3.9, 1);
		expect(reader.get(calibrationKey("provider-a", "model-y"))).toBeUndefined();
		const raw = JSON.parse(readFileSync(join(dir, "token-ratio.json"), "utf8")) as { version: number };
		expect(raw.version).toBe(3);

		// Zero-token or zero-count records are uninformative: dropped.
		const filtered = new CalibrationCache({ dir: mkdtempSync(join(tmpdir(), "pi-my-pi-cache-")) });
		const other = calibrationKey("p", "m");
		filtered.record(other, mk(0, 0, 0, 0, 0), 100);
		filtered.record(other, mk(10, 20, 0, 0, 0), 0);
		expect(filtered.stats(other)).toBeUndefined();
		// Signed deltas (a shrinking context) are kept.
		filtered.record(other, mk(-50, -200, 0, -30, 0), -80);
		expect(filtered.stats(other)?.n).toBe(1);
		expect(filtered.stats(other)?.sumTokens).toBe(-80);
	});

	it("tolerates missing, corrupt and legacy cache files", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-my-pi-cache-"));
		const missing = new CalibrationCache({ dir });
		expect(() => missing.load()).not.toThrow();
		expect(missing.get("p/m")).toBeUndefined();

		writeFileSync(join(dir, "token-ratio.json"), "{{{", "utf8");
		const corrupt = new CalibrationCache({ dir });
		expect(() => corrupt.load()).not.toThrow();
		expect(corrupt.get("p/m")).toBeUndefined();

		writeFileSync(
			join(dir, "token-ratio.json"),
			JSON.stringify({ version: 2, models: { "p/m": { n: 99 } }, inputs: {} }),
			"utf8",
		);
		const legacy = new CalibrationCache({ dir });
		legacy.load();
		expect(legacy.get("p/m")).toBeUndefined();
	});
});
