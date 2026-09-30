/**
 * Offline fake of the three Alpaca endpoints the adapter uses, serving SYNTHETIC data shaped like
 * the documented payloads (bars / assets / calendar). It implements the query semantics the
 * adapter relies on (inclusive start/end, limit, sort, page_token) and records every request so
 * tests can assert URLs and headers. No network, no real market data.
 */
import { generateSyntheticBars } from '@fume/core/fixtures';
import {
  resolveWeeklySessions,
  type Bar,
  type InstrumentId,
  type MarketSession,
  type TradingSessionSpec,
} from '@fume/core';

export const TEST_KEY_ID = 'TEST-KEY-ID-NOT-REAL';
export const TEST_SECRET = 'TEST-SECRET-NOT-REAL';

const weekdays = (start: string, end: string) =>
  ([1, 2, 3, 4, 5] as const).map((startDay) => ({ startDay, start, end }));
const SPEC: TradingSessionSpec = {
  timezone: 'America/New_York',
  regular: weekdays('09:30', '16:00'),
  extended: [],
  calendarId: 'TEST',
};

export interface FakeCalendarDay {
  date: string;
  open: string;
  close: string;
}

export interface RecordedRequest {
  url: URL;
  headers: Record<string, string>;
}

export interface FakeAlpacaOptions {
  /** Inclusive local dates of the synthetic calendar. */
  from?: string;
  to?: string;
  /** Dates to drop (holidays) and dates with a 13:00 close. */
  holidays?: readonly string[];
  earlyCloses?: readonly string[];
  /** Max bars the fake returns per page regardless of `limit` (forces pagination). */
  pageCap?: number;
  /** Minute starts (ms) with no trades (IEX gaps). */
  gaps?: readonly number[];
  /** Market "now": only minutes completed by then exist (coarser bars are partial). */
  now?: number;
  /** Pre/post-market minutes added before each open and after each close (IEX has these). */
  extendedMinutes?: number;
}

export class FakeAlpaca {
  readonly requests: RecordedRequest[] = [];
  readonly calendar: FakeCalendarDay[];
  readonly sessions: MarketSession[];
  minutes: Bar[];
  /** Override a response for the next matching path (status + body + headers). */
  nextResponse: { status: number; body: unknown; headers?: Record<string, string> } | null = null;
  private readonly pageCap: number;

  constructor(options: FakeAlpacaOptions = {}) {
    const from = options.from ?? '2026-09-21';
    const to = options.to ?? '2026-09-25';
    const holidays = new Set(options.holidays ?? []);
    const early = new Set(options.earlyCloses ?? []);
    const weekly = resolveWeeklySessions({
      instrumentId: 'eq:FAKE' as InstrumentId,
      spec: SPEC,
      from,
      to,
    });
    this.calendar = weekly
      .filter((s) => !holidays.has(s.sessionDate))
      .map((s) => ({
        date: s.sessionDate,
        open: '09:30',
        close: early.has(s.sessionDate) ? '13:00' : '16:00',
      }));
    this.sessions = weekly
      .filter((s) => !holidays.has(s.sessionDate))
      .map((s) => ({
        ...s,
        windows: s.windows.map((w) =>
          early.has(s.sessionDate) ? { ...w, end: w.start + 3.5 * 3_600_000 } : w,
        ),
      }));
    const gaps = new Set(options.gaps ?? []);
    this.minutes = generateSyntheticBars({
      seed: 11,
      sessions: this.sessions,
      sessionMode: 'regular',
      durationMs: 60_000,
      count: this.sessions.length * 390,
      startPrice: 600,
      tickSize: 0.01,
      walk: 'multiplicative',
      volatility: 0.0008,
      gapVolatility: 0.005,
      dojiProbability: 0.05,
      longWickProbability: 0.02,
      baseVolume: 2000,
    })
      .filter((b) =>
        this.sessions.some((s) => s.windows.some((w) => b.start >= w.start && b.start < w.end)),
      )
      .filter((b) => !gaps.has(b.start))
      .filter((b) => options.now === undefined || b.start + 60_000 <= options.now);
    const ext = options.extendedMinutes ?? 0;
    if (ext > 0) {
      const extra: Bar[] = [];
      for (const s of this.sessions) {
        const w = s.windows[0]!;
        const ref = this.minutes.find((m) => m.start >= w.start) ?? this.minutes[0]!;
        for (let i = 1; i <= ext; i++) {
          for (const start of [w.start - i * 60_000, w.end + (i - 1) * 60_000]) {
            extra.push({
              ...ref,
              start,
              volume: 5,
              open: ref.open,
              high: ref.open,
              low: ref.open,
              close: ref.open,
            });
          }
        }
      }
      this.minutes = [...this.minutes, ...extra].sort((a, b) => a.start - b.start);
    }
    this.pageCap = options.pageCap ?? 10_000;
  }

  /** Epoch-aligned bars of `minutes` built from the synthetic 1-minute series. */
  barsOf(minutes: number): Bar[] {
    if (minutes === 1) return this.minutes;
    const size = minutes * 60_000;
    const out: Bar[] = [];
    for (const m of this.minutes) {
      const start = Math.floor(m.start / size) * size;
      const last = out[out.length - 1];
      if (last && last.start === start) {
        last.high = Math.max(last.high, m.high);
        last.low = Math.min(last.low, m.low);
        last.close = m.close;
        last.volume += m.volume;
        last.tradeCount = (last.tradeCount ?? 0) + (m.tradeCount ?? 0);
      } else out.push({ ...m, start, tradeCount: m.tradeCount ?? 0 });
    }
    return out;
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    this.requests.push({ url, headers });
    if (this.nextResponse) {
      const { status, body, headers: extra } = this.nextResponse;
      this.nextResponse = null;
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: extra ?? {},
      });
    }
    if (
      headers['apca-api-key-id'] !== TEST_KEY_ID ||
      headers['apca-api-secret-key'] !== TEST_SECRET
    ) {
      return Response.json({ message: 'forbidden.' }, { status: 401 });
    }
    const path = url.pathname;
    const asset = /^\/v2\/assets\/([^/]+)$/.exec(path);
    if (asset) return this.asset(decodeURIComponent(asset[1]!));
    if (path === '/v2/calendar') return this.calendarResponse(url);
    const bars = /^\/v2\/stocks\/([^/]+)\/bars$/.exec(path);
    if (bars) return this.bars(url);
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };

  private asset(symbol: string): Response {
    const known: Record<string, object> = {
      SPY: { exchange: 'ARCA', name: 'SPDR S&P 500 ETF Trust', shortable: true },
      NVDA: { exchange: 'NASDAQ', name: 'NVIDIA Corporation Common Stock', shortable: true },
      OLD: { exchange: 'NYSE', name: 'Delisted Corp', status: 'inactive' },
      OTCX: { exchange: 'OTC', name: 'Some OTC Co' },
    };
    const extra = known[symbol];
    if (!extra)
      return Response.json({ code: 40410000, message: 'asset not found' }, { status: 404 });
    return Response.json({
      id: '00000000-0000-4000-8000-000000000000',
      class: 'us_equity',
      symbol,
      status: 'active',
      tradable: true,
      marginable: true,
      easy_to_borrow: true,
      fractionable: true,
      attributes: [],
      ...extra,
    });
  }

  private calendarResponse(url: URL): Response {
    const start = url.searchParams.get('start') ?? '0000-00-00';
    const end = url.searchParams.get('end') ?? '9999-99-99';
    return Response.json(
      this.calendar
        .filter((d) => d.date >= start && d.date <= end)
        .map((d) => ({
          ...d,
          session_open: '0400',
          session_close: '2000',
          settlement_date: d.date,
        })),
    );
  }

  private bars(url: URL): Response {
    const q = url.searchParams;
    const minutes = Number(/^(\d+)Min$/.exec(q.get('timeframe') ?? '')?.[1]);
    const start = Date.parse(q.get('start') ?? '1970-01-01T00:00:00Z');
    const end = Date.parse(q.get('end') ?? '2100-01-01T00:00:00Z'); // INCLUSIVE, like Alpaca
    const limit = Math.min(Number(q.get('limit') ?? 1000), this.pageCap);
    const desc = q.get('sort') === 'desc';
    let series = this.barsOf(minutes).filter((b) => b.start >= start && b.start <= end);
    if (desc) series = [...series].reverse();
    const offset = Number(q.get('page_token') ? atob(q.get('page_token')!) : 0);
    const page = series.slice(offset, offset + limit);
    const next = offset + limit < series.length ? btoa(String(offset + limit)) : null;
    return Response.json({
      bars: page.length === 0 ? null : page.map(toAlpacaBar),
      symbol: 'X',
      next_page_token: next,
    });
  }
}

export function toAlpacaBar(b: Bar) {
  return {
    t: new Date(b.start).toISOString().replace('.000Z', 'Z'),
    o: b.open,
    h: b.high,
    l: b.low,
    c: b.close,
    v: b.volume,
    n: b.tradeCount ?? 0,
    vw: b.vwap ?? (b.high + b.low + b.close) / 3,
  };
}
