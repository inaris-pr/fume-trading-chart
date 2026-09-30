/**
 * Massive futures payload -> @fume/core normalization. Malformed payloads are REJECTED
 * (ProviderFailure `internal`), never guessed; unknown fields are ignored. Numbers may arrive as
 * JSON numbers (REST) or numeric strings (the WebSocket sends o/h/l/c/dv as strings, observed
 * 2026-09-30); both are normalized to finite numbers here. Nothing Massive-shaped leaves this
 * module through its return types except the small internal record types below.
 */
import {
  addDays,
  resolveWeeklySessions,
  zoneOffsetMs,
  zonedWallTimeToUtc,
  type Bar,
  type Decimal,
  type InstrumentId,
  type MarketSession,
  type TradingSessionSpec,
  type UnixMs,
} from '@fume/core';
import { ProviderFailure } from '../../errors.ts';

export const CME_TIMEZONE = 'America/Chicago';

const malformed = (what: string) =>
  new ProviderFailure({
    code: 'internal',
    message: `Malformed upstream ${what}`,
    retryable: false,
  });

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** A finite number from a JSON number or a numeric string; null when absent or not numeric. */
export function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && NUMERIC.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Time

/** "YYYY-MM-DD" calendar date of `ms` in `timeZone`. */
export function localDate(ms: UnixMs, timeZone: string): string {
  return new Date(ms + zoneOffsetMs(ms, timeZone)).toISOString().slice(0, 10);
}

/** Nanosecond epoch string for a whole-ms UnixMs (query parameters; exact). */
export function msToNsString(ms: UnixMs): string {
  return `${BigInt(ms) * 1_000_000n}`;
}

// ---------------------------------------------------------------------------------------------
// Aggregates

export interface AggregateFields {
  start: UnixMs;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount?: number;
}

/**
 * Validates OHLCV + alignment for one aggregate whose start/end were already converted to ms.
 * `intervalMs` is the expected width (1 s or 1 min); the start must be aligned to it.
 */
export function checkAggregate(
  fields: {
    start: number | null;
    open: unknown;
    high: unknown;
    low: unknown;
    close: unknown;
    volume: unknown;
    trades: unknown;
  },
  intervalMs: number,
): AggregateFields {
  const { start } = fields;
  if (start === null || !Number.isSafeInteger(start) || start % intervalMs !== 0) {
    throw malformed('aggregate timestamp');
  }
  const open = toFiniteNumber(fields.open);
  const high = toFiniteNumber(fields.high);
  const low = toFiniteNumber(fields.low);
  const close = toFiniteNumber(fields.close);
  if (open === null || high === null || low === null || close === null) {
    throw malformed('aggregate prices');
  }
  if (!(high >= low) || open > high || open < low || close > high || close < low) {
    throw malformed('aggregate OHLC range');
  }
  const volume = toFiniteNumber(fields.volume);
  if (volume === null || volume < 0) throw malformed('aggregate volume');
  let tradeCount: number | undefined;
  if (fields.trades !== undefined && fields.trades !== null) {
    const n = toFiniteNumber(fields.trades);
    if (n === null || !Number.isInteger(n) || n < 0) throw malformed('aggregate trade count');
    tradeCount = n;
  }
  return {
    start,
    open,
    high,
    low,
    close,
    volume,
    ...(tradeCount !== undefined ? { tradeCount } : {}),
  };
}

/**
 * One REST aggregate (`/futures/v1/aggs`): `window_start` is epoch NANOSECONDS (a JSON number;
 * minute/second starts are exactly representable as doubles). Status: final once the interval has
 * ended at `now`.
 */
export function normalizeRestAggregate(raw: unknown, intervalMs: number, now: UnixMs): Bar {
  if (!isRecord(raw)) throw malformed('aggregate');
  const ns = toFiniteNumber(raw.window_start);
  const start = ns === null || ns % 1_000_000 !== 0 ? null : ns / 1_000_000;
  const fields = checkAggregate(
    {
      start,
      open: raw.open,
      high: raw.high,
      low: raw.low,
      close: raw.close,
      volume: raw.volume,
      trades: raw.transactions,
    },
    intervalMs,
  );
  return {
    ...fields,
    status: fields.start + intervalMs <= now ? 'final' : 'provisional',
    revision: 0,
  };
}

/** Validates a paged envelope: `results` array (or absent) and an optional `next_url` string. */
export function parsePage(
  body: unknown,
  what: string,
): { results: unknown[]; nextUrl: string | null } {
  if (!isRecord(body)) throw malformed(what);
  const { results, next_url: next } = body;
  if (results !== undefined && results !== null && !Array.isArray(results)) throw malformed(what);
  if (next !== undefined && next !== null && typeof next !== 'string')
    throw malformed(`${what} cursor`);
  return { results: (results as unknown[] | null | undefined) ?? [], nextUrl: next ? next : null };
}

// ---------------------------------------------------------------------------------------------
// Contracts and products

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_CODES = 'FGHJKMNQUVXZ';
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export interface ContractRecord {
  ticker: string;
  root: string;
  /** "YYYY-MM" delivery month. */
  contractMonth: string;
  firstTradeDate: string | null;
  lastTradeDate: string;
  settlementDate: string | null;
  tradeTickSize: number;
  tradingVenue: string | null;
}

/**
 * "YYYY-MM" contract month from a CME-style contract code (root + month code + 1-2 digit year).
 * The year's decade is inferred from the last trade date: the contract month lies within
 * [lastTrade - 1 year, lastTrade + 9 years] and its year ends in the code's digit(s).
 */
export function contractMonthOf(
  ticker: string,
  root: string,
  lastTradeDate: string,
): string | null {
  if (!ticker.startsWith(root)) return null;
  const m = /^([FGHJKMNQUVXZ])(\d{1,2})$/.exec(ticker.slice(root.length));
  if (!m || !DATE.test(lastTradeDate)) return null;
  const month = MONTH_CODES.indexOf(m[1]!) + 1;
  const digits = m[2]!;
  const mod = digits.length === 1 ? 10 : 100;
  const lastYear = Number(lastTradeDate.slice(0, 4));
  for (let year = lastYear - 1; year <= lastYear + 9; year++) {
    if (year % mod === Number(digits)) return `${year}-${String(month).padStart(2, '0')}`;
  }
  return null;
}

/** CME contract code for a root and "YYYY-MM" (one-digit year, e.g. NQ + 2026-12 -> NQZ6). */
export function contractCode(root: string, contractMonth: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(contractMonth);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${root}${MONTH_CODES[month - 1]}${Number(m[1]) % 10}`;
}

export function monthLabel(contractMonth: string): string {
  const [year, month] = contractMonth.split('-');
  return `${MONTH_NAMES[Number(month) - 1] ?? month} ${year}`;
}

/** One contract row; null for rows that are not usable single contracts of `root`. */
export function normalizeContract(raw: unknown, root: string): ContractRecord | null {
  if (!isRecord(raw)) throw malformed('contract');
  const { ticker, product_code: product, last_trade_date: lastTrade, type } = raw;
  if (typeof ticker !== 'string' || typeof product !== 'string') throw malformed('contract');
  if (product !== root) return null;
  if (type !== undefined && type !== null && type !== 'single') return null;
  if (typeof lastTrade !== 'string' || !DATE.test(lastTrade)) return null;
  const contractMonth = contractMonthOf(ticker, root, lastTrade);
  if (!contractMonth) return null;
  const tick = toFiniteNumber(raw.trade_tick_size);
  if (tick === null || !(tick > 0)) throw malformed('contract tick size');
  const date = (v: unknown) => (typeof v === 'string' && DATE.test(v) ? v : null);
  return {
    ticker,
    root,
    contractMonth,
    firstTradeDate: date(raw.first_trade_date),
    lastTradeDate: lastTrade,
    settlementDate: date(raw.settlement_date),
    tradeTickSize: tick,
    tradingVenue: typeof raw.trading_venue === 'string' ? raw.trading_venue : null,
  };
}

export interface ProductRecord {
  root: string;
  name: string;
  tradingVenue: string | null;
  /** Contract size in `unitOfMeasure` (the price multiplier, e.g. NQ 20 index points). */
  unitQty: number;
  unitOfMeasure: string | null;
  currency: string;
}

export function normalizeProduct(raw: unknown, root: string): ProductRecord | null {
  if (!isRecord(raw)) throw malformed('product');
  if (raw.product_code !== root) return null;
  if (raw.type !== undefined && raw.type !== null && raw.type !== 'single') return null;
  const qty = toFiniteNumber(raw.unit_of_measure_qty);
  if (qty === null || !(qty > 0)) throw malformed('product unit');
  return {
    root,
    name: typeof raw.name === 'string' && raw.name ? raw.name : `${root} futures`,
    tradingVenue: typeof raw.trading_venue === 'string' ? raw.trading_venue : null,
    unitQty: qty,
    unitOfMeasure: typeof raw.unit_of_measure === 'string' ? raw.unit_of_measure : null,
    currency:
      typeof raw.trade_currency_code === 'string' && /^[A-Z]{3}$/.test(raw.trade_currency_code)
        ? raw.trade_currency_code
        : 'USD',
  };
}

export interface SnapshotRecord {
  ticker: string;
  sessionVolume: number;
  /** Last (delayed) trade time, when the snapshot has one. */
  lastTradeMs: UnixMs | null;
}

export function normalizeSnapshot(raw: unknown): SnapshotRecord | null {
  if (!isRecord(raw) || !isRecord(raw.details) || typeof raw.details.ticker !== 'string')
    return null;
  const session = isRecord(raw.session) ? raw.session : {};
  const volume = toFiniteNumber(session.volume) ?? 0;
  const trade = isRecord(raw.last_trade) ? raw.last_trade : null;
  const updatedNs = trade ? toFiniteNumber(trade.last_updated) : null;
  return {
    ticker: raw.details.ticker,
    sessionVolume: volume >= 0 ? volume : 0,
    lastTradeMs: updatedNs === null ? null : Math.floor(updatedNs / 1_000_000),
  };
}

// ---------------------------------------------------------------------------------------------
// Decimal helpers (instrument metadata is carried as Decimal strings)

function decimalsOf(n: number): number {
  const s = String(n);
  if (/e/i.test(s)) return 12;
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

export function toDecimal(n: number): Decimal {
  return trimZeros(n.toFixed(decimalsOf(n)));
}

/** tick × multiplier as an exact decimal string (both inputs are short decimals). */
export function multiplyDecimal(a: number, b: number): Decimal {
  const da = decimalsOf(a);
  const db = decimalsOf(b);
  const product = BigInt(Math.round(a * 10 ** da)) * BigInt(Math.round(b * 10 ** db));
  const scale = da + db;
  const neg = product < 0n;
  const digits = (neg ? -product : product).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return `${neg ? '-' : ''}${trimZeros(text)}`;
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

export function priceDecimals(tick: number): number {
  return Math.min(8, decimalsOf(tick));
}

// ---------------------------------------------------------------------------------------------
// Sessions

/**
 * CME Globex weekly schedule for the supported roots (equity index, metals, energy): Sunday-Thursday
 * 17:00 CT until 16:00 CT the next day; the trading day is the day the session ends. Used ONLY for
 * dates the provider schedule does not cover (before its history or beyond its published range).
 */
export const CME_GLOBEX_SESSION: TradingSessionSpec = {
  timezone: CME_TIMEZONE,
  regular: ([7, 1, 2, 3, 4] as const).map((startDay) => ({
    startDay,
    start: '17:00',
    end: '16:00',
  })),
  extended: [],
  calendarId: 'CME-GLOBEX',
};

export interface ScheduleEvent {
  event: string;
  sessionEndDate: string;
  time: UnixMs;
}

/**
 * Schedule rows for one product -> unique events. The API returns every event several times
 * (observed 2x, CL 13x), so rows are de-duplicated by (session end date, event, timestamp).
 */
export function normalizeScheduleRows(rows: readonly unknown[], root: string): ScheduleEvent[] {
  const unique = new Map<string, ScheduleEvent>();
  for (const raw of rows) {
    if (!isRecord(raw)) throw malformed('schedule');
    if (raw.product_code !== root) continue;
    const { event, session_end_date: date, timestamp } = raw;
    if (typeof event !== 'string' || typeof date !== 'string' || !DATE.test(date)) {
      throw malformed('schedule row');
    }
    const time = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
    if (!Number.isFinite(time) || time % 60_000 !== 0) throw malformed('schedule timestamp');
    unique.set(`${date}|${event}|${time}`, { event, sessionEndDate: date, time });
  }
  return [...unique.values()];
}

/**
 * Events -> one MarketSession per session end date. A trading window opens at `open` and ends at
 * the next `close`, `pause` or `pre_open` (holiday sessions express halts only as a later
 * pre_open/open pair). A window that never ends is dropped (never guessed).
 */
export function scheduleToSessions(
  events: readonly ScheduleEvent[],
  instrumentId: InstrumentId,
): MarketSession[] {
  const byDate = new Map<string, ScheduleEvent[]>();
  for (const e of events) {
    const list = byDate.get(e.sessionEndDate);
    if (list) list.push(e);
    else byDate.set(e.sessionEndDate, [e]);
  }
  const sessions: MarketSession[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const ordered = byDate.get(date)!.sort((a, b) => a.time - b.time || rank(a) - rank(b));
    const windows: { start: UnixMs; end: UnixMs; kind: 'regular' }[] = [];
    let openedAt: UnixMs | null = null;
    for (const e of ordered) {
      if (e.event === 'open') {
        openedAt ??= e.time;
      } else if (
        openedAt !== null &&
        (e.event === 'close' || e.event === 'pause' || e.event === 'pre_open')
      ) {
        if (e.time > openedAt) windows.push({ start: openedAt, end: e.time, kind: 'regular' });
        openedAt = null;
      }
    }
    if (windows.length > 0) sessions.push({ instrumentId, sessionDate: date, windows });
  }
  return sessions;
}

/** Tie-break for events at the same instant: closing events before opening ones. */
function rank(e: ScheduleEvent): number {
  return e.event === 'open' ? 1 : 0;
}

/**
 * Sessions for [fromDate, toDate] (session end dates, CT): provider sessions inside the provider's
 * coverage [coveredFrom, coveredTo] (a covered date without sessions is a holiday), the weekly
 * Globex schedule outside it.
 */
export function mergeWithWeekly(args: {
  provider: readonly MarketSession[];
  coveredFrom: string | null;
  coveredTo: string | null;
  fromDate: string;
  toDate: string;
  instrumentId: InstrumentId;
}): MarketSession[] {
  const { provider, coveredFrom, coveredTo, fromDate, toDate, instrumentId } = args;
  const inCoverage = (d: string) =>
    coveredFrom !== null && coveredTo !== null && d >= coveredFrom && d <= coveredTo;
  const weekly = resolveWeeklySessions({
    instrumentId,
    spec: CME_GLOBEX_SESSION,
    from: fromDate,
    to: toDate,
  }).filter((s) => !inCoverage(s.sessionDate));
  const own = provider.filter((s) => s.sessionDate >= fromDate && s.sessionDate <= toDate);
  return [...own, ...weekly].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
}

/** Midnight (00:00) of a CT calendar date, as UnixMs. */
export function ctMidnight(date: string): UnixMs {
  return zonedWallTimeToUtc(date, '00:00', CME_TIMEZONE);
}

export { addDays };
