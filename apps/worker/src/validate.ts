/**
 * Query-parameter validation for the /api/v1 market-data routes. Every failure is a 400
 * invalid_request naming the field; nothing is coerced silently.
 */
import {
  TIMEFRAMES,
  type AssetClass,
  type InstrumentId,
  type TimeframeId,
  type UnixMs,
} from '@fume/core';
import { invalidRequest } from './errors.ts';

export const DEFAULT_BAR_LIMIT = 500;
export const MAX_BAR_LIMIT = 2000;
/** Longest /sessions range accepted in one request. */
export const MAX_SESSIONS_RANGE_MS = 1100 * 86_400_000;

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

/** Upper-cases and validates a ticker ("spy" -> "SPY"). */
export function parseSymbol(value: string | null): string {
  const symbol = (value ?? '').trim().toUpperCase();
  if (!SYMBOL.test(symbol))
    throw invalidRequest('symbol must be 1-10 letters, digits or dots', 'symbol');
  return symbol;
}

/** Asset class of a symbol to resolve: `equity` (default; ETFs included) or `future` (a root). */
export function parseAssetClass(value: string | null): AssetClass {
  if (value === null || value === '' || value === 'equity') return 'equity';
  if (value === 'future') return 'future';
  throw invalidRequest('assetClass must be "equity" or "future"', 'assetClass');
}

/**
 * Fume instrument ids are backend-issued ("eq:SPY", "fut:NQ:2026-12"). Clients must not build
 * them; the backend parses its own formats here. `symbol` is set for ids that map 1:1 to a symbol.
 */
export function parseInstrumentId(value: string | null): {
  id: InstrumentId;
  namespace: string;
  symbol: string | null;
} {
  const raw = value ?? '';
  const equity = /^eq:([A-Z][A-Z0-9.]{0,9})$/.exec(raw);
  if (equity) return { id: raw as InstrumentId, namespace: 'eq', symbol: equity[1]! };
  if (/^fut:[A-Z][A-Z0-9]{0,4}:\d{4}-(0[1-9]|1[0-2])$/.test(raw)) {
    return { id: raw as InstrumentId, namespace: 'fut', symbol: null };
  }
  throw invalidRequest('instrumentId is missing or malformed', 'instrumentId');
}

/** Opaque stream-hub key (backend-issued, from /instruments/resolve). */
export function parseStreamKey(value: string | null): string {
  if (value === null || !/^[a-z0-9-]{1,32}$/.test(value)) {
    throw invalidRequest('key is missing or malformed', 'key');
  }
  return value;
}

export function parseTimeframe(value: string | null): TimeframeId {
  if (value === null || !Object.hasOwn(TIMEFRAMES, value)) {
    throw invalidRequest(
      `timeframe must be one of ${Object.keys(TIMEFRAMES).join(', ')}`,
      'timeframe',
    );
  }
  return value as TimeframeId;
}

/** Only regular-session candles exist in the MVP; `extended` is rejected, never downgraded. */
export function parseSessionMode(value: string | null): 'regular' {
  if (value === null || value === 'regular') return 'regular';
  if (value === 'extended') throw invalidRequest('session=extended is not enabled', 'session');
  throw invalidRequest('session must be "regular"', 'session');
}

function parseUnixMs(value: string, field: string): UnixMs {
  if (!/^\d{1,16}$/.test(value)) throw invalidRequest(`${field} must be a UnixMs integer`, field);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw invalidRequest(`${field} is out of range`, field);
  return n;
}

export function parseOptionalEnd(value: string | null): UnixMs | undefined {
  return value === null ? undefined : parseUnixMs(value, 'end');
}

export function parseLimit(value: string | null): number {
  if (value === null) return DEFAULT_BAR_LIMIT;
  if (!/^\d{1,5}$/.test(value)) throw invalidRequest('limit must be a positive integer', 'limit');
  const n = Number(value);
  if (n < 1 || n > MAX_BAR_LIMIT) throw invalidRequest(`limit must be 1-${MAX_BAR_LIMIT}`, 'limit');
  return n;
}

export function parseRange(from: string | null, to: string | null): { from: UnixMs; to: UnixMs } {
  if (from === null) throw invalidRequest('from is required', 'from');
  if (to === null) throw invalidRequest('to is required', 'to');
  const range = { from: parseUnixMs(from, 'from'), to: parseUnixMs(to, 'to') };
  if (range.from >= range.to) throw invalidRequest('from must be before to', 'from');
  if (range.to - range.from > MAX_SESSIONS_RANGE_MS) {
    throw invalidRequest('range is too long (max 1100 days)', 'to');
  }
  return range;
}
