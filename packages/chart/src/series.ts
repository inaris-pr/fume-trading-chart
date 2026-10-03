/**
 * Maps bars onto time-scale slots once per data change, so each frame only binary-searches.
 */
import type { Bar, TimeScaleMapping } from '@fume/core';

export interface IndexedSeries {
  /** Bars that map to an open slot, in ascending slot order. */
  readonly bars: readonly Bar[];
  /** slots[i] is the slot of bars[i]. */
  readonly slots: Float64Array;
  /** Bars dropped because their time is in compressed time or outside the mapping. */
  readonly unmappedCount: number;
}

export function indexSeries(bars: readonly Bar[], mapping: TimeScaleMapping): IndexedSeries {
  const kept: Bar[] = [];
  const slotList: number[] = [];
  let unmapped = 0;
  let lastSlot = Number.NEGATIVE_INFINITY;
  for (const bar of bars) {
    const slot = mapping.toSlot(bar.start);
    if (slot === null) {
      unmapped++;
      continue;
    }
    if (slot <= lastSlot) {
      throw new Error(
        `Bars must be in strictly ascending time order with one bar per slot (bar at ${bar.start})`,
      );
    }
    kept.push(bar);
    slotList.push(slot);
    lastSlot = slot;
  }
  return { bars: kept, slots: Float64Array.from(slotList), unmappedCount: unmapped };
}

/** Half-open index range [from, to) of bars whose slot lies in [fromSlot, toSlot]. */
export function visibleIndexRange(
  slots: Float64Array,
  fromSlot: number,
  toSlot: number,
): { from: number; to: number } {
  return {
    from: firstIndexWhere(slots, (s) => s >= fromSlot),
    to: firstIndexWhere(slots, (s) => s > toSlot),
  };
}

/** First index whose value satisfies a monotone predicate (false...false true...true). */
function firstIndexWhere(values: Float64Array, predicate: (value: number) => boolean): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (predicate(values[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** A series the chart owns and updates incrementally. */
export interface MutableSeries {
  bars: Bar[];
  slots: Float64Array;
  unmappedCount: number;
}

export function toMutableSeries(series: IndexedSeries): MutableSeries {
  return { bars: [...series.bars], slots: series.slots, unmappedCount: series.unmappedCount };
}

/** Index of the bar whose slot equals `slot` exactly, or -1 (binary search). */
export function exactSlotIndex(slots: Float64Array, slot: number): number {
  let lo = 0;
  let hi = slots.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = slots[mid]!;
    if (value === slot) return mid;
    if (value < slot) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export interface MergeResult {
  replaced: number;
  appended: number;
  inserted: number;
  unmapped: number;
}

/** MergeResult plus the earliest bar position whose bar changed (internal: indicator invalidation). */
export interface MergeOutcome extends MergeResult {
  /** Position of the first replaced/inserted/appended bar; the series length when nothing changed. */
  firstChanged: number;
}

/**
 * Merges bars into the series by slot (i.e. by canonical start time):
 * - a bar whose slot already exists replaces it in place (O(log n), no allocation);
 * - bars after the last slot are appended (one allocation for the batch);
 * - anything else (older bars, gap fills) triggers one ordered rebuild of the series.
 * Within one batch, a later bar with the same start wins.
 */
export function mergeIntoSeries(
  series: MutableSeries,
  bars: readonly Bar[],
  mapping: TimeScaleMapping,
): MergeOutcome {
  const result: MergeOutcome = {
    replaced: 0,
    appended: 0,
    inserted: 0,
    unmapped: 0,
    firstChanged: series.bars.length,
  };
  const additions = new Map<number, Bar>();
  for (const bar of bars) {
    const slot = mapping.toSlot(bar.start);
    if (slot === null) {
      result.unmapped++;
      continue;
    }
    const index = exactSlotIndex(series.slots, slot);
    if (index >= 0) {
      series.bars[index] = bar;
      result.replaced++;
      result.firstChanged = Math.min(result.firstChanged, index);
    } else {
      additions.set(slot, bar);
    }
  }
  series.unmappedCount += result.unmapped;
  if (additions.size === 0) return result;

  const added = [...additions.entries()].sort((a, b) => a[0] - b[0]);
  const last = series.slots.length > 0 ? series.slots[series.slots.length - 1]! : -Infinity;
  if (added[0]![0] > last) {
    const slots = new Float64Array(series.slots.length + added.length);
    slots.set(series.slots);
    added.forEach(([slot, bar], i) => {
      slots[series.slots.length + i] = slot;
      series.bars.push(bar);
    });
    result.firstChanged = Math.min(result.firstChanged, series.slots.length);
    series.slots = slots;
    result.appended = added.length;
    return result;
  }

  // Everything from the first inserted position on moved or changed.
  const firstInserted = firstIndexAtOrAbove(series.slots, added[0]![0]);
  result.firstChanged = Math.min(result.firstChanged, firstInserted);
  const merged: [number, Bar][] = series.bars.map((bar, i) => [series.slots[i]!, bar]);
  merged.push(...added);
  merged.sort((a, b) => a[0] - b[0]);
  series.bars = merged.map(([, bar]) => bar);
  series.slots = Float64Array.from(merged, ([slot]) => slot);
  result.inserted = added.length;
  return result;
}

/** Number of slots below `slot` (= the position `slot` takes when inserted). */
function firstIndexAtOrAbove(slots: Float64Array, slot: number): number {
  return firstIndexWhere(slots, (s) => s >= slot);
}
