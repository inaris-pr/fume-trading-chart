# CLAUDE.md — Fume Trading Chart

Permanent project rules for Claude Code sessions. Keep this file short and stable; current status
lives in [docs/HANDOFF.md](docs/HANDOFF.md), design detail in the linked docs.

## Project

- **Fume Trading Chart**: a custom, standalone, single-user trading chart/platform (paper trading
  later), built in staged, owner-approved increments.
- Development happens on **Windows** (PowerShell and Git Bash). Node ≥ 22, pnpm 10 workspaces.
- The **repository root is the source of truth**: code, Git history, this file and
  `docs/HANDOFF.md`. Do not reconstruct decisions from memory or assumptions.

## Architecture rules (enforced by `test/boundaries.test.ts`)

- `packages/core` → nothing (no DOM, no provider code).
- `packages/chart` → `core` **type-only** (`import type`; core is a devDependency).
- `packages/replay` → `core`.
- `apps/worker` → `core` (runtime); `wrangler` is dev-only.
- `apps/web` → `core`, `chart`, `replay`, and Fume's own HTTP API client (relative `/api/v1` only).
- Provider-specific code (payload types, hosts, header names) stays behind adapters in
  `apps/worker/src/providers/<provider>/`; only the Worker composition root imports them.
- The **browser never connects directly to Alpaca** (or any provider).
- **Custom Canvas 2D chart only.** No TradingView, no Lightweight Charts, no third-party financial
  chart renderer (lockfile guard).

## Market data rules

- Default chart session: **US regular trading hours**.
- Visible timeframe order: **1D | 4H | 1H | 15m | 5m | 1m**.
- 1H buckets are session-aligned: 09:30–10:30, 10:30–11:30, 11:30–12:30, 12:30–13:30,
  13:30–14:30, 14:30–15:30, 15:30–16:00 (short).
- 4H buckets: 09:30–13:30, 13:30–16:00. Early closes clip the last bucket.
- **Canonical candles are built by Fume** (`@fume/core`), never taken from a provider's 1h/1d bars.
- Replay (`@fume/replay`) remains the deterministic, offline reference provider and the default mode.

## Security rules

- Alpaca credential values exist locally **only** in `apps/worker/.dev.vars` (gitignored).
- **Never** print, echo, read back, log, commit, screenshot or otherwise expose those values. Check
  only that the file exists / variables are defined; scans compare values without printing them.
- Never put credentials in browser code, `import.meta.env` or `VITE_*` variables, URLs, fixtures,
  API responses or logs.
- `.dev.vars` and `.wrangler/` must stay ignored. Cloudflare Worker secrets are used later, at
  deployment; do not deploy unless a stage explicitly calls for it.
- Never ask the owner to paste credentials into chat.

## Git / stage workflow

1. One feature branch per stage (`stage-N/<scope>`), created from an up-to-date `main`.
2. Implement → test → the owner reviews visually.
3. Commit and push **only after the owner approves**. Never commit, push or open a PR unasked.
4. Create the PR → owner squash-merges → sync `main` (fast-forward) → verify the stage content on
   `main` by tree/content, not ancestry → delete the old branch (local + remote, prune) → create
   the next stage branch.
5. **Never start the next stage without explicit approval.**
6. Do **not** add `Co-Authored-By` lines unless the owner explicitly asks.

## Quality gates (package scripts; run before any commit)

```
pnpm test            # all Vitest suites, incl. boundary / chart-library / fixture guards
pnpm typecheck
pnpm format:check
pnpm build
pnpm scan:secrets    # tracked + untracked files, compares local credential values
pnpm scan:bundle     # after build: no provider hosts, auth headers, __fume handles or credentials
```

Local dev: `pnpm dev` (replay), `pnpm dev:worker`, `pnpm dev:api` (web + Worker, `?source=api`).

## Project docs (read what the task needs; do not duplicate them here)

- [ARCHITECTURE.md](ARCHITECTURE.md): system shape, package boundaries, chart engine, data paths
- [docs/HANDOFF.md](docs/HANDOFF.md): current status, verified facts, next action
- [docs/roadmap.md](docs/roadmap.md): stages, acceptance criteria, risks and spikes
- [docs/market-data.md](docs/market-data.md): canonical candles, history, live reconciliation
- [docs/http-api.md](docs/http-api.md): `/api/v1` contract
- [docs/security.md](docs/security.md): credentials, origin policy, authentication
- [docs/performance.md](docs/performance.md): measured baselines
- [docs/research.md](docs/research.md): provider facts with VERIFIED/UNVERIFIED status, S1 results
