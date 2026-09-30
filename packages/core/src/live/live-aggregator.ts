/**
 * Deterministic live candle aggregation (docs/market-data.md, "Live aggregation").
 *
 * State is kept per canonical MINUTE (slot of a 1-minute TimeScaleMapping built from the
 * sessions and session mode). Each minute may hold:
 *   official           final or revised provider bar (highest precedence)
 *   providerProvisional a provider's in-progress minute bar
 *   fromTrades          a minute built from individual trades
 * Canonical candles of any timeframe are re-folded from the effective minutes of the affected
 * buckets with the same aggregateBars() used for history, so bucket math exists once.
 */
import { aggregateBars } from '../aggregate.ts';
import { compareEpochNs } from '../event-time.ts';
import type { Bar, MarketEvent, Trade } from '../market-data.ts';
import type { EpochNs, InstrumentId, UnixMs } from '../primitives.ts';
import type { TimeScaleMapping } from '../time-scale.ts';
import { BoundedKeySet, tradeIdentity } from './dedupe.ts';

const MINUTE_MS = 60_000;

/** Minute slots retained behind the newest event: two full days of 24h sessions. */
export const DEFAULT_RETENTION_MINUTES = 2 * 1440;
export const DEFAULT_DEDUPE_CAPACITY = 10_000;

export interface LiveAggregatorOptions {
  instrumentId: InstrumentId;
  /** 1-minute canonical mapping for the instrument's sessions and session mode. */
  minuteScale: TimeScaleMapping;
  retentionMinutes?: number;
  dedupeCapacity?: number;
}

export interface LiveDiagnostics {
  acceptedTrades: number;
  duplicateTrades: number;
  outsideSessionTrades: number;
  /** Trades for a minute that already has an official bar (the official bar wins). */
  tradesAfterOfficial: number;
  acceptedOfficialBars: number;
  /** final/revised bars not newer than the stored one (duplicates or stale revisions). */
  staleOfficialBars: number;
  /** Events older than the retained / seeded coverage window; they cannot be applied safely. */
  eventsOutsideRetention: number;
  /** Buckets not re-folded because part of them lies before the covered minutes. */
  uncoveredBuckets: number;
  /** Events for other instruments, session-level bars and non-candle events. */
  ignoredEvents: number;
}

interface TradeAccumulator {
  open: number;
  openNs: EpochNs;
  openSeq: number;
  close: number;
  closeNs: EpochNs;
  closeSeq: number;
  high: number;
  low: number;
  volume: number;
  tradeCount: number;
}

interface MinuteState {
  start: UnixMs;
  official?: { bar: Bar; rank: 1 | 2 };
  providerProvisional?: Bar;
  fromTrades?: TradeAccumulator;
}

export class LiveCandleAggregator {
  readonly instrumentId: InstrumentId;
  private readonly minuteScale: TimeScaleMapping;
  private readonly retention: number;
  private readonly dedupe: BoundedKeySet;
  private readonly minutes = new Map<number, MinuteState>();
  private coverageSlot: number | null = null;
  private newestSlot = Number.NEGATIVE_INFINITY;
  private oldestRetainedSlot = Number.POSITIVE_INFINITY;
  /** Latest market time known complete (trade times, official bar ends). */
  private highWaterMs = Number.NEGATIVE_INFINITY;
  private readonly diag: LiveDiagnostics = {
    acceptedTrades: 0,
    duplicateTrades: 0,
    outsideSessionTrades: 0,
    tradesAfterOfficial: 0,
    acceptedOfficialBars: 0,
    staleOfficialBars: 0,
    eventsOutsideRetention: 0,
    uncoveredBuckets: 0,
    ignoredEvents: 0,
  };

  constructor(options: LiveAggregatorOptions) {
    this.instrumentId = options.instrumentId;
    this.minuteScale = options.minuteScale;
    this.retention = options.retentionMinutes ?? DEFAULT_RETENTION_MINUTES;
    this.dedupe = new BoundedKeySet(options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY);
    if (!(this.retention >= 1)) throw new Error('retentionMinutes must be >= 1');
  }

  /**
   * Seeds official (historical) 1-minute bars and declares minute data complete from
   * `coverageFrom` (default: the first seeded bar). Canonical buckets that start before the
   * coverage are never re-folded, because their earlier minutes are unknown to the aggregator.
   * Returns the starts of minutes that changed.
   */
  seedOfficialMinutes(bars: readonly Bar[], coverageFrom?: UnixMs): UnixMs[] {
    const from = coverageFrom ?? bars[0]?.start;
    if (from !== undefined) {
      const slot = this.minuteScale.toSlot(from);
      const covered = slot === null ? this.nextOpenSlotAtOrAfter(from) : Math.ceil(slot);
      if (covered !== null && (this.coverageSlot === null || covered < this.coverageSlot)) {
        this.coverageSlot = covered;
      }
    }
    const changed = new Set<UnixMs>();
    for (const bar of bars) {
      const start = this.applyOfficial(bar, 1);
      if (start !== null) changed.add(start);
    }
    this.prune();
    return [...changed].sort((a, b) => a - b);
  }

  /** Applies events in order; returns the starts of minutes whose effective bar changed. */
  apply(events: readonly MarketEvent[]): UnixMs[] {
    const changed = new Set<UnixMs>();
    for (const event of events) {
      const start = this.applyOne(event);
      if (start !== null) changed.add(start);
    }
    this.prune();
    return [...changed].sort((a, b) => a - b);
  }

  /** Effective bar for one minute: official > provider provisional > trade-built. */
  effectiveMinute(start: UnixMs): Bar | null {
    const slot = this.minuteScale.toSlot(start);
    if (slot === null || !Number.isInteger(slot)) return null;
    const state = this.minutes.get(slot);
    return state ? effectiveBar(state) : null;
  }

  /** All retained effective minutes, ascending. */
  effectiveMinutes(): Bar[] {
    return [...this.minutes.keys()]
      .sort((a, b) => a - b)
      .map((slot) => effectiveBar(this.minutes.get(slot)!))
      .filter((b): b is Bar => b !== null);
  }

  /**
   * Canonical candles (for `target`, e.g. the displayed timeframe) of every bucket containing a
   * changed minute, re-folded from effective minutes. Ascending, one bar per bucket.
   */
  foldBuckets(target: TimeScaleMapping, changedMinuteStarts: readonly UnixMs[]): Bar[] {
    const buckets = new Set<number>();
    for (const start of changedMinuteStarts) {
      const slot = target.toSlot(start);
      if (slot !== null) buckets.add(Math.floor(slot));
    }
    const out: Bar[] = [];
    for (const bucket of [...buckets].sort((a, b) => a - b)) {
      const bar = this.foldBucket(target, bucket);
      if (bar) out.push(bar);
    }
    return out;
  }

  /** Earliest minute start the aggregator has complete data for (null before seeding). */
  coverageStart(): UnixMs | null {
    return this.coverageSlot === null ? null : this.minuteScale.slotStart(this.coverageSlot);
  }

  retainedMinuteCount(): number {
    return this.minutes.size;
  }

  diagnostics(): Readonly<LiveDiagnostics> {
    return { ...this.diag };
  }

  // -------------------------------------------------------------------------------------------

  private applyOne(event: MarketEvent): UnixMs | null {
    if (event.kind === 'trade') {
      if (event.trade.instrumentId !== this.instrumentId) return this.ignore();
      return this.applyTrade(event.trade);
    }
    if (event.kind === 'bar') {
      if (event.instrumentId !== this.instrumentId || event.interval !== '1m') return this.ignore();
      if (event.phase === 'provisional') return this.applyProviderProvisional(event.bar);
      return this.applyOfficial(event.bar, event.phase === 'revised' ? 2 : 1);
    }
    return this.ignore();
  }

  private ignore(): null {
    this.diag.ignoredEvents++;
    return null;
  }

  private applyTrade(trade: Trade): UnixMs | null {
    if (!Number.isFinite(trade.price) || !(trade.size > 0)) return this.ignore();
    const slotValue = this.minuteScale.toSlot(trade.time.ms);
    if (slotValue === null) {
      this.diag.outsideSessionTrades++;
      return null;
    }
    const slot = Math.floor(slotValue);
    if (!this.isRetainable(slot)) {
      this.diag.eventsOutsideRetention++;
      return null;
    }
    const identity = tradeIdentity(trade);
    if (identity !== null && !this.dedupe.add(identity)) {
      this.diag.duplicateTrades++;
      return null;
    }
    const state = this.stateFor(slot);
    if (trade.time.ms > this.highWaterMs) this.highWaterMs = trade.time.ms;
    if (state.official) {
      this.diag.tradesAfterOfficial++;
      return null;
    }
    const seq = trade.ingestSeq ?? -1;
    const acc = state.fromTrades;
    if (!acc) {
      state.fromTrades = {
        open: trade.price,
        openNs: trade.time.ns,
        openSeq: seq,
        close: trade.price,
        closeNs: trade.time.ns,
        closeSeq: seq,
        high: trade.price,
        low: trade.price,
        volume: trade.size,
        tradeCount: 1,
      };
    } else {
      if (isBefore(trade.time.ns, seq, acc.openNs, acc.openSeq)) {
        acc.open = trade.price;
        acc.openNs = trade.time.ns;
        acc.openSeq = seq;
      }
      if (isBefore(acc.closeNs, acc.closeSeq, trade.time.ns, seq)) {
        acc.close = trade.price;
        acc.closeNs = trade.time.ns;
        acc.closeSeq = seq;
      }
      if (trade.price > acc.high) acc.high = trade.price;
      if (trade.price < acc.low) acc.low = trade.price;
      acc.volume += trade.size;
      acc.tradeCount += 1;
    }
    this.diag.acceptedTrades++;
    return state.start;
  }

  private applyProviderProvisional(bar: Bar): UnixMs | null {
    const slot = this.exactMinuteSlot(bar.start);
    if (slot === null) return this.ignore();
    if (!this.isRetainable(slot)) {
      this.diag.eventsOutsideRetention++;
      return null;
    }
    const state = this.stateFor(slot);
    if (state.official) return null;
    state.providerProvisional = { ...bar, status: 'provisional' };
    return state.start;
  }

  private applyOfficial(bar: Bar, rank: 1 | 2): UnixMs | null {
    const slot = this.exactMinuteSlot(bar.start);
    if (slot === null) return this.ignore();
    if (!this.isRetainable(slot)) {
      this.diag.eventsOutsideRetention++;
      return null;
    }
    const state = this.stateFor(slot);
    const current = state.official;
    if (
      current &&
      (rank < current.rank || (rank === current.rank && bar.revision <= current.bar.revision))
    ) {
      this.diag.staleOfficialBars++;
      return null;
    }
    state.official = { bar: { ...bar, status: 'final' }, rank };
    if (bar.start + MINUTE_MS > this.highWaterMs) this.highWaterMs = bar.start + MINUTE_MS;
    this.diag.acceptedOfficialBars++;
    return state.start;
  }

  private foldBucket(target: TimeScaleMapping, bucket: number): Bar | null {
    const firstValue = this.minuteScale.toSlot(target.slotStart(bucket));
    if (firstValue === null) return null;
    const first = Math.ceil(firstValue);
    if (this.coverageSlot === null || first < this.coverageSlot) {
      this.diag.uncoveredBuckets++;
      return null;
    }
    const minutes: Bar[] = [];
    let allOfficial = true;
    let lastSlot = first;
    for (let slot = first; slot <= this.newestSlot || this.minutes.has(slot); slot++) {
      const start = this.minuteScale.slotStart(slot);
      const inBucket = target.toSlot(start);
      if (inBucket === null || Math.floor(inBucket) !== bucket) break;
      lastSlot = slot;
      const state = this.minutes.get(slot);
      const bar = state ? effectiveBar(state) : null;
      if (!bar) continue;
      if (!state?.official) allOfficial = false;
      minutes.push(bar);
    }
    if (minutes.length === 0) return null;
    const [folded] = aggregateBars({ bars: minutes, sourceDurationMs: MINUTE_MS, target }).bars;
    if (!folded) return null;
    const bucketEndMs = this.minuteScale.slotStart(lastSlot) + MINUTE_MS;
    const ended = this.highWaterMs >= bucketEndMs && this.bucketIsClosed(target, bucket, lastSlot);
    return { ...folded, status: allOfficial && ended ? 'final' : 'provisional' };
  }

  /** The bucket's last minute is its final minute (the next minute belongs to another bucket). */
  private bucketIsClosed(target: TimeScaleMapping, bucket: number, lastSlot: number): boolean {
    const next = target.toSlot(this.minuteScale.slotStart(lastSlot + 1));
    return next === null || Math.floor(next) !== bucket;
  }

  private exactMinuteSlot(start: UnixMs): number | null {
    const slot = this.minuteScale.toSlot(start);
    return slot !== null && Number.isInteger(slot) ? slot : null;
  }

  private isRetainable(slot: number): boolean {
    if (this.coverageSlot !== null && slot < this.coverageSlot) return false;
    return !(slot <= this.newestSlot - this.retention);
  }

  private stateFor(slot: number): MinuteState {
    let state = this.minutes.get(slot);
    if (!state) {
      state = { start: this.minuteScale.slotStart(slot) };
      this.minutes.set(slot, state);
      if (slot > this.newestSlot) this.newestSlot = slot;
      if (slot < this.oldestRetainedSlot) this.oldestRetainedSlot = slot;
    }
    return state;
  }

  /**
   * Drops minutes older than the retention window (batched) and advances coverage accordingly:
   * corrections for pruned minutes are rejected afterwards, never guessed.
   */
  private prune(): void {
    const keepFrom = this.newestSlot - this.retention + 1;
    // Coverage never extends below the retention window, even before minutes are deleted.
    if (this.coverageSlot !== null && this.coverageSlot < keepFrom) this.coverageSlot = keepFrom;
    if (!(this.oldestRetainedSlot < keepFrom - 256)) return;
    for (const slot of [...this.minutes.keys()]) if (slot < keepFrom) this.minutes.delete(slot);
    this.oldestRetainedSlot = keepFrom;
  }

  private nextOpenSlotAtOrAfter(time: UnixMs): number | null {
    // Walk forward minute by minute through closed time (bounded: at most a few days).
    for (let t = time, i = 0; i < 7 * 1440; i++, t += MINUTE_MS) {
      const slot = this.minuteScale.toSlot(t);
      if (slot !== null) return Math.ceil(slot);
    }
    return null;
  }
}

function effectiveBar(state: MinuteState): Bar | null {
  if (state.official) return state.official.bar;
  if (state.providerProvisional) return state.providerProvisional;
  const acc = state.fromTrades;
  if (!acc) return null;
  return {
    start: state.start,
    open: acc.open,
    high: acc.high,
    low: acc.low,
    close: acc.close,
    volume: acc.volume,
    tradeCount: acc.tradeCount,
    status: 'provisional',
    revision: 0,
  };
}

/** (aNs, aSeq) strictly before (bNs, bSeq). */
function isBefore(aNs: EpochNs, aSeq: number, bNs: EpochNs, bSeq: number): boolean {
  const c = compareEpochNs(aNs, bNs);
  return c < 0 || (c === 0 && aSeq < bSeq);
}
