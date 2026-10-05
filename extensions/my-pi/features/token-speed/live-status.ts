import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Calibration } from "./estimator.ts";
import { formatIdleSegments, formatStreamingSegments, formatWaitSegments, type StatusSegment } from "./format.ts";
import type { LiveSample, StreamMetrics } from "./metrics.ts";

const STATUS_KEY = "my-pi";
/** Live status refresh throttle: at most once per second (event-driven, no timers). */
const LIVE_UPDATE_INTERVAL_MS = 1000;
/** Tick rate of the wait-phase elapsed counter (no stream events fire before the first delta). */
const WAIT_TICK_MS = 100;

export interface LiveStatusOptions {
	metrics: StreamMetrics;
	isEnabled(): boolean;
	showDuringStream(): boolean;
}

/**
 * Owns the status-line presentation for the token-speed feature: the
 * wait-phase elapsed ticker, the throttled live rendering while streaming,
 * the idle summary, and the reaction to settings changes. All time comes from
 * the caller or from the one wait ticker it owns; there is no other clock.
 */
export class LiveStatus {
	private readonly metrics: StreamMetrics;
	private readonly isEnabled: () => boolean;
	private readonly showDuringStream: () => boolean;
	private waitTimer: ReturnType<typeof setInterval> | undefined;
	private lastSample: LiveSample | undefined;
	private lastLiveUpdateMs = 0;

	constructor(options: LiveStatusOptions) {
		this.metrics = options.metrics;
		this.isEnabled = options.isEnabled;
		this.showDuringStream = options.showDuringStream;
	}

	/** Segments that update in real time highlight; static ones stay dim. */
	private render(ctx: ExtensionContext, segments: StatusSegment[]): string {
		return segments.map((segment) => ctx.ui.theme.fg(segment.live ? "accent" : "dim", segment.text)).join(" ");
	}

	private setStatus(ctx: ExtensionContext, text: string): void {
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	private clear(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	/**
	 * While waiting for the first delta no stream events fire, so the elapsed
	 * counter needs its own ticker. It self-disarms when settings change
	 * mid-wait, and is stopped on first delta / message end / shutdown.
	 */
	startWait(ctx: ExtensionContext, anchorMs: number): void {
		this.stopWait();
		if (!this.isEnabled() || !this.showDuringStream()) return;
		this.waitTimer = setInterval(() => {
			if (!this.isEnabled() || !this.showDuringStream()) {
				this.stopWait();
				this.clear(ctx);
				return;
			}
			this.setStatus(
				ctx,
				this.render(
					ctx,
					// The previous message's average is the best speed
					// reference available before the first token arrives.
					formatWaitSegments(
						Date.now() - anchorMs,
						this.metrics.inputTokensEstimate,
						this.metrics.stats?.avgTps ?? null,
					),
				),
			);
		}, WAIT_TICK_MS);
	}

	/** Tear down the wait-phase ticker; safe to call repeatedly. True when one was running. */
	stopWait(): boolean {
		if (this.waitTimer === undefined) return false;
		clearInterval(this.waitTimer);
		this.waitTimer = undefined;
		return true;
	}

	/**
	 * The wait phase ended with the first delta: stop the ticker and make the
	 * next live sample render immediately.
	 */
	endWait(): void {
		if (this.stopWait()) this.lastLiveUpdateMs = 0;
	}

	/** A new assistant message starts: forget the previous message's throttle state. */
	onMessageStart(): void {
		this.lastSample = undefined;
		this.lastLiveUpdateMs = 0;
	}

	/**
	 * Render the streaming status for one event. Token counters refresh on
	 * every delta; ttft and the window rate come from the throttled sample so
	 * the speed figure stays put for up to LIVE_UPDATE_INTERVAL_MS.
	 */
	renderLive(ctx: ExtensionContext, now: number, calibration: Calibration | undefined, partialUsage: number): void {
		if (!this.isEnabled() || !this.showDuringStream()) return;
		const sample = this.metrics.liveSample(now, calibration, partialUsage);
		if (!sample) return; // no deltas yet: the wait counter still owns the status
		const rateJustBecameMeasurable =
			this.lastSample !== undefined && this.lastSample.tps === null && sample.tps !== null;
		if (
			!this.lastSample ||
			this.lastLiveUpdateMs === 0 ||
			rateJustBecameMeasurable ||
			now - this.lastLiveUpdateMs >= LIVE_UPDATE_INTERVAL_MS
		) {
			this.lastSample = sample;
			this.lastLiveUpdateMs = now;
		}
		// Token counters (C/T/O) refresh on every delta; ttft and the window
		// rate come from the throttled sample so the speed figure stays put.
		const throttled = this.lastSample;
		const shown: LiveSample = { ...sample, ttftMs: throttled.ttftMs, tps: throttled.tps };
		this.setStatus(ctx, this.render(ctx, formatStreamingSegments(shown)));
	}

	/** Render the idle summary for the last completed message. */
	renderIdle(ctx: ExtensionContext): void {
		if (!this.isEnabled()) return;
		const stats = this.metrics.stats;
		const segments = stats ? formatIdleSegments(stats) : [];
		if (segments.length === 0) {
			this.clear(ctx);
			return;
		}
		this.setStatus(ctx, this.render(ctx, segments));
	}

	/** React to a settings change (tokenSpeed.* keys only). */
	onSettingsChange(ctx: ExtensionContext, key: string): void {
		if (key !== "tokenSpeed.enabled" && key !== "tokenSpeed.showDuringStream") return;
		const active = this.isEnabled() && (ctx.isIdle() || this.showDuringStream());
		if (!active) {
			this.stopWait();
			this.clear(ctx);
			return;
		}
		if (ctx.isIdle()) {
			this.renderIdle(ctx);
		}
	}

	/** Session teardown: stop the ticker and clear the status. */
	shutdown(ctx: ExtensionContext): void {
		this.stopWait();
		this.clear(ctx);
	}
}
