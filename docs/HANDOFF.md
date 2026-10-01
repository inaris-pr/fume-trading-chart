# Fume Current Handoff

## Current status

**Current stage: Stage 6 — React embedding** (branch `stage-6/react-embedding`)

Status: **IMPLEMENTED (uncommitted, local only), AWAITING OWNER REVIEW.** New `@fume/react`
package (`<FumeChartView />`, imperative ref, optional go-to-latest + status chrome, headless
mode); `apps/web` and the two-chart proof render through it; docs/embedding.md documents it.

Stage 5 (squash-merged to `main` as `3597927`) summary follows.

**Stage 5 implementation (2026-09-30, owner instruction "proceed with building the platform"; licensing is
handled separately before public launch and does not shape the architecture):**

- Provider-neutral routing: `apps/worker/src/registry.ts` (equities/ETFs -> Alpaca IEX, futures ->
  Massive Futures Starter), futures ids `fut:<ROOT>:<YYYY-MM>`, `/instruments/resolve?assetClass=future`.
- Massive REST adapter (`providers/massive/`): root -> recommended contract from reference data +
  delayed snapshot volume, explicit contract codes, 1-minute bars (cursor paging), schedules ->
  sessions (de-duplicated; weekly Globex fallback outside coverage).
- Massive delayed stream adapter (`A.`/`AM.` aggregates, numeric strings normalized, bounded
  reconnect, `max_connections`/1008 -> `connection_conflict` hold) behind the core
  `StreamingMarketDataProvider` port.
- Feed-scoped Durable Object hub (`src/hub/`, `FeedHubObject`, one instance per stream key):
  subscription union, fan-out, 60 s idle grace, REST reconciliation after reconnect, persisted
  conflict hold, hibernatable sockets + attachments for reconstruction; `/api/v1/stream?key=`.
- Core: `1s` bar events folded into the provisional minute; the provider minute is authoritative.
- Web: futures roots in the selector (ES NQ YM GC SI CL, with friendly labels; DIA added to
  Stocks & ETFs), contract chip (e.g. `NQZ6 · Dec 2026`),
  "CME futures · Delayed ~10m" label from feed metadata, stream client + live handoff/resync.
- Validated locally against the real delayed feed (wrangler dev, Durable Object local; nothing
  deployed). Alpaca equities unchanged and history-only.

**CURRENT PROVIDER DIRECTION (owner, 2026-09-30):**

- **US equities / ETFs: Alpaca** (Stage 4 implementation unchanged; Massive Stocks not needed).
- **Initial futures: Massive Futures Starter** ($29/month, already owned) for **GC, SI, CL, NQ,
  YM**; data may be ~10 minutes delayed; real-time and trade-level futures are not required
  initially. Intended provider, **pending Massive's written approval of the private Cloudflare
  backend use**.
- **Databento:** deferred as a researched fallback, not selected.
- Reason: Alpaca already works and needs no extra stock-data subscription; Massive Starter was
  locally proven sufficient for the delayed futures chart; removing a working provider only to
  reduce vendors has no architectural benefit. Fume stays provider-neutral (no provider-specific
  chart logic in the browser; ARCHITECTURE.md names no permanent provider).
- **Approved conceptual futures model** (not implemented): Massive REST 1m aggregates → canonical
  Fume 1m history; delayed WebSocket 1 s aggregates → provisional current minute; Massive 1m
  aggregate → authoritative final/reconciled minute; Fume 1m → 5m / 15m / 1h / 4h / 1d. Reconnect:
  reconnect → authenticate → resubscribe → REST 1m overlap → replace/reconcile recent bars → resume
  1 s aggregates. Massive aggregate bars are authoritative for initial futures.
- **Connection limit (observed):** all five futures fit on one WebSocket; a second connection with
  the same key displaced the older one (`max_connections`, close 1008). Permanent design: one
  centralized Massive provider/feed hub; no browser connections to Massive; dev processes must not
  compete with a deployed hub; on 1008 back off and surface the conflict, never a reconnect fight.
- **Cloud deployment of Massive data: BLOCKED PENDING WRITTEN MASSIVE CONFIRMATION.** Local
  capability testing is complete (spike `apps/worker/spikes/massive-futures-starter/`,
  NON-PRODUCTION). Details:
  [research.md](research.md#product-direction-update--massive-futures-starter-capability-spike-2026-09-30-intended-futures-provider-cloud-blocked-pending-massive-licensing).
- No permanent futures implementation exists.

- The GO approves the DO hub **primitive** only. Preferred permanent topology after the futures
  checkpoint: **provider/feed-scoped DO hubs** (one hub per provider feed); not implemented.
- Required permanent-design constraints (disposable in-memory state, expected reconstruction,
  resync + reconciliation after every reconnect, official bars authoritative, ~60 s idle close,
  406 = bounded backoff, S4 shortfalls unresolved): ARCHITECTURE.md §6.
- The temporary Cloudflare Worker `fume-s3-spike` and its secrets were deleted after S3.

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
approved single-tab fallback, decided by the S3 result.

**Stage 5 sequence (owner decision 2026-09-30, roadmap is authoritative):** A. S2 ✅ → B. S3 ✅ →
C. owner DO vs single-tab decision ✅ (GO: DO) → D. **futures-provider + multi-provider architecture
checkpoint** → E. owner approval → F. permanent streaming implementation → G. S4 → H. S7.
Reason: Fume will support multiple market-data providers: Alpaca for equities/ETFs and, later, a
futures provider for **GC, SI, CL, NQ, YM** (actual futures, not ETF proxies such as
GLD/SLV/USO/QQQ/DIA). Databento is preferred pending licensing confirmation (Massive fallback);
no provider is locked in and nothing futures-related is implemented. See roadmap "Multi-provider / futures direction" and ARCHITECTURE §6.1. Later in Stage 5: **S4** (provisional
IEX trade-built minute vs the official minute bar) and **S7** (Cloudflare Access including
WebSocket upgrades, JWT verification in the Worker).

## Stage 5 boundaries

- Stage 4 history must keep working (no regression); Replay remains available.
- The browser still never connects directly to Alpaca; credentials stay Worker/backend-only.
- No trading, orders, positions or P&L in Stage 5; no Stage 6 work.
- No permanent Durable Object architecture until the S3 go/no-go. Do not assume the DO path is
  approved merely because it appears in the roadmap.
- The streaming layer must stay provider-neutral: no "one StreamHub = one Alpaca socket" design;
  provider specifics stay inside provider adapters.
- No futures-provider code, no GC/SI/CL/NQ/YM in the UI, no fake futures data until the checkpoint
  is approved.

## Completed stages

- **Stage 0:** architecture, contracts and repository foundation.
- **Stage 1:** custom Canvas 2D chart engine.
- **Stage 2:** interactions: ticker/timeframe controls, horizontal zoom/pan, crosshair, manual price
  scaling.
- **Stage 3:** `ReplayMarketDataProvider`, live aggregation/reconciliation, incremental updates,
  older-history loading, 2D chart navigation, go-to-latest (→|).
- **Stage 4:** local Cloudflare Worker backend plus real Alpaca IEX historical market data:
  instruments, calendar sessions, Fume canonical aggregation and HTTP paging (`?source=api`).
- **Stage 5:** Massive delayed futures streaming (feed-scoped Durable Object hubs), ES/DIA and
  selector labels, `@fume/datafeed` (headless `ChartSession` + `DataFeed`), two-chart proof.

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

**STOP: owner review of the uncommitted Stage 6 work** (branch `stage-6/react-embedding`, not
committed or pushed): `@fume/react` (`<FumeChartView />`), `apps/web` migrated to it (UI
unchanged), two-chart proof on two `<FumeChartView />`s sharing one `FumeApiDataFeed`,
docs/embedding.md. After approval: commit, push, PR, owner squash-merge; the next stage starts
only on explicit approval.

Local run: `pnpm dev:api` (Worker + Durable Object hub, needs the keys in
`apps/worker/.dev.vars`), then `http://localhost:5173/?source=api&symbol=NQ&asset=future&tf=5m`.
Only one process may hold the Massive connection.

Not started: crosshair/visible-range engine events, overlay/drawings/indicators, layout
persistence, packaging (compiled builds), cross-origin backend auth, trading-platform integration.

## Recovery instructions

A fresh Claude Code session should begin by reading:

1. `CLAUDE.md`
2. `docs/HANDOFF.md`
3. `git status`
4. `git log --oneline -5`

Then read only the additional architecture/docs the immediate task needs. Trust the repository, Git
history, `CLAUDE.md` and `docs/HANDOFF.md` as the source of truth; do not reconstruct prior
decisions from assumptions or conversation memory.
