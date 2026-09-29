/**
 * Deterministic, provider-neutral canonical candle aggregation (docs/market-data.md).
 *
 * Buckets are defined by the TARGET TimeScaleMapping, the same object the chart uses for its
 * axis, so candles and axis slots can never disagree. Session-aligned buckets, the short final
 * bucket of a window (e.g. 1h 15:30-16:00), early closes and scheduled breaks all follow from the
 * sessions the mapping was built from.
 */
import type { Bar } from './market-data.ts';
import type { TimeScaleMapping } from './time-scale.ts';

export interface AggregateOptions {
  /** Lower-timeframe bars, strictly ascending by `start`. */
  bars: readonly Bar[];
  /** Duration of each input bar (e.g. 60_000 for 1m). Used to reject bars that straddle a bucket. */
  sourceDurationMs: number;
  /** Mapping for the TARGET timeframe (intraday or session slots) and session mode. */
  target: TimeScaleMapping;
}

export interface AggregateResult {
  bars: Bar[];
  /** Input bars outside every open window of the target mapping (e.g. extended hours in regular mode). */
  droppedOutsideSession: number;
}

/**
 * Folds lower-timeframe bars into canonical target buckets:
 * open = first open, high = max, low = min, close = last close, volume = sum.
 * tradeCount / vwap are kept only when every input bar has them. `status` is final only if every
 * input is final. Empty buckets produce no bar; bars are never merged across buckets, windows or
 * sessions.
 */
export function aggregateBars(options: AggregateOptions): AggregateResult {
  const { bars, sourceDurationMs, target } = options;
  if (!(sourceDurationMs > 0)) throw new Error('sourceDurationMs must be positive');

  const out: Bar[] = [];
  let dropped = 0;
  let current: Accumulator | null = null;
  let previousStart = Number.NEGATIVE_INFINITY;

  for (const bar of bars) {
    if (bar.start <= previousStart) {
      throw new Error(`Input bars must be strictly ascending (bar at ${bar.start})`);
    }
    previousStart = bar.start;

    const slot = target.toSlot(bar.start);
    if (slot === null) {
      dropped++;
      continue;
    }
    const bucket = Math.floor(slot);
    const lastInstant = target.toSlot(bar.start + sourceDurationMs - 1);
    if (lastInstant === null || Math.floor(lastInstant) !== bucket) {
      throw new Error(
        `Source bar at ${bar.start} (${sourceDurationMs} ms) straddles a target bucket boundary; ` +
          'the source timeframe does not nest in the target buckets',
      );
    }

    if (current && current.bucket === bucket) {
      merge(current, bar);
    } else {
      if (current) out.push(finish(current));
      current = start(bucket, target.slotStart(bucket), bar);
    }
  }
  if (current) out.push(finish(current));
  return { bars: out, droppedOutsideSession: dropped };
}

interface Accumulator {
  bucket: number;
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradeCount: number | undefined;
  vwapNumerator: number | undefined;
  allFinal: boolean;
}

function start(bucket: number, bucketStart: number, bar: Bar): Accumulator {
  return {
    bucket,
    start: bucketStart,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    tradeCount: bar.tradeCount,
    vwapNumerator: bar.vwap === undefined ? undefined : bar.vwap * bar.volume,
    allFinal: bar.status === 'final',
  };
}

function merge(acc: Accumulator, bar: Bar): void {
  if (bar.high > acc.high) acc.high = bar.high;
  if (bar.low < acc.low) acc.low = bar.low;
  acc.close = bar.close;
  acc.volume += bar.volume;
  acc.tradeCount =
    acc.tradeCount === undefined || bar.tradeCount === undefined
      ? undefined
      : acc.tradeCount + bar.tradeCount;
  acc.vwapNumerator =
    acc.vwapNumerator === undefined || bar.vwap === undefined
      ? undefined
      : acc.vwapNumerator + bar.vwap * bar.volume;
  acc.allFinal &&= bar.status === 'final';
}

function finish(acc: Accumulator): Bar {
  return {
    start: acc.start,
    open: acc.open,
    high: acc.high,
    low: acc.low,
    close: acc.close,
    volume: acc.volume,
    ...(acc.tradeCount !== undefined ? { tradeCount: acc.tradeCount } : {}),
    ...(acc.vwapNumerator !== undefined && acc.volume > 0
      ? { vwap: acc.vwapNumerator / acc.volume }
      : {}),
    status: acc.allFinal ? 'final' : 'provisional',
    revision: 0,
  };
}
