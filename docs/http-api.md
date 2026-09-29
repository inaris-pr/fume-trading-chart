# HTTP API contract, v1 (draft)

Base path: `/api/v1`. JSON bodies use `@fume/core` shapes.

- **Timestamps:** event times (orders, fills) are `EventTime { ns, ms }`. Bar starts and query parameters (`end`, `from`, `to`, `fillsSince`) are `UnixMs`.
- **Money and quantities:** `Decimal` strings.

**Origin, authentication and authorization are separate steps** (see [security.md](security.md)):

- Browser requests must come from an origin in `FUME_ALLOWED_ORIGINS`. CORS headers are sent only for those origins.
- Every request must also authenticate. The standalone deployment uses a Cloudflare Access identity. Locally, the Worker binds only to localhost.

**Errors:** non-2xx responses always return:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "limitPrice is required for limit orders",
    "retryable": false,
    "details": { "field": "limitPrice" }
  }
}
```

`code` values: `unauthorized`, `forbidden_origin`, `invalid_request`, `not_found`, `rejected` (by broker), `insufficient_entitlement`, `rate_limited` (with a `Retry-After` header), `unavailable`, `internal`.

## Market data

### `GET /api/v1/instruments/resolve?symbol=SPY`

`200 → { "instrument": Instrument }` or `404`.

### `GET /api/v1/bars?instrumentId=eq:SPY&timeframe=1h&session=regular&end=<UnixMs>&limit=500`

Returns **canonical, session-aligned Fume candles**, built server-side from provider base bars (see [market-data.md](market-data.md#canonical-candles-provider-neutral)). They are never raw provider timeframes.

- Pages backwards from `end` (exclusive). `limit` is at most 2000 canonical candles.
- With `end` omitted, the latest candles are returned, including the current in-progress bucket as `provisional`.
- `session`: `regular` (default) or `extended`. The MVP implements `regular` only; `extended` returns `400 invalid_request` until it's enabled.

```json
{
  "meta": {
    "instrumentId": "eq:SPY",
    "timeframe": "1h",
    "sessionMode": "regular",
    "feed": { "providerId": "alpaca", "feedId": "iex", "consolidated": false, "delayMs": 0 }
  },
  "bars": [
    {
      "start": 1790000000000,
      "open": 1,
      "high": 1,
      "low": 1,
      "close": 1,
      "volume": 100,
      "status": "final",
      "revision": 0
    }
  ],
  "hasMore": true,
  "serverTime": 1790000000123
}
```

Bars are ascending. The client loads older data with `end = bars[0].start`.

### `GET /api/v1/sessions?instrumentId=eq:SPY&from=<UnixMs>&to=<UnixMs>`

`200 → { "sessions": MarketSession[] }`. Used for session separators and the market-open state.

## Trading (paper only in the MVP)

### `GET /api/v1/trading/snapshot?instrumentId=eq:SPY&fillsSince=<UnixMs>`

One call to (re)build client trading state:
`200 → TradingSnapshot` (`account`, `position | null`, `openOrders`, `fills`, `asOf`).

### `GET /api/v1/account` → `{ "account": Account }`

### `GET /api/v1/positions?instrumentId=` → `{ "positions": Position[] }`

### `GET /api/v1/orders?instrumentId=&status=open|closed|all&after=&limit=` → `{ "orders": Order[] }`

### `GET /api/v1/orders/by-client-id/{clientOrderId}` → `{ "order": Order }` or `404`

Used after an ambiguous submit (timeout or network error) instead of resubmitting.

### `POST /api/v1/orders`

```json
{
  "clientOrderId": "6f1c…uuid",
  "instrumentId": "eq:SPY",
  "side": "buy",
  "type": "limit",
  "timeInForce": "day",
  "quantity": "10",
  "limitPrice": "501.25",
  "extendedHours": false
}
```

- `extendedHours` is optional. If present it must be `false`; the MVP places regular-session orders only.
- `201 → { "order": Order }`. The order is **accepted, not filled**. Its status is whatever the broker reported.
- Server-side validation: see [security.md](security.md#trading-request-validation).
- Idempotency: `clientOrderId` passes through to the broker. A duplicate `clientOrderId` returns `409` with the existing order if one can be fetched.

### `DELETE /api/v1/orders/{orderId}`

`202 → { "status": "cancel_requested" }`. The cancellation is confirmed later by a `canceled` or `cancel_rejected` event.

### `POST /api/v1/positions/{instrumentId}/close`

`202 → { "order": Order }` (the closing order). The position is closed only when that order fills.

## Operational

### `GET /api/v1/health`

`200 → { "ok": true, "version": "…", "tradingEnvironment": "paper", "marketDataFeed": "iex" }`. It never includes secrets or key IDs.
