# Embedding Fume (React component, headless session + DataFeed)

Status: **Stage 6 "React embedding"** (2026-09-30, uncommitted), on top of the Stage 5 headless
session + DataFeed extraction. A React application embeds a Fume chart with `<FumeChartView />`
(`@fume/react`); any other host drives the framework-free packages directly. The standalone app
(`apps/web`) consumes both only through their public entry points, exactly as another application
would. Not yet: drawings, indicators, layouts, packaging (compiled builds), cross-origin backend
auth.

## Packages

| Package          | Role                                                                                           | Depends on                                          |
| ---------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `@fume/core`     | Domain types, sessions, session-aware time scale, candle math (pure)                           | nothing                                             |
| `@fume/chart`    | Canvas engine `FumeChart` (framework-free; core types only)                                    | `@fume/core` (types)                                |
| `@fume/datafeed` | `ChartSession` (headless controller), `DataFeed` contract, `FumeApiDataFeed`, `ReplayDataFeed` | `@fume/core`, `@fume/replay`, `@fume/chart` (types) |
| `@fume/replay`   | Deterministic offline dataset + provider (used by `ReplayDataFeed`)                            | `@fume/core`                                        |
| `@fume/react`    | `<FumeChartView />`: thin React binding (chart + session lifecycle, optional chrome)           | `@fume/core`, `@fume/chart`, `@fume/datafeed`       |

React is a **peer dependency** of `@fume/react` (`^18.2.0 || ^19.0.0`): the binding uses only
hooks, `forwardRef` and the automatic JSX runtime, all available in React 18, so a React 18 host
can embed it unchanged (the reference app itself runs React 19). Nothing else in Fume depends on
React, and core, chart, replay and datafeed never import `@fume/react` (`test/boundaries.test.ts`).

Without React, the host owns the DOM container, the `FumeChart` instance and any UI chrome
(symbol picker, feed badge, "go to latest" button). With `<FumeChartView />` the component owns
the container, chart and session; the host keeps the DataFeed and its own chrome. Market-data
providers and their keys stay behind Fume's backend; the browser only talks to `/api/v1`.

## React: `<FumeChartView />`

```tsx
import { useRef } from 'react';
import { FumeApiDataFeed } from '@fume/datafeed';
import { FumeChartView, type FumeChartViewHandle } from '@fume/react';

// The HOST creates the feed (once per page) and shares it between every chart on the page.
const feed = new FumeApiDataFeed();

function Charts() {
  const view = useRef<FumeChartViewHandle>(null);

  return (
    <div style={{ height: 480 }}>
      <FumeChartView ref={view} datafeed={feed} symbol="NQ" assetClass="future" timeframe="5m" />
    </div>
  );
}
```

The component fills its parent (`width/height: 100%`); give the parent a real size. Candles,
live updates, zoom, pan, crosshair and rendering never go through React state: the component
re-renders only for its optional chrome.

### Props

| Prop                      | Required | Default    | Meaning                                                                                      |
| ------------------------- | -------- | ---------- | -------------------------------------------------------------------------------------------- |
| `datafeed`                | yes      |            | Any `DataFeed` (`FumeApiDataFeed`, `ReplayDataFeed`, your own). Share one instance per page. |
| `symbol`                  | yes      |            | Ticker or futures root (`"SPY"`, `"NQ"`).                                                    |
| `timeframe`               | yes      |            | `'1d'`, `'4h'`, `'1h'`, `'15m'`, `'5m'` or `'1m'`.                                           |
| `assetClass`              | no       | `'equity'` | `'future'` resolves a root to a specific contract.                                           |
| `settings`                | no       | defaults   | `ChartSessionSettings`; **read when the view is created** (remount with a `key` to change).  |
| `theme`                   | no       | built-in   | `Partial<ChartTheme>`; applied live when the object identity changes (memoize it).           |
| `className`, `style`      | no       |            | Added to / merged into the root `div.fume-chart`.                                            |
| `goToLatestButton`        | no       | `true`     | Built-in "go to latest" button while the newest candle is out of view.                       |
| `statusOverlay`           | no       | `false`    | Built-in loading/empty/error notice: `true` (generic text) or `(status) => ReactNode`.       |
| `onStatus`                | no       |            | `ChartStatus`: `loading`, then `ready`, `empty` or `error`.                                  |
| `onStreamState`           | no       |            | Live connection health of the shown instrument (`null` = history only).                      |
| `onFollowingLatestChange` | no       |            | `{ following, plotCorner }`: whether the newest candle is in view (for your own button).     |

Changing `symbol`/`assetClass` selects the new instrument (cached resolves are reused); changing
only `timeframe` switches the timeframe on the same subscription; a re-render with the same values
does nothing. Callbacks are read through a ref, so inline functions never recreate the chart.

**Headless mode:** `goToLatestButton={false}` (with the default `statusOverlay={false}`) renders
only the chart; drive your own chrome from `onStatus`, `onStreamState` and
`onFollowingLatestChange`.

**Not exposed (yet):** crosshair and visible-range events. The engine draws the crosshair and
manages its view internally and has no public notification hooks for them, so the binding does
not simulate them. They come with engine events in a later stage.

### Imperative ref (`FumeChartViewHandle`)

```ts
view.current?.goToLatest(); // boolean: false when already following the newest candle
await view.current?.setTimeframe('1h'); // until the next `timeframe` prop change
await view.current?.selectInstrument('ES', 'future'); // until the next symbol/assetClass change
view.current?.getState(); // { symbol, timeframe, bars, hasMore, streaming, followingLatest } | null
```

Props stay the source of truth: an imperative switch lasts until the corresponding prop changes.
There is no `dispose` on the handle; unmounting disposes.

### Lifecycle ownership

- **The component owns** one `FumeChart` + one `ChartSession` per mount and `datafeed`. Unmount
  (or a new `datafeed` prop) disposes both: the session unsubscribes from the feed, the chart
  removes its canvases, resize observer, pixel-ratio watcher, DOM listeners and animation frame.
  A late response for a disposed view is ignored. Safe under React StrictMode (mount, unmount,
  remount leaves exactly one live view).
- **The host owns** the `DataFeed`: create it once (module scope or `useState(() => …)`), share
  it between views, dispose it when the page no longer needs it. The component never disposes the
  feed, so a shared `FumeApiDataFeed` keeps its stream connection for the other views; its socket
  closes 30 s after the last subscription ends (see Multiplexing). To tie a feed to a component,
  create and dispose it in the **same** effect and pass it down once it exists; do not pair
  `useMemo` with a disposing cleanup, because StrictMode's simulated unmount would dispose a feed
  that is still in use.
- **The host provides** a sized parent, the symbol picker, timeframe controls and feed badges,
  and (for another origin) the backend access described below.

### CSS hooks

`fume-chart` (root, positioned), `fume-chart-canvas` (engine container), `fume-chart-latest`
(go-to-latest button, positioned at the plot corner), `fume-chart-status` +
`fume-chart-status-<loading|empty|error>` (status overlay). The component sets only
layout-critical inline styles; colors and typography are the host's (`apps/web/src/styles.css`
is a complete example).

### Two charts, one feed

```tsx
<FumeChartView datafeed={feed} symbol="NQ" assetClass="future" timeframe="5m" />
<FumeChartView datafeed={feed} symbol="ES" assetClass="future" timeframe="1h" />
```

Both views subscribe on one stream connection (two hub subscriptions); a reconnect restores both.
Proof: `?source=api&proof=two-charts` in the standalone app and
`packages/react/test/binding.test.ts`.

## Framework-free quick start

```ts
import { FumeChart } from '@fume/chart';
import { ChartSession, FumeApiDataFeed } from '@fume/datafeed';

// ONE feed per page: every chart using it shares one stream connection per hub.
const feed = new FumeApiDataFeed({
  baseUrl: '/api/v1', // or 'https://fume.example/api/v1'
  getAuthHeaders: async () => ({ Authorization: `Bearer ${await host.token()}` }),
  createWebSocket: (url) => new WebSocket(url), // attach stream credentials here if needed
});

const chart = new FumeChart(container, {
  timeScale: { toSlot: () => null, slotStart: (s) => s, boundaries: () => [] },
  formatPrice: (p) => p.toFixed(2),
  formatTime: () => '',
  minPriceStep: 0.01,
});
const session = new ChartSession({
  datafeed: feed,
  chart,
  onStatus: (s) => render(s), // loading | ready | empty | error
  onStreamState: (s) => badge(s), // live connection health, null = history only
});
chart.setOptions({ onNeedsOlderData: (r) => void session.requestOlderData(r) });

await session.select('NQ', '5m', 'future'); // futures root -> a specific contract
await session.setTimeframe('1h');
chart.goToLatest(); // newest data the feed has (delayed feeds: newest delayed candle)
session.dispose();
chart.destroy();
feed.dispose(); // when the page is done with all charts
```

## `DataFeed` (public contract)

```ts
interface DataFeed {
  resolveInstrument(
    symbol: string,
    options?: { assetClass?: AssetClass; signal?: AbortSignal },
  ): Promise<ResolvedInstrument>; // { instrument, live }
  getBars(query: { instrumentId; timeframe; end?; limit; signal? }): Promise<BarsPage>; // canonical candles
  getSessions(instrumentId, from, to, signal?): Promise<MarketSession[]>;
  subscribe(instrumentId, handlers: LiveHandlers): LiveSubscription | null; // null = history only
  dispose(): void;
}
interface LiveHandlers {
  onEvents(events: readonly MarketEvent[]): void; // trades and/or 1s/1m bars for this instrument
  onStatus(state: StreamState): void;
  onResync(reason: string): void; // events may be missing: re-fetch the tail
}
```

- `limit` is the requested page size; a feed may page differently, e.g. `ReplayDataFeed` pages
  by whole trading sessions (`REPLAY_SESSIONS_PER_PAGE`: 1m 2, 5m 5, 15m 10, 1h 20, 4h 40, 1d 60 —
  the replay chart's long-standing page sizes). Callers always continue from the oldest returned
  candle.
- `getBars` returns **canonical, session-aligned candles** (Fume's own buckets, never provider
  hour/day bars), ascending, unique starts, all `< end`, with `hasMore` and the feed's
  `serverTime`. Paging: `end = oldest loaded start`.
- `ResolvedInstrument.live` says whether `subscribe` delivers events for that instrument.
- Errors are `DataFeedError { code, message, retryable, reason? }` (`FumeApiError` adds the HTTP
  `status`). `reason` is provider-neutral, e.g. `contract_expired`, `schedule_unavailable`.
- A host may implement its own `DataFeed` (e.g. proxying another backend) as long as it keeps
  these semantics.

## `ChartSession`

```ts
new ChartSession({ datafeed, chart, onStatus?, onStreamState?, settings? })
session.select(symbol, timeframe, assetClass?)   // clears, loads history + 1m seed, goes live
session.setTimeframe(timeframe)                  // reloads canonical candles, keeps the subscription
session.requestOlderData(request)                // chart onNeedsOlderData -> prepend without a jump
session.state()                                  // { symbol, timeframe, bars, hasMore, oldest, streaming, liveDiagnostics }
session.dispose()                                // unsubscribes; the feed stays usable
```

- `chart` is any `ChartSink` (`setData`, `upsertBars`, `prependBars`, `resolveOlderDataRequest`):
  normally a `FumeChart`.
- `settings` override the defaults exported as `DEFAULT_VIEW`, `HISTORY_PAGE`,
  `LIVE_SEED_MINUTES` (initial view per timeframe, candles per page, 1m seed size), and
  `clearOnSwitch` (default `true`: a switch clears the chart and reports `loading`; `false` keeps
  the previous candles visible until the new data is ready, which the standalone app uses in
  replay mode, as it always did).
- `ChartStatus`: `loading` → `ready { feed, bars, instrument, streaming }` | `empty` | `error { code, message }`.
- Live: subscribe + buffer → history + 1m seed → `LiveCandleAggregator` → fold changed minutes
  into the displayed timeframe → `upsertBars`. Trades or per-second aggregates move the current
  minute; the provider minute finalizes it. `onResync` → tail re-fetch without clearing.

## `FumeApiDataFeed` options

| Option            | Default                                                | Purpose                                                                 |
| ----------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `baseUrl`         | `/api/v1` (page origin)                                | API base, relative or absolute                                          |
| `fetch`           | `globalThis.fetch`                                     | Custom fetch (SSR, tests, proxies)                                      |
| `getAuthHeaders`  | none                                                   | Headers for every HTTP request (called per request; never logged)       |
| `createWebSocket` | browser `WebSocket`                                    | Stream socket factory (subprotocol/query credentials, custom transport) |
| `streamUrl`       | `<baseUrl>/stream?key=<key>`, ws(s) on the page origin | Stream URL override                                                     |

Stream keys are opaque, issued by `/instruments/resolve`; the host never builds them.

## Multiplexing

`FumeApiDataFeed` keeps **one `StreamConnection` per stream-hub key**. Each
`ChartSession.subscribe` becomes one hub subscription (`subId` s1, s2, …) on that single socket;
the hub keeps the upstream union. Incoming `market` frames are routed to subscriptions by
instrument id; `status` goes to every subscription (a new one gets the last known status at
once); `resync`, a `seq` gap or a hub restart resync every subscription; after a reconnect each
subscription resyncs once the hub re-acknowledges it. The socket opens with the first
subscription and closes 30 s after the last one ends (quick switches reuse it). **This idle close
is an intentional resource-management change** of the shared-stream design: before the
extraction the standalone app kept its stream socket open for the page lifetime; now a page with
no streamed chart releases its hub connection (and, through the hub's own 60 s grace, the
provider upstream). The hub accepts
10 subscriptions per connection. `ReplayDataFeed` likewise runs one replay stream for all its
subscriptions.

Proof: `?source=api&proof=two-charts` in the standalone app renders NQ 5m and ES 1h on one feed
(footer: stream diagnostics); `packages/datafeed/test/two-chart-proof.test.ts` asserts one socket,
two subscriptions, per-chart routing and per-chart resync.

## Backend requirements for another origin (not done yet)

The backend currently allows only `FUME_ALLOWED_ORIGINS` and authenticates only local loopback
requests. Embedding in another origin needs: the host origin in the allowlist, a real
authenticator (Cloudflare Access or host-issued tokens), and a WebSocket credential scheme that
matches `createWebSocket`. Distributing licensed market data to other users is a licensing
question, not a technical one (docs/research.md).

## Versioning

Packages are private workspace packages exporting TypeScript source (`exports: ./src/index.ts`).
Before another application consumes them outside this monorepo they need compiled ESM + `.d.ts`
builds and semantic versions; the stream protocol is negotiated by `hello { protocol: 1 }`.
