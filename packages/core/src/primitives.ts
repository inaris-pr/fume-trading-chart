/**
 * Shared primitive types.
 *
 * Numeric policy (see docs/domain-model.md):
 * - Market-data prices/volumes are `number` (float64). They are for rendering and aggregation.
 * - Brokerage money and quantities are `Decimal` strings, exactly as the broker reports them.
 *   Convert to number only for display or P&L estimation, never to build an order request.
 */

/**
 * Milliseconds since the Unix epoch, UTC, as an integer. Used for rendering, bar bucket starts
 * (which are whole-second aligned by construction) and local bookkeeping. NOT the canonical
 * timestamp of market or trading events. See `EventTime`.
 */
export type UnixMs = number;

/**
 * Canonical high-precision event timestamp: integer nanoseconds since the Unix epoch (UTC),
 * encoded as a base-10 string with no sign, no leading zeros and no fraction,
 * e.g. "1790000000123456789".
 *
 * Why a string: epoch nanoseconds (~1.8e18) exceed Number.MAX_SAFE_INTEGER (~9.0e15), so a
 * float64 would silently round them. `bigint` is exact but not JSON-serializable. A canonical
 * decimal string is exact, JSON-safe and cheap to order: compare by length, then
 * lexicographically. Convert with BigInt() when arithmetic is needed.
 * Providers with lower precision (µs, ms) are zero-extended to ns by the adapter.
 */
export type EpochNs = string & { readonly __brand: 'EpochNs' };

/**
 * Timestamp of a market or trading event: canonical `ns` plus derived `ms` for Canvas rendering.
 * Invariant: ms === Number(BigInt(ns) / 1_000_000n) (floor). Ordering always uses `ns`.
 */
export interface EventTime {
  ns: EpochNs;
  ms: UnixMs;
}

/** Canonical base-10 decimal string, e.g. "187.25", "0.0001", "-3". No exponent notation. */
export type Decimal = string;

/** Opaque, backend-issued instrument identifier, e.g. "eq:SPY". Clients must not parse it. */
export type InstrumentId = string & { readonly __brand: 'InstrumentId' };

/** Identifies a provider implementation, e.g. "alpaca", "replay". */
export type ProviderId = string;

/** Provider-neutral error surfaced across the provider boundary. */
export interface ProviderError {
  code:
    | 'unauthorized'
    | 'insufficient_entitlement'
    | 'rate_limited'
    | 'invalid_request'
    | 'not_found'
    | 'rejected'
    | 'unavailable'
    | 'internal';
  message: string;
  retryable: boolean;
  /** Suggested wait before retry, when the provider supplies one. */
  retryAfterMs?: number;
  /** Raw provider code for logs only; never branch on it outside the adapter. */
  providerCode?: string;
  /** Provider-neutral detail a UI or API may act on (never raw provider text). */
  reason?: ProviderErrorReason;
}

/** Provider-neutral failure details surfaced to clients (API `details.reason`, stream status). */
export type ProviderErrorReason =
  | 'contract_not_found'
  | 'contract_expired'
  | 'auth_failed'
  | 'entitlement'
  | 'connection_conflict'
  | 'upstream_disconnected'
  | 'history_unavailable'
  | 'schedule_unavailable'
  | 'no_delayed_data_yet';
