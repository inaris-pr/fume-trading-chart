# Trading-state reconciliation

**Principle:** the broker is the source of truth, but the UI doesn't wait for REST to show what the broker has already told us. Every client-side trading value carries its provenance as `Sourced<T>` (`packages/core/src/trading.ts`), in one of three sources:

| Source     | What it is                                                                                         | Examples                                                                                               | Provisional?                                                    |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `stream`   | A value the **broker reported** in a streamed `trade_updates` event, applied the moment it arrives | order status, filled qty, fill price/qty/time, resulting position qty (`position_qty`, VERIFIED field) | **Yes**: broker-confirmed, but events can be missed (no replay) |
| `derived`  | A value **Fume computed** from streamed events                                                     | average entry after a fill; unrealized P&L and position value computed from it                         | **Yes**: an estimate                                            |
| `snapshot` | Broker REST state                                                                                  | account (buying power, equity), position (qty, avg entry), open orders, fill history                   | **No**: authoritative, replaces the other two                   |

The type enforces `provisional === (source !== 'snapshot')`. The position projection (`PositionProjection`) tracks provenance **per field**, because after a fill the quantity is `stream` while the average entry is `derived`. A value computed from any provisional input is itself provisional: unrealized P&L is provisional whenever the average entry is. The UI shows provisional values immediately and marks them subtly (for example, a "syncing" dot). It never hides them.

## What updates immediately on a streamed fill

Take a `fill` or `partial_fill` event with price `p`, qty `q`, and resulting signed position qty `Q'`. In the same frame:

| Display                              | Immediate value                                                                                                                                                                                                                                | Source                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Order status, filled / remaining qty | From the event's order state                                                                                                                                                                                                                   | `stream`                              |
| Execution marker on the chart        | Placed at `(fill.time.ms, p)`. One marker per `executionId`                                                                                                                                                                                    | `stream`                              |
| Position qty and side                | `Q'` from the event, as reported by the broker (not computed)                                                                                                                                                                                  | `stream`                              |
| Avg entry price                      | Estimated deterministically from the previous avg entry `A` and qty `Q`: <br>• adding in the same direction: `A' = (A·\|Q\| + p·q) / \|Q'\|` <br>• reducing: `A' = A` <br>• flipping through zero: `A' = p` <br>• flat (`Q' = 0`): no position | `derived`                             |
| Unrealized P&L, position value       | From `A'`, `Q'`, the last price and `contractMultiplier`                                                                                                                                                                                       | `derived` (provisional while `A'` is) |
| Limit-order line                     | Remaining qty shrinks. The line is removed on `filled`                                                                                                                                                                                         | `stream`                              |
| Buying power / equity                | **Not estimated.** Buying-power rules (margin, short reserves) are broker logic. The last snapshot value stays, marked "syncing" until `accountSnapshot` arrives                                                                               | `snapshot` (stale-marked)             |

## Reconciliation

- After any trading event, the hub fetches position + account once (debounced about 250 ms) and pushes `positionSnapshot` / `accountSnapshot`. The client **replaces** every `stream`/`derived` value with the snapshot value (`provisional: false`).
- **Guard against stale snapshots.** Position REST responses carry no event time, so a snapshot fetched a moment after a fill could predate it. Rule: if the snapshot's position qty differs from the latest streamed `Q'`, the hub refetches once after about 1 s. If it still differs, **the snapshot wins**, the divergence is logged, and the UI shows the snapshot. Orders are protected by `updatedAt.ns` (older states are ignored). Fills are keyed by `executionId`.
- The derived avg entry is always replaced by the broker's value. Differences above one tick are logged, so the estimate formula can be checked against real paper fills in Stage 6.

## Projection rules (pure reducer in `@fume/core`, unit-tested)

- Orders are keyed by `orderId`. An event is applied only if it moves the order forward:
  - terminal statuses (`filled`, `canceled`, `rejected`, `expired`, `replaced`) never change;
  - `filledQuantity` never decreases;
  - states with an older `updatedAt.ns` are ignored.
- Fills are keyed by `executionId`, and duplicates are ignored.
- **Accepted never means filled.** A 2xx on submit shows the broker's status (`accepted` / `new` / `pending_new`).
- Quantity arithmetic and the avg-entry estimate use a small fixed-point decimal helper (scaled `bigint`, no float). Division in the estimate is rounded half-even to 8 decimal places, and results are rounded again only for display. Unrealized P&L is a display estimate and may use float.

## Scenarios

| Situation                                               | Procedure                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Browser refresh**                                     | Connect WS → `subscribe(trading)` → buffer events → `GET /trading/snapshot` → apply buffered events that are newer (by `updatedAt.ns` / `executionId`) → live.                                                                                                      |
| **Browser network interruption**                        | WS drops → backoff reconnect → the same procedure as a refresh. A `seq` gap triggers the same procedure.                                                                                                                                                            |
| **Upstream trade_updates drop** (hub side)              | Hub reconnects with backoff, re-auths, re-`listen`s, and broadcasts `resync(trading)`. Clients re-snapshot. Events during the gap are **lost by design** (no replay), and the snapshot recovers the resulting state.                                                |
| **Backend restart / DO eviction**                       | Browser sockets close → clients reconnect → the new hub opens upstream sockets and sends `resync(all)`. There's no server-side state to recover.                                                                                                                    |
| **Ambiguous submit** (timeout, 5xx, dropped connection) | **Never resubmit blindly.** `GET /orders/by-client-id/{clientOrderId}`. If found, adopt it. If not found after a short retry window, report "unknown, check orders" and re-snapshot. Broker duplicate-ID rejection is the second safety net (UNVERIFIED, spike S5). |
| **Cancel**                                              | `DELETE` → "cancel requested" → removed on a streamed `canceled` event (immediately) or when a snapshot no longer lists it. On `cancel_rejected`, it stays (it probably filled).                                                                                    |
| **Close position**                                      | `POST …/close` → the closing order is shown working → the position line updates on each streamed fill (immediate) and is confirmed by `positionSnapshot`.                                                                                                           |
| **Backstop**                                            | While the tab is visible, a snapshot every 60 s catches silent divergence. It's a safety net, not the primary mechanism.                                                                                                                                            |

## Chart overlays

| Overlay                                              | Source                                                                  |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Average-entry line + qty + live unrealized P&L label | position (stream estimate → snapshot), last price, `contractMultiplier` |
| Pending limit-order lines (remaining qty)            | open orders with `limitPrice`                                           |
| Buy/sell execution markers                           | fills, one per execution (partial fills separate)                       |
| Current-price line                                   | last trade                                                              |

Known discrepancy: paper fills are simulated against the **NBBO**, while the chart shows **IEX** trades. A fill marker may sit outside the candle's range. Markers are never clamped, and a tooltip notes the feed.
