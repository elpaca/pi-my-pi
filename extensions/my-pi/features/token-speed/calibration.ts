/**
 * Per-model calibration: one shared linear regression from character buckets
 * to tokens, trained on two kinds of authoritative samples:
 *
 *  - output samples: visible streamed assistant chars → billed output tokens
 *  - input increment (Δ) samples: the request-payload char increment between
 *    two consecutive authoritative requests → the billed prompt-token delta
 *
 * Both are intercept-free (constants such as system+tools cancel in Δ
 * samples and are absent in outputs), so they pool into ONE ratio set that
 * serves the input estimate, the live T/O estimates, and the rate. Least
 * squares through the origin over the five buckets; validated offline
 * against ~79k real samples: rebased input estimates land at ~0.1% median
 * error, outputs at ~11-16% median, across 30 models.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUCKET_KEYS, type Calibration, type CharCounts, isZeroCounts } from "./estimator.ts";

/** Samples required before the learned calibration replaces the defaults. */
export const MIN_SAMPLES = 20;
const DIM = BUCKET_KEYS.length;

export interface ModelCalibrationStats {
	n: number;
	/** Gram matrix (Σ x_i·x_j), DIM×DIM, bucket order = BUCKET_KEYS. */
	gram: number[][];
	/** Σ x_i·y per bucket. Can hold negatives (Δ samples may be negative). */
	sy: number[];
	/** Σ x_i per bucket (diagnostics; Δ samples contribute signed values). */
	sums: number[];
	/** Σ y (diagnostics; Δ samples contribute signed values). */
	sumTokens: number;
	updatedAt: string;
}

export interface CalibrationFileData {
	version: number;
	models: Record<string, ModelCalibrationStats>;
}

const FILE_VERSION = 3;

export function calibrationKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

function zeroMatrix(): number[][] {
	return BUCKET_KEYS.map(() => BUCKET_KEYS.map(() => 0));
}

export function emptyStats(): ModelCalibrationStats {
	return {
		n: 0,
		gram: zeroMatrix(),
		sy: BUCKET_KEYS.map(() => 0),
		sums: BUCKET_KEYS.map(() => 0),
		sumTokens: 0,
		updatedAt: new Date(0).toISOString(),
	};
}

/**
 * Accumulate one sample into the statistics (mutates and returns the same
 * object). `tokens` may be negative (a shrinking context between requests);
 * zero-token samples carry no information and are rejected by the caller.
 */
export function addSample(
	stats: ModelCalibrationStats,
	counts: CharCounts,
	tokens: number,
	now: Date = new Date(),
): ModelCalibrationStats {
	const x = BUCKET_KEYS.map((key) => counts[key]);
	stats.n += 1;
	for (let i = 0; i < DIM; i++) {
		const xi = x[i] ?? 0;
		const gramRow = stats.gram[i];
		if (!gramRow) continue;
		stats.sy[i] = (stats.sy[i] ?? 0) + xi * tokens;
		stats.sums[i] = (stats.sums[i] ?? 0) + xi;
		for (let j = 0; j < DIM; j++) {
			gramRow[j] = (gramRow[j] ?? 0) + xi * (x[j] ?? 0);
		}
	}
	stats.sumTokens += tokens;
	stats.updatedAt = now.toISOString();
	return stats;
}

/**
 * Solve the DIM×DIM normal equations (partial pivoting) for the
 * tokens-per-char coefficients and return chars-per-token ratios. Returns
 * undefined when there is not enough data or the system is
 * degenerate/non-physical.
 */
export function solveCalibration(stats: ModelCalibrationStats | undefined): Calibration | undefined {
	if (!stats || stats.n < MIN_SAMPLES) return undefined;
	const scale = Math.max(...stats.gram.flat().map(Math.abs));
	if (!(scale > 0)) return undefined;
	// Gaussian elimination with partial pivoting on the augmented matrix.
	const m: number[][] = stats.gram.map((row, i) => [...row, stats.sy[i] ?? 0]);
	for (let col = 0; col < DIM; col++) {
		const colOf = (row: number[] | undefined): number => (row === undefined ? 0 : (row[col] ?? 0));
		let pivot = col;
		for (let r = col + 1; r < DIM; r++) {
			if (Math.abs(colOf(m[r])) > Math.abs(colOf(m[pivot]))) pivot = r;
		}
		const pivotRow = m[pivot];
		if (!pivotRow || Math.abs(colOf(pivotRow)) < scale * 1e-10) return undefined;
		const current = m[col];
		if (!current) return undefined;
		if (pivot !== col) {
			m[pivot] = current;
			m[col] = pivotRow;
		}
		for (let r = 0; r < DIM; r++) {
			if (r === col) continue;
			const target = m[r];
			if (!target) continue;
			const factor = colOf(target) / colOf(pivotRow);
			for (let c = col; c <= DIM; c++) {
				target[c] = (target[c] ?? 0) - factor * (pivotRow[c] ?? 0);
			}
		}
	}
	const a: number[] = [];
	for (let i = 0; i < DIM; i++) {
		const diag = m[i]?.[i];
		if (diag === undefined || Math.abs(diag) < scale * 1e-10) return undefined;
		const value = (m[i]?.[DIM] ?? 0) / diag;
		if (!(value > 0)) return undefined; // non-physical density
		a.push(value);
	}
	const [cjk, word, digit, punct, space] = a;
	if (cjk === undefined || word === undefined || digit === undefined || punct === undefined || space === undefined) {
		return undefined;
	}
	return { cjk: 1 / cjk, word: 1 / word, digit: 1 / digit, punct: 1 / punct, space: 1 / space };
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseVector(raw: unknown, allowNegative: boolean): number[] | undefined {
	if (!Array.isArray(raw) || raw.length !== DIM) return undefined;
	const out: number[] = [];
	for (const v of raw) {
		if (!isFiniteNumber(v)) return undefined;
		if (!allowNegative && v < 0) return undefined;
		out.push(v);
	}
	return out;
}

/** Validate and normalize file contents. Returns undefined for missing/corrupt/incompatible data. */
export function parseCalibrationFile(data: unknown): CalibrationFileData | undefined {
	if (!data || typeof data !== "object") return undefined;
	if ((data as { version?: unknown }).version !== FILE_VERSION) return undefined;
	const models = (data as { models?: unknown }).models;
	if (!models || typeof models !== "object") return undefined;
	const result: CalibrationFileData = { version: FILE_VERSION, models: {} };
	for (const [key, raw] of Object.entries(models as Record<string, unknown>)) {
		if (!raw || typeof raw !== "object") continue;
		const s = raw as Record<string, unknown>;
		const gramRaw = s.gram;
		if (!Array.isArray(gramRaw) || gramRaw.length !== DIM) continue;
		const gram: number[][] = [];
		let ok = true;
		for (const rowRaw of gramRaw) {
			const row = parseVector(rowRaw, false);
			if (!row) {
				ok = false;
				break;
			}
			gram.push(row);
		}
		if (!ok) continue;
		const sy: number[] | undefined = parseVector(s.sy, true);
		const sums: number[] | undefined = parseVector(s.sums, true);
		if (!sy || !sums || !isFiniteNumber(s.n) || s.n < 0 || !isFiniteNumber(s.sumTokens)) continue;
		result.models[key] = {
			n: s.n,
			gram,
			sy,
			sums,
			sumTokens: s.sumTokens,
			updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : new Date(0).toISOString(),
		};
	}
	return result;
}

export class CalibrationCache {
	private readonly models = new Map<string, ModelCalibrationStats>();
	private readonly file: string;

	constructor(options?: { dir?: string }) {
		const dir = options?.dir ?? process.env.PI_MY_PI_CACHE_DIR ?? join(tmpdir(), "pi-my-pi");
		this.file = join(dir, "token-ratio.json");
	}

	/** Read the cache file. Missing or corrupt data leaves the cache empty. */
	load(): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.file, "utf8"));
		} catch {
			return;
		}
		const data = parseCalibrationFile(parsed);
		if (!data) return;
		for (const [key, stats] of Object.entries(data.models)) {
			this.models.set(key, stats);
		}
	}

	/** Calibrated ratios for a model, or undefined until enough samples exist. */
	get(key: string): Calibration | undefined {
		return solveCalibration(this.models.get(key));
	}

	stats(key: string): ModelCalibrationStats | undefined {
		return this.models.get(key);
	}

	/**
	 * Record one authoritative sample — a visible-output sample or a
	 * request-increment (Δ) sample — and flush the cache to disk.
	 */
	record(key: string, counts: CharCounts, tokens: number, now: Date = new Date()): void {
		if (tokens === 0 || isZeroCounts(counts)) return;
		let stats = this.models.get(key);
		if (!stats) {
			stats = emptyStats();
			this.models.set(key, stats);
		}
		addSample(stats, counts, tokens, now);
		this.flush();
	}

	/** Best-effort atomic write; failures are silently ignored (cache semantics). */
	flush(): void {
		if (this.models.size === 0) return;
		try {
			const data: CalibrationFileData = {
				version: FILE_VERSION,
				models: Object.fromEntries(this.models),
			};
			mkdirSync(dirname(this.file), { recursive: true });
			const tempFile = `${this.file}.tmp-${process.pid}`;
			writeFileSync(tempFile, JSON.stringify(data), "utf8");
			renameSync(tempFile, this.file);
		} catch {
			// Cache is disposable; ignore write errors.
		}
	}
}
