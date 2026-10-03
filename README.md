# pi-my-pi

Personal [pi](https://github.com/badlogic/pi-mono) package with small quality-of-life extensions.
Currently: **token speed** in the status bar, managed through a unified `/my-pi` settings menu.

## Features

### token-speed

Shows token counters and LLM throughput in the footer status line:

- **While waiting for the first token**: `I115.0k ⇢1.3s` — the estimated total input size
  (system + tools + messages, estimated once per request from the outgoing payload; static for
  the request, dim) plus a live elapsed counter (accent), ticking every 0.1s, so long
  server-side thinking is visible instead of a silent bar. Once the first token arrives the same
  counter carries over into the streaming display as the TTFT slot.
- **While streaming** the segments follow the temporal order of a request:
  `I115.0k ⇢1.3s T4.5k O3.7k ~45.3 TPS` — input goes out, the first token arrives (TTFT),
  thinking streams (`T`), then the visible output (`O`), and the rate describes the whole
  generation. The `O` and `T` counters refresh on **every** delta; the rate figure updates at
  most once per second. Parts that update in real time render in the accent color, frozen parts
  stay dim. While the stream is younger than the window the rate is averaged over its actual
  span (a steady stream shows its true speed from the first sample, no warm-up ramp); once the
  window is full a burst ages out over exactly 3s. A delivery silence of one full window or more
  (hidden server-side reasoning, buffering relays) starts a fresh measurement segment, so the
  rate right after a stall describes the resumed stream, not the stall. Streaming counts are
  estimated from characters (providers only report authoritative token usage at the end of a
  message); the `~` marks the rate as an estimate. `O` counts **non-thinking** output only
  (text + tool calls) — thinking belongs to `T`, so `T + O` tracks the total output. The `O`
  slot appears once that output is measurable (no `O0` placeholder during the thinking phase);
  the `T` slot appears only while thinking content is actually streamed — hidden reasoning
  stays invisible until the reliable end-of-message count.
- **When idle**: `I115.0k ⇢1.2s T4.5k O3.7k 45.3TPS` (all dim) for the last assistant message,
  same order. Reliable provider data wins over estimates: input from
  `usage.input + usage.cacheRead + usage.cacheWrite` (pi-ai reports the uncached input
  separately from cache; the sum is the total prompt, matching the payload estimate; otherwise
  the request-payload estimate is shown), thinking from `usage.reasoning` when reported
  (otherwise the streamed-thinking char estimate), output from `usage.output − thinking` so
  `T + O ≈ output` (hidden reasoning belongs to `T`, never to `O`). The speed numerator is the
  **visible** output (`usage.output − usage.reasoning`): tokens generated but never streamed
  (hidden reasoning) don't count. The average is suppressed when the decode window is too short
  to measure a rate (< 500ms, e.g. whole-message burst delivery) — a rate needs a minimum
  integration window.
- **Unmeasurable slots show `N/A`** instead of a misleading number: unknown TTFT (no request
  anchor), speed below the measurement limits (burst flush, no visible tokens), or `N/A` alone
  when nothing about a message could be measured. Fields with neither reliable data nor an
  estimate (e.g. `T` for a provider that neither streams thinking nor reports reasoning) are
  omitted. Token counts scale as `980`, `12.3k`, `1.23M`.

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
