/**
 * Massive futures historical market-data adapter: implements the core
 * HistoricalMarketDataProvider port for the supported CME roots (ES, NQ, YM, GC, SI, CL).
 *
 * - Instruments are SPECIFIC contracts. A root ("NQ") resolves to a recommended contract from
 *   reference data (nearest non-expired contracts, ranked by delayed snapshot session volume); a
 *   contract code ("NQZ6") resolves to that contract. Nothing about today's front month is
 *   hard-coded. No synthetic continuous contracts.
 * - Base bars: 1-minute aggregates only (Fume builds 5m..1d itself, session-aligned).
 * - Sessions: the provider trading schedule (holidays, early closes), de-duplicated; the weekly
 *   Globex schedule only for dates the provider schedule does not cover.
 *
 * One instance per incoming Worker request (or per hub); reference data is cached through
 * MassiveSharedCache. Instrument ids are backend-issued and provider-neutral: "fut:<ROOT>:<YYYY-MM>".
 */
import type {
  BarPage,
  BarPageRequest,
  DataFeedInfo,
  HistoricalMarketDataProvider,
  Instrument,
  InstrumentId,
  MarketSession,
  UnixMs,
} from '@fume/core';
import { ProviderFailure } from '../../errors.ts';
import type { MassiveHttpClient } from './client.ts';
import { MASSIVE_FUTURES_DELAY_MS, MASSIVE_FUTURES_ROOTS, MASSIVE_PROVIDER_ID } from './config.ts';
import {
  addDays,
  CME_GLOBEX_SESSION,
  CME_TIMEZONE,
  contractCode,
  ctMidnight,
  localDate,
  mergeWithWeekly,
  monthLabel,
  msToNsString,
  multiplyDecimal,
  normalizeContract,
  normalizeProduct,
  normalizeRestAggregate,
  normalizeScheduleRows,
  normalizeSnapshot,
  parsePage,
  priceDecimals,
  scheduleToSessions,
  toDecimal,
  type ContractRecord,
  type ProductRecord,
} from './normalize.ts';

const MINUTE = 60_000;
const DAY = 86_400_000;
/** Largest page the aggregates endpoint accepts. */
export const MASSIVE_MAX_PAGE_SIZE = 50_000;
/** Upstream pages followed for one getBars call. */
export const MAX_PAGES_PER_CALL = 4;
/** Nearest non-expired contracts considered for the recommendation. */
export const RECOMMENDATION_CANDIDATES = 4;
/** A candidate needs a (delayed) trade this recent to be recommended by volume. */
const RECENT_TRADE_MS = 4 * DAY;
/** Starter plan: about two years of history (observed 2026-09-30: data from ~2024-10-01). */
const HISTORY_DAYS = 730;

const CONTRACTS_TTL_MS = 60 * MINUTE;
const RECOMMENDATION_TTL_MS = 10 * MINUTE;
const PRODUCT_TTL_MS = 24 * 60 * MINUTE;
const CURRENT_SCHEDULE_TTL_MS = 6 * 60 * MINUTE;

const FUTURE_ID = /^fut:([A-Z][A-Z0-9]{0,4}):(\d{4}-\d{2})$/;
const CONTRACT_SUFFIX = /^[FGHJKMNQUVXZ]\d{1,2}$/;

export function massiveHistoryFloor(now: UnixMs): UnixMs {
  return Math.floor((now - HISTORY_DAYS * DAY) / DAY) * DAY;
}

export function futuresInstrumentId(root: string, contractMonth: string): InstrumentId {
  return `fut:${root}:${contractMonth}` as InstrumentId;
}

export function parseFuturesInstrumentId(
  id: string,
): { root: string; contractMonth: string } | null {
  const m = FUTURE_ID.exec(id);
  return m ? { root: m[1]!, contractMonth: m[2]! } : null;
}

/** Isolate-level caches shared by every per-request provider. Never holds credentials. */
export class MassiveSharedCache {
  readonly contracts = new Map<string, { records: ContractRecord[]; expires: number }>();
  readonly contractByTicker = new Map<string, { record: ContractRecord | null; expires: number }>();
  readonly recommendation = new Map<string, { ticker: string; expires: number }>();
  readonly products = new Map<string, { product: ProductRecord; expires: number }>();
  /** Provider sessions per root and calendar year, with the dates the schedule covered. */
  readonly scheduleYears = new Map<
    string,
    {
      sessions: MarketSession[];
      coveredFrom: string | null;
      coveredTo: string | null;
      expires: number;
    }
  >();
}

export interface MassiveProviderOptions {
  client: MassiveHttpClient;
  cache: MassiveSharedCache;
  now?: () => UnixMs;
}

export interface RecommendationDiagnostics {
  root: string;
  candidates: string[];
  method: 'volume' | 'nearest';
  ticker: string;
}

export class MassiveFuturesMarketDataProvider implements HistoricalMarketDataProvider {
  readonly id = MASSIVE_PROVIDER_ID;
  readonly feed: DataFeedInfo = {
    providerId: MASSIVE_PROVIDER_ID,
    feedId: 'futures-delayed',
    // The complete exchange feed for each contract (not a single venue among several).
    consolidated: true,
    delayMs: MASSIVE_FUTURES_DELAY_MS,
    displayName: 'CME futures',
  };
  readonly nativeIntervalsMinutes: readonly number[] = [1];
  private readonly client: MassiveHttpClient;
  private readonly cache: MassiveSharedCache;
  private readonly now: () => UnixMs;
  lastRecommendation: RecommendationDiagnostics | null = null;
  lastBarsDiagnostics = { pages: 0, rawBars: 0, duplicates: 0 };

  constructor(options: MassiveProviderOptions) {
    this.client = options.client;
    this.cache = options.cache;
    this.now = options.now ?? Date.now;
  }

  /** Earliest bar start this plan serves (moves with time). */
  historyFloor(): UnixMs {
    return massiveHistoryFloor(this.now());
  }

  /**
   * "NQ" -> the recommended NQ contract; "NQZ6" -> that contract. Unknown roots/contracts resolve
   * to null; an expired contract code throws not_found with reason `contract_expired`.
   */
  async resolveInstrument(symbol: string): Promise<Instrument | null> {
    if (MASSIVE_FUTURES_ROOTS.includes(symbol)) {
      const ticker = await this.recommendedTicker(symbol);
      if (!ticker) return null;
      const record = await this.contractByTicker(ticker, symbol);
      return record ? this.instrumentFor(record) : null;
    }
    const parsed = this.parseCode(symbol);
    if (!parsed) return null;
    const record = await this.contractByTicker(symbol, parsed.root);
    if (!record) return null;
    if (record.lastTradeDate < this.today()) {
      throw new ProviderFailure({
        code: 'not_found',
        message: 'Contract expired',
        retryable: false,
        reason: 'contract_expired',
      });
    }
    return this.instrumentFor(record);
  }

  /** Loads a contract by its Fume id (expired contracts stay loadable for their history). */
  async getInstrument(id: InstrumentId): Promise<Instrument | null> {
    const parsed = parseFuturesInstrumentId(id);
    if (!parsed || !MASSIVE_FUTURES_ROOTS.includes(parsed.root)) return null;
    const ticker = contractCode(parsed.root, parsed.contractMonth);
    if (!ticker) return null;
    const record = await this.contractByTicker(ticker, parsed.root);
    if (!record || record.contractMonth !== parsed.contractMonth) return null;
    return this.instrumentFor(record);
  }

  async getSessions(
    instrument: Instrument,
    from: UnixMs,
    to: UnixMs,
  ): Promise<readonly MarketSession[]> {
    const root = this.assertOwn(instrument);
    const now = this.now();
    // Session end dates that can contain windows overlapping [from, to].
    const fromDate = localDate(from, CME_TIMEZONE);
    const toDate = addDays(localDate(to, CME_TIMEZONE), 1);
    const firstYear = Number(fromDate.slice(0, 4));
    const lastYear = Number(toDate.slice(0, 4));
    const currentYear = Number(localDate(now, CME_TIMEZONE).slice(0, 4));
    const out: MarketSession[] = [];
    for (let year = firstYear; year <= lastYear; year++) {
      const key = `${root}:${year}`;
      let entry = this.cache.scheduleYears.get(key);
      if (!entry || entry.expires <= now) {
        entry = { ...(await this.fetchScheduleYear(root, year)), expires: 0 };
        entry.expires =
          year < currentYear ? Number.POSITIVE_INFINITY : now + CURRENT_SCHEDULE_TTL_MS;
        this.cache.scheduleYears.set(key, entry);
      }
      const lo = `${year}-01-01` > fromDate ? `${year}-01-01` : fromDate;
      const hi = `${year}-12-31` < toDate ? `${year}-12-31` : toDate;
      out.push(
        ...mergeWithWeekly({
          provider: entry.sessions,
          coveredFrom: entry.coveredFrom,
          coveredTo: entry.coveredTo,
          fromDate: lo,
          toDate: hi,
          instrumentId: instrument.id,
        }),
      );
    }
    return out
      .map((s) => ({ ...s, instrumentId: instrument.id }))
      .filter((s) => s.windows.some((w) => w.end > from && w.start <= to));
  }

  /**
   * 1-minute bars with start in [request.start ?? history floor, request.end), newest `limit`,
   * ascending. Requests go newest-first so the newest bars arrive in the first page.
   */
  async getBars(request: BarPageRequest): Promise<BarPage> {
    this.assertOwn(request.instrument);
    if (request.intervalMinutes !== 1) {
      throw new ProviderFailure({
        code: 'internal',
        message: `Interval ${request.intervalMinutes}m is not a native interval`,
        retryable: false,
      });
    }
    const now = this.now();
    const limit = Math.max(1, Math.floor(request.limit));
    const start = Math.max(request.start ?? 0, this.historyFloor());
    if (request.end <= start) return { bars: [], hasMore: false };
    const ticker = request.instrument.marketDataRef.symbol;
    const raw: unknown[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      if (pages >= MAX_PAGES_PER_CALL) break;
      const body = cursor
        ? await this.client.getJson(cursor, {}, request.signal as AbortSignal | undefined)
        : await this.client.getJson(
            `futures/v1/aggs/${encodeURIComponent(ticker)}`,
            {
              resolution: '1min',
              'window_start.gte': msToNsString(start),
              'window_start.lt': msToNsString(request.end),
              limit: Math.min(MASSIVE_MAX_PAGE_SIZE, limit - raw.length),
              sort: 'window_start.desc',
            },
            request.signal as AbortSignal | undefined,
          );
      pages++;
      const page = parsePage(body, 'aggregates page');
      raw.push(...page.results);
      if (page.nextUrl !== null && page.nextUrl === cursor) {
        throw new ProviderFailure({
          code: 'internal',
          message: 'Upstream repeated a cursor',
          retryable: false,
        });
      }
      cursor = page.nextUrl;
    } while (cursor !== null && raw.length < limit);

    const byStart = new Map<number, ReturnType<typeof normalizeRestAggregate>>();
    let duplicates = 0;
    for (const item of raw) {
      const bar = normalizeRestAggregate(item, MINUTE, now);
      if (byStart.has(bar.start)) duplicates++;
      byStart.set(bar.start, bar);
    }
    const inRange = [...byStart.values()]
      .filter((b) => b.start >= start && b.start < request.end)
      .sort((a, b) => a.start - b.start);
    const bars = inRange.slice(-limit);
    this.lastBarsDiagnostics = { pages, rawBars: raw.length, duplicates };
    return { bars, hasMore: cursor !== null || inRange.length > bars.length };
  }

  // -------------------------------------------------------------------------------------------
  // Contracts

  private today(): string {
    return localDate(this.now(), CME_TIMEZONE);
  }

  private parseCode(symbol: string): { root: string } | null {
    const root = MASSIVE_FUTURES_ROOTS.find(
      (r) => symbol.startsWith(r) && CONTRACT_SUFFIX.test(symbol.slice(r.length)),
    );
    return root ? { root } : null;
  }

  /** Active single contracts of `root` that have not passed their last trade date, by expiry. */
  async activeContracts(root: string): Promise<ContractRecord[]> {
    const now = this.now();
    const today = this.today();
    const hit = this.cache.contracts.get(root);
    if (hit && hit.expires > now) return hit.records.filter((c) => c.lastTradeDate >= today);
    // Reference data is published daily; very early in a day it may not exist yet.
    let records = await this.fetchContracts(root, today);
    if (records.length === 0) records = await this.fetchContracts(root, addDays(today, -1));
    records = records
      .filter((c) => c.lastTradeDate >= today)
      .sort((a, b) => a.lastTradeDate.localeCompare(b.lastTradeDate));
    this.cache.contracts.set(root, { records, expires: now + CONTRACTS_TTL_MS });
    for (const r of records) {
      this.cache.contractByTicker.set(r.ticker, { record: r, expires: now + CONTRACTS_TTL_MS });
    }
    return records;
  }

  private async fetchContracts(root: string, date: string): Promise<ContractRecord[]> {
    const body = await this.client.getJson('futures/v1/contracts', {
      product_code: root,
      date,
      active: 'true',
      type: 'single',
      limit: 1000,
    });
    const { results } = parsePage(body, 'contracts page');
    const unique = new Map<string, ContractRecord>();
    for (const raw of results) {
      const record = normalizeContract(raw, root);
      if (record) unique.set(record.ticker, record);
    }
    return [...unique.values()];
  }

  /**
   * The recommended contract for a root: among the nearest non-expired contracts, the one with the
   * highest delayed session volume that has recently traded; the nearest contract when no
   * candidate qualifies (or the snapshot is unavailable).
   */
  async recommendedTicker(root: string): Promise<string | null> {
    const now = this.now();
    const hit = this.cache.recommendation.get(root);
    if (hit && hit.expires > now) return hit.ticker;
    const contracts = await this.activeContracts(root);
    const candidates = contracts.slice(0, RECOMMENDATION_CANDIDATES);
    if (candidates.length === 0) return null;
    let volumes: Map<string, { volume: number; lastTradeMs: number | null }> = new Map();
    try {
      const body = await this.client.getJson('futures/v1/snapshot', {
        'ticker.any_of': candidates.map((c) => c.ticker).join(','),
        limit: 100,
      });
      volumes = new Map(
        parsePage(body, 'snapshot page')
          .results.map((r) => normalizeSnapshot(r))
          .filter((s): s is NonNullable<typeof s> => s !== null)
          .map((s) => [s.ticker, { volume: s.sessionVolume, lastTradeMs: s.lastTradeMs }]),
      );
    } catch (error) {
      if (!(error instanceof ProviderFailure) || error.code === 'unauthorized') throw error;
      // Snapshot unavailable: fall back to the nearest contract (diagnostics say so).
    }
    const ticker = pickRecommended(candidates, volumes, now);
    this.lastRecommendation = {
      root,
      candidates: candidates.map((c) => c.ticker),
      method: ticker.byVolume ? 'volume' : 'nearest',
      ticker: ticker.ticker,
    };
    this.cache.recommendation.set(root, {
      ticker: ticker.ticker,
      expires: now + RECOMMENDATION_TTL_MS,
    });
    return ticker.ticker;
  }

  /** One contract by code (latest reference row, expired contracts included). */
  private async contractByTicker(ticker: string, root: string): Promise<ContractRecord | null> {
    const now = this.now();
    const hit = this.cache.contractByTicker.get(ticker);
    if (hit && hit.expires > now) return hit.record;
    const body = await this.client.getJson('futures/v1/contracts', {
      ticker,
      sort: 'date.desc',
      limit: 1,
    });
    const [first] = parsePage(body, 'contracts page').results;
    const record = first === undefined ? null : normalizeContract(first, root);
    const found = record && record.ticker === ticker ? record : null;
    this.cache.contractByTicker.set(ticker, { record: found, expires: now + CONTRACTS_TTL_MS });
    return found;
  }

  private async product(root: string): Promise<ProductRecord> {
    const now = this.now();
    const hit = this.cache.products.get(root);
    if (hit && hit.expires > now) return hit.product;
    const body = await this.client.getJson('futures/v1/products', {
      product_code: root,
      sort: 'date.desc',
      limit: 10,
    });
    const product = parsePage(body, 'products page')
      .results.map((r) => normalizeProduct(r, root))
      .find((p): p is ProductRecord => p !== null);
    if (!product) {
      throw new ProviderFailure({
        code: 'not_found',
        message: 'Product not found',
        retryable: false,
        reason: 'contract_not_found',
      });
    }
    this.cache.products.set(root, { product, expires: now + PRODUCT_TTL_MS });
    return product;
  }

  private async instrumentFor(record: ContractRecord): Promise<Instrument> {
    const product = await this.product(record.root);
    const tick = record.tradeTickSize;
    const multiplier = toDecimal(product.unitQty);
    return {
      id: futuresInstrumentId(record.root, record.contractMonth),
      assetClass: 'future',
      displaySymbol: record.ticker,
      description: `${product.name} · ${monthLabel(record.contractMonth)}`,
      ...((record.tradingVenue ?? product.tradingVenue)
        ? { exchange: (record.tradingVenue ?? product.tradingVenue)! }
        : {}),
      currency: product.currency,
      tickRules: [{ fromPrice: '0', tickSize: toDecimal(tick) }],
      priceFormat: { kind: 'decimal', decimals: priceDecimals(tick) },
      quantityStep: '1',
      quantityUnit: 'contracts',
      contractMultiplier: multiplier,
      session: CME_GLOBEX_SESSION,
      // No futures brokerage is connected: market data only.
      tradable: false,
      shortable: 'unknown',
      future: {
        rootSymbol: record.root,
        contractMonth: record.contractMonth,
        expiration: ctMidnight(record.settlementDate ?? record.lastTradeDate),
        lastTradeTime: ctMidnight(record.lastTradeDate),
        tickValue: multiplyDecimal(tick, product.unitQty),
      },
      marketDataRef: { providerId: MASSIVE_PROVIDER_ID, symbol: record.ticker },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Schedules

  private async fetchScheduleYear(
    root: string,
    year: number,
  ): Promise<{ sessions: MarketSession[]; coveredFrom: string | null; coveredTo: string | null }> {
    const rows: unknown[] = [];
    let cursor: string | null = null;
    let pages = 0;
    try {
      do {
        const body = cursor
          ? await this.client.getJson(cursor)
          : await this.client.getJson('futures/v1/schedules', {
              product_code: root,
              'session_end_date.gte': `${year}-01-01`,
              'session_end_date.lte': `${year}-12-31`,
              limit: 1000,
            });
        pages++;
        const page = parsePage(body, 'schedules page');
        rows.push(...page.results);
        cursor = page.nextUrl;
      } while (cursor !== null && pages < 12);
    } catch (error) {
      if (error instanceof ProviderFailure && error.code !== 'unauthorized') {
        throw new ProviderFailure({
          code: error.code === 'insufficient_entitlement' ? error.code : 'unavailable',
          message: 'Trading schedule unavailable',
          retryable: error.retryable,
          reason:
            error.code === 'insufficient_entitlement' ? 'entitlement' : 'schedule_unavailable',
        });
      }
      throw error;
    }
    const events = normalizeScheduleRows(rows, root);
    const placeholder = 'fut:schedule' as InstrumentId;
    const sessions = scheduleToSessions(events, placeholder);
    const dates = events.map((e) => e.sessionEndDate).sort();
    return {
      sessions,
      coveredFrom: dates[0] ?? null,
      // A truncated response only covers what it returned.
      coveredTo: dates.at(-1) ?? null,
    };
  }

  private assertOwn(instrument: Instrument): string {
    const root = instrument.future?.rootSymbol;
    if (instrument.marketDataRef.providerId !== MASSIVE_PROVIDER_ID || !root) {
      throw new ProviderFailure({
        code: 'invalid_request',
        message: 'Instrument belongs to another provider',
        retryable: false,
      });
    }
    return root;
  }
}

/** Pure recommendation rule (exported for tests). Candidates are ordered by expiry. */
export function pickRecommended(
  candidates: readonly ContractRecord[],
  snapshot: ReadonlyMap<string, { volume: number; lastTradeMs: number | null }>,
  now: UnixMs,
): { ticker: string; byVolume: boolean } {
  let best: { ticker: string; volume: number } | null = null;
  for (const c of candidates) {
    const s = snapshot.get(c.ticker);
    if (!s || !(s.volume > 0) || s.lastTradeMs === null || now - s.lastTradeMs > RECENT_TRADE_MS) {
      continue;
    }
    if (!best || s.volume > best.volume) best = { ticker: c.ticker, volume: s.volume };
  }
  return best
    ? { ticker: best.ticker, byVolume: true }
    : { ticker: candidates[0]!.ticker, byVolume: false };
}
