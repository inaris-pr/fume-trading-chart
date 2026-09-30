# Fume Trading Chart

A single-user, web-based trading chart with a **custom Canvas 2D chart engine**, real-time and historical market data, and **paper** trading, with orders, fills and positions drawn on the chart. It deploys to Cloudflare.

Alpaca (Basic plan, IEX feed, paper trading) is the _first_ provider behind provider-neutral interfaces. The chart and domain model don't depend on it.

> **Status: Stage 4 (Worker + real Alpaca/IEX history, local only).** A local Cloudflare Worker serves canonical candles built from real Alpaca IEX history; the deterministic replay (Stage 3) remains the default. No live Alpaca streaming, no trading and no deployment yet. See [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/roadmap.md](docs/roadmap.md).

## Scope

In scope: candlestick chart (1m / 5m / 15m / 1h / 1d, regular trading hours, session-aligned candles built by Fume), live candles updating on every trade, market and limit orders, cancel, close position, and the position/P&L/orders/fills overlay on the chart.

Explicitly out of scope for the MVP: indicators, drawing tools, watchlists, scanners, news, alerts, backtesting, automation, multi-chart, options, Level II/DOM, live-money trading, futures integration (the model is futures-ready, but there's no futures provider yet).

## Repository layout

```
packages/core   provider-neutral domain types, provider interfaces, session/time-scale logic,
                formatters, deterministic fixtures (@fume/core/fixtures)
packages/chart  framework-independent Canvas 2D chart engine
packages/replay deterministic replay MarketDataProvider (synthetic instruments, history, live tape)
apps/web        React + Vite shell hosting the chart (replay, or history from the Fume API)
apps/worker     Cloudflare Worker: /api/v1 routes + Alpaca historical adapter (local only)
docs/           design, contracts, research, roadmap
```

## Local setup

Requirements: Node ≥ 22, pnpm 10 (`corepack enable` or a standalone install).

```bash
pnpm install
```

```bash
pnpm typecheck
```

```bash
pnpm format:check
```

```bash
pnpm test
```

```bash
pnpm build
```

Run the app locally with the deterministic replay (http://localhost:5173, no network, no keys):

```bash
pnpm dev
```

Run the local Worker (http://127.0.0.1:8787; needs `apps/worker/.dev.vars`, see Credentials):

```bash
pnpm dev:worker
```

Run both for real Alpaca/IEX history, then open http://localhost:5173/?source=api (Vite proxies `/api` to the Worker; the browser never calls Alpaca):

```bash
pnpm dev:api
```

Spike S1 (real IEX bar verification; writes sanitized fixtures) and the security scans:

```bash
pnpm s1
```

```bash
pnpm scan:secrets
```

```bash
pnpm build && pnpm scan:bundle
```

Chart controls: mouse wheel / trackpad pinch over the chart zooms around the pointer, drag pans, the crosshair shows price, time and OHLC. On the right price axis, drag or wheel to stretch/compress prices (manual scale) and double-click to return to auto-fit. Symbols (SPY, QQQ, AAPL, NVDA, TSLA) and timeframes (1D, 4H, 1H, 15m, 5m, 1m) are deterministic replay data.

The replay starts at Fri 2026-09-25 14:00 ET and plays the synthetic tape (trades, then official and occasionally revised minute bars) at 20× speed through the Monday session. Pan left to load older history (a short artificial delay makes loading visible).

Development/QA query parameters (not user features): `?source=api` (historical candles from the Fume backend; label "Alpaca · IEX · historical"; no live ticks), `?symbol=SPY&tf=1h` (initial selection; also `SYN-FLAT`, `SYN-NEG`, `SYN-SUB` scale edge cases), `?speed=60` (replay speed), `?bench` (render and live-path benchmark, see [docs/performance.md](docs/performance.md)).

## Credentials

Never commit credentials, and never put them in frontend code. See [docs/security.md](docs/security.md). In short:

- Local: copy [apps/worker/.dev.vars.example](apps/worker/.dev.vars.example) to `apps/worker/.dev.vars` (gitignored) and fill in your Alpaca **paper** keys there. Non-secret settings are in `apps/worker/wrangler.jsonc`.
- Cloudflare: `pnpm exec wrangler secret put ALPACA_API_KEY_ID` and `pnpm exec wrangler secret put ALPACA_API_SECRET_KEY`, run from `apps/worker/`.

## Data caveat

With the Alpaca Basic plan, market data is the **IEX** feed only, not consolidated SIP. Candles and especially volume will differ from platforms that show consolidated data. That's expected, not a bug. Fume requests `feed=iex` explicitly and labels the chart "IEX". History is `adjustment=raw`: stock splits appear as price jumps. Alpaca's IEX history can also miss whole sessions (observed: 2025-03-10); Fume shows them as empty sessions and never fabricates bars.
