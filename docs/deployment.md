# Cloudflare deployment preparation

Status: implementation prepared locally; **nothing deployed and no Cloudflare resources created**.
This work is isolated on `deployment/cloudflare-prep`, based on
`7593b0cc14af450080055c812145366fedc40119` (local main, Stage 8).
Stage 9's uncommitted feature tree is not included. Revalidate after integrating reviewed feature work.
This document supersedes older local-only deployment/authentication descriptions for this branch.

## Architecture

Browser -> Cloudflare Access -> one Worker:

- Vite assets from `apps/web/dist` through `ASSETS`.
- Same-origin `/api/v1/*` JSON API.
- `/api/v1/stream?key=futures-delayed` WebSocket upgrade -> `FEED_HUB` ->
  `FeedHubObject` -> one provider upstream for the feed.

No Pages deployment, Node server, D1, KV, or R2 is required. Node >=22 and pnpm 10.26.1 are
build tools. The chart, provider selection, timeframe behavior, drawings and data-source default
are unchanged. Equities remain Alpaca IEX historical data; futures use Massive delayed data.
Paper trading and Alpaca streaming are not implemented.

## Authentication

Local: the existing default Wrangler config keeps `FUME_ENV=local`. Only the request URL's
loopback hostname enables the bypass; Host/Forwarded headers cannot enable it. Vite still runs
on localhost:5173, proxies /api to 127.0.0.1:8787 with WebSocket forwarding, and needs no Access login.
The default local Worker config has no assets requirement, so existing `pnpm dev:worker` does not
require a frontend build.

Production: only the exact environment name `production` enables Access verification, and HTTPS
is required. `jose` validates the RS256 signature using keys from the configured Access team's
`/cdn-cgi/access/certs`, exact issuer, audience, required subject/issued-at/expiry, expiry and nbf,
and rejects future issued-at times. Only HTTPS *.cloudflareaccess.com team origins are accepted.
Key fetching has a timeout, bounded cache and refresh cooldown; outages fail closed.

Every API data request, WebSocket upgrade and asset/navigation request requires a valid
`Cf-Access-Jwt-Assertion`. Unknown environments deny access. Production on loopback still
requires Access; accidentally choosing local mode on a public hostname denies access.
CORS preflight OPTIONS may return an empty 204 without a JWT after the origin check; it returns
no data and cannot upgrade a socket. The subsequent request must authenticate.

A later Cloudflare Access application/policy must cover the entire hostname and permit only the
owner's identity. No email is hardcoded. Do not accept a claimed email header as authentication.
The Worker independently verifies the assertion; all alternate/preview endpoints must be disabled
or protected by the same policy. Access terminates login at the edge; frontend JavaScript neither
handles nor receives the assertion. Tokens/cookies are stripped before forwarding to assets and
the internal stream hub, and are never returned or logged. Failure responses are generic.

The JWT is checked at WebSocket upgrade, not on every frame. Existing sessions may remain open
after the login token expires; Access policy/session revocation and reconnect/login behavior must
be tested during the later authorized deployment. No additional token issuance service is added.

## Routing and assets

The production environment has `assets.directory=../web/dist`, binding `ASSETS`,
`not_found_handling=single-page-application`, and `run_worker_first=true`.
Worker-first is mandatory: do not allow SPA navigation or matching assets to bypass authentication.

The Worker sends /api and /api/* exclusively to the API router. JSON errors, missing API routes,
and failed WebSocket requests never fall back to index.html. Other GET/HEAD paths authenticate
then use the native asset binding for static files and SPA navigations. Other methods and upgrades
outside the API are rejected. Authenticated frontend responses are private/no-store. No generic
upstream proxy exists; provider hosts remain fixed by provider adapters and strict settings checks.

Build output includes frontend source maps. They contain no secrets (the bundle scan includes
maps) but reveal frontend source to authenticated readers. Decide whether to exclude maps in a
later release policy; no chart build behavior was changed here.

## Configuration

`apps/worker/wrangler.jsonc` keeps default local settings and adds an explicit `production`
environment. Production deliberately has no route/domain, workers.dev disabled, preview URLs
disabled, empty Access/origin settings, and Massive disabled. It cannot serve an authenticated
production application until the operator fills in non-secret settings and approves deployment.

Runtime secrets (names only):

- `ALPACA_API_KEY_ID`
- `ALPACA_API_SECRET_KEY`
- `MASSIVE_API_KEY`

Use Cloudflare **Worker secrets in the production environment**, never VITE_* variables, source,
committed vars, frontend build substitutions, or chat. No secrets were copied to this worktree.
Normal local setup remains the ignored apps/worker/.dev.vars file, created locally by the owner.

Non-secret variables:

| Name                       | Configuration                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------- |
| FUME_ENV                   | production in the production environment; local only for development                   |
| FUME_ALLOWED_ORIGINS       | Exact deployed HTTPS origin, no path or wildcard; blank denies browser Origin requests |
| FUME_ACCESS_TEAM_DOMAIN    | Exact HTTPS Cloudflare Access team origin, without trailing slash                      |
| FUME_ACCESS_AUD            | Access application's audience tag                                                      |
| FUME_MASSIVE_ENABLED       | false until written cloud-use authorization and a reviewed release decision            |
| ALPACA_DATA_BASE_URL       | Existing fixed Alpaca market-data endpoint                                             |
| ALPACA_TRADING_BASE_URL    | Existing fixed paper-trading endpoint                                                  |
| ALPACA_DATA_FEED           | Existing IEX feed                                                                      |
| MASSIVE_REST_BASE_URL      | Existing fixed Massive REST endpoint                                                   |
| MASSIVE_FUTURES_STREAM_URL | Existing fixed delayed-futures WebSocket endpoint                                      |

Provider endpoint settings are already present in the example Wrangler configuration.
Alpaca stream variables in older examples are unused in this build. Access issuer/audience are
identifiers, not passwords; nevertheless they stay backend-only.

Bindings:

- `ASSETS`: built Vite frontend; production only.
- `FEED_HUB`: existing Durable Object class `FeedHubObject`, exported by src/index.ts.
- Migration `v1` uses `new_sqlite_classes: ["FeedHubObject"]`. It is repeated in the
  production environment with its binding. This task does not apply the migration.
- The DO persists the stream key and conflict cooldown, not user drawings or indicator settings.

## Massive release blocker

**Written authorization for private cloud-backend use remains unresolved.** Do not interpret
this configuration, a valid key, or passing tests as authorization.

Production requires the exact string `FUME_MASSIVE_ENABLED=true` in addition to a valid key
and fixed endpoint settings. Otherwise futures HTTP routes and the stream hub cannot initialize
the provider and return unavailable. The gate is inside the provider settings used both by the
router and Durable Object construction/reconstruction. Existing local behavior remains enabled
by local credentials; an explicit false also disables it locally.

The safe default is to pause full-functionality deployment until authorization is recorded.
An equities/replay-only deployment would omit existing futures capability and needs a separate
explicit scope decision; it is not silently approved by this task.
Avoid simultaneous local and cloud upstreams with the same single-connection feed credential.
Client socket hibernation does not make an active outgoing provider WebSocket free/hibernatable.

## Default data source and My Dashboard

The root page still defaults to deterministic replay. `?source=api` selects the hosted API.
After deployment and verification, the future My Dashboard appUrl may include that query.
No Dashboard file was modified. New-tab launch is the initial integration; embedding requires
separate Access-cookie and framing-policy verification. Hosting makes Fume reachable remotely,
but does not add cross-device persistence or new mobile chart interactions.

## Local validation (no deployment)

From this worktree:

```powershell
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm check:worker
pnpm scan:secrets
pnpm scan:bundle
```

`check:worker` runs Wrangler with **--dry-run --env production** and writes only to ignored
.wrangler/prepared. It bundles the Worker and checks bindings/assets configuration; it does not
upload, migrate, create an Access application, or deploy. Run pnpm build first. No lint tool is
configured; formatting is not a substitute for lint.

Unit/integration tests use generated ephemeral signing keys, a fake JWKS endpoint and fake
providers/hubs. No live market-data requests or second upstream connection are required.
The isolated worktree has no real credential file; regular scans report zero local values
compared unless the owner independently configures it. Their pattern checks still apply.

## Later deployment checklist — requires explicit approval

1. Review this branch's changes and choose the final release revision. Integrate separately
   reviewed Stage 9 work if desired, then repeat all validation. Push, PR creation and deployment require separate explicit approval.
2. Resolve and record Massive's written authorization, or explicitly approve reduced scope.
3. Select the Cloudflare account and stable HTTPS hostname. A custom domain is optional;
   an Access-protected workers.dev address can be used. No DNS/domain changes have been made.
4. Create the Access policy for the owner's identity in the later authorized deployment phase.
   Configure the issuer, audience and exact browser origin; verify no alternate endpoint bypass.
5. Add required runtime secrets securely to the production environment; keep Massive disabled
   until authorized. Confirm Worker/DO plan limits and active-stream costs.
6. Review assets and FEED_HUB/migration configuration, then obtain explicit deployment approval.
7. Only after approval deploy the selected revision and migration. Arrange a controlled
   single-upstream handoff without stopping unrelated applications.
8. Verify real Access login and denied users; missing/expired/forged JWT rejection; static assets
   and deep links; JSON API failures; history; symbol/timeframe changes; wss upgrade and reconnect;
   multi-tab hub sharing; logout/session expiry; provider errors; no credential exposure.
9. Only after success record the stable URL for a separate My Dashboard registry update.

References:

- [Cloudflare JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Worker-first static assets](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [WebSocket hibernation limitations](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

## Recorded validation — October 3, 2026

- `pnpm format:check`: passed.
- `pnpm typecheck`: passed across the workspace.
- `pnpm test`: **806 passed in 53 files**, including 46 new deployment tests.
- `pnpm build`: passed (Vite frontend, Stage 8 base).
- `pnpm check:worker`: passed, production Worker bundled locally with ASSETS and FEED_HUB.
  Wrangler's "Total Upload" label is a size estimate; --dry-run exited without uploading.
- `pnpm scan:secrets` and `pnpm scan:bundle`: passed, zero findings.
- Additional in-memory comparison of all three existing local provider credential values
  against isolated source and browser assets: zero findings. No credential files were copied.
- `git diff --check`: passed. No lint configuration was introduced.
- Actual local workerd checks passed: frontend root, SPA deep link, built JavaScript, local API,
  and JSON 404 for an unknown API route. Local mode was supplied only as a temporary CLI override;
  the production configuration remains production.
- Actual local production-mode checks returned 401 for the root, SPA deep link, JavaScript
  asset, API health request, and a WebSocket upgrade. No provider requests were made.
- Both temporary servers were shut down. Wrangler could not fetch optional Request.cf metadata
  and used its local fallback; this did not prevent startup or the checks.
- Signed-JWT tests use generated ephemeral keys and mocked JWKS. Successful WebSocket forwarding
  uses a fake hub in Node; real hosted Access login, accepted wss connections, and live provider
  behavior remain checks for the later authorized deployment. No claim of cloud end-to-end
  verification is made.

### Isolation record

Worktree: `C:\Users\inari\Projects\Fume-cloudflare-prep`

Branch: `deployment/cloudflare-prep`

Base commit: `7593b0cc14af450080055c812145366fedc40119`

The initial preparation was left uncommitted. The owner subsequently authorized one local release-preparation checkpoint commit after a full diff review and validation. No push, PR, deployment or Cloudflare resource creation is authorized.

Original checkout: `C:\Users\inari\Projects\Fume`

Branch: `stage-9/indicator-foundation`

HEAD: `245de2b05c019c44c4f2a7be8bc944bd5092a0a7`

The original branch, HEAD, porcelain status and hashes of all 251 tracked/non-ignored
files were compared with the pre-worktree snapshot and matched. Its 42 uncommitted files
(26 modified and 16 untracked) remain untouched:

```text
 M ARCHITECTURE.md
 M CLAUDE.md
 M apps/web/src/App.tsx
 M apps/web/src/DrawingToolbar.tsx
 M apps/web/src/bench.ts
 M apps/web/src/icons.tsx
 M apps/web/src/styles.css
 M docs/HANDOFF.md
 M docs/embedding.md
 M packages/chart/package.json
 M packages/chart/src/chart.ts
 M packages/chart/src/frame.ts
 M packages/chart/src/index.ts
 M packages/chart/src/interaction.ts
 M packages/chart/src/layout.ts
 M packages/chart/src/paint-overlay.ts
 M packages/chart/src/paint.ts
 M packages/chart/src/price-scale.ts
 M packages/chart/src/series.ts
 M packages/react/src/FumeChartView.tsx
 M packages/react/src/binding.ts
 M packages/react/src/index.ts
 M packages/react/test/binding.test.ts
 M packages/react/test/fume-chart-view.test.tsx
 M pnpm-lock.yaml
 M test/boundaries.test.ts
?? apps/web/src/IndicatorPanel.tsx
?? docs/indicators.md
?? packages/chart/src/indicators/engine.ts
?? packages/chart/src/indicators/format.ts
?? packages/chart/test/indicators.test.ts
?? packages/indicators/package.json
?? packages/indicators/src/builtin/moving-averages.ts
?? packages/indicators/src/builtin/oscillators.ts
?? packages/indicators/src/definition.ts
?? packages/indicators/src/index.ts
?? packages/indicators/src/model.ts
?? packages/indicators/src/registry.ts
?? packages/indicators/src/series.ts
?? packages/indicators/test/formulas.test.ts
?? packages/indicators/test/model.test.ts
?? packages/indicators/tsconfig.json
```

Deployment changes are isolated as a Git worktree and branch, not mixed into the Stage 9 checkout.
Some future integration conflicts are possible in shared documentation, dependency manifests/lockfile
and architecture boundary tests; review those when combining branches rather than overwriting Stage 9.
