/**
 * Historical -> live handoff (docs/market-data.md, "Historical -> live handoff").
 *
 * Sequence the host follows (identical for replay now and a real provider later):
 *   1. subscribe and BUFFER incoming market events;
 *   2. load historical canonical bars for the displayed timeframe;
 *   3. load the official 1m bars covering the current canonical bucket(s) (the seed);
 *   4. applyBufferedHandoff(): seed, then buffered bar events, then buffered trades;
 *   5. mergeCanonicalBars(history, aggregator.foldBuckets(...)) and go live.
 * Upserts are keyed by bar start, so overlap between history, seed and buffer is harmless.
 */
import type { Bar, MarketEvent } from '../market-data.ts';
import type { UnixMs } from '../primitives.ts';
import type { LiveCandleAggregator } from './live-aggregator.ts';

/**
 * Applies the seed and the buffered events in the documented order: official minute bars first
 * (seed, then buffered final/revised/provisional bars in arrival order), then buffered trades in
 * arrival order. Trades for minutes that are already official are ignored by the aggregator.
 * Returns the starts of all minutes that changed.
 */
export function applyBufferedHandoff(
  aggregator: LiveCandleAggregator,
  args: {
    seedMinutes: readonly Bar[];
    /** Minute data is complete from here (default: first seed minute). */
    coverageFrom?: UnixMs;
    buffered: readonly MarketEvent[];
  },
): UnixMs[] {
  const changed = new Set<UnixMs>(
    aggregator.seedOfficialMinutes(args.seedMinutes, args.coverageFrom),
  );
  const bars = args.buffered.filter((e) => e.kind === 'bar');
  const rest = args.buffered.filter((e) => e.kind !== 'bar');
  for (const start of aggregator.apply(bars)) changed.add(start);
  for (const start of aggregator.apply(rest)) changed.add(start);
  return [...changed].sort((a, b) => a - b);
}

/**
 * Merges canonical upserts into an ascending bar list by `start`: equal starts are replaced,
 * new starts are inserted in order. Pure; never produces duplicate starts.
 */
export function mergeCanonicalBars(existing: readonly Bar[], upserts: readonly Bar[]): Bar[] {
  if (upserts.length === 0) return [...existing];
  const byStart = new Map<UnixMs, Bar>();
  for (const bar of existing) byStart.set(bar.start, bar);
  for (const bar of upserts) byStart.set(bar.start, bar);
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}
