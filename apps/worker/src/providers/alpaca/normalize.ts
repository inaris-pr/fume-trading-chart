/**
 * Alpaca payload -> @fume/core normalization. Malformed payloads are REJECTED (ProviderFailure
 * `internal`), never guessed. Unknown fields are ignored. Nothing Alpaca-shaped leaves this module
 * through its return types.
 */
import {
  epochNsToMs,
  parseRfc3339ToEpochNs,
  zonedWallTimeToUtc,
  zoneOffsetMs,
  type Bar,
  type EpochNs,
  type Instrument,
  type InstrumentId,
  type MarketSession,
  type TradingSessionSpec,
  type UnixMs,
} from '@fume/core';
import { ProviderFailure } from '../../errors.ts';

export const ALPACA_PROVIDER_ID = 'alpaca';
export const US_EQUITY_TIMEZONE = 'America/New_York';

const malformed = (what: string) =>
  new ProviderFailure({
    code: 'internal',
    message: `Malformed upstream ${what}`,
    retryable: false,
  });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------------------------
// Time

/**
 * THE conversion between Fume's EXCLUSIVE `end` (BarPageRequest.end: bars with start < end) and
 * Alpaca's INCLUSIVE `end` query parameter. Bar starts are whole-minute (and so whole-ms)
 * values, so `end - 1 ms` includes every start < end and excludes start === end. Every caller goes
 * through here; results are additionally filtered with `isBeforeExclusiveEnd`.
 */
export function toAlpacaInclusiveEnd(exclusiveEnd: UnixMs): string {
  return new Date(exclusiveEnd - 1).toISOString();
}

export function isBeforeExclusiveEnd(start: UnixMs, exclusiveEnd: UnixMs): boolean {
  return start < exclusiveEnd;
}

/** RFC 3339 for an inclusive lower bound. */
export function toAlpacaStart(start: UnixMs): string {
  return new Date(start).toISOString();
}

/** "YYYY-MM-DD" calendar date of `ms` in `timeZone`. */
export function localDate(ms: UnixMs, timeZone: string): string {
  return new Date(ms + zoneOffsetMs(ms, timeZone)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Bars

export interface NormalizeBarsResult {
  /** Ascending, unique starts. */
  bars: Bar[];
  duplicates: number;
}

/**
 * Normalizes one raw bar. `t` must be RFC 3339, exactly representable in ms and aligned to the
 * interval (epoch-aligned bucket start). OHLC must be finite with low <= open, close <= high;
 * volume finite and >= 0; `n`/`vw` optional. `status` is final once the bar's interval has
 * ended at `now`, provisional otherwise.
 */
export function normalizeBar(raw: unknown, intervalMs: number, now: UnixMs): Bar {
  if (!isRecord(raw) || typeof raw.t !== 'string') throw malformed('bar');
  let ns: EpochNs;
  try {
    ns = parseRfc3339ToEpochNs(raw.t);
  } catch {
    throw malformed('bar timestamp');
  }
  if (BigInt(ns) % 1_000_000n !== 0n) throw malformed('bar timestamp (sub-millisecond)');
  const start = epochNsToMs(ns);
  if (start % intervalMs !== 0) throw malformed('bar timestamp (not interval-aligned)');

  const { o, h, l, c, v, n, vw } = raw;
  if (!isFiniteNumber(o) || !isFiniteNumber(h) || !isFiniteNumber(l) || !isFiniteNumber(c)) {
    throw malformed('bar prices');
  }
  if (!(h >= l) || o > h || o < l || c > h || c < l) throw malformed('bar OHLC range');
  if (!isFiniteNumber(v) || v < 0) throw malformed('bar volume');
  if (n !== undefined && (!Number.isInteger(n) || (n as number) < 0))
    throw malformed('bar trade count');
  if (vw !== undefined && !isFiniteNumber(vw)) throw malformed('bar vwap');

  return {
    start,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: v,
    ...(n !== undefined ? { tradeCount: n as number } : {}),
    ...(vw !== undefined ? { vwap: vw as number } : {}),
    status: start + intervalMs <= now ? 'final' : 'provisional',
    revision: 0,
  };
}

/**
 * Normalizes, sorts ascending and de-duplicates bars (in any provider order). Duplicate starts are
 * resolved deterministically: the LAST occurrence in provider order wins (a later page is the
 * newer answer), and duplicates are counted.
 */
export function normalizeBars(
  raw: readonly unknown[],
  intervalMs: number,
  now: UnixMs,
): NormalizeBarsResult {
  const byStart = new Map<number, Bar>();
  let duplicates = 0;
  for (const item of raw) {
    const bar = normalizeBar(item, intervalMs, now);
    if (byStart.has(bar.start)) duplicates++;
    byStart.set(bar.start, bar);
  }
  const bars = [...byStart.values()].sort((a, b) => a.start - b.start);
  return { bars, duplicates };
}

/** Validates a bars page envelope: `bars` array or null, `next_page_token` string or null. */
export function parseBarsPage(body: unknown): {
  bars: readonly unknown[];
  nextPageToken: string | null;
} {
  if (!isRecord(body)) throw malformed('bars page');
  const { bars, next_page_token: token } = body;
  if (bars !== null && bars !== undefined && !Array.isArray(bars)) throw malformed('bars page');
  if (token !== null && token !== undefined && typeof token !== 'string')
    throw malformed('page token');
  return {
    bars: (bars as unknown[] | null | undefined) ?? [],
    nextPageToken: token ? (token as string) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Instruments

/** Weekly US equity schedule; the per-day truth (holidays, early closes) comes from the calendar. */
const weekdays = (start: string, end: string) =>
  ([1, 2, 3, 4, 5] as const).map((startDay) => ({ startDay, start, end }));

export const US_EQUITY_SESSION: TradingSessionSpec = {
  timezone: US_EQUITY_TIMEZONE,
  regular: weekdays('09:30', '16:00'),
  extended: [...weekdays('04:00', '09:30'), ...weekdays('16:00', '20:00')],
  calendarId: 'XNYS',
};

/**
 * Alpaca exchange code -> ISO 10383 MIC, only where the mapping is unambiguous. Anything else
 * (OTC, unknown codes) is omitted rather than invented.
 */
const EXCHANGE_MIC: Readonly<Record<string, string>> = {
  NYSE: 'XNYS',
  NASDAQ: 'XNAS',
  ARCA: 'ARCX',
  AMEX: 'XASE',
  BATS: 'BATS',
};

export function exchangeMic(code: unknown): string | undefined {
  return typeof code === 'string' ? EXCHANGE_MIC[code] : undefined;
}

/**
 * Asset -> Instrument, or null when the asset is not an ACTIVE US equity (inactive/delisted and
 * other asset classes are "not found" for Stage 4).
 *
 * Alpaca's `class` is `us_equity` for both common stock and ETFs, so every such asset is mapped to
 * assetClass `equity`. ETF classification is NOT guessed from the ticker or name.
 */
export function normalizeAsset(raw: unknown, requestedSymbol: string): Instrument | null {
  if (!isRecord(raw)) throw malformed('asset');
  const { symbol, status, tradable, shortable, name } = raw;
  if (typeof symbol !== 'string' || typeof status !== 'string' || typeof tradable !== 'boolean') {
    throw malformed('asset');
  }
  if (symbol.toUpperCase() !== requestedSymbol) throw malformed('asset (symbol mismatch)');
  if (raw.class !== 'us_equity' || status !== 'active') return null;
  const mic = exchangeMic(raw.exchange);
  return {
    id: `eq:${requestedSymbol}` as InstrumentId,
    assetClass: 'equity',
    displaySymbol: requestedSymbol,
    ...(typeof name === 'string' && name ? { description: name } : {}),
    ...(mic ? { exchange: mic } : {}),
    currency: 'USD',
    tickRules: [
      { fromPrice: '0', tickSize: '0.0001' },
      { fromPrice: '1', tickSize: '0.01' },
    ],
    priceFormat: { kind: 'decimal', decimals: 2 },
    quantityStep: '1',
    quantityUnit: 'shares',
    contractMultiplier: '1',
    session: US_EQUITY_SESSION,
    tradable,
    shortable: typeof shortable === 'boolean' ? shortable : 'unknown',
    marketDataRef: { providerId: ALPACA_PROVIDER_ID, symbol: requestedSymbol },
    brokerageRef: { providerId: ALPACA_PROVIDER_ID, symbol: requestedSymbol },
  };
}

// ---------------------------------------------------------------------------------------------
// Calendar

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Calendar days -> MarketSession[] (ascending, unique dates), one REGULAR window per day built
 * from that day's actual open/close in America/New_York. Holidays are absent from the calendar,
 * early closes come from `close`, and DST is handled by the zone conversion. Nothing is assumed
 * about 16:00.
 */
export function normalizeCalendar(raw: unknown, instrumentId: InstrumentId): MarketSession[] {
  if (!Array.isArray(raw)) throw malformed('calendar');
  const byDate = new Map<string, MarketSession>();
  for (const day of raw) {
    if (!isRecord(day)) throw malformed('calendar day');
    const { date, open, close } = day;
    if (typeof date !== 'string' || !DATE.test(date)) throw malformed('calendar date');
    if (typeof open !== 'string' || !TIME.test(open)) throw malformed('calendar open');
    if (typeof close !== 'string' || !TIME.test(close)) throw malformed('calendar close');
    const start = zonedWallTimeToUtc(date, open, US_EQUITY_TIMEZONE);
    const end = zonedWallTimeToUtc(date, close, US_EQUITY_TIMEZONE);
    if (!(end > start)) throw malformed('calendar day (close before open)');
    byDate.set(date, {
      instrumentId,
      sessionDate: date,
      windows: [{ start, end, kind: 'regular' }],
    });
  }
  return [...byDate.values()].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
}
