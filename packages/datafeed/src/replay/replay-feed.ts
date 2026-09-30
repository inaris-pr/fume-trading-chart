/**
 * ReplayDataFeed: the deterministic, offline DataFeed (synthetic instruments, history and live tape
 * from @fume/replay). No network.
 *
 * - Canonical candles are built here from the replay's official 1-minute bars with the same core
 *   functions the backend uses (session-aligned buckets, `final` only once a bucket has ended at
 *   the replay clock).
 * - Pages are WHOLE SESSIONS, as the replay chart always loaded them: a fixed number of sessions
 *   per timeframe (REPLAY_SESSIONS_PER_PAGE); the query's `limit` is only a hint here.
 * - Live: ONE replay stream per feed, multiplexed over every subscription (trades + 1m bars).
 * - Older pages can be delayed artificially (default 600 ms) so paging is visible in the demo.
 */
import {
  buildCanonicalBars,
  selectWindows,
  type Bar,
  type Instrument,
  type InstrumentId,
  type MarketEvent,
  type MarketSession,
  type MarketStream,
  type TimeframeId,
  type UnixMs,
} from '@fume/core';
import { ReplayMarketDataProvider, type ReplayProviderOptions } from '@fume/replay';
import {
  DataFeedError,
  type BarsPage,
  type BarsQuery,
  type DataFeed,
  type LiveHandlers,
  type LiveSubscription,
  type ResolveOptions,
  type ResolvedInstrument,
} from '../types.ts';

const PAGE = 10_000;
const ALL_TIME = Number.MAX_SAFE_INTEGER;

/**
 * Sessions of history per page (initial load and each older page), per timeframe: the replay
 * chart's long-standing values. Kept small so panning left visibly triggers older-history loads.
 */
export const REPLAY_SESSIONS_PER_PAGE: Readonly<Record<TimeframeId, number>> = {
  '1m': 2,
  '5m': 5,
  '15m': 10,
  '1h': 20,
  '4h': 40,
  '1d': 60,
};

export interface ReplayDataFeedOptions extends ReplayProviderOptions {
  /** Use an existing provider (tests); otherwise one is created from the other options. */
  provider?: ReplayMarketDataProvider;
  /** Artificial latency for older-history pages (requests with `end`). Default 600 ms. */
  olderPageDelayMs?: number;
  /** Delay implementation (tests pass an immediate one). */
  delay?: (ms: number) => Promise<void>;
  /** Whole sessions per page, per timeframe (default REPLAY_SESSIONS_PER_PAGE). */
  sessionsPerPage?: Partial<Record<TimeframeId, number>>;
}

interface Sub {
  instrumentId: InstrumentId;
  handlers: LiveHandlers;
}

export class ReplayDataFeed implements DataFeed {
  readonly provider: ReplayMarketDataProvider;
  private readonly olderDelay: number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly sessionsPerPage: Readonly<Record<TimeframeId, number>>;
  private readonly instruments = new Map<InstrumentId, Instrument>();
  private readonly subs = new Map<number, Sub>();
  private nextSub = 1;
  private stream: MarketStream | null = null;
  private disposed = false;

  constructor(options: ReplayDataFeedOptions = {}) {
    const { provider, olderPageDelayMs, delay, sessionsPerPage, ...providerOptions } = options;
    this.provider = provider ?? new ReplayMarketDataProvider(providerOptions);
    this.sessionsPerPage = { ...REPLAY_SESSIONS_PER_PAGE, ...sessionsPerPage };
    this.olderDelay = olderPageDelayMs ?? 600;
    this.delay = delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async resolveInstrument(
    symbol: string,
    _options: ResolveOptions = {},
  ): Promise<ResolvedInstrument> {
    const instrument = await this.provider.resolveInstrument(symbol);
    if (!instrument) throw new DataFeedError('not_found', `Unknown replay symbol ${symbol}`);
    this.instruments.set(instrument.id, instrument);
    return { instrument, live: true };
  }

  async getSessions(
    instrumentId: InstrumentId,
    from: UnixMs,
    to: UnixMs,
  ): Promise<MarketSession[]> {
    return [...(await this.provider.getSessions(this.instrument(instrumentId), from, to))];
  }

  /**
   * Canonical candles for `timeframe` of the newest whole sessions before `end` (default: the
   * replay's now), `sessionsPerPage[timeframe]` sessions per page.
   */
  async getBars(query: BarsQuery): Promise<BarsPage> {
    if (query.end !== undefined && this.olderDelay > 0) await this.delay(this.olderDelay);
    if (query.signal?.aborted) throw new DataFeedError('unavailable', 'Request aborted');
    const instrument = this.instrument(query.instrumentId);
    const now = this.provider.marketNow();
    const until = query.end ?? now + 1;
    const calendar = await this.provider.getSessions(instrument, 0, ALL_TIME);
    const firstData = this.provider.dataset.dataSessions[0]?.sessionDate ?? '';

    // The newest whole sessions that start before `until` (the current one may be partial).
    const candidates = calendar.filter((s) => {
      const w = selectWindows(s, 'regular')[0];
      return w !== undefined && w.start < until && s.sessionDate >= firstData;
    });
    const count = Math.max(1, this.sessionsPerPage[query.timeframe]);
    const picked: MarketSession[] = candidates.slice(-count);
    const meta = {
      instrumentId: instrument.id,
      timeframe: query.timeframe,
      sessionMode: 'regular' as const,
      feed: this.provider.feed,
    };
    const first = picked[0] && selectWindows(picked[0], 'regular')[0];
    if (!first) return { meta, bars: [], hasMore: false, serverTime: now };

    const minutes = await this.minutesBetween(instrument, first.start, until);
    const bars = buildCanonicalBars({
      baseBars: minutes,
      baseIntervalMinutes: 1,
      sessions: picked,
      timeframe: query.timeframe,
      mode: 'regular',
      asOf: now,
    }).bars.filter((b) => b.start < until);
    return {
      meta,
      bars,
      hasMore: picked.length > 0 && candidates.length > picked.length,
      serverTime: now,
    };
  }

  subscribe(instrumentId: InstrumentId, handlers: LiveHandlers): LiveSubscription | null {
    if (this.disposed) return null;
    const id = this.nextSub++;
    this.subs.set(id, { instrumentId, handlers });
    this.stream ??= this.provider.openStream({ onEvents: (events) => this.route(events) });
    this.applySubscriptions();
    let active = true;
    return {
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.subs.delete(id);
        if (this.subs.size === 0) {
          this.stream?.close();
          this.stream = null;
        } else this.applySubscriptions();
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subs.clear();
    this.stream?.close();
    this.stream = null;
  }

  // -------------------------------------------------------------------------------------------

  private instrument(id: InstrumentId): Instrument {
    const cached = this.instruments.get(id);
    if (cached) return cached;
    const symbol = this.provider.dataset.symbolFor(id);
    const instrument = symbol ? this.provider.dataset.instrument(symbol) : null;
    if (!instrument) throw new DataFeedError('not_found', `Unknown replay instrument ${id}`);
    this.instruments.set(id, instrument);
    return instrument;
  }

  /** Official 1m bars with start in [from, until), paging backwards through the provider. */
  private async minutesBetween(
    instrument: Instrument,
    from: UnixMs,
    until: UnixMs,
  ): Promise<Bar[]> {
    let bars: Bar[] = [];
    let cursor = until;
    for (;;) {
      const page = await this.provider.getBars({
        instrument,
        intervalMinutes: 1,
        start: from,
        end: cursor,
        limit: PAGE,
      });
      if (page.bars.length === 0) break;
      bars = [...page.bars, ...bars];
      cursor = page.bars[0]!.start;
      if (!page.hasMore || cursor <= from) break;
    }
    return bars.filter((b) => b.start >= from);
  }

  private applySubscriptions(): void {
    const ids = [...new Set([...this.subs.values()].map((s) => s.instrumentId))];
    this.stream?.setSubscriptions(
      ids.map((instrumentId) => ({ instrumentId, channels: ['trades', 'minuteBars'] })),
    );
  }

  private route(events: readonly MarketEvent[]): void {
    for (const sub of [...this.subs.values()]) {
      const mine: MarketEvent[] = [];
      for (const e of events) {
        if (e.kind === 'stream_status') sub.handlers.onStatus(e.state);
        else if (e.kind === 'resync_required') sub.handlers.onResync(e.reason);
        else if (belongsTo(e, sub.instrumentId)) mine.push(e);
      }
      if (mine.length > 0) sub.handlers.onEvents(mine);
    }
  }
}

function belongsTo(event: MarketEvent, id: InstrumentId): boolean {
  if (event.kind === 'trade') return event.trade.instrumentId === id;
  if (event.kind === 'quote') return event.quote.instrumentId === id;
  if (event.kind === 'bar' || event.kind === 'instrument_status') return event.instrumentId === id;
  return false;
}
