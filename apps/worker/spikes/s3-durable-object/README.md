# Spike S3: Durable Object as the upstream WebSocket owner (NON-PRODUCTION SPIKE CODE)

**This is research/spike evidence, not Fume production code.** It is not imported by the
production Worker (`apps/worker/src`), it is not the Stage 5 StreamHub, and it must not be
extended into one. The permanent design starts from ARCHITECTURE.md §6 and the futures-provider /
multi-provider checkpoint, not from this code.

## Purpose

Stage 5 spike S3 (run **2026-09-30**): can a Cloudflare Durable Object own Fume's single Alpaca
IEX market-data WebSocket and share it with several clients, and what do its lifecycle and cost
look like during a real market session?

- `src/index.ts`: one DO (`S3Hub`) holding one outbound `v2/iex` socket (SPY trades), with
  lifecycle counters, 406 handling with bounded backoff, a 60 s last-client idle close, and a
  spike-only forced-upstream-loss route. Downstream clients receive per-second **counts only**.
- `client.ts`: test harness (functional sequence, Run B, stats); prints counts/timings only.
- `compare.ts`: per-minute streamed trade counts vs the official IEX 1-minute bars' `n`.
- `wrangler.jsonc`: config of the temporary Worker `fume-s3-spike` (secrets never in this file).

## How it informed the architecture

Results are in [docs/research.md](../../../../docs/research.md) (S3 section). Summary: an outbound
socket alone keeps a DO alive only ~15 minutes; an open downstream client socket kept it alive for
the 36-minute run; reconstruction and redeploys released the Alpaca slot without a 406; forced
upstream recovery took ~1.1 s; one open hub measured ~460.8 GB-s per hour. The owner approved the
**Durable Object hub primitive** (GO) with the required constraints in ARCHITECTURE.md §6.

## Status of the deployed spike

The temporary Cloudflare Worker `fume-s3-spike`, its Durable Object and its secrets
(`ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `S3_TOKEN`) were **deleted** on 2026-09-30 after
the run.

## Secrets

Never commit secrets. Locally the spike read Alpaca keys only from the gitignored
`apps/worker/.dev.vars` via `wrangler dev --env-file`; remotely they were Worker secrets. No
credential, token or raw trade data is stored in this directory.
