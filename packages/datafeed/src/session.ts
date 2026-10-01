/**
 * ChartSession: the headless controller between a DataFeed and a chart (docs/embedding.md). It is
 * framework-free and provider-neutral: it only uses the DataFeed interface, so the same session
 * drives Fume's backend (FumeApiDataFeed), the deterministic replay (ReplayDataFeed) or a host's
 * own feed. History shows CANONICAL candles exactly as the feed built them.
 *
 * - A symbol or timeframe switch clears the chart at once and starts a new generation: the previous
 *   generation's requests are aborted and any late response is ignored, so no stale bars appear.
 * - Older history (chart `onNeedsOlderData`) is fetched with end = oldest loaded start, at most one
 *   request at a time; `hasMore: false` stops paging for that dataset.
 * - The chart's TimeScaleMapping is rebuilt from the calendar sessions covering the loaded bars (plus
 *   a short future window for the right offset); sessions are cached per instrument.
 *
 * Live updates (instruments the feed streams): the documented handoff (docs/market-data.md) with
 * the feed's canonical 1-minute bars as the seed:
 *   subscribe + buffer -> load the displayed timeframe + 1m seed -> seed the LiveCandleAggregator,
 *   apply the buffer -> fold changed minutes into the displayed timeframe (core aggregation, the
 *   same session-aligned buckets as history) -> upsert. Trades or per-second provider aggregates
 *   move the current minute; the provider's minute bar finalizes it. After a stream reconnect, a
 *   sequence gap or a hub restart, the tail is re-fetched and the live state rebuilt (no clearing).
 * "Latest" is the newest data the feed has (for a delayed feed, the newest delayed candle); no
 * empty candles are created up to wall-clock time.
 */
import {
  applyBufferedHandoff,
  createPriceFormatter,
  createSessionTimeScale,
  createTimeFormatter,
  EMPTY_TIME_SCALE,
  LiveCandleAggregator,
  mergeCanonicalBars,
  slotSpecForTimeframe,
  tickSizeAt,
  type AssetClass,
  type Bar,
  type DataFeedInfo,
  type Instrument,
  type InstrumentId,
  type MarketEvent,
  type MarketSession,
  type StreamState,
  type TimeframeId,
  type TimeScaleMapping,
  type UnixMs,
} from '@fume/core';
import type { ChartData, OlderDataRequest } from '@fume/chart';
import { DEFAULT_VIEW, HISTORY_PAGE, LIVE_SEED_MINUTES } from './defaults.ts';
import {
  DataFeedError,
  type ChartSink,
  type DataFeed,
  type LiveSubscription,
  type ResolvedInstrument,
} from './types.ts';

/** What the session reports to its host (loading, ready, empty, error). */
export type ChartStatus =
  | { kind: 'loading'; symbol: string; timeframe: TimeframeId }
  | {
      kind: 'ready';
      symbol: string;
      timeframe: TimeframeId;
      feed: DataFeedInfo;
      bars: number;
      instrument: Instrument;
      /** True when the chart receives streamed updates for this instrument. */
      streaming: boolean;
    }
  | {
      kind: 'empty';
      symbol: string;
      timeframe: TimeframeId;
      instrument?: Instrument;
      streaming?: boolean;
    }
  | { kind: 'error'; symbol: string; timeframe: TimeframeId; code: string; message: string };

/** Overrides for the session defaults (defaults.ts). */
export interface ChartSessionSettings {
  /** Canonical candles per request, per timeframe. */
  historyPage?: Partial<Record<TimeframeId, number>>;
  /** Initial view (bar spacing, right offset) per timeframe. */
  defaultView?: Partial<Record<TimeframeId, { barSpacing: number; rightOffset: number }>>;
  /** 1-minute bars loaded to seed live updates. */
  liveSeedMinutes?: number;
  /**
   * Clear the chart as soon as a symbol or timeframe switch starts (default true). With false the
   * previous candles stay visible until the new data is ready (the replay app's behavior).
   */
  clearOnSwitch?: boolean;
}

export interface ChartSessionOptions {
  datafeed: DataFeed;
  chart: ChartSink;
  onStatus?: (status: ChartStatus) => void;
  /** Live connection health (live instruments only; null when the instrument is history only). */
  onStreamState?: (state: StreamState | null) => void;
  settings?: ChartSessionSettings;
}

/** Candles re-fetched for the displayed timeframe on a live resync. */
const RESYNC_PAGE = 60;

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

interface LiveState {
  aggregator: LiveCandleAggregator;
  /** Mapping of the displayed timeframe (bucket assignment for folds). */
  mapping: TimeScaleMapping;
}

interface Loaded {
  instrument: Instrument;
  timeframe: TimeframeId;
  oldest: UnixMs | null;
  hasMore: boolean;
  bars: number;
  live: LiveState | null;
}

export class ChartSession {
  private readonly datafeed: DataFeed;
  private readonly chart: ChartSink;
  private readonly onStatus: (status: ChartStatus) => void;
  private readonly onStreamState: (state: StreamState | null) => void;
  private readonly historyPage: Readonly<Record<TimeframeId, number>>;
  private readonly defaultView: Readonly<
    Record<TimeframeId, { barSpacing: number; rightOffset: number }>
  >;
  private readonly liveSeedMinutes: number;
  private readonly clearOnSwitch: boolean;
  private readonly instruments = new Map<string, ResolvedInstrument>();
  private readonly coverage = new Map<InstrumentId, Coverage>();
  private generation = 0;
  private abort: AbortController | null = null;
  private loaded: Loaded | null = null;
  private symbol = '';
  private assetClass: AssetClass = 'equity';
  private olderInFlight = false;
  private disposed = false;
  private subscription: LiveSubscription | null = null;
  /** Instrument currently streamed and the events buffered while (re)loading. */
  private streaming: { instrumentId: InstrumentId; buffer: MarketEvent[] | null } | null = null;
  private resyncInFlight = false;
  private resyncAgain = false;
  private formatters: Pick<ChartData, 'formatPrice' | 'formatTime' | 'minPriceStep'> = {
    formatPrice: (p) => p.toFixed(2),
    formatTime: () => '',
    minPriceStep: 0.01,
  };

  constructor(options: ChartSessionOptions) {
    this.datafeed = options.datafeed;
    this.chart = options.chart;
    this.onStatus = options.onStatus ?? (() => {});
    this.onStreamState = options.onStreamState ?? (() => {});
    const settings = options.settings ?? {};
    this.historyPage = { ...HISTORY_PAGE, ...settings.historyPage };
    this.defaultView = { ...DEFAULT_VIEW, ...settings.defaultView };
    this.liveSeedMinutes = settings.liveSeedMinutes ?? LIVE_SEED_MINUTES;
    this.clearOnSwitch = settings.clearOnSwitch ?? true;
  }

  /** Loads a symbol at a timeframe. Stale loads are aborted and ignored. */
  async select(
    symbol: string,
    timeframe: TimeframeId,
    assetClass: AssetClass = 'equity',
  ): Promise<void> {
    const gen = this.begin(symbol, timeframe);
    this.assetClass = assetClass;
    try {
      const signal = this.abort!.signal;
      const cacheKey = `${assetClass}:${symbol}`;
      let resolved = this.instruments.get(cacheKey);
      if (!resolved) {
        resolved = await this.datafeed.resolveInstrument(symbol, { assetClass, signal });
        if (this.isStale(gen)) return;
        this.instruments.set(cacheKey, resolved);
      }
      this.startStreaming(resolved);
      await this.load(resolved.instrument, timeframe, gen);
    } catch (error) {
      this.fail(gen, symbol, timeframe, error);
    }
  }

  /** Reloads the same instrument at another timeframe (canonical candles come from the backend). */
  async setTimeframe(timeframe: TimeframeId): Promise<void> {
    const instrument =
      this.loaded?.instrument ??
      this.instruments.get(`${this.assetClass}:${this.symbol}`)?.instrument;
    if (!instrument) return this.select(this.symbol, timeframe, this.assetClass);
    const gen = this.begin(this.symbol, timeframe);
    try {
      if (this.streaming?.instrumentId === instrument.id) this.streaming.buffer = [];
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
      const page = await this.datafeed.getBars({
        instrumentId: loaded.instrument.id,
        timeframe: loaded.timeframe,
        end: loaded.oldest,
        limit: this.historyPage[loaded.timeframe],
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
          streaming: l.live !== null,
          liveDiagnostics: l.live?.aggregator.diagnostics() ?? null,
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
    this.streaming = null;
    this.subscription?.unsubscribe();
    this.subscription = null;
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
    if (this.clearOnSwitch) {
      this.chart.setData({
        bars: [],
        timeScale: EMPTY_TIME_SCALE,
        ...this.formatters,
        ...this.defaultView[timeframe],
      });
    }
    this.onStatus({ kind: 'loading', symbol, timeframe });
    return gen;
  }

  /** Subscribes (and buffers) when the feed streams this instrument; otherwise stops streaming. */
  private startStreaming(resolved: ResolvedInstrument): void {
    const id = resolved.instrument.id;
    if (this.streaming?.instrumentId === id && this.subscription) {
      this.streaming.buffer = [];
      return;
    }
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.streaming = null;
    const subscription = resolved.live
      ? this.datafeed.subscribe(id, {
          onEvents: (events) => this.onEvents(events),
          onStatus: (state) => this.onStreamState(state),
          onResync: () => void this.resync(),
        })
      : null;
    if (!subscription) {
      this.onStreamState(null);
      return;
    }
    this.subscription = subscription;
    this.streaming = { instrumentId: id, buffer: [] };
  }

  private async load(instrument: Instrument, timeframe: TimeframeId, gen: number): Promise<void> {
    const signal = this.abort!.signal;
    const liveWanted = this.streaming?.instrumentId === instrument.id;
    const [page, seed] = await Promise.all([
      this.datafeed.getBars({
        instrumentId: instrument.id,
        timeframe,
        limit: this.historyPage[timeframe],
        signal,
      }),
      liveWanted && timeframe !== '1m'
        ? this.datafeed.getBars({
            instrumentId: instrument.id,
            timeframe: '1m',
            limit: this.liveSeedMinutes,
            signal,
          })
        : Promise.resolve(null),
    ]);
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
    const mapping = this.mappingFor(sessions, timeframe);
    let bars = page.bars;
    let live: LiveState | null = null;
    if (liveWanted) {
      const built = this.buildLive(sessions, mapping, seed?.bars ?? page.bars);
      live = built.live;
      bars = mergeCanonicalBars(page.bars, built.upserts);
    }
    this.chart.setData({
      bars,
      timeScale: mapping,
      ...this.formatters,
      ...this.defaultView[timeframe],
    });
    this.loaded = {
      instrument,
      timeframe,
      oldest: first?.start ?? null,
      hasMore: page.hasMore,
      bars: page.bars.length,
      live,
    };
    const symbol = instrument.displaySymbol;
    this.onStatus(
      bars.length === 0
        ? { kind: 'empty', symbol, timeframe, instrument, streaming: live !== null }
        : {
            kind: 'ready',
            symbol,
            timeframe,
            feed: page.meta.feed,
            bars: page.bars.length,
            instrument,
            streaming: live !== null,
          },
    );
  }

  /**
   * Seeds a live aggregator with canonical 1m bars and applies the buffered stream events
   * (docs/market-data.md handoff). Returns the aggregator and the displayed-timeframe candles that
   * changed.
   */
  private buildLive(
    sessions: readonly MarketSession[],
    mapping: TimeScaleMapping,
    seedMinutes: readonly Bar[],
  ): { live: LiveState; upserts: Bar[] } {
    const minuteScale = this.mappingFor(sessions, '1m');
    const aggregator = new LiveCandleAggregator({
      instrumentId: this.streaming!.instrumentId,
      minuteScale,
    });
    const seed = seedMinutes.filter((b) => b.status === 'final');
    const provisional = seedMinutes.filter((b) => b.status !== 'final');
    // The backend's canonical 1m history is complete from its first bar (a minute without trades
    // has no bar), so minute data is covered from there; buckets starting earlier are not refolded.
    const coverageFrom = seedMinutes[0]?.start;
    const buffered = this.streaming!.buffer ?? [];
    this.streaming!.buffer = null;
    const provisionalEvents: MarketEvent[] = provisional.map((bar) => ({
      kind: 'bar',
      instrumentId: this.streaming!.instrumentId,
      interval: '1m',
      phase: 'provisional',
      bar,
    }));
    const changed = applyBufferedHandoff(aggregator, {
      seedMinutes: seed,
      ...(coverageFrom !== undefined ? { coverageFrom } : {}),
      buffered: [...provisionalEvents, ...buffered],
    });
    return { live: { aggregator, mapping }, upserts: aggregator.foldBuckets(mapping, changed) };
  }

  private onEvents(events: readonly MarketEvent[]): void {
    if (this.disposed || !this.streaming) return;
    const id = this.streaming.instrumentId;
    const mine = events.filter(
      (e) =>
        (e.kind === 'bar' && e.instrumentId === id) ||
        (e.kind === 'trade' && e.trade.instrumentId === id),
    );
    if (mine.length === 0) return;
    if (this.streaming.buffer) {
      this.streaming.buffer.push(...mine);
      return;
    }
    const live = this.loaded?.live;
    if (!live || this.loaded?.instrument.id !== id) return;
    const changed = live.aggregator.apply(mine);
    if (changed.length === 0) return;
    this.chart.upsertBars(live.aggregator.foldBuckets(live.mapping, changed));
  }

  /**
   * Re-fetches the tail (displayed timeframe + 1m seed) and rebuilds the live state without
   * clearing the chart. Events arriving meanwhile are buffered and applied after the seed.
   */
  private async resync(): Promise<void> {
    if (this.resyncInFlight) {
      this.resyncAgain = true;
      return;
    }
    const loaded = this.loaded;
    if (!loaded?.live || !this.streaming || this.streaming.instrumentId !== loaded.instrument.id)
      return;
    const gen = this.generation;
    const signal = this.abort!.signal;
    this.resyncInFlight = true;
    this.streaming.buffer ??= [];
    try {
      const [page, seed] = await Promise.all([
        this.datafeed.getBars({
          instrumentId: loaded.instrument.id,
          timeframe: loaded.timeframe,
          limit: RESYNC_PAGE,
          signal,
        }),
        loaded.timeframe === '1m'
          ? Promise.resolve(null)
          : this.datafeed.getBars({
              instrumentId: loaded.instrument.id,
              timeframe: '1m',
              limit: this.liveSeedMinutes,
              signal,
            }),
      ]);
      if (this.isStale(gen) || this.loaded !== loaded) return;
      const sessions = await this.sessionsCovering(
        loaded.instrument.id,
        page.bars[0]?.start ?? page.serverTime - DAY,
        page.serverTime + FUTURE_MS,
        signal,
      );
      if (this.isStale(gen) || this.loaded !== loaded) return;
      const mapping = this.mappingFor(sessions, loaded.timeframe);
      const built = this.buildLive(sessions, mapping, seed?.bars ?? page.bars);
      loaded.live = built.live;
      this.chart.upsertBars(mergeCanonicalBars(page.bars, built.upserts));
    } catch {
      // Keep the chart and the old live state; the next resync trigger retries.
      if (this.streaming?.buffer) {
        const pending = this.streaming.buffer;
        this.streaming.buffer = null;
        this.onEvents(pending);
      }
    } finally {
      this.resyncInFlight = false;
      if (this.resyncAgain) {
        this.resyncAgain = false;
        void this.resync();
      }
    }
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
        const sessions = await this.datafeed.getSessions(instrumentId, start, end, signal);
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
    // Nothing is loaded to apply buffered events to: stop buffering (no unbounded growth).
    if (this.streaming) this.streaming.buffer = null;
    this.report(error, symbol, timeframe);
  }

  private report(error: unknown, symbol: string, timeframe: TimeframeId): void {
    const code = error instanceof DataFeedError ? error.code : 'internal';
    const message =
      error instanceof DataFeedError ? error.message : 'Unexpected error while loading history';
    this.onStatus({ kind: 'error', symbol, timeframe, code, message });
  }
}
