# Fume architecture

Status: **describes the system as built through Stage 9** (2026-10-01; current stage and next
action: [docs/HANDOFF.md](docs/HANDOFF.md)). Parts that are planned but not built are labelled
**planned**. Provider facts are labeled in [docs/research.md](docs/research.md).

## 1. Shape of the system

```
Browser (single user, apps/web)                     Cloudflare Worker (apps/worker, local wrangler dev)
┌───────────────────────────────────────┐  HTTP    ┌──────────────────────────────────────────────┐
│ @fume/react  <FumeChartView />         │ /api/v1  │ router: origin check → local auth → validate │
│  ├─ @fume/chart (Canvas engine:        │─────────▶│ provider registry (per asset class)          │──▶ Alpaca IEX REST
│  │   candles, drawings, indicators)    │          │   equities/ETFs: history                     │    (history)
│  │   └─ @fume/indicators (pure math)   │   WS     │   futures: history + delayed stream          │──▶ Massive REST
│  └─ @fume/datafeed (ChartSession,      │◀────────▶│ /api/v1/stream → FeedHubObject (Durable      │◀─▶ Massive delayed
│      FumeApiDataFeed / ReplayDataFeed) │ /stream  │   Object, one per feed key, ONE upstream)    │    WebSocket
└───────────────────────────────────────┘          └──────────────────────────────────────────────┘
```

**Planned (not built):** paper trading through Alpaca's Trading API (order panel, positions,
`trade_updates`), production deployment behind Cloudflare Access.

- **The browser only talks to Fume.** Alpaca credentials exist only in Worker secrets.
- **Provider adapters sit at the boundary.** Provider payloads are converted into `@fume/core` types inside `apps/worker/src/providers/<provider>/` (`alpaca`, `massive`) and nowhere else.
- **Planned:** Alpaca will be authoritative for orders, fills, positions, buying power and account state; Fume will hold no persisted trading state.

## 2. Recommended stack

| Concern                | Choice                                                                                                                                                                                                 | Why                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language               | TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)                                                                                                                          | You asked for it. One language across chart, core, backend and tests. Strictness catches coordinate and nullable-price bugs.                                         |
| Package manager        | pnpm workspaces (pnpm 10.26.1 is installed)                                                                                                                                                            | Workspaces keep `core`, `chart` and the `worker` as separate packages, so the dependency direction is enforceable. No monorepo framework (Nx/Turbo) is needed.       |
| Chart rendering        | **Canvas 2D, hand-written**, in `@fume/chart`                                                                                                                                                          | Required. Canvas 2D handles thousands of candles if we only draw the visible range. WebGL stays off the table unless profiling shows Canvas can't keep up (risk R8). |
| Frontend build         | Vite                                                                                                                                                                                                   | Fast dev server, minimal config, first-class TS.                                                                                                                     |
| App UI shell           | **React + TypeScript (Vite), decided in Stage 0.** The chart engine stays framework-independent                                                                                                        | See §2.1.                                                                                                                                                            |
| Backend                | One Cloudflare Worker with a small hand-written router                                                                                                                                                 | About ten routes. A router library isn't needed yet; Hono is a fine fallback if routing grows.                                                                       |
| Real-time coordination | **One Durable Object class, `FeedHubObject`, one instance per feed key** (approved after spike S3; §6, §6.1)                                                                                           | One upstream per provider feed/account, shared by every browser tab.                                                                                                 |
| Storage                | **None** (no D1, KV or R2)                                                                                                                                                                             | See §7.                                                                                                                                                              |
| Validation             | Hand-written validators in `@fume/core` for the few request shapes                                                                                                                                     | Three request bodies don't justify zod. Revisit if the contract grows.                                                                                               |
| Tests                  | Vitest 4.1.x (see §9.2). Worker code is tested in Node's Fetch API with injected `fetch` (Stage 4); `@cloudflare/vitest-pool-workers` only if Stage 5 needs DO tests. Playwright only for Stage 11 E2E | Same test runner everywhere. Deterministic pure-function tests make up most of the suite.                                                                            |
| Formatting             | Prettier                                                                                                                                                                                               | One tool, zero-config debates. ESLint is deferred until there's code to lint.                                                                                        |
| Runtime                | Node ≥ 22 locally (24.18.0 installed). Workers runtime in production                                                                                                                                   |                                                                                                                                                                      |

### 2.1 Decision: React shell, framework-independent chart engine

**Choice:** `apps/web` is a minimal React + TypeScript Vite app. `@fume/chart` is plain TypeScript with no React import (`new FumeChart(element, options)`, `destroy()`).

**Why React for the shell and not plain TypeScript:**

- The (planned) order panel, positions and open-order list, plus today's connection status and feed label, are reactive views of fast-changing state. In plain TS we would hand-write a small view/diff layer. That's exactly the kind of custom infrastructure to avoid.
- Deciding now avoids rewriting the Stage 1–5 toolbar and status UI in Stage 6.
- React is the most likely integration target for "another frontend consumes Fume". The package boundary means a non-React consumer still uses `@fume/chart` directly.

**Guardrails that keep this small:**

- Dependencies: `react`, `react-dom`, `@vitejs/plugin-react`. No router, no state library, no UI kit, no CSS framework.
- React never renders the chart. `<FumeChartView>` (`@fume/react`, Stage 6) owns a `<div>`, creates `FumeChart` + `ChartSession` in an effect, forwards props into imperative calls and disposes both on unmount. React re-renders never touch the Canvas.
- Market data flows `DataFeed` → `ChartSession` (`@fume/datafeed`) → `FumeChart` directly, bypassing React; React only receives status callbacks. Drawing and indicator state live in the chart engine. (No framework-free state stores or `useSyncExternalStore` exist yet; trading state, when built, is planned to follow the same pattern.)
- The React wrapper for external consumers was extracted in Stage 6 as `@fume/react` (`<FumeChartView />`, docs/embedding.md); `apps/web` consumes it like any other host.

**Alternative rejected:** plain TypeScript for everything. It has fewer dependencies, but it means building our own reactive UI plumbing for the trading panel, and it gives no integration advantage.

## 3. Repository structure

```
fume-trading-chart/
├─ packages/
│  ├─ core/      @fume/core: domain types, provider ports and the pure logic (sessions,
│  │             time scale, canonical + live candle aggregation, EventTime; later the order
│  │             state machine and P&L). No DOM, no provider code.
│  ├─ chart/     @fume/chart: Canvas chart engine: panes, candles, drawings, indicator panes and
│  │             overlays, crosshair. Provider-neutral.
│  ├─ indicators/ @fume/indicators: pure indicator definitions, schema, incremental calculations
│  │             (Stage 9, docs/indicators.md). No dependencies.
│  ├─ replay/    @fume/replay: deterministic ReplayMarketDataProvider (Stage 3). Offline.
│  ├─ datafeed/  @fume/datafeed: headless ChartSession + DataFeed contract, FumeApiDataFeed
│  │             (HTTP + one multiplexed stream per hub), ReplayDataFeed (docs/embedding.md).
│  └─ react/     @fume/react: <FumeChartView /> React binding (React is a peer dependency).
├─ apps/
│  ├─ web/       Vite + React shell: <FumeChartView /> from @fume/react, app chrome only
│  └─ worker/    Cloudflare Worker: router, registry, FeedHubObject DO, provider adapters
│     └─ src/providers/{alpaca,massive}/, src/hub/
├─ docs/         contracts, designs, research, roadmap
└─ ARCHITECTURE.md, README.md, .env.example
```

**Dependency rules.** Violating these fails review:

- `core` → nothing.
- `chart` → `core`, **type-only** (approved at Stage 1 review, 2026-09-29). `@fume/chart` may `import type` canonical domain contracts from `@fume/core`, such as `Bar`, `TimeScaleMapping` and the formatter/domain types, so the chart consumes the Stage 0 model instead of a second candle model. It must **not** gain a runtime dependency on `@fume/core`: no value imports, and `@fume/core` stays a `devDependency` of the chart package, used only for type resolution. Changing this needs an explicit architecture review. Enforced by `test/boundaries.test.ts`.
- `chart` → `indicators` (runtime, Stage 9): the only package that imports `@fume/indicators`.
- `indicators` → nothing (no dependencies at all; pure TypeScript). Core, replay and datafeed never import it.
- `replay` → `core` (runtime). A provider adapter; it implements the core `MarketDataProvider` port. Core and chart never import it.
- `datafeed` → `core`, `replay` (runtime), `chart` (**type-only**). Framework-free and provider-neutral; the only network code is its Fume API client (`fetch`) and stream connection (`WebSocket`), with a configurable base URL, auth hook and socket factory. Core, chart and replay never import it.
- `react` → `core`, `chart`, `datafeed` (runtime); `react` is a **peer** dependency. A thin binding: no provider code, no network calls, no candle/session logic of its own. Core, chart, replay and datafeed never import it.
- `web` → `core`, `chart`, `datafeed`, `react`, `replay`, only through their public entry points; it makes no network calls itself (the DataFeed does, to Fume's `/api/v1`, never a provider host).
- `worker` → `core` (runtime), `wrangler` (dev only). Provider payload types, hosts and header names live only in `apps/worker/src/providers/<provider>/`.
- Nothing imports from `worker/src/providers/*` except the Worker's composition root.

## 4. Chart engine boundary

The engine is one class per chart instance. It is fed data and reports user intent back to the app.

**The chart engine owns:**

- Canvas setup: device-pixel-ratio scaling, resize via `ResizeObserver`, and layering (a static layer with every pane, a drawing layer and an overlay/crosshair layer).
- Panes (Stage 9): the main price pane plus zero or more indicator panes stacked above one shared time axis, each with its own vertical scale ([docs/indicators.md](docs/indicators.md)).
- The viewport model: slot spacing, right offset, visible logical slot range, price range, auto-scale on or off.
- Coordinate transforms: slot ↔ x and price ↔ y. These are pure and unit-tested. Time ↔ slot goes through the injected **time-scale mapping** (below). The public `ChartCoordinates` (time/price ↔ x/y, Stage 7) is what drawings and future overlays use.
- Rendering bars at their slot positions. Empty slots stay empty, and session separators are drawn where the mapping reports boundaries.
- Rendering of the grid, candles (body and wick), price scale, time scale, crosshair, OHLC legend, and current-price line and label.
- Drawings (Stages 7–8, [docs/drawings.md](docs/drawings.md)): model, tool state machine, hit-testing, editing, undo/redo, rendering. The host owns persistence.
- Indicators (Stage 9, [docs/indicators.md](docs/indicators.md)): runtime state, incremental recalculation, panes, scaling, rendering, legend. Definitions and math live in `@fume/indicators`; the host owns persistence.
- Interaction: drag-pan, wheel/trackpad zoom around the cursor, price-scale drag to rescale, double-click to reset auto-scale, drawing tools and drawing keyboard shortcuts.
- Events (callbacks): `onNeedsOlderData` (the left edge is near the first loaded bar), `onFollowingLatestChange`, the drawing callbacks and `onIndicatorsChange`. There are **no** `visibleRangeChanged` / `crosshairMoved` events; the view and crosshair are readable through getters (`getView`, `getCrosshair`, `getLastFrame`, `getCoordinates`).
- **Planned, not built:** generic app-supplied overlays for trading visuals (order/position lines, execution markers); they are expected to reuse `ChartCoordinates` and the drawing/indicator layer patterns.
- Formatting, which it delegates to injected `formatPrice(p)` and `formatTime(t, granularity)` functions built from `Instrument.priceFormat` and `session.timezone`.

**The chart engine must NOT own:**

- Networking, WebSockets, providers or retry logic.
- Candle aggregation or live-bar construction (that's `@fume/core`; the chart only receives `setBars`, `upsertBars` and `prependBars`).
- Session calendars (it receives a `TimeScaleMapping`).
- Trading state, order logic or P&L math (planned: the app computes these and passes lines and markers).
- Symbol semantics ("SPY", "shares", "$"), market hours, time zones or holidays beyond the formatter it's given.
- Any global state. Two charts on one page must not interfere.

### 4.1 Session-aware time axis (boundary defined now, built incrementally)

The chart's horizontal axis is a sequence of **slots**, not a list of bars. The chart never computes calendars itself. It receives a mapping object:

```ts
interface TimeScaleMapping {
  /** Slot coordinate for a time. Fractional within a slot; null if the time is in compressed (scheduled-closed) time. */
  toSlot(timeMs: number): number | null;
  /** Start time of a slot. Valid for any integer slot, including future slots right of the last bar. */
  slotStart(slot: number): number;
  /** Boundaries in [from, to] for separators and labels (session start, day, week, month). */
  boundaries(
    fromSlot: number,
    toSlot: number,
  ): readonly { slot: number; kind: 'session' | 'day' | 'week' | 'month' | 'year' }[];
  /** Stage 7: continuous coordinate for any time (closed time collapses to the next open slot; null outside the calendar). */
  timeToSlotCoordinate(timeMs: number): number | null;
  /** Stage 7: inverse; real open-market time for a coordinate, null outside the resolved slots. */
  slotCoordinateToTime(slot: number): number | null;
}
```

Rules the mapping implements:

- **The mapping is built for a session mode.** In `regular` mode (the MVP default, Q4), only regular windows are "open". Pre/post-market time is compressed like nights. In `extended` mode (supported later), every scheduled window is open.
- **Scheduled closed time is compressed:** nights, weekends, holidays, futures maintenance breaks and (in regular mode) extended hours. It comes from `MarketSession.windows`, which can cross midnight and contain several windows per session.
- **Time inside an open window is linear, in slots that match the canonical session-aligned buckets** (market-data.md). A window's last slot may be shorter (1h: 15:30–16:00), but it's still one slot. A slot with no bar is a **visible, genuine data gap**. That's how missing data during an active session stays distinguishable from a scheduled closure.
- **Daily timeframe:** one slot per `sessionDate`.
- **No calendar, no axis:** a "bar-index mode" fallback was planned but is **not implemented**. Without resolved sessions the placeholder `EMPTY_TIME_SCALE` maps nothing and no bars are shown; the DataFeed always supplies sessions (a weekly futures schedule fills dates the provider schedule does not cover).

**Implementation plan:**

| Stage | What gets built                                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | The chart consumes the interface. The generated-data demo uses a simple fixed weekly RTH schedule mapping (09:30–16:00 ET, weekdays), which proves compression and visible gaps. |
| 3     | `@fume/core` builds the real mapping from `MarketSession[]`, with tests for DST days, holidays, early closes and a futures-style session crossing midnight with a break.         |
| 4     | Real sessions come from the provider through `/api/v1/sessions`.                                                                                                                 |

Nothing in the chart assumes that bar _i_ sits at slot _i_.

A per-user option to also compress empty in-session slots is **not** in the MVP. It could be added later without changing the interface, and would help thin extended-hours IEX data.

### 4.2 Layers and interaction (Stage 2, extended in Stages 7 and 9)

**Three canvases per chart** (two until Stage 7). All are owned by `FumeChart`, sized together from the same backing-store computation (DPR-correct), and removed by `destroy()` together with every listener.

| Layer                   | Draws                                                                                      | Repainted when                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Main canvas             | Every pane: grid, candles, price-overlay and pane indicators, axes, separators, last price | Data, view, price scale, size or indicator change                                    |
| Drawing canvas          | User drawings, hover, handles, unfinished-drawing preview                                  | After each main repaint, and on drawing/selection/hover changes (no frame rebuild)   |
| Overlay canvas (on top) | Crosshair lines and readouts (across panes), OHLC and indicator legends                    | Every pointer move (no frame rebuild, no recalculation), and after each main repaint |

The overlay receives all pointer, wheel, double-click and key events (drawings first: docs/drawings.md); the main and drawing canvases have `pointer-events: none`.

**Atomic data replacement.** `chart.setData({ bars, timeScale, formatPrice, formatTime, minPriceStep, barSpacing?, rightOffset? })` replaces the series, its time scale and formatters in one step, then resets the view (latest bars, the given default spacing), the price scale (AUTO) and the crosshair. Symbol and timeframe switches use it, so no slot index, label or price range from the previous dataset can survive. `setBars` / `setOptions` remain for single-property changes.

**Horizontal viewport** (`view-state.ts`, pure). The view is `{ barSpacing, rightOffset }`, the exact inputs of the Stage 1 viewport.

- Wheel or trackpad pinch over the **plot** zooms, anchored at the slot under the pointer. On or right of the latest bar, the right offset in slots is kept instead, so the live edge does not jump. Mostly horizontal trackpad scrolling pans.
- Drag in the **plot** pans with pointer capture.
- Bounds: spacing 1–60 CSS px; at least 5 bars stay visible at either pan extreme; empty space right of the latest bar is at most 60% of the plot.

**Vertical price scale** (`price-scale-state.ts`, pure). Two modes:

| Mode           | Price range                                                         | Entered by                                                                                      |
| -------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| AUTO (default) | Fitted to the visible bars on every repaint (Stage 1 behavior)      | Initial state; double-click on the price axis; `resetPriceScale()`; any `setData` / `resetView` |
| MANUAL         | An absolute price range kept through horizontal pan/zoom and resize | Drag or wheel on the **price axis**                                                             |

- **Price-axis drag** (primary button, pointer capture): dragging down compresses (larger range), up stretches (smaller range), continuously: `factor = exp(dy * 0.005)`, always recomputed from the range at drag start. The price under the pointer at drag start keeps its height.
- **Price-axis wheel**: scrolling down compresses, up stretches, anchored at the price under the pointer, at most 2x per event. A wheel event over the price axis never zooms horizontally; one over the plot never touches the price scale.
- **Limits**: range span at least two ticks, and at most the larger of 20x the whole data's price span and half the mid price. Results are always finite and positive.
- Only the price → y transform changes; bar prices are never modified. The manual range is passed into `buildFrame`, so candles, ticks, the crosshair and its label all use the same active price scale.

| Event                                  | Price-scale behavior                                               |
| -------------------------------------- | ------------------------------------------------------------------ |
| Horizontal pan / zoom                  | AUTO refits; MANUAL keeps its range                                |
| Container resize / DPR change          | AUTO refits; MANUAL keeps the same price range over the new height |
| Symbol or timeframe switch (`setData`) | Reset to AUTO                                                      |
| Double-click on the price axis         | Reset to AUTO                                                      |

### 4.3 Live data path (Stages 3 and 5)

```
DataFeed.subscribe (ReplayDataFeed, or FumeApiDataFeed → /api/v1/stream hub)
  │ MarketEvent[] (trade, 1s/1m bar final/revised/provisional, status)
  ▼
ChartSession (@fume/datafeed, framework-free)         DataFeed.getBars / getSessions (1m seed)
  │ subscribe + buffer → load history → applyBufferedHandoff → live
  ▼
LiveCandleAggregator (@fume/core, pure)
  │ minute state: official > provider provisional > trade-built
  │ foldBuckets(displayed timeframe) → canonical upserts (aggregateBars)
  ▼
FumeChart.upsertBars / setData / prependBars (@fume/chart)
```

- **Timestamps** are exact: `EventTime.ns` is parsed from RFC 3339 with BigInt and compared as canonical strings (`event-time.ts`); trade order is `(time.ns, ingestSeq)`.
- **The aggregator** keeps minute state for a bounded window (2 × 1440 minute slots behind the newest event), de-duplicates trades by `venue + tradeId` in a bounded set (10,000), and re-folds only the canonical buckets that contain changed minutes. Buckets that start before the seeded/retained coverage are never re-folded; late events for pruned minutes are dropped and counted (`diagnostics()`).
- **Timeframe switches** re-aggregate the same minute state with `aggregateBars` (no resubscription). **Symbol switches** resubscribe and rebuild through the handoff.

### 4.4 Incremental chart updates and history loading (Stage 3)

| API                                           | Behavior                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setData(data)`                               | Replaces the series atomically; resets view (latest bars, default spacing), price scale (AUTO), crosshair and the older-data state. Used for symbol/timeframe switches.                                                                                                                                                                                                       |
| `upsertBars(bars)`                            | Live updates. Same start → replaced in place (binary search, no allocation); later start → appended. Zoom, pan, MANUAL price scale and the crosshair pointer are kept. **Live edge:** if the latest bar was on screen, the view follows the new bar; if the user panned back, `rightOffset` shifts by the slot delta so nothing on screen moves (also while dragging).        |
| `prependBars(bars, { hasMore?, timeScale? })` | Older history. Bars are placed by time-scale slot and the view is anchored to the latest slot, so visible x positions do not change; an optional wider `timeScale` re-slots everything under the same anchor. Completes a pending older-data request.                                                                                                                         |
| `onNeedsOlderData({ before })` option         | Fires once after a main repaint when the left edge of the view is within half a screen (≥ 10 slots) of the oldest bar. State then stays `pending` until `prependBars` (→ `idle`, or `exhausted` with `hasMore: false`) or `resolveOlderDataRequest(hasMore)`. A resolve without bars does not re-trigger immediately (no request storms); the next interaction may ask again. |

### 4.5 Historical data path (Stage 4; futures added in Stage 5)

```
Browser  ?source=api                        Worker (wrangler dev, 127.0.0.1:8787)            Providers
ChartSession + FumeApiDataFeed ──/api/v1──▶ router: origin → local auth → validate    Alpaca data/paper API (equities)
  (relative URLs, @fume/datafeed)   loadCanonicalPage (provider-neutral)  ──HTTPS──▶  Massive REST (futures)
  chart.setData / prependBars       └ core: selectBaseInterval + buildCanonicalBars
```

- **Worker layout:** `index.ts` (composition root, the only importer of `providers/*`), `router.ts`, `registry.ts`, `cors.ts`, `auth.ts`, `validate.ts`, `errors.ts`, `canonical-history.ts`, `hub/` (feed hub Durable Object), `providers/alpaca/`, `providers/massive/`.
- **Provider port:** the Alpaca adapter implements `HistoricalMarketDataProvider` (the history half of `MarketDataProvider`; no stream until Stage 5).
- **One `/bars` request:** calendar sessions before `end` until they hold `limit` canonical slots (or the 2016 floor) → coarsest verified native interval that nests (`[1, 5, 15]` after S1) → one ranged base-bar fetch → `buildCanonicalBars` → newest `limit` candles. If the fetch was truncated, candles older than the oldest base bar are dropped (never a partial candle).
- **Browser (`ChartSession`):** a switch starts a new generation (requests aborted, late responses ignored). Older pages use `end = oldest loaded start`, one in flight, then `prependBars` with a time scale rebuilt from cached sessions.
- **Local dev topology:** Vite (5173) proxies `/api` to the Worker; no backend URL is compiled into the app.

**Performance rule:** each frame draws only the visible bars. Updating the live bar redraws the frame, but no layout is recomputed unless the viewport changed. Updates are batched through `requestAnimationFrame`.

## 5. Frontend/backend boundary

| Browser (`apps/web`)                                                                                                                                                                               | Backend (`apps/worker`)                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Rendering, interaction, form input                                                                                                                                                                 | All provider communication and credentials                                              |
| Aggregates normalized live events (each trade, current-bar updates, official/revised minute bars) into the displayed timeframe, updating the active candle on every trade (pure `@fume/core` code) | Historical bar retrieval, paging, normalization                                         |
| **Planned:** holds a derived projection of trading state (streamed events applied immediately, reconciled by broker snapshots)                                                                     | **Planned:** validates every trading request (see [docs/security.md](docs/security.md)) |
| **Planned:** generates `clientOrderId` (the idempotency key); never decides that an order filled                                                                                                   | Maps domain requests to provider calls; maps provider errors to `ProviderError`         |
| Computes drawings and indicators locally (`@fume/chart`, `@fume/indicators`)                                                                                                                       | Owns the single upstream stream connection per feed (`FeedHubObject`)                   |

Contracts: [docs/http-api.md](docs/http-api.md) and [docs/websocket-api.md](docs/websocket-api.md), both versioned under `/api/v1`.

**Origins.** The standalone deployment serves the frontend and API from one Worker, so **same-origin is the default**, not a permanent assumption. The backend reads an explicit allowlist, `FUME_ALLOWED_ORIGINS`, which defaults to the app's own origin. Every HTTP request with an `Origin` header, and every WebSocket upgrade, is checked against it, and CORS headers are emitted only for allowlisted origins. Adding the external trading platform later is a configuration change plus an authentication method (below), not a redesign.

**Origin checks are not authentication.** The two are separate middleware steps:

1. `checkOrigin(request, allowlist)` limits which browser pages may call Fume. It protects against CSRF and cross-site WebSockets.
2. `authenticate(request) → Principal | reject` establishes who is calling. Standalone: a Cloudflare Access identity. For the external platform (Stage 10), a second authenticator is added, such as an Access service token or a short-lived signed token issued by that platform's backend. Authorization (paper-only, a single account) runs on the `Principal`, never on the origin.

See [docs/security.md](docs/security.md).

## 6. Decision: Durable Objects (**CONDITIONAL: one class, from Stage 5, only if spike S3 and a cost/lifecycle check pass**)

The default was "no." These are the concrete problems a DO would solve:

1. **Upstream connection limit.** Alpaca allows **1** market-data connection per endpoint on common plans (VERIFIED). A plain Worker can only hold a WebSocket for the lifetime of the request that opened it, so each browser socket would open its own upstream connection. Two tabs, a refresh that overlaps with the old socket, or `wrangler dev` running next to production would all get **error 406**. A single addressable object (`idFromName("default")`) is the only Workers primitive that lets every browser connection share **one** upstream socket.
2. **One subscription set.** The hub keeps a reference count of desired `MarketSubscription`s across clients and applies them declaratively. After an upstream reconnect it resubscribes from that set.
3. **One trade_updates listener** that fans out to every tab, and that triggers a single account/position refresh after each fill. N tabs don't each refetch.
4. **One place to handle reconnect**, with backoff, stale detection, and `resync_required` broadcasts.

The DO does **not** hold authoritative trading state and does not use DO storage in the MVP.

**Cost and lifecycle: what we know and what we don't** (see [docs/research.md](docs/research.md)).

USER-PROVIDED facts:

- DOs can act as outbound WebSocket clients.
- DOs are available on Workers Free with SQLite-backed storage.
- Hibernation does not apply to outbound WebSockets.
- An active outbound WebSocket keeps the DO non-hibernatable, so it can incur **duration** usage.

Consequences:

- **The DO is billable the whole time the upstream sockets are open**, whether or not a browser is sending anything. An open chart tab with an idle user still counts. A chart left open through a trading day means many hours of duration per day.
- Closing the upstream sockets about 60 s after the **last browser disconnects** reduces cost when nothing is open. It does **not** make an open-but-idle tab free.
- We don't yet know the Free-plan duration allowance, the overage price, or whether the runtime ever evicts a DO holding an outbound socket. **These are measured, not assumed:** spike S3 includes a cost/lifecycle run.

**Gate before committing to the DO (end of spike S3):**

1. The DO holds both Alpaca sockets (text and binary frames) through at least one full regular session, with every disconnect logged.
2. The dashboard's duration usage for that run is recorded and extrapolated to "chart open 6.5 h/day" and "16 h/day (extended hours)". It must fit the Free allowance, or a cost you explicitly accept.
3. Eviction and restart behavior is observed, and it's compatible with the `resync` design.

**If the gate fails,** the fallback needs no DO. A stateless Worker relays per browser connection, and the client enforces a **single active tab** (a BroadcastChannel lock). A second tab shows "open elsewhere". On refresh, the new relay waits for and retries a 406 with backoff. This is worse, but workable for one user.

Stages 1–4 need no DO in either case.

**OWNER DECISION (2026-09-30): GO — Durable Objects approved as the shared real-time hub
primitive.** This approves the hub _primitive_, not the permanent topology, which waits for the
futures-provider / multi-provider checkpoint. **Checkpoint outcome (2026-09-30):** the preferred
topology is **provider/feed-scoped DO hubs** (one hub per provider feed, each owning its own
upstream, subscriptions, limits, reconstruction and resync); it is not implemented and is confirmed
when permanent streaming is approved (§6.1).

Evidence (S3, [research.md](docs/research.md)): one Alpaca upstream served multiple downstream
clients; Run B stayed live beyond 15 minutes while a downstream client was connected; natural
reconstruction and a redeploy each released the Alpaca slot cleanly; no 406 race observed; forced
upstream recovery ~1.1 s; the ~60 s no-client upstream close worked; measured single-hub usage
fits the Free-plan duration allowance for the tested patterns.

**Required permanent-design constraints:**

1. Durable Object in-memory state is disposable.
2. Reconstruction must be expected (eviction ~15 min after the last request with only an
   outbound socket; hibernation shortly after going idle; every deploy).
3. State needed across reconstruction must be persisted or recoverable.
4. After every upstream reconnect or reconstruction: re-authenticate, re-subscribe, perform a
   bounded recent-history resync, and reconcile with official bars.
5. Streamed trades are best-effort / provisional.
6. Official bars remain authoritative for reconciliation.
7. Keep the ~60 s last-client idle close unless later evidence justifies changing it.
8. `406` means the provider slot is still occupied: bounded backoff, never a tight retry loop.
9. The two observed minute-count shortfalls (S3) remain unresolved and belong to S4.
10. Their cause is **not** known and must not be described as known.

### 6.1 Multi-provider routing and feed-scoped stream hubs (Stage 5, merged)

**Routing (Worker, provider-neutral).** `apps/worker/src/registry.ts` registers one market-data
FEED per asset class; only the composition root (`src/index.ts`) names providers:

| Feed                              | Asset classes | Instrument ids   | History (1m base bars) | Stream key (opaque) |
| --------------------------------- | ------------- | ---------------- | ---------------------- | ------------------- |
| Alpaca IEX (Stage 4, unchanged)   | equity, etf   | `eq:SPY`         | `providers/alpaca`     | none (history only) |
| Massive Futures Starter (delayed) | future        | `fut:NQ:2026-12` | `providers/massive`    | `futures-delayed`   |

The router resolves symbols by asset class (`/instruments/resolve?symbol=NQ&assetClass=future`),
loads instruments by id namespace, and serves bars/sessions through the instrument's
`marketDataRef.providerId`. The browser only ever sees provider-neutral `Instrument`s,
`DataFeedInfo` (with `delayMs`) and an opaque stream key. Brokerage stays a separate port.

**Hubs.** One Durable Object class (`FeedHubObject`), **one instance per stream key** (per provider
feed); Alpaca and Massive are never combined in one object. Each instance runs a provider-neutral
`FeedHub` (`src/hub/feed-hub.ts`):

```
browser tabs --ws /api/v1/stream?key=futures-delayed--> Worker (origin + auth) --> FeedHubObject("futures-delayed")
                                                                                  └─ ONE upstream (delayed futures WebSocket)
```

- **Subscription union:** clients subscribe Fume instrument ids; the hub reference-counts them and
  applies the union declaratively to the single upstream (`A.<contract>`/`AM.<contract>` for the
  futures feed). Last subscription gone -> upstream closed after a 60 s idle grace (S3).
- **Fan-out:** normalized `MarketEvent`s only to the clients subscribed to that instrument.
- **Recovery:** after every upstream (re)connect the hub re-fetches the last 30 min of COMPLETED
  1-minute bars (in delayed time) from REST and sends them as authoritative `1m final` bars. No
  stream replay is assumed. REST failure -> clients get `resync` and re-fetch the tail themselves.
- **Single-connection feeds:** a displaced upstream (`max_connections` / close 1008) becomes
  reason `connection_conflict` with a 60 s .. 15 min hold; the hold is persisted in DO storage so a
  reconstructed hub does not fight the other process; clients see "feed in use elsewhere".
- **Reconstruction:** in-memory state is disposable. Downstream sockets use the Hibernation API;
  their attachments hold each client's subscriptions, so a new instance rebuilds the union from
  `getWebSockets()`, reconnects upstream and tells clients to resync. The stream key is persisted.
- **Stream ports:** core `StreamingMarketDataProvider` (channels declared per feed). Feeds without
  trades deliver `bar` events with `interval: '1s'` (provisional) and `'1m'` (final); consumers
  never assume trade-level data.

**Client.** `@fume/datafeed`'s `FumeApiDataFeed` keeps one multiplexed `StreamConnection` per
hub key on the page's own `/api/v1/stream`; `ChartSession` does the documented handoff (history +
1m seed + buffered events -> `LiveCandleAggregator`) and re-fetches the tail after reconnects,
sequence gaps and hub restarts ([docs/embedding.md](docs/embedding.md)). Delay is shown from
`DataFeedInfo.delayMs` ("Delayed ~10m"), never "live".

**Not in this build:** Alpaca streaming (equities stay history-only), deployment (local
`wrangler dev` only; Durable Objects run locally).

## 7. Decision: database (**NO**)

The MVP has no application-owned data that must persist:

- Orders, fills, positions and account state come from Alpaca (authoritative) and are re-fetched on demand.
- Historical bars come from Alpaca. Caching, if ever needed, would use the Workers Cache API, not a database.
- Fill markers after a refresh come from broker execution history (spike S6).
- UI preferences (last symbol and timeframe) live in `localStorage` in the browser, which is harmless.

We'd reconsider only for a real requirement: an app-owned audit log of submitted orders, user settings synced across devices, or multi-user support.

## 8. Futures readiness

The core model already carries what futures need (`packages/core/src/instrument.ts`): tick rules, fractional price formats, a contract multiplier, a session spec whose windows can cross midnight, a session date that belongs to the _ending_ day, a `future` block (root, contract month, expiration, tick value), and separate market-data and brokerage provider refs. A futures provider plugs in as another `MarketDataProvider` / `BrokerageProvider` pair.

**Implemented (Stage 5, 2026-09-30):** futures ES, NQ, YM, GC, SI and CL through the registered
futures feed (Massive Futures Starter, ~10 min delayed). A root resolves to a specific contract from
reference data (nearest non-expired contracts ranked by delayed session volume; explicit contract
codes also resolve); sessions come from the provider trading schedule (holidays/early closes,
de-duplicated), with the weekly Globex schedule only for dates the schedule does not cover; canonical
5m..1d candles are built by Fume from 1-minute bars on the 17:00 CT session grid.

**Provider-neutral futures conclusions (checkpoint research 2026-09-30):**

- The five target roots are verified CME Group products on four DCMs: GC and SI (COMEX), CL
  (NYMEX), NQ (CME), YM (CBOT). A futures feed therefore needs entitlements on all four.
- The existing session model is sufficient: CME Globex trades Sunday 18:00 ET to Friday 17:00 ET
  with a daily 17:00–18:00 ET break, and the trading day is the day the session ends, which
  `MarketSession` windows and `sessionDate` already express. Holidays and early closes need a
  schedule source (provider schedule API or CME calendar).
- Neither CME nor the reviewed vendors publish exchange-official 1-minute bars; futures bars are
  provider-computed from trades. Reconciliation therefore uses the provider's historical trades/bars.
- A Fume futures `Instrument` is one specific contract; the root is resolved to a contract by the
  backend (no hard-coded front month). First-notice dates were not found in the reviewed provider
  fields, so a CME calendar source is needed for physically delivered contracts.
- Tick size, tick value, multiplier and currency come from an authoritative metadata source
  (provider reference data cross-checked with CME specifications), never hard-coded.

**Equity-specific assumptions kept out of chart/core:**

| Assumption to avoid                          | What we do instead                                                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Session is 09:30–16:00 America/New_York      | `Instrument.session` (tz + windows + calendar)                                                                 |
| Trading day = calendar day in UTC or ET      | `sessionDate` from the session spec (futures sessions start the evening before)                                |
| Only weekends and NYSE holidays are closed   | Calendar from provider/backend (`calendarId`)                                                                  |
| Tick = $0.01; 2 decimals                     | `tickRules` (price-dependent) + `priceFormat` (decimal or fractional 32nds)                                    |
| Currency is USD / "$"                        | `Instrument.currency`                                                                                          |
| Quantity unit is "shares"; fractional shares | `quantityStep`, `quantityUnit`                                                                                 |
| Multiplier = 1 (P&L = Δprice × qty)          | `contractMultiplier` in every P&L computation                                                                  |
| Prices are positive                          | Price scale must handle zero and negative (e.g. crude oil in 2020). No log scale in the MVP                    |
| Ticker string is a unique permanent ID       | Opaque `InstrumentId`; futures contracts expire and roll                                                       |
| "Buying power" is the only margin concept    | Account fields are generic; futures margin is added later without changing the chart                           |
| Volume is an integer                         | `number`                                                                                                       |
| A bar exists for every minute                | Session-aware slot axis: scheduled closures compressed, empty in-session slots stay visible; no synthetic bars |
| Sessions are single daytime windows          | `MarketSession.windows[]`: several windows per session, crossing midnight, with scheduled breaks               |
| Event timestamps fit in milliseconds         | `EventTime { ns, ms }` with canonical nanosecond strings                                                       |
| Split/dividend adjustment                    | History adjustment is a backend/provider setting; the chart doesn't know about it                              |
| Shorting is always possible / never possible | `Instrument.shortable` (tri-state) + broker rejection handling                                                 |

## 9. Deployment (Cloudflare) — planned, not done

**Nothing is deployed.** Everything runs locally (Vite + `wrangler dev`). Cloud use of Massive data is
blocked until Massive confirms the private-backend use in writing. The plan:

- One Worker (`apps/worker`) serves the built frontend as static assets, `/api/v1/*`, and the WebSocket upgrade at `/api/v1/stream`, which it forwards to the feed hub Durable Objects.
- Secrets: `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` via `wrangler secret put`. Non-secret config goes in `vars`.
- **Access control:** a custom domain behind **Cloudflare Access** (one allowed email), and the Worker verifies the Access JWT. `workers.dev` and preview URLs are disabled or also protected. Nothing that can trade is ever reachable without authentication, not even on paper.
- Observability: Workers Logs with structured JSON. Secrets and auth frames are never logged.
- A preview deploy behind Access was planned for Stage 5 but has not happened; Cloudflare-specific WebSocket behavior was validated locally and in the S3 spike only.

## 9.1 Owner decisions recorded

All recorded 2026-09-29.

- **Q1: repository location.** Moved out of OneDrive to `C:\Users\inari\Projects\Fume` (done). Dependencies are installed there.
- **Q2: Replit and the market-data socket.** The Replit platform does not use this Alpaca account's market-data WebSocket. If that changes, it would compete for the 1-connection limit (error 406). Local `wrangler dev` and a deployed instance still compete with each other, so spike S2 stays.
- **Q3: UI shell.** **Approved:** React + TypeScript + Vite shell. The Canvas engine stays framework-independent (§2.1).
- **Q4: session display.** **Regular trading hours by default.** `SessionMode = 'regular' | 'extended'` runs through the domain model, `/bars` (`session=`), the aggregator and the time-axis mapping. An extended-hours toggle can be added later without contract changes. It isn't exposed in the MVP.
- **Q5: candle alignment.** **Session-aligned intraday candles** (1h RTH: 09:30–10:30 … 14:30–15:30, then a short 15:30–16:00), built by Fume deterministically from lower-timeframe base bars. Fume never depends on a provider's native 1h or daily candles. The rule is generic ("anchor at the session window start, clip at its end"), so futures use their own windows. See [docs/market-data.md](docs/market-data.md).
- **Q6: extended-hours orders.** **MVP orders are always `extendedHours: false`**, enforced in the type (`OrderRequest.extendedHours: false`) and by server validation. The order panel has no extended-hours checkbox. This is to be revisited after regular-session paper trading is reliable.
- **Provisional trading values.** Streamed broker values (`stream`) and Fume-computed values (`derived`, e.g. average entry and the P&L computed from it) are marked `provisional` until an authoritative snapshot replaces them. See [docs/trading-state.md](docs/trading-state.md).

## 9.2 Tooling versions (decided 2026-09-29, verified by a probe install)

| Tool                                 | Decision                                                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                           | **Pinned exactly to 7.0.2** (the current `latest`). Exact pin because 7.x is the new native compiler: upgrades are deliberate | In a scratchpad probe with the planned toolchain, `tsc` 7.0.2 type-checked a React 19 JSX component (DOM lib) and a Worker + Durable Object file against `@cloudflare/workers-types` 5.20260929.1 with `skipLibCheck: false`. No selected tool declares a TypeScript peer range, and none depends on the `typescript` package (`pnpm why typescript`: root only) |
| Vite                                 | 8.x (8.3.1 probed)                                                                                                            | Built the probe React app with `@vitejs/plugin-react` 6.1.1 (transpiles without `tsc`)                                                                                                                                                                                                                                                                           |
| Vitest                               | **4.1.x, not 5.x**                                                                                                            | `@cloudflare/vitest-pool-workers` 0.22.0 (latest) declares `vitest ^4.1.0` as its peer. One test runner everywhere means pinning 4.1 until the pool supports 5. A probe test ran on 4.1.11                                                                                                                                                                       |
| Wrangler / `@cloudflare/vite-plugin` | 4.143.1 / 1.62.1                                                                                                              | Installed with no peer warnings                                                                                                                                                                                                                                                                                                                                  |
| Prettier                             | Pinned exactly to 3.9.9                                                                                                       | Keeps formatting stable across machines                                                                                                                                                                                                                                                                                                                          |

**Fallback:** if a later tool needs the TypeScript compiler **API** (for example typescript-eslint or declaration bundlers, neither selected), pin TypeScript to the latest 6.x for that package instead of adding workarounds. ESLint is deferred, so this doesn't apply yet. **Not probed:** actually running tests inside the Workers pool. Stage 4 did not need it (Worker code is plain Fetch API and is tested in Node); `workerd` is installed with `wrangler` (install scripts allowed only for `esbuild` and `workerd` in `pnpm-workspace.yaml`) and `wrangler dev` runs the Worker locally.

## 10. Other design documents

- [docs/domain-model.md](docs/domain-model.md): domain types, numeric policy, provider ports
- [docs/drawings.md](docs/drawings.md): drawing model, coordinate model, tool state machine, hit-testing, editing UX (Stages 7–8)
- [docs/indicators.md](docs/indicators.md): indicator definitions, schema, formulas, invalidation, panes (Stage 9)
- [docs/embedding.md](docs/embedding.md): `@fume/datafeed`, `<FumeChartView />`, embedding rules
- [docs/http-api.md](docs/http-api.md), [docs/websocket-api.md](docs/websocket-api.md): contracts
- [docs/market-data.md](docs/market-data.md): historical/live reconciliation and candle aggregation
- [docs/trading-state.md](docs/trading-state.md): order/position reconciliation
- [docs/security.md](docs/security.md): credentials and trading-request security
- [docs/roadmap.md](docs/roadmap.md): stages, acceptance criteria, test strategy, risks and spikes
