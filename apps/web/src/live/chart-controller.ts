/**
 * LiveChartController: framework-free glue between a MarketDataProvider, the live aggregator and
 * a chart. It follows the documented handoff (docs/market-data.md):
 *   subscribe + buffer -> load 1m history -> seed + apply buffer -> go live.
 * All candle math lives in @fume/core; all drawing and interaction in @fume/chart. React only
 * creates this object and forwards symbol/timeframe selections.
 */
import {
  aggregateBars,
  applyBufferedHandoff,
  createPriceFormatter,
  createSessionTimeScale,
  createTimeFormatter,
  LiveCandleAggregator,
  slotSpecForTimeframe,
  tickSizeAt,
  type Bar,
  type Instrument,
  type MarketDataProvider,
  type MarketEvent,
  type MarketSession,
  type MarketStream,
  type TimeframeId,
  type TimeScaleMapping,
  type UnixMs,
} from '@fume/core';
import type { ChartData, OlderDataRequest, PrependOptions } from '@fume/chart';
import { DEFAULT_VIEW, HISTORY_SESSIONS } from '../timeframes.ts';

/** The subset of FumeChart the controller drives (lets tests use a recorder). */
export interface ChartSink {
  setData(data: ChartData): void;
  upsertBars(bars: readonly Bar[]): unknown;
  prependBars(bars: readonly Bar[], options?: PrependOptions): unknown;
  resolveOlderDataRequest(hasMore: boolean): void;
}

export interface LiveChartControllerOptions {
  provider: MarketDataProvider;
  chart: ChartSink;
  /** Artificial latency for older-history loads (makes the demo's loading visible). */
  olderDataDelayMs?: number;
  /** Delay implementation (tests pass an immediate one). */
  delay?: (ms: number) => Promise<void>;
}

const MINUTE = 60_000;
const PAGE = 10_000;
/** Sessions of official minutes the live aggregator is seeded with (covers any 1D bucket). */
const SEED_SESSIONS = 2;

interface Loaded {
  instrument: Instrument;
  sessions: readonly MarketSession[];
  minuteScale: TimeScaleMapping;
  aggregator: LiveCandleAggregator;
  /** 1m history + live effective minutes, ascending. */
  minutes: Bar[];
  hasOlder: boolean;
  timeframe: TimeframeId;
  mapping: TimeScaleMapping;
  formatPrice: ChartData['formatPrice'];
  formatTime: ChartData['formatTime'];
  minPriceStep: number;
}

export class LiveChartController {
  private readonly provider: MarketDataProvider;
  private readonly chart: ChartSink;
  private readonly stream: MarketStream;
  private readonly olderDelay: number;
  private readonly delay: (ms: number) => Promise<void>;
  private token = 0;
  private loaded: Loaded | null = null;
  private buffering: { instrumentId: string; events: MarketEvent[] } | null = null;
  private disposed = false;

  constructor(options: LiveChartControllerOptions) {
    this.provider = options.provider;
    this.chart = options.chart;
    this.olderDelay = options.olderDataDelayMs ?? 600;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.stream = this.provider.openStream({ onEvents: (events) => this.onEvents(events) });
  }

  /** Loads a symbol (history + live) at a timeframe. Stale loads are abandoned. */
  async select(symbol: string, timeframe: TimeframeId): Promise<void> {
    const token = ++this.token;
    this.loaded = null;
    const instrument = await this.provider.resolveInstrument(symbol);
    if (!instrument || this.isStale(token)) return;

    // 1. Subscribe first and buffer, so nothing is lost while history loads.
    this.buffering = { instrumentId: instrument.id, events: [] };
    this.stream.setSubscriptions([
      { instrumentId: instrument.id, channels: ['trades', 'minuteBars'] },
    ]);

    // 2. Calendar and 1m history.
    const sessions = await this.provider.getSessions(instrument, 0, Number.MAX_SAFE_INTEGER);
    if (this.isStale(token)) return;
    const minuteScale = createSessionTimeScale({
      sessions,
      sessionMode: 'regular',
      slot: slotSpecForTimeframe('1m'),
    });
    const history = await this.loadSessions(
      instrument,
      sessions,
      Math.max(HISTORY_SESSIONS[timeframe], SEED_SESSIONS),
      Number.MAX_SAFE_INTEGER,
    );
    if (this.isStale(token)) return;

    // 3. Seed the aggregator with the latest sessions, then apply what arrived meanwhile.
    const aggregator = new LiveCandleAggregator({ instrumentId: instrument.id, minuteScale });
    const coverageFrom = sessionStartBefore(
      sessions,
      history.bars.at(-1)?.start ?? 0,
      SEED_SESSIONS - 1,
    );
    const seed = history.bars.filter((b) => b.start >= coverageFrom);
    const buffered = this.buffering?.events ?? [];
    this.buffering = null;
    const loaded: Loaded = {
      instrument,
      sessions,
      minuteScale,
      aggregator,
      minutes: [...history.bars],
      hasOlder: history.hasMore,
      timeframe,
      mapping: this.mappingFor(sessions, timeframe),
      formatPrice: createPriceFormatter(instrument.priceFormat),
      formatTime: createTimeFormatter(instrument.session.timezone),
      minPriceStep: tickSizeAt(instrument.tickRules, history.bars.at(-1)?.close ?? 1),
    };
    const changed = applyBufferedHandoff(aggregator, { seedMinutes: seed, coverageFrom, buffered });
    this.mergeMinutes(loaded, changed);
    this.loaded = loaded;

    // 4. Show canonical candles and go live.
    this.showTimeframe(loaded);
  }

  /** Re-aggregates the same minute state for another timeframe (no resubscription). */
  async setTimeframe(timeframe: TimeframeId): Promise<void> {
    const loaded = this.loaded;
    if (!loaded || loaded.timeframe === timeframe) return;
    const token = this.token;
    const needed = HISTORY_SESSIONS[timeframe];
    const have = countSessions(loaded.sessions, loaded.minutes);
    if (have < needed && loaded.hasOlder) {
      const older = await this.loadSessions(
        loaded.instrument,
        loaded.sessions,
        needed - have,
        loaded.minutes[0]!.start,
      );
      if (this.isStale(token) || this.loaded !== loaded) return;
      loaded.minutes = [...older.bars, ...loaded.minutes];
      loaded.hasOlder = older.hasMore;
    }
    loaded.timeframe = timeframe;
    loaded.mapping = this.mappingFor(loaded.sessions, timeframe);
    this.showTimeframe(loaded);
  }

  /** Chart callback: load older history, then prepend it without moving the view. */
  async requestOlderData(request: OlderDataRequest): Promise<void> {
    const loaded = this.loaded;
    const token = this.token;
    if (!loaded || !loaded.hasOlder) {
      this.chart.resolveOlderDataRequest(false);
      return;
    }
    await this.delay(this.olderDelay);
    if (this.isStale(token) || this.loaded !== loaded) return;
    const oldest = loaded.minutes[0]?.start ?? request.before;
    const older = await this.loadSessions(
      loaded.instrument,
      loaded.sessions,
      HISTORY_SESSIONS[loaded.timeframe],
      oldest,
    );
    if (this.isStale(token) || this.loaded !== loaded) return;
    loaded.minutes = [...older.bars, ...loaded.minutes];
    loaded.hasOlder = older.hasMore;
    const canonical = aggregateBars({
      bars: older.bars,
      sourceDurationMs: MINUTE,
      target: loaded.mapping,
    }).bars;
    this.chart.prependBars(canonical, { hasMore: older.hasMore });
  }

  /** Diagnostics for QA and tests. */
  state() {
    const l = this.loaded;
    return l
      ? {
          symbol: l.instrument.displaySymbol,
          timeframe: l.timeframe,
          minutes: l.minutes.length,
          hasOlder: l.hasOlder,
          diagnostics: l.aggregator.diagnostics(),
        }
      : null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.token++;
    this.loaded = null;
    this.buffering = null;
    this.stream.close();
  }

  // -------------------------------------------------------------------------------------------

  private onEvents(events: readonly MarketEvent[]): void {
    if (this.disposed) return;
    if (this.buffering) {
      const id = this.buffering.instrumentId;
      for (const e of events) if (belongsTo(e, id)) this.buffering.events.push(e);
      return;
    }
    const loaded = this.loaded;
    if (!loaded) return;
    const relevant = events.filter((e) => belongsTo(e, loaded.instrument.id));
    if (relevant.length === 0) return;
    const changed = loaded.aggregator.apply(relevant);
    if (changed.length === 0) return;
    this.mergeMinutes(loaded, changed);
    this.chart.upsertBars(loaded.aggregator.foldBuckets(loaded.mapping, changed));
  }

  private showTimeframe(loaded: Loaded): void {
    const bars =
      loaded.timeframe === '1m'
        ? loaded.minutes
        : aggregateBars({ bars: loaded.minutes, sourceDurationMs: MINUTE, target: loaded.mapping })
            .bars;
    this.chart.setData({
      bars,
      timeScale: loaded.mapping,
      formatPrice: loaded.formatPrice,
      formatTime: loaded.formatTime,
      minPriceStep: loaded.minPriceStep,
      ...DEFAULT_VIEW[loaded.timeframe],
    });
  }

  /** Copies the aggregator's effective minutes into the minute list (replace or insert, ordered). */
  private mergeMinutes(loaded: Loaded, changed: readonly UnixMs[]): void {
    for (const start of changed) {
      const bar = loaded.aggregator.effectiveMinute(start);
      if (!bar) continue;
      const { minutes } = loaded;
      const i = lowerBound(minutes, start);
      if (minutes[i]?.start === start) minutes[i] = bar;
      else minutes.splice(i, 0, bar);
    }
  }

  private mappingFor(sessions: readonly MarketSession[], timeframe: TimeframeId): TimeScaleMapping {
    return createSessionTimeScale({
      sessions,
      sessionMode: 'regular',
      slot: slotSpecForTimeframe(timeframe),
    });
  }

  /**
   * Loads `count` whole sessions of 1m bars ending before `end`, paging backwards. Whole sessions
   * keep every canonical bucket complete (all buckets start at a session boundary or later).
   */
  private async loadSessions(
    instrument: Instrument,
    sessions: readonly MarketSession[],
    count: number,
    end: UnixMs,
  ): Promise<{ bars: Bar[]; hasMore: boolean }> {
    let bars: Bar[] = [];
    let cursor = end;
    let hasMore = true;
    let from: UnixMs | null = null;
    while (hasMore) {
      const page = await this.provider.getBars({
        instrument,
        intervalMinutes: 1,
        end: cursor,
        limit: PAGE,
      });
      if (page.bars.length === 0) {
        hasMore = false;
        break;
      }
      bars = [...page.bars, ...bars];
      hasMore = page.hasMore;
      cursor = page.bars[0]!.start;
      from ??= sessionStartBefore(sessions, bars.at(-1)!.start, count - 1);
      if (bars[0]!.start <= from) break;
    }
    if (from === null) return { bars: [], hasMore: false };
    const trimmed = bars.filter((b) => b.start >= from!);
    return { bars: trimmed, hasMore: hasMore || trimmed.length < bars.length };
  }

  private isStale(token: number): boolean {
    return this.disposed || token !== this.token;
  }
}

function belongsTo(event: MarketEvent, instrumentId: string): boolean {
  if (event.kind === 'trade') return event.trade.instrumentId === instrumentId;
  if (event.kind === 'bar') return event.instrumentId === instrumentId;
  return false;
}

/** Start of the regular session `back` sessions before the session containing `t`. */
function sessionStartBefore(sessions: readonly MarketSession[], t: UnixMs, back: number): UnixMs {
  const starts = sessions
    .map((s) => s.windows.find((w) => w.kind === 'regular')?.start)
    .filter((x): x is number => x !== undefined)
    .sort((a, b) => a - b);
  let index = starts.length - 1;
  while (index > 0 && starts[index]! > t) index--;
  return starts[Math.max(0, index - back)] ?? t;
}

function countSessions(sessions: readonly MarketSession[], minutes: readonly Bar[]): number {
  const first = minutes[0]?.start;
  const last = minutes.at(-1)?.start;
  if (first === undefined || last === undefined) return 0;
  return sessions.filter((s) =>
    s.windows.some((w) => w.kind === 'regular' && w.end > first && w.start <= last),
  ).length;
}

function lowerBound(bars: readonly Bar[], start: UnixMs): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.start < start) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
