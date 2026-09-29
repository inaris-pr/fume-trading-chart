# Fume Trading Chart

A single-user, web-based trading chart with a **custom Canvas 2D chart engine**, real-time and historical market data, and **paper** trading, with orders, fills and positions drawn on the chart. It deploys to Cloudflare.

Alpaca (Basic plan, IEX feed, paper trading) is the _first_ provider behind provider-neutral interfaces. The chart and domain model don't depend on it.

> **Status: Stage 1 (custom Canvas chart on deterministic data).** No market data, backend or trading yet. See [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/roadmap.md](docs/roadmap.md).

## Scope

In scope: candlestick chart (1m / 5m / 15m / 1h / 1d, regular trading hours, session-aligned candles built by Fume), live candles updating on every trade, market and limit orders, cancel, close position, and the position/P&L/orders/fills overlay on the chart.

Explicitly out of scope for the MVP: indicators, drawing tools, watchlists, scanners, news, alerts, backtesting, automation, multi-chart, options, Level II/DOM, live-money trading, futures integration (the model is futures-ready, but there's no futures provider yet).

## Repository layout

```
packages/core   provider-neutral domain types, provider interfaces, session/time-scale logic,
                formatters, deterministic fixtures (@fume/core/fixtures)
packages/chart  framework-independent Canvas 2D chart engine
apps/web        React + Vite shell hosting the chart (deterministic demo data)
apps/worker     Cloudflare Worker backend    (Stage 4)
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

Run the app locally (http://localhost:5173):

```bash
pnpm dev
```

Dev-only query parameters: `?scenario=flat|negative|subpenny` (scale edge cases), `?bars=N` (dataset size), `?bench` (render benchmark, see [docs/performance.md](docs/performance.md)).

## Credentials

Never commit credentials, and never put them in frontend code. See [docs/security.md](docs/security.md). In short:

- Local: copy the variables from [.env.example](.env.example) into `apps/worker/.dev.vars` (gitignored) and fill in your Alpaca **paper** keys there.
- Cloudflare: `pnpm exec wrangler secret put ALPACA_API_KEY_ID` and `pnpm exec wrangler secret put ALPACA_API_SECRET_KEY`, run from `apps/worker/`.

## Data caveat

With the Alpaca Basic plan, market data is the **IEX** feed only, not consolidated SIP. Candles and especially volume will differ from platforms that show consolidated data. That's expected, not a bug.
