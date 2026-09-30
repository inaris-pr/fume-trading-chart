/**
 * Alpaca historical market-data adapter (Stage 4): implements the core
 * HistoricalMarketDataProvider port. No streaming (Stage 5).
 *
 * - Base bars: SINGLE-symbol endpoint, `feed=iex` and `adjustment=raw` on every request, pages
 *   followed via next_page_token (bounded, repeated tokens rejected), page size <= 10,000.
 * - Instruments: the trading API asset endpoint (paper host).
 * - Sessions: the trading API calendar (holidays and early closes from the calendar, not code).
 *
 * One instance per incoming Worker request (it holds that request's HTTP client and call budget);
 * calendar and asset caches are shared across requests through AlpacaSharedCache.
 */
import type {
  BarPage,
  BarPageRequest,
  DataFeedInfo,
  HistoricalMarketDataProvider,
  Instrument,
  MarketSession,
  UnixMs,
} from '@fume/core';
import { ProviderFailure } from '../../errors.ts';
import type { AlpacaHttpClient } from './client.ts';
import {
  ALPACA_PROVIDER_ID,
  isBeforeExclusiveEnd,
  localDate,
  normalizeAsset,
  normalizeBars,
  normalizeCalendar,
  parseBarsPage,
  toAlpacaInclusiveEnd,
  toAlpacaStart,
  US_EQUITY_TIMEZONE,
} from './normalize.ts';

/**
 * Native intervals declared to Fume's base-interval selection. ONLY intervals verified by spike S1
 * (start-labeled, epoch-aligned, nesting, canonical equality with 1Min) may be listed. `1` is
 * always safe.
 *
 * S1 (real SPY IEX data, adjustment=raw, completed session 2026-09-29 plus the 2025-11-28 early
 * close): 5Min and 15Min passed every check, and canonical 5m/15m/1h/4h/1d built from them were
 * identical to those built from 1Min. See docs/research.md and test/fixtures/alpaca/recorded/.
 */
export const ALPACA_NATIVE_INTERVALS: readonly number[] = [1, 5, 15];

/** Maximum bars per upstream page (Alpaca's documented maximum). */
export const ALPACA_MAX_PAGE_SIZE = 10_000;
/**
 * Upstream pages followed for one getBars call. Observed in S1 follow-up (2026-09-29): IEX 15Min
 * pages held ~730-740 bars (about one month) even with limit=10000, so the page count grows with
 * the time span requested, not with the bar count.
 */
export const MAX_PAGES_PER_CALL = 10;
/** IEX history on the Basic plan starts in 2016 (docs/research.md). */
export const ALPACA_HISTORY_FLOOR: UnixMs = Date.UTC(2016, 0, 1, 5, 0); // 2016-01-01 00:00 ET

const ASSET_TTL_MS = 60 * 60_000;
const CURRENT_CALENDAR_TTL_MS = 6 * 60 * 60_000;

/** Isolate-level caches, shared by every per-request provider. */
export class AlpacaSharedCache {
  readonly assets = new Map<string, { instrument: Instrument | null; expires: number }>();
  /** Calendar days (normalized, instrument-independent) per calendar year. */
  readonly calendarYears = new Map<number, { sessions: MarketSession[]; expires: number }>();
}

export interface AlpacaProviderOptions {
  client: AlpacaHttpClient;
  cache: AlpacaSharedCache;
  now?: () => UnixMs;
  /** Override for tests. Must stay a subset of verified intervals in production. */
  nativeIntervalsMinutes?: readonly number[];
}

export class AlpacaMarketDataProvider implements HistoricalMarketDataProvider {
  readonly id = ALPACA_PROVIDER_ID;
  readonly feed: DataFeedInfo = {
    providerId: ALPACA_PROVIDER_ID,
    feedId: 'iex',
    consolidated: false,
    // The Basic plan's IEX feed is real-time (no delay); IEX is a single venue, not SIP/NBBO.
    delayMs: 0,
  };
  readonly nativeIntervalsMinutes: readonly number[];
  private readonly client: AlpacaHttpClient;
  private readonly cache: AlpacaSharedCache;
  private readonly now: () => UnixMs;
  /** Diagnostics for the last getBars call. */
  lastBarsDiagnostics = { pages: 0, rawBars: 0, duplicates: 0 };

  constructor(options: AlpacaProviderOptions) {
    this.client = options.client;
    this.cache = options.cache;
    this.now = options.now ?? Date.now;
    this.nativeIntervalsMinutes = options.nativeIntervalsMinutes ?? ALPACA_NATIVE_INTERVALS;
  }

  async resolveInstrument(symbol: string): Promise<Instrument | null> {
    const now = this.now();
    const cached = this.cache.assets.get(symbol);
    if (cached && cached.expires > now) return cached.instrument;
    let instrument: Instrument | null;
    try {
      const body = await this.client.getJson('trading', `v2/assets/${encodeURIComponent(symbol)}`);
      instrument = normalizeAsset(body, symbol);
    } catch (error) {
      if (!(error instanceof ProviderFailure) || error.code !== 'not_found') throw error;
      instrument = null;
    }
    this.cache.assets.set(symbol, { instrument, expires: now + ASSET_TTL_MS });
    return instrument;
  }

  /**
   * Sessions overlapping [from, to]. Missing calendar years are fetched in ONE upstream call and
   * cached per year (past years for the isolate's life, the current/future years for 6 h).
   */
  async getSessions(
    instrument: Instrument,
    from: UnixMs,
    to: UnixMs,
  ): Promise<readonly MarketSession[]> {
    this.assertOwn(instrument);
    const now = this.now();
    const firstYear = Number(localDate(from, US_EQUITY_TIMEZONE).slice(0, 4));
    const lastYear = Number(localDate(to, US_EQUITY_TIMEZONE).slice(0, 4));
    const currentYear = Number(localDate(now, US_EQUITY_TIMEZONE).slice(0, 4));
    const missing: number[] = [];
    for (let y = firstYear; y <= lastYear; y++) {
      const hit = this.cache.calendarYears.get(y);
      if (!hit || hit.expires <= now) missing.push(y);
    }
    if (missing.length > 0) {
      const lo = missing[0]!;
      const hi = missing[missing.length - 1]!;
      const body = await this.client.getJson('trading', 'v2/calendar', {
        start: `${lo}-01-01`,
        end: `${hi}-12-31`,
      });
      const days = normalizeCalendar(body, instrument.id);
      for (let y = lo; y <= hi; y++) {
        this.cache.calendarYears.set(y, {
          sessions: days.filter((s) => s.sessionDate.startsWith(`${y}-`)),
          expires: y < currentYear ? Number.POSITIVE_INFINITY : now + CURRENT_CALENDAR_TTL_MS,
        });
      }
    }
    const sessions: MarketSession[] = [];
    for (let y = firstYear; y <= lastYear; y++) {
      for (const s of this.cache.calendarYears.get(y)?.sessions ?? []) {
        if (s.windows.some((w) => w.end > from && w.start <= to)) {
          sessions.push({ ...s, instrumentId: instrument.id });
        }
      }
    }
    return sessions;
  }

  /**
   * Base bars with start in [request.start ?? history floor, request.end), newest `limit`,
   * ascending. Requests go newest-first (sort=desc) so the newest bars arrive in the first page.
   */
  async getBars(request: BarPageRequest): Promise<BarPage> {
    this.assertOwn(request.instrument);
    const minutes = request.intervalMinutes;
    if (!this.nativeIntervalsMinutes.includes(minutes)) {
      throw new ProviderFailure({
        code: 'internal',
        message: `Interval ${minutes}m is not a verified native interval`,
        retryable: false,
      });
    }
    const intervalMs = minutes * 60_000;
    const limit = Math.max(1, Math.floor(request.limit));
    const symbol = request.instrument.marketDataRef.symbol;
    // Always send an explicit start: never rely on the upstream's default range.
    const start = request.start ?? ALPACA_HISTORY_FLOOR;
    const raw: unknown[] = [];
    const seenTokens = new Set<string>();
    let token: string | null = null;
    let pages = 0;
    do {
      if (pages >= MAX_PAGES_PER_CALL) break;
      const body = await this.client.getJson(
        'data',
        `v2/stocks/${encodeURIComponent(symbol)}/bars`,
        {
          timeframe: `${minutes}Min`,
          start: toAlpacaStart(start),
          end: toAlpacaInclusiveEnd(request.end),
          limit: Math.min(ALPACA_MAX_PAGE_SIZE, limit - raw.length),
          adjustment: 'raw',
          feed: 'iex',
          sort: 'desc',
          ...(token ? { page_token: token } : {}),
        },
        request.signal as AbortSignal | undefined,
      );
      pages++;
      const page = parseBarsPage(body);
      raw.push(...page.bars);
      token = page.nextPageToken;
      if (token !== null) {
        if (seenTokens.has(token)) {
          throw new ProviderFailure({
            code: 'internal',
            message: 'Upstream repeated a page token',
            retryable: false,
          });
        }
        seenTokens.add(token);
      }
    } while (token !== null && raw.length < limit);

    const { bars: normalized, duplicates } = normalizeBars(raw, intervalMs, this.now());
    const inRange = normalized.filter(
      (b) => isBeforeExclusiveEnd(b.start, request.end) && b.start >= start,
    );
    const bars = inRange.slice(-limit);
    this.lastBarsDiagnostics = { pages, rawBars: raw.length, duplicates };
    // More (older) bars may exist when a token remained, or the limit cut the result.
    const hasMore = token !== null || inRange.length > bars.length;
    return { bars, hasMore };
  }

  private assertOwn(instrument: Instrument): void {
    if (instrument.marketDataRef.providerId !== ALPACA_PROVIDER_ID) {
      throw new ProviderFailure({
        code: 'invalid_request',
        message: 'Instrument belongs to another provider',
        retryable: false,
      });
    }
  }
}
