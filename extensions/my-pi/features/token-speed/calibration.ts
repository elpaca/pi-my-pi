import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Calibration } from "./estimator.ts";

/**
 * Per-model token-ratio calibration.
 *
 * For each provider/model we accumulate just enough statistics to fit
 *   outputTokens ≈ a·cjkChars + b·nonCjkChars
 * online (least squares through the origin, no intercept), then cache the
 * derived chars-per-token ratios in a JSON file under the OS temp dir.
 *
 * The cache lives outside the agent dir on purpose: it is disposable derived
 * data, safe to lose, and must not pollute `~/.pi/agent`.
 */

/** Minimum completed messages before a model's calibration is trusted. */
export const MIN_SAMPLES = 20;

/** Below this determinant-to-scale ratio the two regressors are collinear and the fit is unreliable. */
const MIN_DET_SCALE = 1e-6;

export interface ModelCalibrationStats {
	/** Completed messages observed. */
	n: number;
	/** Σ cjk² */
	s11: number;
	/** Σ cjk·nonCjk */
	s12: number;
	/** Σ nonCjk² */
	s22: number;
	/** Σ cjk·outputTokens */
	s1y: number;
	/** Σ nonCjk·outputTokens */
	s2y: number;
	sumCjk: number;
	sumNonCjk: number;
	sumOut: number;
	updatedAt: string;
}

export interface CalibrationFileData {
	version: number;
	/** Output-char calibration per model: assistant chars → billed output tokens. */
	models: Record<string, ModelCalibrationStats>;
	/** Input-char calibration per model: request payload chars → billed prompt tokens. */
	inputs: Record<string, ModelCalibrationStats>;
}

const FILE_VERSION = 2;

export function calibrationKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

export function emptyStats(): ModelCalibrationStats {
	return {
		n: 0,
		s11: 0,
		s12: 0,
		s22: 0,
		s1y: 0,
		s2y: 0,
		sumCjk: 0,
		sumNonCjk: 0,
		sumOut: 0,
		updatedAt: new Date(0).toISOString(),
	};
}

/** Accumulate one completed message into the statistics (mutates and returns the same object). */
export function addSample(
	stats: ModelCalibrationStats,
	cjkChars: number,
	nonCjkChars: number,
	outputTokens: number,
	now: Date = new Date(),
): ModelCalibrationStats {
	stats.n += 1;
	stats.s11 += cjkChars * cjkChars;
	stats.s12 += cjkChars * nonCjkChars;
	stats.s22 += nonCjkChars * nonCjkChars;
	stats.s1y += cjkChars * outputTokens;
	stats.s2y += nonCjkChars * outputTokens;
	stats.sumCjk += cjkChars;
	stats.sumNonCjk += nonCjkChars;
	stats.sumOut += outputTokens;
	stats.updatedAt = now.toISOString();
	return stats;
}

/**
 * Solve the 2x2 normal equations for (a, b) and return chars-per-token ratios.
 * Returns undefined when there is not enough data or the system is degenerate.
 */
export function solveCalibration(stats: ModelCalibrationStats | undefined): Calibration | undefined {
	if (!stats || stats.n < MIN_SAMPLES) return undefined;
	const scale = stats.s11 * stats.s22;
	if (!(scale > 0)) return undefined;
	const det = scale - stats.s12 * stats.s12;
	if (!(det > 1e-9) || det < scale * MIN_DET_SCALE) return undefined;
	const a = (stats.s1y * stats.s22 - stats.s2y * stats.s12) / det;
	const b = (stats.s11 * stats.s2y - stats.s12 * stats.s1y) / det;
	if (!(a > 0) || !(b > 0)) return undefined;
	return { cjkCharsPerToken: 1 / a, nonCjkCharsPerToken: 1 / b };
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseModelStats(raw: unknown): ModelCalibrationStats | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const s = raw as Record<string, unknown>;
	const numericFields = ["s11", "s12", "s22", "s1y", "s2y", "sumCjk", "sumNonCjk", "sumOut"];
	if (!isFiniteNumber(s.n) || !numericFields.every((field) => isFiniteNumber(s[field]))) return undefined;
	return {
		n: s.n,
		s11: s.s11 as number,
		s12: s.s12 as number,
		s22: s.s22 as number,
		s1y: s.s1y as number,
		s2y: s.s2y as number,
		sumCjk: s.sumCjk as number,
		sumNonCjk: s.sumNonCjk as number,
		sumOut: s.sumOut as number,
		updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : new Date(0).toISOString(),
	};
}

/**
 * Validate and normalize file contents. Returns undefined for missing/corrupt
 * data. Version 1 files carried only the output calibration; their models are
 * migrated as-is (the accumulated output samples stay valuable) and the input
 * calibration starts empty.
 */
export function parseCalibrationFile(data: unknown): CalibrationFileData | undefined {
	if (!data || typeof data !== "object") return undefined;
	const version = (data as { version?: unknown }).version;
	if (version !== 1 && version !== FILE_VERSION) return undefined;
	const models = (data as { models?: unknown }).models;
	if (!models || typeof models !== "object") return undefined;
	const result: CalibrationFileData = { version: FILE_VERSION, models: {}, inputs: {} };
	for (const [key, raw] of Object.entries(models as Record<string, unknown>)) {
		const stats = parseModelStats(raw);
		if (stats) result.models[key] = stats;
	}
	if (version === FILE_VERSION) {
		const inputs = (data as { inputs?: unknown }).inputs;
		if (inputs && typeof inputs === "object") {
			for (const [key, raw] of Object.entries(inputs as Record<string, unknown>)) {
				const stats = parseModelStats(raw);
				if (stats) result.inputs[key] = stats;
			}
		}
	}
	return result;
}

export class CalibrationCache {
	private readonly models = new Map<string, ModelCalibrationStats>();
	private readonly inputs = new Map<string, ModelCalibrationStats>();
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
		for (const [key, stats] of Object.entries(data.inputs)) {
			this.inputs.set(key, stats);
		}
	}

	/** Calibrated output ratios for a model, or undefined until enough samples exist. */
	get(key: string): Calibration | undefined {
		return solveCalibration(this.models.get(key));
	}

	/**
	 * Calibrated input ratios for a model: payload chars → billed prompt
	 * tokens. The input text mix (tool schemas, tool results, code) tokenizes
	 * differently from assistant output, so it gets its own regression.
	 */
	getInput(key: string): Calibration | undefined {
		return solveCalibration(this.inputs.get(key));
	}

	stats(key: string): ModelCalibrationStats | undefined {
		return this.models.get(key);
	}

	inputStats(key: string): ModelCalibrationStats | undefined {
		return this.inputs.get(key);
	}

	/** Record one completed message's output stats and flush the cache to disk. */
	record(key: string, cjkChars: number, nonCjkChars: number, outputTokens: number, now: Date = new Date()): void {
		if (!(outputTokens > 0) || cjkChars + nonCjkChars <= 0) return;
		let stats = this.models.get(key);
		if (!stats) {
			stats = emptyStats();
			this.models.set(key, stats);
		}
		addSample(stats, cjkChars, nonCjkChars, outputTokens, now);
		this.flush();
	}

	/**
	 * Record one completed request's input stats: the request-time payload
	 * chars against the authoritative billed prompt total (input + cacheRead +
	 * cacheWrite), and flush the cache to disk.
	 */
	recordInput(key: string, cjkChars: number, nonCjkChars: number, promptTokens: number, now: Date = new Date()): void {
		if (!(promptTokens > 0) || cjkChars + nonCjkChars <= 0) return;
		let stats = this.inputs.get(key);
		if (!stats) {
			stats = emptyStats();
			this.inputs.set(key, stats);
		}
		addSample(stats, cjkChars, nonCjkChars, promptTokens, now);
		this.flush();
	}

	/** Best-effort atomic write; failures are silently ignored (cache semantics). */
	flush(): void {
		if (this.models.size === 0 && this.inputs.size === 0) return;
		try {
			const data: CalibrationFileData = {
				version: FILE_VERSION,
				models: Object.fromEntries(this.models),
				inputs: Object.fromEntries(this.inputs),
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
