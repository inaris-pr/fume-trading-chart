# Fume Current Handoff

## Current status

**Stage 4 — Alpaca historical market data**

Status: IMPLEMENTED · VALIDATED · VISUALLY APPROVED · COMMITTED · PUSHED · **PR NOT YET CREATED**

- Current branch: `stage-4/alpaca-historical-data` (pushed, tracks `origin`)
- Stage 4 commit: `6dc388a988cffc13c37eb2a47e4051c5ba2ad2ee`
- Current `main` / base: `61b27b1267b5dd3d7d4eca39c8b7b7cbca1ef988`
- The working tree was clean before this handoff documentation was added (it is committed on the
  same branch as a separate documentation-only commit).

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

Create **PR #4**: `stage-4/alpaca-historical-data` → `main`, title
**`Stage 4: Alpaca historical market data`**. The PR includes the Stage 4 implementation plus this
handoff documentation.

After the owner squash-merges PR #4:

1. `git fetch origin`
2. switch to `main`
3. pull `origin/main` (fast-forward only)
4. verify the Stage 4 content is present on `main` (tree/content comparison, not only ancestry)
5. delete the local Stage 4 branch
6. delete the remote Stage 4 branch and prune
7. create the Stage 5 branch. `docs/roadmap.md` defines Stage 5's scope but does **not** name the
   branch: follow the `stage-N/<scope>` convention and confirm the exact name with the owner.
8. **Do not implement Stage 5 until explicitly instructed.**

Stage 5 is expected to introduce real-time Alpaca market data / WebSockets and the related backend
streaming architecture (with spikes S2–S4 and the S3 Durable Object cost gate), but
[roadmap.md](roadmap.md) is authoritative for the exact scope.

## Recovery instructions

A fresh Claude Code session should begin by reading:

1. `CLAUDE.md`
2. `docs/HANDOFF.md`
3. `git status`
4. `git log --oneline -5`

Then read only the additional architecture/docs the immediate task needs. Trust the repository, Git
history, `CLAUDE.md` and `docs/HANDOFF.md` as the source of truth; do not reconstruct prior
decisions from assumptions or conversation memory.
