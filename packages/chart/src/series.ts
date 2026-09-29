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
