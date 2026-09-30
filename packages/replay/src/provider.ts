/**
 * ReplayMarketDataProvider: a deterministic, offline implementation of the provider-neutral
 * MarketDataProvider port (packages/core/src/providers.ts). It behaves like a live feed on a shared
 * market clock:
 * - getBars() returns official 1-minute bars published before "now" (revised when published);
 * - openStream() emits each subscribed symbol's tape events as the clock passes their emit time;
 * - a new subscription starts at the current market time (no backlog), like a real feed.
 */
import type {
  BarPage,
  BarPageRequest,
  DataFeedInfo,
  Instrument,
  InstrumentId,
  MarketDataProvider,
  MarketEvent,
  MarketSession,
  MarketStream,
  MarketStreamHandlers,
  MarketSubscription,
  UnixMs,
} from '@fume/core';
import { FINAL_BAR_DELAY_MS, ReplayDataset, type TapeEntry } from './dataset.ts';
import type { ReplaySymbol } from './instruments.ts';
import { ReplayClock, timerScheduler, type ReplayScheduler } from './scheduler.ts';

export interface ReplayProviderOptions {
  dataset?: ReplayDataset;
  scheduler?: ReplayScheduler;
  /** Market-time ms per real ms. Default 20 (a replay minute every 3 s). */
  speed?: number;
  /** Market time the replay starts at. Default: the dataset's replay start. */
  startMs?: UnixMs;
  /** Real ms between stream ticks. Default 50. */
  tickMs?: number;
}

const MINUTE = 60_000;
const MAX_PAGE = 10_000;

export class ReplayMarketDataProvider implements MarketDataProvider {
  readonly id = 'replay';
  readonly feed: DataFeedInfo = {
    providerId: 'replay',
    feedId: 'synthetic',
    consolidated: false,
    delayMs: 0,
  };
  readonly nativeIntervalsMinutes: readonly number[] = [1];
  readonly dataset: ReplayDataset;
  private readonly scheduler: ReplayScheduler;
  private readonly clock: ReplayClock;
  private readonly tickMs: number;

  constructor(options: ReplayProviderOptions = {}) {
    this.dataset = options.dataset ?? new ReplayDataset();
    this.scheduler = options.scheduler ?? timerScheduler();
    this.tickMs = options.tickMs ?? 50;
    this.clock = new ReplayClock(
      this.dataset.dataSessions,
      options.startMs ?? this.dataset.replayStartMs,
      options.speed ?? 20,
      this.scheduler.now(),
    );
  }

  /** Current replay market time. */
  marketNow(): UnixMs {
    return this.clock.marketTime(this.scheduler.now());
  }

  async resolveInstrument(symbol: string): Promise<Instrument | null> {
    return this.dataset.instrument(symbol);
  }

  async getSessions(
    instrument: Instrument,
    from: UnixMs,
    to: UnixMs,
  ): Promise<readonly MarketSession[]> {
    return this.dataset.sessionsFor(instrument.id, from, to);
  }

  /**
   * Official 1-minute bars with start < request.end that have been published by now, newest
   * `limit` of them, ascending. hasMore reports whether older bars exist.
   */
  async getBars(request: BarPageRequest): Promise<BarPage> {
    if (request.signal?.aborted) throw providerError('unavailable', 'Request aborted', false);
    if (request.intervalMinutes !== 1) {
      throw providerError(
        'invalid_request',
        `Replay serves 1-minute bars only (got ${request.intervalMinutes})`,
        false,
      );
    }
    const symbol = this.dataset.symbolFor(request.instrument.id);
    if (!symbol)
      throw providerError('not_found', `Unknown replay instrument ${request.instrument.id}`, false);
    const now = this.marketNow();
    const all = this.dataset.minuteBars(symbol);
    // Published = its final bar was emitted by now; the page ends before request.end.
    const publishedBefore = Math.min(request.end, now - FINAL_BAR_DELAY_MS - MINUTE + 1);
    const endIndex = upperBoundByStart(all, publishedBefore); // bars[0..endIndex) start < limit
    const limit = Math.max(1, Math.min(MAX_PAGE, Math.floor(request.limit)));
    const floorIndex = request.start === undefined ? 0 : upperBoundByStart(all, request.start);
    const startIndex = Math.max(floorIndex, endIndex - limit);
    const bars = all
      .slice(startIndex, endIndex)
      .map((b) => this.dataset.officialMinute(symbol, b, now));
    return { bars, hasMore: startIndex > 0 };
  }

  openStream(handlers: MarketStreamHandlers): MarketStream {
    return new ReplayStream(this, handlers, this.scheduler, this.tickMs);
  }

  /** @internal Tape of a subscribed instrument. */
  tapeFor(instrumentId: InstrumentId): { symbol: ReplaySymbol; tape: readonly TapeEntry[] } | null {
    const symbol = this.dataset.symbolFor(instrumentId);
    return symbol ? { symbol, tape: this.dataset.tape(symbol) } : null;
  }
}

class ReplayStream implements MarketStream {
  /** instrumentId -> index of the next tape entry to emit. */
  private readonly cursors = new Map<InstrumentId, { tape: readonly TapeEntry[]; next: number }>();
  private timer: unknown = null;
  private closed = false;
  private ingestSeq = 0;
  private announced = false;

  constructor(
    private readonly provider: ReplayMarketDataProvider,
    private readonly handlers: MarketStreamHandlers,
    private readonly scheduler: ReplayScheduler,
    private readonly tickMs: number,
  ) {
    this.schedule();
  }

  setSubscriptions(subscriptions: readonly MarketSubscription[]): void {
    if (this.closed) return;
    const now = this.provider.marketNow();
    const desired = new Set(subscriptions.map((s) => s.instrumentId));
    for (const id of [...this.cursors.keys()]) if (!desired.has(id)) this.cursors.delete(id);
    for (const id of desired) {
      if (this.cursors.has(id)) continue;
      const found = this.provider.tapeFor(id);
      if (!found) continue;
      // Start after everything already emitted by the market clock: no backlog on subscribe.
      this.cursors.set(id, { tape: found.tape, next: upperBoundByEmit(found.tape, now) });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) this.scheduler.clearTimeout(this.timer);
    this.timer = null;
    this.cursors.clear();
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = this.scheduler.setTimeout(() => this.tick(), this.tickMs);
  }

  private tick(): void {
    this.timer = null;
    if (this.closed) return;
    const now = this.provider.marketNow();
    const batch: { emitMs: number; order: number; event: MarketEvent }[] = [];
    if (!this.announced) {
      this.announced = true;
      batch.push({
        emitMs: -Infinity,
        order: -1,
        event: { kind: 'stream_status', state: { status: 'live' } },
      });
    }
    for (const cursor of this.cursors.values()) {
      while (cursor.next < cursor.tape.length && cursor.tape[cursor.next]!.emitMs <= now) {
        const entry = cursor.tape[cursor.next]!;
        batch.push({ emitMs: entry.emitMs, order: batch.length, event: entry.event });
        cursor.next++;
      }
    }
    batch.sort((a, b) => a.emitMs - b.emitMs || a.order - b.order);
    // The replay acts as the hub: it assigns ingestSeq in emission order.
    const events = batch.map(({ event }) =>
      event.kind === 'trade'
        ? { ...event, trade: { ...event.trade, ingestSeq: this.ingestSeq++ } }
        : event,
    );
    if (events.length > 0) this.handlers.onEvents(events);
    this.schedule();
  }
}

function upperBoundByStart(bars: readonly { start: number }[], before: number): number {
  let lo = 0;
  let hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.start < before) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBoundByEmit(tape: readonly TapeEntry[], now: number): number {
  let lo = 0;
  let hi = tape.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tape[mid]!.emitMs <= now) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function providerError(
  code: 'unavailable' | 'invalid_request' | 'not_found',
  message: string,
  retryable: boolean,
) {
  return Object.assign(new Error(message), { code, message, retryable });
}
