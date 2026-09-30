# Embedding Fume (headless session + DataFeed)

Status: **milestone "headless session + DataFeed extraction"** (2026-09-30, uncommitted). Fume's
chart can be driven by any host through framework-free packages; the standalone app
(`apps/web`) consumes them only through their public entry points, exactly as another
application would. Not yet: a React package, drawings, indicators, layouts, packaging (compiled
builds), cross-origin backend auth.

## Packages

| Package          | Role                                                                                           | Depends on                                          |
| ---------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `@fume/core`     | Domain types, sessions, session-aware time scale, candle math (pure)                           | nothing                                             |
| `@fume/chart`    | Canvas engine `FumeChart` (framework-free; core types only)                                    | `@fume/core` (types)                                |
| `@fume/datafeed` | `ChartSession` (headless controller), `DataFeed` contract, `FumeApiDataFeed`, `ReplayDataFeed` | `@fume/core`, `@fume/replay`, `@fume/chart` (types) |
| `@fume/replay`   | Deterministic offline dataset + provider (used by `ReplayDataFeed`)                            | `@fume/core`                                        |

The host owns the DOM container, the `FumeChart` instance and any UI chrome (symbol picker,
feed badge, "go to latest" button). Market-data providers and their keys stay behind Fume's
backend; the browser only talks to `/api/v1`.

## Quick start (framework-free)

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
