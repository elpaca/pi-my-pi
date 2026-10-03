#!/usr/bin/env node
/**
 * Analyze pi session files to estimate chars-per-token ratios for CJK vs non-CJK text.
 *
 * Usage:
 *   node scripts/analyze-token-ratio.mjs
 *   SAMPLE=400 SEED=1 node scripts/analyze-token-ratio.mjs
 *
 * Reads assistant messages with usage.output, extracts the generated text
 * (text + thinking + tool-call arguments), counts CJK vs non-CJK code points,
 * then fits  output_tokens ≈ c0 + a*cjkChars + b*nonCjkChars  via least squares.
 *
 * Reported chars/token = 1/a (CJK) and 1/b (non-CJK). The intercept c0 is the
 * average per-message overhead (chat template / tool-call structure tokens).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const SESSION_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || join(AGENT_DIR, "sessions");
const SAMPLE_SIZE = Number(process.env.SAMPLE || 200);
const SEED = Number(process.env.SEED || 42);
const MAX_MSGS_PER_FILE = Number(process.env.MAX_MSGS || 500);
const MIN_OUTPUT = Number(process.env.MIN_OUTPUT || 10);

function isCjk(cp) {
	return (
		(cp >= 0x2e80 && cp <= 0x2eff) || // CJK radicals
		(cp >= 0x3000 && cp <= 0x303f) || // CJK symbols & punctuation
		(cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
		(cp >= 0x31f0 && cp <= 0x31ff) || // Katakana phonetic extensions
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
		(cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
		(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
		(cp >= 0xff00 && cp <= 0xffef) || // Fullwidth forms
		(cp >= 0x20000 && cp <= 0x2a6df) || // CJK Ext B
		(cp >= 0x2f800 && cp <= 0x2fa1f) // CJK compatibility ideographs supplement
	);
}

function walk(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
	}
	return out;
}

let seed = SEED >>> 0;
function rand() {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
}

function extractText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const b of content) {
		if (!b) continue;
		if (b.type === "text") text += b.text || "";
		else if (b.type === "thinking") text += b.thinking || b.text || "";
		else if (b.type === "toolCall") {
			try {
				text += JSON.stringify(b.arguments ?? {});
			} catch {
				/* ignore */
			}
		}
	}
	return text;
}

function countChars(text) {
	let cjk = 0;
	let nonCjk = 0;
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (isCjk(cp)) cjk++;
		else nonCjk++;
	}
	return { cjk, nonCjk };
}

/** Solve a small dense linear system A x = b (Gaussian elimination, partial pivot). */
function solve(A, b) {
	const n = b.length;
	const M = A.map((row, i) => [...row, b[i]]);
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
		if (Math.abs(M[pivot][col]) < 1e-12) return null;
		[M[col], M[pivot]] = [M[pivot], M[col]];
		const p = M[col][col];
		for (let c = col; c <= n; c++) M[col][c] /= p;
		for (let r = 0; r < n; r++) {
			if (r === col) continue;
			const f = M[r][col];
			if (f === 0) continue;
			for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
		}
	}
	return M.map((row) => row[n]);
}

/** Fit y = c0 + a*x1 + b*x2. Returns {c0,a,b} or null. */
function fit3(rows) {
	if (rows.length < 4) return null;
	const X = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];
	const XtY = [0, 0, 0];
	for (const { x1, x2, y } of rows) {
		const f = [1, x1, x2];
		for (let i = 0; i < 3; i++) {
			for (let j = 0; j < 3; j++) X[i][j] += f[i] * f[j];
			XtY[i] += f[i] * y;
		}
	}
	const beta = solve(X, XtY);
	if (!beta) return null;
	return { c0: beta[0], a: beta[1], b: beta[2] };
}

/** Fit y = a*x1 + b*x2 (through origin, no per-message overhead). */
function fit2(rows) {
	if (rows.length < 3) return null;
	let s11 = 0;
	let s12 = 0;
	let s22 = 0;
	let s1y = 0;
	let s2y = 0;
	for (const { x1, x2, y } of rows) {
		s11 += x1 * x1;
		s12 += x1 * x2;
		s22 += x2 * x2;
		s1y += x1 * y;
		s2y += x2 * y;
	}
	const det = s11 * s22 - s12 * s12;
	if (Math.abs(det) < 1e-12) return null;
	const a = (s1y * s22 - s2y * s12) / det;
	const b = (s11 * s2y - s12 * s1y) / det;
	return { a, b };
}

function r2(rows, { c0, a, b }) {
	let ssRes = 0;
	let ssTot = 0;
	const mean = rows.reduce((s, r) => s + r.y, 0) / rows.length;
	for (const { x1, x2, y } of rows) {
		const pred = c0 + a * x1 + b * x2;
		ssRes += (y - pred) ** 2;
		ssTot += (y - mean) ** 2;
	}
	return ssTot > 0 ? 1 - ssRes / ssTot : 0;
}

function median(arr) {
	if (!arr.length) return NaN;
	const s = [...arr].sort((x, y) => x - y);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmt(n, d = 2) {
	return Number.isFinite(n) ? n.toFixed(d) : "n/a";
}

function report(name, rows) {
	if (rows.length < 4) {
		console.log(`${name}: 样本不足 (${rows.length})`);
		return;
	}
	const fit = fit3(rows);
	const sumCjk = rows.reduce((s, r) => s + r.x1, 0);
	const sumNon = rows.reduce((s, r) => s + r.x2, 0);
	const sumOut = rows.reduce((s, r) => s + r.y, 0);

	// Simple group ratios
	const asciiOnly = rows.filter((r) => r.x1 === 0 && r.x2 > 0);
	const cjkOnly = rows.filter((r) => r.x1 > 0 && r.x1 / (r.x1 + r.x2) > 0.9);
	const asciiRatio = asciiOnly.length
		? asciiOnly.reduce((s, r) => s + r.x2, 0) / asciiOnly.reduce((s, r) => s + r.y, 0)
		: NaN;
	const cjkRatio = cjkOnly.length ? cjkOnly.reduce((s, r) => s + r.x1, 0) / cjkOnly.reduce((s, r) => s + r.y, 0) : NaN;
	const fit2v = fit2(rows);
	// Collinearity between cjk and nonCjk within a group (1 = perfectly collinear → unstable split)
	const n = rows.length;
	const mx = rows.reduce((s, r) => s + r.x1, 0) / n;
	const my = rows.reduce((s, r) => s + r.x2, 0) / n;
	let cov = 0;
	let vx = 0;
	let vy = 0;
	for (const r of rows) {
		cov += (r.x1 - mx) * (r.x2 - my);
		vx += (r.x1 - mx) ** 2;
		vy += (r.x2 - my) ** 2;
	}
	const corr = vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : 0;
	// Robust marginal CJK ratio: attribute residual tokens to CJK using a fixed non-CJK ratio.
	const R_NON = fit2v ? 1 / fit2v.b : 3.8;
	let cjkSum = 0;
	let residSum = 0;
	for (const r of rows) {
		const resid = r.y - r.x2 / R_NON;
		if (r.x1 > 0 && resid > 0) {
			cjkSum += r.x1;
			residSum += resid;
		}
	}
	const robustCjkRatio = residSum > 0 ? cjkSum / residSum : NaN;
	// Candidate fixed heuristic: tokens = cjk/1.3 + nonCjk/3.8
	const H_CJK = 1.3;
	const H_NON = 3.8;
	const relErr = rows.map((r) => Math.abs(r.x1 / H_CJK + r.x2 / H_NON - r.y) / r.y);

	console.log(`\n=== ${name} ===`);
	console.log(`  messages=${rows.length}  cjkChars=${sumCjk}  nonCjkChars=${sumNon}  outputTokens=${sumOut}`);
	console.log(
		`  corpus: CJK ${fmt((sumCjk / (sumCjk + sumNon)) * 100, 1)}%  non-CJK ${fmt((sumNon / (sumCjk + sumNon)) * 100, 1)}%`,
	);
	if (fit) {
		console.log(
			`  regression: tokens = ${fmt(fit.c0, 2)} + ${fmt(fit.a, 4)}*cjk + ${fmt(fit.b, 4)}*nonCjk   (R²=${fmt(r2(rows, fit), 4)})`,
		);
		console.log(
			`    → chars/token: CJK ${fmt(1 / fit.a)}   non-CJK ${fmt(1 / fit.b)}   (per-msg overhead ≈ ${fmt(fit.c0, 1)} tok)`,
		);
	} else {
		console.log("  regression: 无法求解");
	}
	if (fit2v) {
		console.log(
			`  fit(no-intercept): chars/token: CJK ${fmt(1 / fit2v.a)}   non-CJK ${fmt(1 / fit2v.b)}   (tokens = cjk/${fmt(1 / fit2v.a)} + nonCjk/${fmt(1 / fit2v.b)})`,
		);
	}
	if (Number.isFinite(cjkRatio)) console.log(`  pure-CJK msgs (n=${cjkOnly.length}): ${fmt(cjkRatio)} chars/token`);
	if (Number.isFinite(asciiRatio))
		console.log(`  pure-ASCII msgs (n=${asciiOnly.length}): ${fmt(asciiRatio)} chars/token`);
	console.log(
		`  corr(cjk,nonCjk)=${fmt(corr, 3)}   robust CJK chars/token (given non-CJK ${fmt(R_NON)}) = ${fmt(robustCjkRatio)}`,
	);
	console.log(
		`  heuristic cjk/${H_CJK} + nonCjk/${H_NON}: median rel.err ${fmt(median(relErr) * 100, 1)}%   mean rel.err ${fmt((relErr.reduce((s, v) => s + v, 0) / relErr.length) * 100, 1)}%`,
	);
}

function main() {
	console.log(`session dir: ${SESSION_DIR}`);
	let files;
	try {
		statSync(SESSION_DIR);
		files = walk(SESSION_DIR);
	} catch {
		console.error(`session dir not found: ${SESSION_DIR}`);
		process.exit(1);
	}
	console.log(`found ${files.length} session files`);

	// deterministic shuffle + sample
	const shuffled = [...files];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	const sample = shuffled.slice(0, Math.min(SAMPLE_SIZE, shuffled.length));
	console.log(`sampled ${sample.length} files (seed=${SEED})`);

	const all = [];
	const byModel = new Map();
	const byProvider = new Map();
	let parsedFiles = 0;

	for (const file of sample) {
		let content;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		parsedFiles++;
		let count = 0;
		for (const line of content.split("\n")) {
			if (count >= MAX_MSGS_PER_FILE) break;
			if (line?.[0] !== "{") continue;
			let obj;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}
			if (obj.type !== "message") continue;
			const m = obj.message;
			if (m?.role !== "assistant") continue;
			const out = m.usage?.output;
			if (!Number.isFinite(out) || out < MIN_OUTPUT) continue;
			const text = extractText(m.content);
			if (!text) continue;
			const { cjk, nonCjk } = countChars(text);
			if (cjk + nonCjk === 0) continue;
			const row = { x1: cjk, x2: nonCjk, y: out, model: m.model || "?", provider: m.provider || "?" };
			all.push(row);
			count++;
			if (!byModel.has(row.model)) byModel.set(row.model, []);
			byModel.get(row.model).push(row);
			if (!byProvider.has(row.provider)) byProvider.set(row.provider, []);
			byProvider.get(row.provider).push(row);
		}
	}

	console.log(`parsed ${parsedFiles} files, ${all.length} assistant messages with usage.output >= ${MIN_OUTPUT}`);
	if (!all.length) {
		console.error("no usable messages found");
		process.exit(1);
	}

	report("ALL", all);

	const topModels = [...byModel.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12);
	console.log("\n########## per model ##########");
	for (const [model, rows] of topModels) report(model, rows);

	const topProviders = [...byProvider.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8);
	console.log("\n########## per provider ##########");
	for (const [provider, rows] of topProviders) report(provider, rows);
}

main();
