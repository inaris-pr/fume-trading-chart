/**
 * Offline fake of the Massive futures REST API (shapes as observed in the 2026-09-30 spike):
 * products, contracts (point-in-time rows), snapshot, 1-minute aggregates with `next_url` cursors,
 * and trading schedules (every row duplicated, as the real API does). Deterministic synthetic data;
 * no real market data and no real credentials.
 */
import { CME_GLOBEX_SESSION } from '../src/providers/massive/normalize.ts';
import { resolveWeeklySessions, type InstrumentId } from '@fume/core';

export const TEST_MASSIVE_KEY = 'test-massive-key-not-real-0000';
export const MASSIVE_ENV = {
  MASSIVE_REST_BASE_URL: 'https://api.massive.com',
  MASSIVE_FUTURES_STREAM_URL: 'wss://delayed.massive.com/futures',
  MASSIVE_API_KEY: TEST_MASSIVE_KEY,
};

const MIN = 60_000;

export interface ContractRow {
  ticker: string;
  product_code: string;
  first_trade_date: string;
  last_trade_date: string;
  settlement_date: string;
  trade_tick_size: number;
  trading_venue: string;
  type: 'single' | 'combo';
}

const c = (
  ticker: string,
  root: string,
  first: string,
  last: string,
  tick: number,
  venue: string,
  type: 'single' | 'combo' = 'single',
): ContractRow => ({
  ticker,
  product_code: root,
  first_trade_date: first,
  last_trade_date: last,
  settlement_date: last,
  trade_tick_size: tick,
  trading_venue: venue,
  type,
});

export const CONTRACTS: ContractRow[] = [
  c('ESU6', 'ES', '2025-06-20', '2026-09-18', 0.25, 'XCME'), // expired
  c('ESZ6', 'ES', '2025-09-19', '2026-12-18', 0.25, 'XCME'),
  c('ESH7', 'ES', '2025-12-19', '2027-03-19', 0.25, 'XCME'),
  c('ESM7', 'ES', '2026-03-20', '2027-06-17', 0.25, 'XCME'),
  c('NQU6', 'NQ', '2025-06-20', '2026-09-18', 0.25, 'XCME'), // expired
  c('NQZ6', 'NQ', '2022-05-22', '2026-12-18', 0.25, 'XCME'),
  c('NQH7', 'NQ', '2025-09-19', '2027-03-19', 0.25, 'XCME'),
  c('NQM7', 'NQ', '2025-12-19', '2027-06-17', 0.25, 'XCME'),
  c('NQU7', 'NQ', '2026-03-20', '2027-09-17', 0.25, 'XCME'),
  c('NQH8', 'NQ', '2026-03-20', '2028-03-17', 0.25, 'XCME'),
  c('NQZ6-NQH7', 'NQ', '2026-03-20', '2026-12-18', 0.05, 'XCME', 'combo'),
  c('GCV6', 'GC', '2024-11-29', '2026-10-28', 0.1, 'XCEC'),
  c('GCX6', 'GC', '2025-02-10', '2026-11-25', 0.1, 'XCEC'),
  c('GCZ6', 'GC', '2020-12-31', '2026-12-29', 0.1, 'XCEC'),
  c('GCF7', 'GC', '2025-02-10', '2027-01-27', 0.1, 'XCEC'),
  c('SIZ6', 'SI', '2021-12-31', '2026-12-29', 0.005, 'XCEC'),
  c('SIH7', 'SI', '2025-02-10', '2027-03-29', 0.005, 'XCEC'),
  c('CLX6', 'CL', '2018-01-22', '2026-10-20', 0.01, 'XNYM'),
  c('CLZ6', 'CL', '2017-11-21', '2026-11-20', 0.01, 'XNYM'),
  c('YMZ6', 'YM', '2025-12-19', '2026-12-18', 1, 'XCBT'),
  c('YMH7', 'YM', '2026-03-20', '2027-03-19', 1, 'XCBT'),
];

export const PRODUCTS: Record<string, Record<string, unknown>> = {
  ES: { name: 'E-mini S&P 500 Futures', venue: 'XCME', qty: 50, unit: 'IPNT' },
  NQ: { name: 'E-mini Nasdaq-100 Index Futures', venue: 'XCME', qty: 20, unit: 'IPNT' },
  GC: { name: 'Gold Futures', venue: 'XCEC', qty: 100, unit: 'TRYOZ' },
  SI: { name: 'Silver Futures', venue: 'XCEC', qty: 5000, unit: 'TRYOZ' },
  CL: { name: 'Light Sweet Crude Oil Futures', venue: 'XNYM', qty: 1000, unit: 'BBL' },
  YM: {
    name: 'E-mini Dow Jones Industrial Average Index Futures',
    venue: 'XCBT',
    qty: 5,
    unit: 'IPNT',
  },
};

/** Delayed snapshot session volumes (the nearest GC month is NOT the active one). */
export const SNAPSHOT_VOLUME: Record<string, number> = {
  ESZ6: 1_250_000,
  ESH7: 9_800,
  ESM7: 120,
  NQZ6: 431_341,
  NQH7: 1_200,
  NQM7: 50,
  NQU7: 33_910, // anomalous deferred volume, but no recent trade -> not eligible
  GCV6: 781,
  GCX6: 115,
  GCZ6: 127_082,
  GCF7: 68,
  SIZ6: 31_742,
  SIH7: 739,
  CLX6: 171_760,
  CLZ6: 52_598,
  YMZ6: 54_085,
  YMH7: 20,
};
/** Contracts without a recent (delayed) last trade in the snapshot. */
const STALE_TRADES = new Set(['NQU7']);

export interface FakeMassiveOptions {
  now: number;
  /** Fail these paths (prefix match) with this HTTP status. */
  failPaths?: Record<string, number>;
  /** Snapshot rows missing entirely. */
  snapshotDown?: boolean;
  /** Page size the fake uses for aggregates (to exercise cursors). */
  aggsPageSize?: number;
  /** Extra schedule rows (replace the generated ones for these dates). */
  closedDates?: readonly string[];
}

export class FakeMassive {
  readonly requests: { path: string; query: Record<string, string> }[] = [];
  private readonly options: FakeMassiveOptions;

  constructor(options: FakeMassiveOptions) {
    this.options = options;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const headers = new Headers(init?.headers);
    const query = Object.fromEntries(url.searchParams);
    this.requests.push({ path: url.pathname, query });
    if (url.origin !== 'https://api.massive.com') return json(404, { status: 'NOT_FOUND' });
    if (url.searchParams.has('apiKey')) return json(400, { status: 'ERROR' }); // key never in URLs
    if (headers.get('Authorization') !== `Bearer ${TEST_MASSIVE_KEY}`) {
      return json(401, { status: 'ERROR' });
    }
    for (const [prefix, status] of Object.entries(this.options.failPaths ?? {})) {
      if (url.pathname.startsWith(prefix)) return json(status, { status: 'ERROR' });
    }
    const p = url.pathname;
    if (p === '/futures/v1/products') return this.products(query);
    if (p === '/futures/v1/contracts') return this.contracts(query);
    if (p === '/futures/v1/snapshot') return this.snapshot(query);
    if (p === '/futures/v1/schedules') return this.schedules(query);
    if (p.startsWith('/futures/v1/aggs/'))
      return this.aggs(decodeURIComponent(p.slice(17)), query, url);
    if (p.startsWith('/futures/v1/trades') || p.startsWith('/futures/v1/quotes')) {
      return json(403, { status: 'NOT_AUTHORIZED' });
    }
    return json(404, { status: 'NOT_FOUND' });
  };

  private products(q: Record<string, string>): Response {
    const p = PRODUCTS[q.product_code ?? ''];
    if (!p) return json(200, { status: 'OK', results: [] });
    return json(200, {
      status: 'OK',
      results: [
        {
          product_code: q.product_code,
          name: p.name,
          trading_venue: p.venue,
          type: 'single',
          unit_of_measure: p.unit,
          unit_of_measure_qty: p.qty,
          trade_currency_code: 'USD',
          date: '2026-09-30',
        },
      ],
    });
  }

  private contracts(q: Record<string, string>): Response {
    if (q.ticker) {
      const row = CONTRACTS.find((r) => r.ticker === q.ticker);
      if (!row) return json(200, { status: 'OK', results: [] });
      const date = row.last_trade_date < '2026-09-30' ? row.last_trade_date : '2026-09-30';
      return json(200, {
        status: 'OK',
        results: [{ ...row, date, active: date <= row.last_trade_date }],
      });
    }
    const date = q.date ?? '2026-09-30';
    const rows = CONTRACTS.filter(
      (r) =>
        r.product_code === q.product_code &&
        (!q.type || r.type === q.type) &&
        r.first_trade_date <= date &&
        r.last_trade_date >= date,
    ).map((r) => ({ ...r, date, active: true }));
    return json(200, { status: 'OK', results: rows });
  }

  private snapshot(q: Record<string, string>): Response {
    if (this.options.snapshotDown) return json(503, { status: 'ERROR' });
    const tickers = (q['ticker.any_of'] ?? '').split(',').filter(Boolean);
    const nowNs = BigInt(this.options.now - 10 * MIN) * 1_000_000n;
    return json(200, {
      status: 'OK',
      results: tickers.map((ticker) => ({
        details: { ticker, product_code: ticker.slice(0, 2), settlement_date: '2026-12-18' },
        session: { volume: SNAPSHOT_VOLUME[ticker] ?? 0, close: 1 },
        ...(STALE_TRADES.has(ticker)
          ? {}
          : {
              last_trade: { timeframe: 'DELAYED', price: 1, size: 1, last_updated: Number(nowNs) },
            }),
      })),
    });
  }

  /** Sessions from the weekly Globex rule (holidays via `closedDates`), rows duplicated 2x. */
  private schedules(q: Record<string, string>): Response {
    const from = q['session_end_date.gte'] ?? '2026-01-01';
    const to = q['session_end_date.lte'] ?? '2026-12-31';
    // The real schedule history starts 2024-07-31 and is published ~2 months ahead.
    const lo = from < '2024-07-31' ? '2024-07-31' : from;
    const hi = to > '2026-11-30' ? '2026-11-30' : to;
    if (lo > hi) return json(200, { status: 'OK', results: [] });
    const sessions = resolveWeeklySessions({
      instrumentId: 'fut:X' as InstrumentId,
      spec: CME_GLOBEX_SESSION,
      from: lo,
      to: hi,
    });
    const rows: unknown[] = [];
    for (const s of sessions) {
      if (this.options.closedDates?.includes(s.sessionDate)) continue;
      const w = s.windows[0]!;
      for (const [event, t] of [
        ['pre_open', w.start - 45 * MIN],
        ['open', w.start],
        ['close', w.end],
      ] as const) {
        const row = {
          event,
          product_code: q.product_code,
          product_name: 'x',
          session_end_date: s.sessionDate,
          timestamp: new Date(t).toISOString().replace('.000Z', '+00:00'),
          trading_venue: 'XCME',
        };
        rows.push(row, row);
      }
    }
    return json(200, { status: 'OK', results: rows });
  }

  /**
   * One bar per minute inside the weekly Globex windows up to now - 10 min (delayed), price rising
   * one tick per minute from a per-contract base. Newest first with sort=window_start.desc.
   */
  private aggs(ticker: string, q: Record<string, string>, url: URL): Response {
    const row = CONTRACTS.find((r) => r.ticker === ticker);
    if (!row) return json(200, { status: 'OK', results: [] });
    const gte = Number(BigInt(q['window_start.gte'] ?? '0') / 1_000_000n);
    const lt = Number(
      BigInt(q['window_start.lt'] ?? String(BigInt(this.options.now) * 1_000_000n)) / 1_000_000n,
    );
    const offset = Number(q.cursor_offset ?? '0');
    const limit = Math.min(Number(q.limit ?? '1000'), this.options.aggsPageSize ?? 50_000);
    const delayedNow = this.options.now - 10 * MIN;
    const all = fakeMinuteStarts(
      Math.max(gte, delayedNow - 400 * 24 * 60 * MIN),
      Math.min(lt, delayedNow + 1),
    );
    const desc = q.sort !== 'window_start.asc';
    const ordered = desc ? all.reverse() : all;
    const page = ordered.slice(offset, offset + limit);
    const results = page.map((start) => fakeAggregate(ticker, row.trade_tick_size, start));
    const next = offset + limit < ordered.length ? new URL(url) : null;
    if (next) {
      for (const k of [...next.searchParams.keys()]) next.searchParams.delete(k);
      next.searchParams.set('cursor_offset', String(offset + limit));
      for (const k of ['window_start.gte', 'window_start.lt', 'limit', 'sort', 'resolution']) {
        if (q[k] !== undefined) next.searchParams.set(k, q[k]);
      }
    }
    return json(200, { status: 'OK', results, ...(next ? { next_url: next.toString() } : {}) });
  }
}

/** Minute starts in [from, to) inside weekly Globex windows. */
export function fakeMinuteStarts(from: number, to: number): number[] {
  if (!(to > from)) return [];
  const day = 86_400_000;
  const sessions = resolveWeeklySessions({
    instrumentId: 'fut:X' as InstrumentId,
    spec: CME_GLOBEX_SESSION,
    from: new Date(from - day).toISOString().slice(0, 10),
    to: new Date(to + day).toISOString().slice(0, 10),
  });
  const out: number[] = [];
  for (const s of sessions) {
    for (const w of s.windows) {
      for (
        let t = Math.max(w.start, Math.ceil(from / MIN) * MIN);
        t < Math.min(w.end, to);
        t += MIN
      ) {
        out.push(t);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

export function fakeAggregate(ticker: string, tick: number, start: number) {
  const base = ticker.startsWith('NQ')
    ? 30_000
    : ticker.startsWith('ES')
      ? 6_500
      : ticker.startsWith('GC')
        ? 4_000
        : 100;
  const step = (start / MIN) % 200;
  const open = round(base + step * tick, tick);
  return {
    ticker,
    window_start: start * 1_000_000,
    session_end_date: '2026-09-30',
    open,
    high: round(open + 2 * tick, tick),
    low: round(open - tick, tick),
    close: round(open + tick, tick),
    volume: 10 + (step % 7),
    transactions: 5 + (step % 3),
    dollar_volume: 1,
  };
}

function round(v: number, tick: number): number {
  const d = String(tick).split('.')[1]?.length ?? 0;
  return Number(v.toFixed(d));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
