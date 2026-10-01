# Fume Current Handoff

Operational state for a fresh session. Permanent rules: [CLAUDE.md](../CLAUDE.md). Design:
[ARCHITECTURE.md](../ARCHITECTURE.md) and the docs linked below. The repository (code, Git history,
this file) is the source of truth; do not reconstruct decisions from memory.

## Current status (2026-10-01)

- **Branch:** `stage-9/indicator-foundation` (local only), created from `main`.
- **`main`:** `7593b0cc14af450080055c812145366fedc40119` (Stage 8 squash merge, PR #8).
- **Stage 8 — Drawing UX: COMPLETE AND MERGED.**
- **Stage 9 — Indicator Foundation: defined below, NOT started.** Implementation needs an approved
  plan first.
- Everything runs locally (Vite + `wrangler dev`); nothing is deployed.

## Completed stages (all squash-merged into `main`)

| Stage | Content                                                                                        | `main` commit |
| ----- | ---------------------------------------------------------------------------------------------- | ------------- |
| 0     | Architecture, contracts, repository foundation                                                 | `c148b51`     |
| 1     | Custom Canvas 2D chart engine (`@fume/chart`)                                                  | `dab940f`     |
| 2     | Interactions: zoom/pan, crosshair + OHLC legend, auto/manual price scaling                     | `567aef4`     |
| 3     | Replay provider, live aggregation/reconciliation, older-history paging, Go to Latest           | `61b27b1`     |
| 4     | Cloudflare Worker + Alpaca IEX historical equities, canonical aggregation, `/api/v1`           | `59899da`     |
| 5     | Massive delayed futures streaming, feed-scoped Durable Object hubs, `@fume/datafeed`           | `3597927`     |
| 6     | `@fume/react` (`<FumeChartView />`), React `^18.2.0 \|\| ^19.0.0` peer; `apps/web` migrated    | `0a6831c`     |
| 7     | Drawing foundation: drawing layer, model, coordinates, tool state machine, three drawing tools | `a4e3926`     |
| 8     | Drawing UX: style editing, lock, visibility, duplicate, undo/redo, shortcuts, properties bar   | `7593b0c`     |

**Roadmap numbering:** [roadmap.md](roadmap.md) still lists its original plan (Stage 6 paper
trading, 7 trading on the chart, 8 recovery/hardening, 9 production deploy, …). Since Stage 6 the
owner directs the stages; those roadmap items are future work and get renumbered when approved.
Follow this file for the current stage.

## Current product

**Instruments** (`apps/web` selector; replay mode offers SPY, QQQ, AAPL, NVDA, TSLA):

| Group         | Symbols                         | Source                                                                        |
| ------------- | ------------------------------- | ----------------------------------------------------------------------------- |
| Stocks & ETFs | SPY, QQQ, DIA, AAPL, NVDA, TSLA | Alpaca IEX, history only (raw adjustment), RTH                                |
| Futures       | ES, NQ, YM, GC, SI, CL          | Massive Futures Starter, ~10 min delayed, live (delayed) stream, full session |

Futures roots resolve to a specific contract at runtime (e.g. `NQZ6 · Dec 2026`); contract months
are never hard-coded.

**Timeframes:** 1D | 4H | 1H | 15m | 5m | 1m (session-aligned buckets; CLAUDE.md).

**Chart:** custom Canvas renderer (three layers: candles, drawings, crosshair overlay), zoom/pan,
crosshair + OHLC legend, auto/manual vertical scaling, Go to Latest, historical paging,
session-aware compressed time, live (delayed futures) and replay data, shared stream multiplexing
(one socket per hub for any number of charts), embeddable `<FumeChartView />`.

**Drawings** ([drawings.md](drawings.md)): dedicated drawing canvas; anchors in market coordinates
(time + price); versioned schema (`fume.drawings` v1); hit-testing; selection; draggable handles;
whole-drawing dragging; Delete/Backspace; Escape cancels; Trend Line, Horizontal Line, Rectangle;
left drawing toolbar (rail) in the reference app. Drawings live in memory per instrument in
`apps/web` (lost on reload).

**Stage 8 drawing UX** (drawings.md "Drawing UX (Stage 8)"):

- Line color / width / solid-dashed-dotted editing; rectangle fill color / opacity (rgba in the
  existing `fillColor`; schema still v1).
- Lock / unlock; hide / restore; duplicate (5 bars later, 4% of the visible range lower).
- Undo / redo: drawing history lives in `@fume/chart` (`drawings/history.ts`), one step per
  completed user mutation.
- Keyboard shortcuts (Escape, Delete/Backspace, Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y, Ctrl+D), ignored
  in text fields; hosts may forward page keys to `handleKeyDown`.
- Improved selection and cursor behavior (selected drawing keeps hit precedence, 3 px drag
  threshold, locked drawings pan the chart).
- Reference app: contextual drawing properties bar, drawing list, undo/redo buttons in the rail.
- `@fume/react` stays a thin pass-through (handle methods delegate 1:1; no logic or history).

## Architecture in one screen

```
browser: apps/web ── @fume/react ── @fume/chart (Canvas)        @fume/datafeed ── /api/v1 (relative)
                                        └ type-only ─ @fume/core ─┘   (FumeApiDataFeed | ReplayDataFeed)
Worker (apps/worker): /api/v1 routes ── provider registry
   equities → Alpaca IEX REST (history)          futures → Massive REST + delayed WebSocket
   /api/v1/stream → FeedHubObject (Durable Object, one per feed key): ONE upstream per feed/account,
   subscription union, fan-out, reconciliation after reconnect, conflict hold on max_connections
```

- `@fume/core`: domain, sessions, session-aware time scale, canonical aggregation (higher
  timeframes built by Fume from canonical 1m), live aggregator.
- `@fume/datafeed`: headless `ChartSession` + `DataFeed` contract; one multiplexed stream
  connection per hub key (30 s idle close).
- `@fume/react`: thin binding; React is a peer dependency. Docs: [embedding.md](embedding.md).
- Provider details: ARCHITECTURE.md §6.1, [market-data.md](market-data.md),
  [research.md](research.md).

## Rules that matter most (full list: CLAUDE.md)

- Drawings never persist raw x/y pixels or bar indices; anchors are real timestamps + prices.
- Drawing logic stays in the engine (`packages/chart/src/drawings/`), never in React; the React
  wrapper stays thin (pass-through props/handle only).
- The host owns drawing persistence; the chart never saves.
- The browser never receives provider credentials and never connects to a provider.
- No TradingView, no Lightweight Charts, no third-party chart renderer.
- Never start a second Massive upstream connection (one Worker/hub process at a time; a second
  connection with the same key displaces the first: `max_connections`, close 1008).
- Do not hard-code futures contract months.
- Higher timeframes are built by Fume from canonical 1m; never taken from provider 1h/1d bars.
- Futures session handling stays session-aware (full Globex session with the daily break).
- Massive-derived data is not exposed to external users; cloud deployment of Massive data is
  blocked until Massive confirms the private-backend use in writing. Paper trading only, later.

## Local run

```
pnpm dev            # web only, replay mode (http://localhost:5173/)
pnpm dev:worker     # local Worker on 127.0.0.1:8787 (needs apps/worker/.dev.vars)
pnpm dev:api        # web + Worker; open http://localhost:5173/?source=api
                    # futures: ?source=api&symbol=NQ&asset=future&tf=5m
                    # two-chart proof: ?source=api&proof=two-charts
```

- Only one Worker process may run (it holds the Massive connection). The Worker only accepts the
  origin `http://localhost:5173`.
- Dev-only QA handles in the browser console: `__fumeFeed` (e.g. `streamDiagnostics()`),
  `__fumeView.current` (the `FumeChartViewHandle`: `getState()`, `getDrawings()`,
  `setDrawingTool()`); on the proof page `__fumeView1` / `__fumeView2`.
- Windows note: a long-running Vite dev server has occasionally stopped noticing file changes
  (stale module served). Touch the file or restart Vite before debugging "impossible" behavior.

## Quality gates (all must pass before a commit)

`pnpm test` · `pnpm typecheck` · `pnpm format:check` · `pnpm scan:secrets` · `pnpm build` ·
`pnpm scan:bundle`. Baseline on `main` after Stage 8: **760 tests in 52 files pass**; all gates
green. (Occasional 5 s timeouts under heavy machine load are transient; rerun the affected file
before treating them as failures.)

## Security state

- Credentials (Alpaca key/secret, `MASSIVE_API_KEY`) exist only in the ignored
  `apps/worker/.dev.vars`. Never print, read back, log or commit them; scans compare values
  without printing.
- The Worker accepts only local loopback requests (`FUME_ENV=local`); no production auth or
  deployment exists.

## Known limitations

- Drawings: no persistence across reload; no multi-select; no snapping/magnet (time snaps to bars,
  price is free); no z-order editing; no Fibonacci; no touch-specific UX; undo history is per
  chart and is cleared on a symbol switch.
- Drawings whose anchors lie outside the loaded calendar are hidden until that history is paged in.
- No crosshair/visible-range events on the engine API.
- No indicators yet; no brokerage/order execution; no trading-platform integration.
- Equities are history-only (no live Alpaca stream); `adjustment=raw` shows splits as price cliffs.
- Packages export TypeScript source (no compiled builds); no cross-origin backend auth.

## Next milestone: Stage 9 — Indicator Foundation (defined, NOT started)

Purpose: introduce the reusable indicator architecture and a first small set of indicators,
without coupling indicator calculations to React or the reference app. The implementation plan
must be approved before any code; scope is refined at that point. Likely scope:

- Framework-independent indicator model, lifecycle and calculation pipeline.
- Indicator rendering layer(s); price-overlay indicators and separate-pane indicators.
- Indicator settings; add / remove / update APIs.
- Indicator state owned by the chart/indicator engine, not React.
- First representative indicators to validate the architecture.

Out of scope until the plan is approved: AI-generated indicators, Pine Script, TradingView
compatibility, strategy/backtesting engine, alerts, brokerage/order execution, trading-platform
integration, cloud persistence, user accounts, marketplace/community scripts.

Starting points in the code: `ChartCoordinates` (`packages/chart/src/coordinates.ts`, the public
time/price ↔ pixel API meant for overlays and indicators), the layer pattern in `chart.ts`
(main / drawings / overlay canvases), the frame model (`frame.ts`), and canonical candles from
`@fume/core`. Note: ARCHITECTURE.md §4 still lists generic overlays (`HorizontalLine`, `Marker`)
and `visibleRangeChanged` / `crosshairMoved` events from the Stage 0 plan; **none of these exist
in the engine today**.

## Stage workflow reminder

Branch per stage → implement → gates → owner visual review → commit/push only when told → PR →
owner squash-merges → fast-forward `main`, verify the stage content by tree → next branch. Never
start the next stage, push, open a PR or merge without explicit approval. No `Co-Authored-By`.

## Fresh-session checklist

1. Read `CLAUDE.md`, then this file.
2. `git status`, `git log --oneline -5` (expect `main` at `7593b0c`).
3. For Stage 9: ARCHITECTURE.md (§4 chart engine boundary, §4.2 layers), the chart/rendering
   code it points to, [embedding.md](embedding.md) (public `@fume/chart` / `@fume/react` surface),
   and [drawings.md](drawings.md) only for the reusable overlay patterns (coordinates, layer,
   framework-free controller, history).
