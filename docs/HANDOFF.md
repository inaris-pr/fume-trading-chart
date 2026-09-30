# Fume Current Handoff

## Current status

**Current stage: Stage 5 — Real-time + preview deploy**

Status: **PREPARED · NOT IMPLEMENTED**

- Current branch: `stage-5/realtime-preview` (local only until the owner approves a push)
- Base / `main`: `59899dacfb2b52b39db8da397fe391dd2f170909`
- Stage 4: **MERGED via PR #4**; main squash commit `59899dacfb2b52b39db8da397fe391dd2f170909`.
- Stage 4 historical Alpaca functionality is now the **frozen baseline**.

## Stage 5 scope (from [roadmap.md](roadmap.md); roadmap is authoritative)

- Alpaca real-time market-data stream adapter
- backend stream hub
- `/api/v1/stream`
- real live candles
- preview deployment behind Cloudflare Access

Stage 5 must **not** jump straight into the full implementation. Required gates first:

- **S2 — connection limit:** does Alpaca's one-connection limit apply per API key or per account,
  and what exactly happens when a second IEX stream is opened (error 406? old socket dropped?).
- **S3 — Durable Object gate:** outbound WebSocket from a DO, text/binary frames, auth timing,
  disconnect/reconnect, lifecycle/eviction and duration cost. The roadmap requires a **go/no-go**
  before committing to the StreamHub architecture (ARCHITECTURE.md §6).

The eventual implementation follows **one** of: **A.** Durable Object StreamHub, or **B.** the
approved single-tab fallback, decided by the S3 result. Later in Stage 5: **S4** (provisional
IEX trade-built minute vs the official minute bar) and **S7** (Cloudflare Access including
WebSocket upgrades, JWT verification in the Worker).

## Stage 5 boundaries

- Stage 4 history must keep working (no regression); Replay remains available.
- The browser still never connects directly to Alpaca; credentials stay Worker/backend-only.
- No trading, orders, positions or P&L in Stage 5; no Stage 6 work.
- No permanent Durable Object architecture until the S3 go/no-go. Do not assume the DO path is
  approved merely because it appears in the roadmap.

## Completed stages

- **Stage 0:** architecture, contracts and repository foundation.
- **Stage 1:** custom Canvas 2D chart engine.
- **Stage 2:** interactions: ticker/timeframe controls, horizontal zoom/pan, crosshair, manual price
  scaling.
- **Stage 3:** `ReplayMarketDataProvider`, live aggregation/reconciliation, incremental updates,
  older-history loading, 2D chart navigation, go-to-latest (→|).
- **Stage 4:** local Cloudflare Worker backend plus real Alpaca IEX historical market data:
  instruments, calendar sessions, Fume canonical aggregation and HTTP paging (`?source=api`).

## Stage 4 verified facts (spike S1, `pnpm s1`)

- Provider: Alpaca · Feed: IEX · Adjustment: raw
- S1 SPY completed regular session: **2026-09-29**
- Observed: 1Min = **390** bars, 5Min = **78** bars, 15Min = **26** bars; **no IEX gaps** during
  that tested session.
- Verified native intervals for this tested data: **`[1, 5, 15]`**
- Canonical equality (built from 1Min vs from native bars) passed: 5m, 15m, 1h, 4h, 1d.
- 1h: 7 canonical candles on a full session; the final 15:30–16:00 candle is short.
- 4h: 2 canonical candles on a full session.
- Early-close validation: **2025-11-28** (13:00 close; clipped buckets correct).
- **Scope caveat:** verified on the tested SPY sessions only. Do not describe these as universal
  guarantees beyond that evidence. Details: [research.md](research.md#spike-s1-results-2026-09-29).

## Current application modes

| Mode                 | URL                                  | Label                     |
| -------------------- | ------------------------------------ | ------------------------- |
| Default (replay)     | http://localhost:5173/?source=replay | Replay · not live         |
| Historical real data | http://localhost:5173/?source=api    | Alpaca · IEX · historical |
| Worker (local only)  | http://127.0.0.1:8787                | —                         |

Any `source` other than `api` (or none) is replay. Stage 4 is **historical HTTP data only**; there is
**no live Alpaca WebSocket integration yet**.

## Current local commands

```
pnpm dev            # web, replay mode
pnpm dev:worker     # local Worker (needs apps/worker/.dev.vars)
pnpm dev:api        # web + Worker, then open ?source=api
pnpm s1             # S1 real-data verification (writes sanitized fixtures)
pnpm test
pnpm typecheck
pnpm format:check
pnpm build
pnpm scan:secrets
pnpm scan:bundle    # after pnpm build
```

## Security state

- Real credentials live only in `apps/worker/.dev.vars`; the file is ignored and untracked.
- Never read the credential values back into chat (or any output).
- The frontend production bundle contains no Alpaca hosts, auth-header names or credentials.
- Fixtures contain response bodies only.
- No Cloudflare production deployment exists yet; no production authentication exists yet (the
  Worker accepts only `FUME_ENV=local` on a loopback host).

## Current test state (at Stage 4 approval)

- 530 tests pass across 32 files; 132 Worker tests pass.
- Typecheck, format and build: pass.
- Secret scan: 0 findings. Bundle scan: 0 findings.
- Boundary / chart-library guards: pass.

## Important known limitations

- Real historical mode does not tick live; WebSocket market data is Stage 5.
- In-progress real candle behavior has automated coverage but was not verified during an open
  market.
- Alpaca IEX returned no bars for 2025-03-10; Fume correctly leaves the session empty.
- `adjustment=raw`: splits can appear as historical price cliffs.
- Alpaca US equities normalize to `equity`; Fume does not guess the ETF subtype from ticker/name.
- Worker tests use Node + injected `fetch`, not the Cloudflare Workers test pool.
- Everything is still local-only.

## Exact next action

**Begin Stage 5 only after explicit instruction.** The first Stage 5 work is architecture/risk
validation, not production implementation. Order:

1. Re-read: `CLAUDE.md`, `docs/HANDOFF.md`, `docs/roadmap.md`, `ARCHITECTURE.md` §6,
   `docs/market-data.md`, `docs/websocket-api.md`, `docs/security.md`.
2. **Run S2:** using the existing local Alpaca credentials (never exposed), open two controlled IEX
   streaming connections and record the exact observed connection-limit behavior. Do not build the
   production stream adapter yet.
3. **Design and perform the S3 gate:** a minimal Durable Object experiment with an outbound Alpaca
   WebSocket: text/binary frame handling, auth timing, disconnect/reconnect behavior,
   lifecycle/eviction observations, duration/cost measurement and extrapolation. Use a Cloudflare
   preview only as far as this spike requires. Present the results before choosing StreamHub vs the
   single-tab fallback.
4. **STOP for the owner's go/no-go** before implementing the permanent Stage 5 streaming
   architecture.

Do not begin Stage 6 trading work.

## Recovery instructions

A fresh Claude Code session should begin by reading:

1. `CLAUDE.md`
2. `docs/HANDOFF.md`
3. `git status`
4. `git log --oneline -5`

Then read only the additional architecture/docs the immediate task needs. Trust the repository, Git
history, `CLAUDE.md` and `docs/HANDOFF.md` as the source of truth; do not reconstruct prior
decisions from assumptions or conversation memory.
