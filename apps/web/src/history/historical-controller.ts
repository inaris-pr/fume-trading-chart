/**
 * HistoricalChartController: framework-free glue between Fume's HTTP history API and a chart
 * (Stage 4, `?source=alpaca`). It shows CANONICAL candles exactly as the backend built them: no
 * client-side aggregation, no live ticks, no replay events.
 *
 * - A symbol or timeframe switch clears the chart at once and starts a new generation: the previous
 *   generation's requests are aborted and any late response is ignored, so no stale bars appear.
 * - Older history (chart `onNeedsOlderData`) is fetched with end = oldest loaded start, at most one
 *   request at a time; `hasMore: false` stops paging for that dataset.
 * - The chart's TimeScaleMapping is rebuilt from the calendar sessions covering the loaded bars (plus
 *   a short future window for the right offset); sessions are cached per instrument.
 */
import {
  createPriceFormatter,
  createSessionTimeScale,
  createTimeFormatter,
  slotSpecForTimeframe,
  tickSizeAt,
  type DataFeedInfo,
  type Instrument,
  type InstrumentId,
  type MarketSession,
  type TimeframeId,
  type TimeScaleMapping,
  type UnixMs,
} from '@fume/core';
import type { ChartData, OlderDataRequest } from '@fume/chart';
import type { ChartSink } from '../live/chart-controller.ts';
import { DEFAULT_VIEW } from '../timeframes.ts';
import { FumeApiError, type BarsPage, type BarsQuery } from '../api/fume-client.ts';

/** The subset of FumeHttpClient the controller uses (tests pass a fake backend). */
export interface HistoryClient {
  resolveInstrument(symbol: string, signal?: AbortSignal): Promise<Instrument>;
  getSessions(
    instrumentId: InstrumentId,
    from: UnixMs,
    to: UnixMs,
    signal?: AbortSignal,
  ): Promise<MarketSession[]>;
  getBars(query: BarsQuery): Promise<BarsPage>;
}

export type HistoryStatus =
  | { kind: 'loading'; symbol: string; timeframe: TimeframeId }
  | { kind: 'ready'; symbol: string; timeframe: TimeframeId; feed: DataFeedInfo; bars: number }
  | { kind: 'empty'; symbol: string; timeframe: TimeframeId }
  | { kind: 'error'; symbol: string; timeframe: TimeframeId; code: string; message: string };

export interface HistoricalControllerOptions {
  client: HistoryClient;
  chart: ChartSink;
  onStatus?: (status: HistoryStatus) => void;
}

/**
 * Canonical candles per request (initial load and each older page); the API allows up to 2000.
 * Sized so one request stays at a few upstream calls on the Basic plan: upstream pages hold about
 * one month of bars (observed 2026-09-29), so 4H/1D pages are ~75/150 sessions (3/7 calls).
 */
export const HISTORY_PAGE: Readonly<Record<TimeframeId, number>> = {
  '1m': 1000,
  '5m': 800,
  '15m': 600,
  '1h': 500,
  '4h': 150,
  '1d': 150,
};

const DAY = 86_400_000;
/** Future calendar sessions loaded so the right offset shows real session slots. */
const FUTURE_MS = 14 * DAY;
/** The backend accepts at most 1100 days per /sessions request. */
const SESSIONS_CHUNK_MS = 1000 * DAY;

interface Coverage {
  from: UnixMs;
  to: UnixMs;
  byDate: Map<string, MarketSession>;
}

interface Loaded {
  instrument: Instrument;
  timeframe: TimeframeId;
  oldest: UnixMs | null;
  hasMore: boolean;
  bars: number;
}

const EMPTY_SCALE: TimeScaleMapping = {
  toSlot: () => null,
  slotStart: (s) => s,
  boundaries: () => [],
};

export class HistoricalChartController {
  private readonly client: HistoryClient;
  private readonly chart: ChartSink;
  private readonly onStatus: (status: HistoryStatus) => void;
  private readonly instruments = new Map<string, Instrument>();
  private readonly coverage = new Map<InstrumentId, Coverage>();
  private generation = 0;
  private abort: AbortController | null = null;
  private loaded: Loaded | null = null;
  private symbol = '';
  private olderInFlight = false;
  private disposed = false;
  private formatters: Pick<ChartData, 'formatPrice' | 'formatTime' | 'minPriceStep'> = {
    formatPrice: (p) => p.toFixed(2),
    formatTime: () => '',
    minPriceStep: 0.01,
  };

  constructor(options: HistoricalControllerOptions) {
    this.client = options.client;
    this.chart = options.chart;
    this.onStatus = options.onStatus ?? (() => {});
  }

  /** Loads a symbol at a timeframe. Stale loads are aborted and ignored. */
  async select(symbol: string, timeframe: TimeframeId): Promise<void> {
    const gen = this.begin(symbol, timeframe);
    try {
      const signal = this.abort!.signal;
      let instrument = this.instruments.get(symbol);
      if (!instrument) {
        instrument = await this.client.resolveInstrument(symbol, signal);
        if (this.isStale(gen)) return;
        this.instruments.set(symbol, instrument);
      }
      await this.load(instrument, timeframe, gen);
    } catch (error) {
      this.fail(gen, symbol, timeframe, error);
    }
  }

  /** Reloads the same instrument at another timeframe (canonical candles come from the backend). */
  async setTimeframe(timeframe: TimeframeId): Promise<void> {
    const instrument = this.loaded?.instrument ?? this.instruments.get(this.symbol);
    if (!instrument) return this.select(this.symbol, timeframe);
    const gen = this.begin(this.symbol, timeframe);
    try {
      await this.load(instrument, timeframe, gen);
    } catch (error) {
      this.fail(gen, this.symbol, timeframe, error);
    }
  }

  /** Chart callback: fetch the page before the oldest loaded candle and prepend it without a jump. */
  async requestOlderData(_request: OlderDataRequest): Promise<void> {
    const loaded = this.loaded;
    if (!loaded || !loaded.hasMore || loaded.oldest === null) {
      this.chart.resolveOlderDataRequest(false);
      return;
    }
    if (this.olderInFlight) return; // one request per series at a time
    const gen = this.generation;
    const signal = this.abort!.signal;
    this.olderInFlight = true;
    try {
      const page = await this.client.getBars({
        instrumentId: loaded.instrument.id,
        timeframe: loaded.timeframe,
        end: loaded.oldest,
        limit: HISTORY_PAGE[loaded.timeframe],
        signal,
      });
      if (this.isStale(gen) || this.loaded !== loaded) return;
      loaded.hasMore = page.hasMore;
      const first = page.bars[0];
      if (!first) {
        this.chart.resolveOlderDataRequest(page.hasMore);
        return;
      }
      const sessions = await this.sessionsCovering(loaded.instrument.id, first.start, null, signal);
      if (this.isStale(gen) || this.loaded !== loaded) return;
      loaded.oldest = first.start;
      loaded.bars += page.bars.length;
      this.chart.prependBars(page.bars, {
        hasMore: page.hasMore,
        timeScale: this.mappingFor(sessions, loaded.timeframe),
      });
    } catch (error) {
      if (this.isStale(gen) || this.loaded !== loaded) return;
      // Keep the chart; do not retry in a loop (the chart asks again on the next interaction).
      this.chart.resolveOlderDataRequest(true);
      this.report(error, loaded.instrument.displaySymbol, loaded.timeframe);
    } finally {
      if (this.generation === gen) this.olderInFlight = false;
    }
  }

  state() {
    const l = this.loaded;
    return l
      ? {
          symbol: l.instrument.displaySymbol,
          timeframe: l.timeframe,
          bars: l.bars,
          hasMore: l.hasMore,
          oldest: l.oldest,
        }
      : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.loaded = null;
  }

  // -------------------------------------------------------------------------------------------

  /** New generation: abort the previous one, clear the chart, report loading. */
  private begin(symbol: string, timeframe: TimeframeId): number {
    const gen = ++this.generation;
    this.abort?.abort();
    this.abort = new AbortController();
    this.loaded = null;
    this.olderInFlight = false;
    this.symbol = symbol;
    this.chart.setData({
      bars: [],
      timeScale: EMPTY_SCALE,
      ...this.formatters,
      ...DEFAULT_VIEW[timeframe],
    });
    this.onStatus({ kind: 'loading', symbol, timeframe });
    return gen;
  }

  private async load(instrument: Instrument, timeframe: TimeframeId, gen: number): Promise<void> {
    const signal = this.abort!.signal;
    const page = await this.client.getBars({
      instrumentId: instrument.id,
      timeframe,
      limit: HISTORY_PAGE[timeframe],
      signal,
    });
    if (this.isStale(gen)) return;
    const first = page.bars[0];
    const sessions = await this.sessionsCovering(
      instrument.id,
      first?.start ?? page.serverTime - 7 * DAY,
      page.serverTime + FUTURE_MS,
      signal,
    );
    if (this.isStale(gen)) return;
    this.formatters = {
      formatPrice: createPriceFormatter(instrument.priceFormat),
      formatTime: createTimeFormatter(instrument.session.timezone),
      minPriceStep: tickSizeAt(instrument.tickRules, page.bars.at(-1)?.close ?? 1),
    };
    this.chart.setData({
      bars: page.bars,
      timeScale: this.mappingFor(sessions, timeframe),
      ...this.formatters,
      ...DEFAULT_VIEW[timeframe],
    });
    this.loaded = {
      instrument,
      timeframe,
      oldest: first?.start ?? null,
      hasMore: page.hasMore,
      bars: page.bars.length,
    };
    const symbol = instrument.displaySymbol;
    this.onStatus(
      page.bars.length === 0
        ? { kind: 'empty', symbol, timeframe }
        : { kind: 'ready', symbol, timeframe, feed: page.meta.feed, bars: page.bars.length },
    );
  }

  /**
   * All cached sessions for the instrument after making sure [from, to] is covered (`to` null =
   * keep the current end). Only the missing edges are fetched, in chunks the API accepts.
   */
  private async sessionsCovering(
    instrumentId: InstrumentId,
    from: UnixMs,
    to: UnixMs | null,
    signal: AbortSignal,
  ): Promise<MarketSession[]> {
    const DAY_PAD = DAY; // include the whole session containing `from`
    let cov = this.coverage.get(instrumentId);
    const wantFrom = from - DAY_PAD;
    const wantTo = to ?? cov?.to ?? from + DAY;
    const ranges: [UnixMs, UnixMs][] = [];
    if (!cov) ranges.push([wantFrom, wantTo]);
    else {
      if (wantFrom < cov.from) ranges.push([wantFrom, cov.from]);
      // The forward edge is a moving "now + future window": extend it only when it has grown by
      // more than a day, so each load does not re-request a few seconds of calendar.
      if (wantTo > cov.to + DAY) ranges.push([cov.to, wantTo]);
    }
    for (const [lo, hi] of ranges) {
      for (let start = lo; start < hi; start += SESSIONS_CHUNK_MS) {
        const end = Math.min(hi, start + SESSIONS_CHUNK_MS);
        const sessions = await this.client.getSessions(instrumentId, start, end, signal);
        cov = this.coverage.get(instrumentId) ?? { from: start, to: end, byDate: new Map() };
        for (const s of sessions) cov.byDate.set(s.sessionDate, s);
        cov.from = Math.min(cov.from, start);
        cov.to = Math.max(cov.to, end);
        this.coverage.set(instrumentId, cov);
      }
    }
    return [...(this.coverage.get(instrumentId)?.byDate.values() ?? [])].sort((a, b) =>
      a.sessionDate.localeCompare(b.sessionDate),
    );
  }

  private mappingFor(sessions: readonly MarketSession[], timeframe: TimeframeId): TimeScaleMapping {
    return createSessionTimeScale({
      sessions,
      sessionMode: 'regular',
      slot: slotSpecForTimeframe(timeframe),
    });
  }

  private isStale(gen: number): boolean {
    return this.disposed || gen !== this.generation;
  }

  private fail(gen: number, symbol: string, timeframe: TimeframeId, error: unknown): void {
    if (this.isStale(gen)) return;
    this.report(error, symbol, timeframe);
  }

  private report(error: unknown, symbol: string, timeframe: TimeframeId): void {
    const code = error instanceof FumeApiError ? error.code : 'internal';
    const message =
      error instanceof FumeApiError ? error.message : 'Unexpected error while loading history';
    this.onStatus({ kind: 'error', symbol, timeframe, code, message });
  }
}
