/**
 * Character-to-token estimation.
 *
 * Characters are classified into five buckets with distinct token densities:
 *   cjk   — CJK ideographs, kana, hangul, CJK punctuation, fullwidth forms
 *   word  — letters (ASCII and non-ASCII) and underscore
 *   digit — ASCII digits
 *   punct — punctuation, symbols, JSON syntax, and everything else
 *   space — whitespace
 *
 * Tokens are estimated linearly: tokens ≈ Σ bucket_chars / ratio[bucket].
 * The estimator is linear in the counts, so it applies unchanged to signed
 * per-bucket deltas — the increment between two requests.
 *
 * Default ratios are conservative priors (see README); the per-model
 * calibration (calibration.ts) replaces them once enough authoritative
 * samples are seen. Validated against ~79k real samples (39k request-payload
 * increments and outputs across 30 models): rebased estimates land within
 * ~0.1% median error once calibrated, ~5% with the bare defaults.
 */

export interface CharCounts {
	cjk: number;
	word: number;
	digit: number;
	punct: number;
	space: number;
}

/**
 * Chars-per-token ratios, one per bucket. Structurally a CharCounts vector —
 * both enter estimateTokens as plain bucket vectors (tokens ≈ Σ chars/ratio).
 */
export type Calibration = CharCounts;

export const DEFAULT_CALIBRATION: Calibration = {
	cjk: 1.3,
	word: 4.0,
	digit: 2.5,
	punct: 2.2,
	space: 5.0,
};

/** Bucket field names in canonical order (mirrors calibration.ts matrix layout). */
export const BUCKET_KEYS = ["cjk", "word", "digit", "punct", "space"] as const;
export type BucketKey = (typeof BUCKET_KEYS)[number];

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

function isSpaceCodePoint(cp: number): boolean {
	return (
		cp === 0x20 ||
		(cp >= 0x09 && cp <= 0x0d) || // tab, LF, VT, FF, CR
		cp === 0xa0 || // NBSP
		cp === 0x2028 || // line separator
		cp === 0x2029 // paragraph separator
	);
}

/** Bucket for one code point. Non-ASCII, non-CJK, non-space chars count as word. */
export function classifyCodePoint(cp: number): BucketKey {
	if (isCjkCodePoint(cp)) return "cjk";
	if (isSpaceCodePoint(cp)) return "space";
	if (cp >= 0x30 && cp <= 0x39) return "digit";
	if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f) return "word";
	if (cp < 0x80) return "punct";
	return "word"; // accented letters, cyrillic, etc. — tokenizes like letters
}

/** All buckets zero. */
export function zeroCounts(): CharCounts {
	return { cjk: 0, word: 0, digit: 0, punct: 0, space: 0 };
}

/** True when every bucket is exactly zero. */
export function isZeroCounts(counts: CharCounts): boolean {
	return BUCKET_KEYS.every((key) => counts[key] === 0);
}

/** a += b (mutates a). */
export function addCounts(a: CharCounts, b: CharCounts): CharCounts {
	for (const key of BUCKET_KEYS) a[key] += b[key];
	return a;
}

/** a - b, per bucket (signed; used for request-to-request increments). */
export function subCounts(a: CharCounts, b: CharCounts): CharCounts {
	const delta = zeroCounts();
	for (const key of BUCKET_KEYS) delta[key] = a[key] - b[key];
	return delta;
}

/** Classify every code point of the text into the five buckets. */
export function countTextChars(text: string): CharCounts {
	const counts = zeroCounts();
	for (const char of text) {
		const cp = char.codePointAt(0);
		if (cp !== undefined) counts[classifyCodePoint(cp)]++;
	}
	return counts;
}

/** Total chars across buckets (meaningful for non-negative counts). */
export function countTotalChars(counts: CharCounts): number {
	return BUCKET_KEYS.reduce((sum, key) => sum + counts[key], 0);
}

const BASE64_PATTERN = /^[A-Za-z0-9+/=]+$/;

/** Base64 blobs (inline images) and data URLs carry no usable char→token signal. */
function isBinaryText(text: string): boolean {
	return text.startsWith("data:") || (text.length > 1024 && BASE64_PATTERN.test(text));
}

/**
 * Classify every character a provider request payload serializes to — string
 * values, object keys, and the JSON syntax between them — because all of it
 * consumes prompt tokens on the wire. Image/base64 data is blanked out before
 * serialization. Works for Anthropic-style `{system, messages, tools}` and
 * OpenAI-style `{messages, tools}` payloads alike; this is the raw material
 * for the estimated prompt size of a request.
 */
export function countPayloadChars(payload: unknown): CharCounts {
	if (payload === undefined || payload === null) return zeroCounts();
	const text = JSON.stringify(payload, (_key, value: unknown) => {
		if (typeof value === "string" && isBinaryText(value)) return "";
		return value;
	});
	return countTextChars(text ?? "");
}

/** Estimate tokens from (possibly signed) bucket counts using the given ratios. */
export function estimateTokens(counts: CharCounts, calibration: Calibration = DEFAULT_CALIBRATION): number {
	let tokens = 0;
	for (const key of BUCKET_KEYS) {
		const ratio = calibration[key] > 0 ? calibration[key] : DEFAULT_CALIBRATION[key];
		tokens += counts[key] / ratio;
	}
	return tokens;
}

/**
 * Authoritative prompt total of a past request, paired with the payload chars
 * that were billed for it: the anchor for rebased input estimates and for Δ
 * training samples. Session-scoped on purpose — system prompt and tool
 * schemas are constant within a session and cancel in the increment.
 */
export interface InputAnchor {
	tokens: number;
	chars: CharCounts;
}

/**
 * Estimate the total input tokens (system + tools + messages) of a request
 * whose payload serializes to `chars`. When the session already has an
 * authoritative prompt total (`anchor`), REBASE on it:
 * est = anchor.tokens + ratio·Δchars. The constant parts (system, tools, JSON
 * overhead) cancel in the increment, which removes the dominant error source
 * of full-payload estimates (validated offline: ~0.1% median vs ~40%+).
 * Returns null when the payload carries nothing countable.
 */
export function estimateInputTokens(
	chars: CharCounts,
	anchor: InputAnchor | undefined,
	calibration?: Calibration,
): number | null {
	if (countTotalChars(chars) <= 0) return null;
	const tokens = anchor
		? anchor.tokens + estimateTokens(subCounts(chars, anchor.chars), calibration)
		: estimateTokens(chars, calibration);
	return Math.round(tokens);
}
