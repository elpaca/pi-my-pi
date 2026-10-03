# pi-my-pi

Personal [pi](https://github.com/badlogic/pi-mono) package with small quality-of-life extensions.
Currently: **token speed** in the status bar, managed through a unified `/my-pi` settings menu.

## Features

### token-speed

Shows LLM token throughput in the footer status line:

- **While waiting for the first token**: `⇢1.3s` (accent color) — a live elapsed counter, ticking
  every 0.1s, so long server-side thinking is visible instead of a silent bar. Once the first token
  arrives the same prefix carries over into the streaming display.
- **While streaming**: `⇢1.3s ~45.3 TPS` (accent color) — time to first token plus a sliding-window
  rate over the last 3s, refreshed at most once per second. While the stream is younger than the
  window the rate is averaged over its actual span (a steady stream shows its true speed from the
  first sample, no warm-up ramp); once the window is full a burst ages out over exactly 3s. A
  delivery silence of one full window or more (hidden server-side reasoning, buffering relays)
  starts a fresh measurement segment, so the rate right after a stall describes the resumed stream,
  not the stall. Streaming token counts are estimated from characters (providers only report
  authoritative token usage at the end of a message); `~` marks the value as an estimate.
- **When idle**: `⇢1.2s 45.3TPS` (dim color) for the last assistant message — time to first token
  and average decode speed. The speed numerator is the **visible** output (`usage.output −
  usage.reasoning`): tokens generated but never streamed (hidden reasoning) don't count. The
  average is suppressed when the decode window is too short to measure a rate (< 500ms, e.g.
  whole-message burst delivery) — a rate needs a minimum integration window.
- **Unmeasurable slots show `N/A`** instead of a misleading number: unknown TTFT (no request
  anchor), speed below the measurement limits (burst flush, no visible tokens), or `N/A` alone
  when nothing about a message could be measured.

Estimation splits text into CJK and non-CJK characters. Default ratios were calibrated against
~22.5k real assistant messages (~15.6M output tokens) with `scripts/analyze-token-ratio.mjs`:

| text    | chars per token |
| ------- | --------------- |
| CJK     | ≈ 1.0 – 1.3     |
| non-CJK | ≈ 3.8 – 4.0     |

On top of the defaults the extension **self-calibrates per provider/model**: after each completed
message it accumulates `(cjk, nonCjk, outputTokens)` samples and fits
`tokens ≈ a·cjk + b·nonCjk` online. The calibration data is cached in the OS temp directory
(`$TMPDIR/pi-my-pi/token-ratio.json`, override with `PI_MY_PI_CACHE_DIR`) — it is disposable and
never written to the pi agent dir.

Last-message stats are persisted as custom session entries, so the idle status survives restarts
and session tree navigation (branch switches restore the stats of the current branch).

## Install

```sh
pi install git:github.com/elpaca/pi-my-pi
# or, for local development:
pi -e /path/to/pi-my-pi
```

## Update

```sh
pi update --extensions
```

## Usage

```
/my-pi                 open the settings menu
/my-pi list            print all settings and current values
/my-pi <key> <value>   change a setting directly, e.g. /my-pi tokenSpeed.enabled off
```

Settings (persisted globally to `<agentDir>/my-pi.json`):

| key                        | default | description                                        |
| -------------------------- | ------- | -------------------------------------------------- |
| `tokenSpeed.enabled`       | `on`    | show token throughput in the status bar            |
| `tokenSpeed.showDuringStream` | `on` | show live TPS while streaming (idle stats always)  |

## Development

```sh
npm install
npm run check   # typecheck (tsc) + lint (biome) + test (vitest)
npm run format  # biome format
```

Layout:

```
extensions/my-pi/
├── index.ts                     entry: registers features and /my-pi
├── types.ts                     shared Feature / SettingSchema types
├── settings.ts                  global settings store (JSON file, atomic writes)
├── commands/settings-menu.ts    /my-pi command + interactive menu
└── features/token-speed/
    ├── index.ts                 event wiring + status rendering
    ├── metrics.ts               timing/counter state machine
    ├── estimator.ts             char→token estimation (CJK/non-CJK)
    ├── calibration.ts           per-model least-squares calibration cache
    └── format.ts                status text formatting
scripts/analyze-token-ratio.mjs  offline calibration analysis over session files
```

## License

MIT
