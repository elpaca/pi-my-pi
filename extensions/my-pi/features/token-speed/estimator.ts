/**
 * Character-to-token estimation.
 *
 * Default ratios were calibrated against ~22.5k real assistant messages
 * (~15.6M output tokens) via scripts/analyze-token-ratio.mjs:
 *   CJK     ≈ 1.0–1.3 chars/token
 *   non-CJK ≈ 3.8–4.0 chars/token
 * Median relative error of the fixed heuristic is ~15%, good enough for a
 * live speed display. Per-model calibration (calibration.ts) tightens this.
 */

export interface CharCounts {
	cjk: number;
	nonCjk: number;
}

export interface Calibration {
	/** CJK code points per token. */
	cjkCharsPerToken: number;
	/** Non-CJK code points per token (ASCII, code, punctuation, whitespace...). */
	nonCjkCharsPerToken: number;
}

export const DEFAULT_CALIBRATION: Calibration = {
	cjkCharsPerToken: 1.3,
	nonCjkCharsPerToken: 3.8,
};

/** True for CJK ideographs, kana, hangul, CJK punctuation, and fullwidth forms. */
export function isCjkCodePoint(cp: number): boolean {
	return (
		(cp >= 0x2e80 && cp <= 0x2eff) || // CJK radicals
		(cp >= 0x3000 && cp <= 0x303f) || // CJK symbols and punctuation
		(cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
		(cp >= 0x31f0 && cp <= 0x31ff) || // Katakana phonetic extensions
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
		(cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
		(cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
		(cp >= 0xff00 && cp <= 0xffef) || // Fullwidth forms
		(cp >= 0x20000 && cp <= 0x2a6df) || // CJK Extension B
		(cp >= 0x2f800 && cp <= 0x2fa1f) // CJK compatibility ideographs supplement
	);
}

/** Count CJK vs non-CJK code points. Iterates code points, so surrogate pairs count once. */
export function countChars(text: string): CharCounts {
	let cjk = 0;
	let nonCjk = 0;
	for (const char of text) {
		const cp = char.codePointAt(0);
		if (cp !== undefined && isCjkCodePoint(cp)) {
			cjk++;
		} else {
			nonCjk++;
		}
	}
	return { cjk, nonCjk };
}

export function countTotalChars(counts: CharCounts): number {
	return counts.cjk + counts.nonCjk;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/=]+$/;

/** Base64 blobs (inline images) and data URLs carry no usable char→token signal. */
function isBinaryText(text: string): boolean {
	return text.startsWith("data:") || (text.length > 1024 && BASE64_PATTERN.test(text));
}

/**
 * Sum CJK vs non-CJK chars over every string value of a provider request
 * payload (whatever `before_provider_request` carries: Anthropic-style
 * `{system, messages, tools}` or OpenAI-style `{messages, tools}`). Object
 * keys are ignored; image data is skipped. This is the raw material for the
 * estimated cached-context size of a request.
 */
export function countPayloadChars(payload: unknown): CharCounts {
	const total: CharCounts = { cjk: 0, nonCjk: 0 };
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			if (!isBinaryText(value)) {
				const counts = countChars(value);
				total.cjk += counts.cjk;
				total.nonCjk += counts.nonCjk;
			}
		} else if (Array.isArray(value)) {
			for (const item of value) visit(item);
		} else if (value !== null && typeof value === "object") {
			for (const item of Object.values(value)) visit(item);
		}
	};
	visit(payload);
	return total;
}

/** Estimate token count from character counts using the given calibration. */
export function estimateTokens(counts: CharCounts, calibration: Calibration = DEFAULT_CALIBRATION): number {
	const cjkRatio =
		calibration.cjkCharsPerToken > 0 ? calibration.cjkCharsPerToken : DEFAULT_CALIBRATION.cjkCharsPerToken;
	const nonCjkRatio =
		calibration.nonCjkCharsPerToken > 0 ? calibration.nonCjkCharsPerToken : DEFAULT_CALIBRATION.nonCjkCharsPerToken;
	return counts.cjk / cjkRatio + counts.nonCjk / nonCjkRatio;
}
