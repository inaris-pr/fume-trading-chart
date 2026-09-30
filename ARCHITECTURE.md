# Fume architecture

Status: **Stage 0 proposal, awaiting approval.** Facts are labeled in [docs/research.md](docs/research.md).

## 1. Shape of the system

```
Browser (single user)                          Cloudflare                                 Alpaca
┌──────────────────────────────┐   HTTPS   ┌──────────────────────────────────────┐   HTTPS   ┌──────────────┐
│ apps/web                     │──────────▶│ apps/worker  (one Worker)            │──────────▶│ Trading API  │
│  ├─ @fume/chart (Canvas)     │  /api/v1  │  ├─ static assets (apps/web build)   │           │ (paper)      │
│  ├─ order panel              │           │  ├─ HTTP API: history, snapshot,     │──────────▶│ Data API     │
│  └─ FumeClient (HTTP + WS)   │           │  │   orders, cancel, close           │           │ (IEX)        │
│      uses @fume/core         │   WSS     │  └─ StreamHub Durable Object (x1)    │   WSS     ├──────────────┤
│                              │◀─────────▶│      ├─ fan-out to N browser sockets │◀─────────▶│ data stream  │
└──────────────────────────────┘ /api/v1/  │      ├─ ONE upstream data socket     │           │ (v2/iex)     │
                                   stream  │      └─ ONE upstream trade_updates   │◀─────────▶│ trade stream │
                                           └──────────────────────────────────────┘           └──────────────┘
```

- **The browser only talks to Fume.** Alpaca credentials exist only in Worker secrets.
- **Alpaca is authoritative** for orders, fills, positions, buying power and account state. Fume holds no persisted trading state.
- **Provider adapters sit at the boundary.** Alpaca payloads are converted into `@fume/core` types inside `apps/worker/src/providers/alpaca/` and nowhere else.

## 2. Recommended stack

| Concern                | Choice                                                                                                                                                                                                 | Why                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language               | TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)                                                                                                                          | You asked for it. One language across chart, core, backend and tests. Strictness catches coordinate and nullable-price bugs.                                         |
| Package manager        | pnpm workspaces (pnpm 10.26.1 is installed)                                                                                                                                                            | Workspaces keep `core`, `chart` and the `worker` as separate packages, so the dependency direction is enforceable. No monorepo framework (Nx/Turbo) is needed.       |
| Chart rendering        | **Canvas 2D, hand-written**, in `@fume/chart`                                                                                                                                                          | Required. Canvas 2D handles thousands of candles if we only draw the visible range. WebGL stays off the table unless profiling shows Canvas can't keep up (risk R8). |
| Frontend build         | Vite                                                                                                                                                                                                   | Fast dev server, minimal config, first-class TS.                                                                                                                     |
| App UI shell           | **React + TypeScript (Vite), decided in Stage 0.** The chart engine stays framework-independent                                                                                                        | See §2.1.                                                                                                                                                            |
| Backend                | One Cloudflare Worker with a small hand-written router                                                                                                                                                 | About ten routes. A router library isn't needed yet; Hono is a fine fallback if routing grows.                                                                       |
| Real-time coordination | **One Durable Object class, `StreamHub`, one instance: CONDITIONAL** on spike S3 + cost/lifecycle validation                                                                                           | See §6.                                                                                                                                                              |
| Storage                | **None** (no D1, KV or R2)                                                                                                                                                                             | See §7.                                                                                                                                                              |
| Validation             | Hand-written validators in `@fume/core` for the few request shapes                                                                                                                                     | Three request bodies don't justify zod. Revisit if the contract grows.                                                                                               |
| Tests                  | Vitest 4.1.x (see §9.2). Worker code is tested in Node's Fetch API with injected `fetch` (Stage 4); `@cloudflare/vitest-pool-workers` only if Stage 5 needs DO tests. Playwright only for Stage 11 E2E | Same test runner everywhere. Deterministic pure-function tests make up most of the suite.                                                                            |
| Formatting             | Prettier                                                                                                                                                                                               | One tool, zero-config debates. ESLint is deferred until there's code to lint.                                                                                        |
| Runtime                | Node ≥ 22 locally (24.18.0 installed). Workers runtime in production                                                                                                                                   |                                                                                                                                                                      |

### 2.1 Decision: React shell, framework-independent chart engine

**Choice:** `apps/web` is a minimal React + TypeScript Vite app. `@fume/chart` is plain TypeScript with no React import (`new FumeChart(element, options)`, `destroy()`).

**Why React for the shell and not plain TypeScript:**

- The order panel, positions, open-order list, connection status and feed label are all reactive views of the same fast-changing trading projection. In plain TS we would hand-write a small view/diff layer. That's exactly the kind of custom infrastructure to avoid.
- Deciding now avoids rewriting the Stage 1–5 toolbar and status UI in Stage 6.
- React is the most likely integration target for "another frontend consumes Fume". The package boundary means a non-React consumer still uses `@fume/chart` directly.

**Guardrails that keep this small:**

- Dependencies: `react`, `react-dom`, `@vitejs/plugin-react`. No router, no state library, no UI kit, no CSS framework.
- React never renders the chart. A single `<ChartHost>` component owns a `<div>`, creates `FumeChart` in an effect, forwards props into imperative calls (`setBars`, `setOverlays`, …) and calls `destroy()` on unmount. React re-renders never touch the Canvas.
- Market and trading state live in framework-free stores in `@fume/core` (pure reducers plus a subscribe function). React reads them with `useSyncExternalStore`. The high-frequency trade path goes store → chart directly, bypassing React.
- A React wrapper for external consumers (`@fume/chart-react`) is extracted from `<ChartHost>` in Stage 10 only if the consuming app is React.

**Alternative rejected:** plain TypeScript for everything. It has fewer dependencies, but it means building our own reactive UI plumbing for the trading panel, and it gives no integration advantage.

## 3. Repository structure

```
fume-trading-chart/
├─ packages/
│  ├─ core/      @fume/core: domain types, provider ports and the pure logic (sessions,
│  │             time scale, canonical + live candle aggregation, EventTime; later the order
│  │             state machine and P&L). No DOM, no provider code.
│  ├─ chart/     @fume/chart: Canvas chart engine (Stage 1). Depends on nothing provider-specific.
│  └─ replay/    @fume/replay: deterministic ReplayMarketDataProvider (Stage 3). Offline.
├─ apps/
│  ├─ web/       Vite + React shell: <ChartHost>, order panel, FumeClient (Stage 1+)
│  └─ worker/    Cloudflare Worker + StreamHub DO + provider adapters (Stage 4+)
│     └─ src/providers/{alpaca,replay}/
├─ docs/         contracts, designs, research, roadmap
└─ ARCHITECTURE.md, README.md, .env.example
```

Only `packages/core` exists after Stage 0. Other folders are created in the stage that needs them.

**Dependency rules.** Violating these fails review:

- `core` → nothing.
- `chart` → `core`, **type-only** (approved at Stage 1 review, 2026-09-29). `@fume/chart` may `import type` canonical domain contracts from `@fume/core`, such as `Bar`, `TimeScaleMapping` and the formatter/domain types, so the chart consumes the Stage 0 model instead of a second candle model. It must **not** gain a runtime dependency on `@fume/core`: no value imports, and `@fume/core` stays a `devDependency` of the chart package, used only for type resolution. Changing this needs an explicit architecture review. Enforced by `test/boundaries.test.ts`.
- `replay` → `core` (runtime). A provider adapter; it implements the core `MarketDataProvider` port. Core and chart never import it.
- `web` → `core`, `chart`, `replay`, and Fume's own HTTP API (relative `/api/v1` only; never a provider host).
- `worker` → `core` (runtime), `wrangler` (dev only). Provider payload types, hosts and header names live only in `apps/worker/src/providers/<provider>/`.
- Nothing imports from `worker/src/providers/*` except the Worker's composition root.

## 4. Chart engine boundary

The engine is one class per chart instance. It is fed data and reports user intent back to the app.

**The chart engine owns:**

- Canvas setup: device-pixel-ratio scaling, resize via `ResizeObserver`, and layering (a static layer plus an overlay/crosshair layer).
- The viewport model: slot spacing, right offset, visible logical slot range, price range, auto-scale on or off.
- Coordinate transforms: slot ↔ x and price ↔ y. These are pure and unit-tested. Time ↔ slot goes through the injected **time-scale mapping** (below).
- Rendering bars at their slot positions. Empty slots stay empty, and session separators are drawn where the mapping reports boundaries.
- Rendering of the grid, candles (body and wick), price scale, time scale, crosshair, OHLC legend, and current-price line and label.
- Rendering of **generic overlays** the app supplies: `HorizontalLine {price, label, style}` and `Marker {time, price, shape, label}`. Trading visuals are built from these.
- Interaction: drag-pan, wheel/trackpad zoom around the cursor, price-scale drag to rescale, double-click to reset auto-scale, keyboard basics.
- Events: `visibleRangeChanged`, `crosshairMoved`, `needsOlderData` (the left edge is near the first loaded bar).
- Formatting, which it delegates to injected `formatPrice(p)` and `formatTime(t, granularity)` functions built from `Instrument.priceFormat` and `session.timezone`.

**The chart engine must NOT own:**

- Networking, WebSockets, providers or retry logic.
- Candle aggregation or live-bar construction (that's `@fume/core`; the chart only receives `setBars`, `upsertBars` and `prependBars`).
- Session calendars (it receives a `TimeScaleMapping`).
- Trading state, order logic or P&L math (the app computes these and passes lines and markers).
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
}
```

Rules the mapping implements:

- **The mapping is built for a session mode.** In `regular` mode (the MVP default, Q4), only regular windows are "open". Pre/post-market time is compressed like nights. In `extended` mode (supported later), every scheduled window is open.
- **Scheduled closed time is compressed:** nights, weekends, holidays, futures maintenance breaks and (in regular mode) extended hours. It comes from `MarketSession.windows`, which can cross midnight and contain several windows per session.
- **Time inside an open window is linear, in slots that match the canonical session-aligned buckets** (market-data.md). A window's last slot may be shorter (1h: 15:30–16:00), but it's still one slot. A slot with no bar is a **visible, genuine data gap**. That's how missing data during an active session stays distinguishable from a scheduled closure.
- **Daily timeframe:** one slot per `sessionDate`.
- **Fallback:** if the calendar is unavailable, the mapping degrades to "one slot per loaded bar" (bar-index mode) and the UI shows that session data is unavailable.

**Implementation plan:**

| Stage | What gets built                                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | The chart consumes the interface. The generated-data demo uses a simple fixed weekly RTH schedule mapping (09:30–16:00 ET, weekdays), which proves compression and visible gaps. |
| 3     | `@fume/core` builds the real mapping from `MarketSession[]`, with tests for DST days, holidays, early closes and a futures-style session crossing midnight with a break.         |
| 4     | Real sessions come from the provider through `/api/v1/sessions`.                                                                                                                 |

Nothing in the chart assumes that bar _i_ sits at slot _i_.

A per-user option to also compress empty in-session slots is **not** in the MVP. It could be added later without changing the interface, and would help thin extended-hours IEX data.

### 4.2 Interaction layer (Stage 2, approved)

**Two canvases per chart.** Both are owned by `FumeChart`, sized together from the same backing-store computation (DPR-correct), and removed by `destroy()` together with every listener.

| Layer                   | Draws                                                       | Repainted when                                                     |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Main canvas             | Grid, candles, axes, session separators, last price         | Data, view, price scale or size change                             |
| Overlay canvas (on top) | Crosshair lines, crosshair price/time readouts, OHLC legend | Every pointer move (no frame rebuild), and after each main repaint |

The overlay receives all pointer, wheel and double-click events; the main canvas has `pointer-events: none`.

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

### 4.3 Live data path (Stage 3, replay)

```
MarketDataProvider (replay now, Alpaca in Stage 4/5)
  │ openStream → MarketEvent[] (trade, bar final/revised/provisional, status)
  ▼
LiveChartController (apps/web, framework-free)        getBars / getSessions (1m history)
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

### 4.5 Historical data path (Stage 4, Alpaca IEX, local only)

```
Browser  ?source=api                        Worker (wrangler dev, 127.0.0.1:8787)            Alpaca
HistoricalChartController ──/api/v1──▶ router: origin → local auth → validate            data API  (bars, feed=iex)
  FumeHttpClient (relative URLs)        loadCanonicalPage (provider-neutral)  ──HTTPS──▶  paper API (assets, calendar)
  chart.setData / prependBars           └ core: selectBaseInterval + buildCanonicalBars
```

- **Worker layout:** `index.ts` (composition root, the only importer of `providers/alpaca`), `router.ts`, `cors.ts`, `auth.ts`, `validate.ts`, `errors.ts`, `canonical-history.ts`, `providers/alpaca/{client,config,normalize,market-data-provider,types}.ts`.
- **Provider port:** the Alpaca adapter implements `HistoricalMarketDataProvider` (the history half of `MarketDataProvider`; no stream until Stage 5).
- **One `/bars` request:** calendar sessions before `end` until they hold `limit` canonical slots (or the 2016 floor) → coarsest verified native interval that nests (`[1, 5, 15]` after S1) → one ranged base-bar fetch → `buildCanonicalBars` → newest `limit` candles. If the fetch was truncated, candles older than the oldest base bar are dropped (never a partial candle).
- **Browser:** a switch clears the chart and starts a new generation (requests aborted, late responses ignored). Older pages use `end = oldest loaded start`, one in flight, then `prependBars` with a time scale rebuilt from cached sessions.
- **Local dev topology:** Vite (5173) proxies `/api` to the Worker; no backend URL is compiled into the app.

**Performance rule:** each frame draws only the visible bars. Updating the live bar redraws the frame, but no layout is recomputed unless the viewport changed. Updates are batched through `requestAnimationFrame`.

## 5. Frontend/backend boundary

| Browser (`apps/web`)                                                                                                                                                                               | Backend (`apps/worker`)                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Rendering, interaction, form input                                                                                                                                                                 | All provider communication and credentials                                      |
| Aggregates normalized live events (each trade, current-bar updates, official/revised minute bars) into the displayed timeframe, updating the active candle on every trade (pure `@fume/core` code) | Historical bar retrieval, paging, normalization                                 |
| Holds a **derived projection** of trading state: streamed events applied immediately, reconciled by broker snapshots                                                                               | Validates every trading request (see [docs/security.md](docs/security.md))      |
| Generates `clientOrderId` (the idempotency key)                                                                                                                                                    | Maps domain requests to provider calls; maps provider errors to `ProviderError` |
| Never decides that an order filled                                                                                                                                                                 | Owns the single upstream stream connections (StreamHub)                         |

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

### 6.1 Multi-provider streaming (planning note, 2026-09-30; not implemented)

Fume will stream from **more than one provider**: Alpaca IEX for US equities/ETFs, and later a futures-capable provider for GC, SI, CL, NQ and YM. The design above describes the Alpaca case only; the permanent Stage 5 design must not hard-code "one hub = one Alpaca socket". It must allow **provider-scoped upstream connections**, potentially simultaneous, for example:

```
StreamHub (or one hub per provider, if that proves cleaner)
  ├─ upstream: alpaca/iex             (1 socket; S2: a 2nd is refused with 406)
  └─ upstream: <futures-provider>/<feed>
```

- Subscriptions route to the upstream that owns the instrument (`Instrument.marketDataRef.providerId`); each upstream keeps its own reference-counted subscription set, reconnect/backoff, stale detection and `resync`.
- Browser frames stay provider-neutral (`MarketEvent`); a client may hold instruments from different providers at once.
- Stage 4 pieces that are single-provider today and will need design at the checkpoint (not changed now): the Worker router takes one `HistoricalMarketDataProvider`; `/api/v1` accepts only `eq:` instrument ids; `/instruments/resolve` treats a symbol as an equity ticker (a futures root such as `NQ` resolves to a contract, not a ticker).
- Whether hubs are Durable Objects at all is decided by S3; the multi-provider shape is decided at the futures-provider checkpoint (roadmap, Stage 5 steps C–E).

## 7. Decision: database (**NO**)

The MVP has no application-owned data that must persist:

- Orders, fills, positions and account state come from Alpaca (authoritative) and are re-fetched on demand.
- Historical bars come from Alpaca. Caching, if ever needed, would use the Workers Cache API, not a database.
- Fill markers after a refresh come from broker execution history (spike S6).
- UI preferences (last symbol and timeframe) live in `localStorage` in the browser, which is harmless.

We'd reconsider only for a real requirement: an app-owned audit log of submitted orders, user settings synced across devices, or multi-user support.

## 8. Futures readiness

The core model already carries what futures need (`packages/core/src/instrument.ts`): tick rules, fractional price formats, a contract multiplier, a session spec whose windows can cross midnight, a session date that belongs to the _ending_ day, a `future` block (root, contract month, expiration, tick value), and separate market-data and brokerage provider refs. A futures provider plugs in as another `MarketDataProvider` / `BrokerageProvider` pair.

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

## 9. Deployment (Cloudflare)

- One Worker (`apps/worker`) serves the built frontend as static assets, `/api/v1/*`, and the WebSocket upgrade at `/api/v1/stream`, which it forwards to the StreamHub DO.
- Secrets: `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` via `wrangler secret put`. Non-secret config goes in `vars`.
- **Access control:** a custom domain behind **Cloudflare Access** (one allowed email), and the Worker verifies the Access JWT. `workers.dev` and preview URLs are disabled or also protected. Nothing that can trade is ever reachable without authentication, not even on paper.
- Observability: Workers Logs with structured JSON. Secrets and auth frames are never logged.
- **Early preview deploy in Stage 5** (behind Access), so Cloudflare-specific WebSocket behavior is validated early instead of discovered in Stage 9.

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
- [docs/http-api.md](docs/http-api.md), [docs/websocket-api.md](docs/websocket-api.md): contracts
- [docs/market-data.md](docs/market-data.md): historical/live reconciliation and candle aggregation
- [docs/trading-state.md](docs/trading-state.md): order/position reconciliation
- [docs/security.md](docs/security.md): credentials and trading-request security
- [docs/roadmap.md](docs/roadmap.md): stages, acceptance criteria, test strategy, risks and spikes
