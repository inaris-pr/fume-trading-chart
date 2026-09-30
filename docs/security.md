# Security model

## Credentials

**Stage 5:** `MASSIVE_API_KEY` (delayed futures) follows the same rules as the Alpaca keys: only in
the gitignored `apps/worker/.dev.vars` locally (a Worker secret later); sent only in the
`Authorization: Bearer` header (REST) and the upstream WebSocket auth frame from the Worker/Durable
Object; never in a URL (cursor `apiKey` parameters are stripped), log, error, fixture, API response
or browser bundle. `scan:secrets` and `scan:bundle` compare its value too.

- The Alpaca **paper** key ID and secret exist in only two places:
  1. **Local:** `apps/worker/.dev.vars`, created by you from `apps/worker/.dev.vars.example` (empty values only). The file is gitignored and read by `wrangler dev` and by the S1 script (`pnpm s1`), which never prints, logs or saves the values.
  2. **Cloudflare:** Worker secrets, set with `pnpm exec wrangler secret put ALPACA_API_KEY_ID` and `… ALPACA_API_SECRET_KEY` from `apps/worker/`. You type the values into the Wrangler prompt yourself. They never go into chat, files or shell history.
- The browser never receives them. They must not appear in frontend code, `import.meta.env`/`VITE_*` variables, API responses, query strings, local/session storage, logs or source maps. The frontend bundle is built without access to the Worker's env.
- `.gitignore` excludes `.env*` and `.dev.vars*` (except the examples). Before the first commit of each stage: `git grep -nE "APCA|SECRET|PK[A-Z0-9]{16}"` must show only placeholder or variable names. We could add a pre-commit secret scan later if wanted.
- Logs never include auth frames, request headers, or the full config object.
- **Stage 4 enforcement:** credentials are sent only in the `APCA-API-KEY-ID` / `APCA-API-SECRET-KEY` request headers from `apps/worker/src/providers/alpaca/client.ts`; never in URLs, errors or logs (tested). Worker logs are one structured line per request (route, status, ms, upstream call count, bar counts). Recorded fixtures contain response bodies only (a boundary test rejects auth headers, key-shaped strings and account identifiers in fixtures). `pnpm scan:secrets` scans every tracked and untracked file; `pnpm scan:bundle` scans `apps/web/dist` for Alpaca hosts, credential header names, `__fume` handles and the actual local credential values (compared, never printed).
- **Host guard (Stage 4):** the Worker treats market data as "not configured" (`503`) unless `ALPACA_DATA_BASE_URL` is exactly `https://data.alpaca.markets`, `ALPACA_TRADING_BASE_URL` exactly `https://paper-api.alpaca.markets` and `ALPACA_DATA_FEED` exactly `iex`.

## Paper-only guard

At startup the Worker refuses to run (every trading route returns `503 unavailable`) unless `ALPACA_TRADING_BASE_URL` is exactly `https://paper-api.alpaca.markets` and the stream URL is the paper stream. There's no live-trading switch in the MVP. Adding one needs explicit approval and a separate review.

## Three separate checks, in order

Every HTTP request and WS upgrade passes three independent middleware steps. None substitutes for another.

### 1. Origin policy (browser-context restriction, **not** authentication)

- Config: `FUME_ALLOWED_ORIGINS`, a comma-separated list of exact origins (scheme + host + port). Standalone default: the app's own origin only. Local dev adds `http://localhost:<vite-port>`.
- A request carrying an `Origin` header that isn't allowlisted is rejected with `403 forbidden_origin`. This applies to state-changing requests and to WS upgrades.
- CORS response headers (`Access-Control-Allow-Origin: <that exact origin>`, `Vary: Origin`, and the allowed methods/headers on preflight) are emitted **only** for allowlisted origins. Never `*`.
- Requests without `Origin` (server-to-server, curl) aren't rejected by this step. They still must pass authentication.
- Purpose: stop other websites from driving the API through your browser (CSRF, cross-site WebSocket hijacking). It proves nothing about **who** is calling. A non-browser client can send any `Origin`.
- Integrating your trading platform later = adding its origin to the allowlist **plus** enabling an authenticator it can use (step 2).

### 2. Authentication (`authenticate(request) → Principal`)

Pluggable authenticators, tried in configured order, failing closed:

- **Standalone (Stage 9):** a Cloudflare Access identity. The custom domain sits behind an Access policy allowing only your email, and the Worker verifies the `Cf-Access-Jwt-Assertion` JWT (signature, issuer, audience) on every request and upgrade. `workers.dev` and preview URLs are disabled or protected the same way.
- **External platform (designed in Stage 10, not built earlier):** one of the following, decided then with the platform's architecture in view. The origin allowlist doesn't change this choice.
  - An Access **service token** for server-to-server calls;
  - a **short-lived signed token** (JWT with audience `fume`, a lifetime of a few minutes) minted by that platform's backend with a shared signing secret stored as a Worker secret.
- **Local (implemented in Stage 4):** `wrangler dev` bound to 127.0.0.1, with a dev-only authenticator that accepts a request only when `FUME_ENV=local` **and** the request host is loopback (`localhost`, `127.0.0.1`, `[::1]`). Any other environment or host gets `401 unauthorized` (fail closed); there is no production authenticator yet.

### 3. Authorization (on the `Principal`)

- MVP: exactly one principal may trade, only on the paper account, only through the validated order routes.
- Nothing is ever authorized based on `Origin`.

## Trading-request validation

Validated server-side (pure functions in `@fume/core`) before any broker call:

- `instrumentId` resolves to a known, `tradable` instrument.
- `side ∈ {buy, sell}`, `type ∈ {market, limit}`, `timeInForce ∈ {day, gtc}`.
- `quantity` is a positive decimal string, a multiple of `quantityStep`, and at most a configured `MAX_ORDER_QTY` (a fat-finger guard even on paper, default 1000).
- `limitPrice` is required if and only if `type = limit`. It must be a decimal on the instrument's tick grid (`tickRules`), and greater than zero for equities and ETFs. Futures may later allow zero or negative prices through instrument metadata.
- `extendedHours` must be `false` or absent (absent is treated as `false`). The MVP accepts regular-session orders only (owner decision Q6), so `true` is rejected with `invalid_request`. When extended-hours trading is approved later, the broker rule applies as well: limit orders only, TIF `day`/`gtc` (VERIFIED).
- `clientOrderId` is a UUID. Unknown fields are rejected.
- The broker still performs the authoritative checks (buying power, shortability). Broker rejections are passed through as `rejected` with the broker's reason.

## Rate limiting

The Basic data limit is 200/min (VERIFIED). For a single user, the realistic risk is the chart's "load older" loop. The client throttles history paging (at most one request in flight per series). The Worker maps a provider 429 to `rate_limited` with `Retry-After` instead of retrying in a tight loop. A global limiter isn't needed for one user.
