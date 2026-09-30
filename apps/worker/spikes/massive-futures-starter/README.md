# Massive Futures Starter capability spike (NON-PRODUCTION SPIKE CODE)

**This is research/spike evidence, not Fume production code.** It is not imported by the
production Worker (`apps/worker/src`), it is not a futures adapter, and it must not be extended into
one. It runs **locally only** (Node), never on Cloudflare: Massive data must not reach a Cloudflare
deployment until Massive confirms the private-backend use in writing (see docs/HANDOFF.md).

## Purpose

Owner direction 2026-09-30: a 10-minute-delayed futures chart is acceptable, and the owner already
holds an individual **Massive Futures Starter** subscription ($29/month). This spike records what
that plan actually provides for GC, SI, CL, NQ and YM: reference data, contract resolution, REST
aggregates, snapshots, schedules, and the delayed WebSocket per-second / per-minute aggregates.

- `shared.ts`: key loading from the gitignored `apps/worker/.dev.vars` (`MASSIVE_API_KEY`), a
  REST `get` that sends the key only in the `Authorization: Bearer` header, and a `log` that
  withholds any line containing the key.
- `rest.ts`: products, exchanges, contracts, snapshot-based contract recommendation, 1-minute and
  1-second aggregates, pagination, session-date semantics, other resolutions, history depth,
  schedules, market status, the plan's trade/quote refusal, and a 2-minute delay track.
- `ws.ts`: `wss://delayed.massive.com/futures`, subscriptions `A.<contract>` and `AM.<contract>`
  only (no trades or quotes), multi-contract subscription, a second concurrent connection,
  close/reconnect with REST gap backfill, a REST minute-bar revision check, and an auth-only probe
  of the real-time host.

```
node apps/worker/spikes/massive-futures-starter/rest.ts
node apps/worker/spikes/massive-futures-starter/ws.ts
npx tsc -p apps/worker/spikes/massive-futures-starter/tsconfig.json
```

Contract tickers are discovered at run time (contracts endpoint + snapshot session volume); none
are hard-coded except expired contracts named once for the history-depth probe.

## Results

See [docs/research.md](../../../../docs/research.md), section "Massive Futures Starter capability
spike".

## Secrets

Never commit secrets. The key is read only from the gitignored `apps/worker/.dev.vars`; it is never
printed, logged, saved, or put in a URL. No raw market data is stored in this directory (run output
went to a local scratch location only).
