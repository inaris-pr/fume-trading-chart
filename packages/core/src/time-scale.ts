/**
 * Session-aware time axis (ARCHITECTURE §4.1). The chart consumes `TimeScaleMapping` and never
 * computes calendars itself; this module builds a mapping from resolved `MarketSession`s.
 */
import type { UnixMs } from './primitives.ts';
import type { MarketSession, SessionMode } from './market-data.ts';
import { selectWindows } from './sessions.ts';
import { isoWeekStart } from './time-zone.ts';

export type TimeBoundaryKind = 'session' | 'day' | 'week' | 'month' | 'year';

export interface TimeBoundary {
  /** First slot after the boundary. */
  slot: number;
  /**
   * Most significant calendar change at this boundary: year > month > week > day.
   * `session` marks a further open window inside the same session (after a scheduled break).
   */
  kind: TimeBoundaryKind;
}

export interface TimeScaleMapping {
  /**
   * Slot coordinate for a time: integer at a slot start, fractional inside a slot.
   * null when the time lies in compressed (scheduled-closed) time or outside the mapping.
   */
  toSlot(timeMs: UnixMs): number | null;
  /**
   * Start time of slot floor(slot). Valid for any integer; outside the resolved sessions the
   * value is extrapolated with the slot duration (approximate, never used for labels).
   */
  slotStart(slot: number): UnixMs;
  /** Boundaries whose slot lies in [fromSlot, toSlot], ascending. */
  boundaries(fromSlot: number, toSlot: number): readonly TimeBoundary[];
}

/**
 * - intraday: session-aligned buckets of `durationMs` inside each open window; the last bucket of
 *   a window is clipped at the window end (docs/market-data.md).
 * - session: one slot per trading session (daily timeframe).
 */
export type SlotSpec = { kind: 'intraday'; durationMs: number } | { kind: 'session' };

const DAY_MS = 86_400_000;

/** Contiguous run of slots: one open window (intraday) or one session (daily). */
interface Segment {
  start: UnixMs;
  end: UnixMs;
  firstSlot: number;
  slotCount: number;
  kind: TimeBoundaryKind;
}

export function createSessionTimeScale(args: {
  sessions: readonly MarketSession[];
  sessionMode: SessionMode;
  slot: SlotSpec;
}): TimeScaleMapping {
  const { slot } = args;
  if (slot.kind === 'intraday' && !(slot.durationMs > 0)) {
    throw new Error('Intraday slot duration must be positive');
  }
  const segments = buildSegments(args.sessions, args.sessionMode, slot);
  const durationMs = slot.kind === 'intraday' ? slot.durationMs : null;
  const nominalStep = durationMs ?? DAY_MS;
  const totalSlots = segments.reduce((n, s) => n + s.slotCount, 0);

  const toSlot = (timeMs: UnixMs): number | null => {
    const i = lastIndexAtOrBefore(segments, timeMs, (s) => s.start);
    const seg = i >= 0 ? segments[i] : undefined;
    if (!seg || timeMs >= seg.end) return null;
    if (durationMs === null) {
      return seg.firstSlot + (timeMs - seg.start) / (seg.end - seg.start);
    }
    const k = Math.floor((timeMs - seg.start) / durationMs);
    const slotStartMs = seg.start + k * durationMs;
    const slotEndMs = Math.min(slotStartMs + durationMs, seg.end);
    return seg.firstSlot + k + (timeMs - slotStartMs) / (slotEndMs - slotStartMs);
  };

  const slotStart = (slotValue: number): UnixMs => {
    const n = Math.floor(slotValue);
    const first = segments[0];
    const last = segments[segments.length - 1];
    if (!first || !last) return n * nominalStep;
    if (n < 0) return first.start + n * nominalStep;
    if (n >= totalSlots) {
      const lastSlotStart = segmentSlotStart(last, last.slotCount - 1, durationMs);
      return lastSlotStart + (n - (totalSlots - 1)) * nominalStep;
    }
    const i = lastIndexAtOrBefore(segments, n, (s) => s.firstSlot);
    const seg = segments[i]!;
    return segmentSlotStart(seg, n - seg.firstSlot, durationMs);
  };

  const boundaries = (fromSlot: number, toSlotValue: number): TimeBoundary[] => {
    const result: TimeBoundary[] = [];
    const from = Math.ceil(fromSlot);
    for (
      let i = firstIndexAtOrAfter(segments, from, (s) => s.firstSlot);
      i < segments.length;
      i++
    ) {
      const seg = segments[i]!;
      if (seg.firstSlot > toSlotValue) break;
      result.push({ slot: seg.firstSlot, kind: seg.kind });
    }
    return result;
  };

  return { toSlot, slotStart, boundaries };
}

function buildSegments(
  sessions: readonly MarketSession[],
  mode: SessionMode,
  slot: SlotSpec,
): Segment[] {
  const ordered = [...sessions].sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));
  const segments: Segment[] = [];
  let nextSlot = 0;
  let previousDate: string | null = null;
  for (const session of ordered) {
    const windows = selectWindows(session, mode);
    const firstWindow = windows[0];
    const lastWindow = windows[windows.length - 1];
    if (!firstWindow || !lastWindow) continue;
    const dateKind = calendarChangeKind(previousDate, session.sessionDate);
    previousDate = session.sessionDate;

    if (slot.kind === 'session') {
      segments.push({
        start: firstWindow.start,
        end: lastWindow.end,
        firstSlot: nextSlot,
        slotCount: 1,
        kind: dateKind,
      });
      nextSlot += 1;
      continue;
    }
    windows.forEach((w, index) => {
      const slotCount = Math.ceil((w.end - w.start) / slot.durationMs);
      if (slotCount <= 0) return;
      segments.push({
        start: w.start,
        end: w.end,
        firstSlot: nextSlot,
        slotCount,
        kind: index === 0 ? dateKind : 'session',
      });
      nextSlot += slotCount;
    });
  }
  return segments;
}

function calendarChangeKind(previous: string | null, current: string): TimeBoundaryKind {
  if (previous === null) return 'day';
  if (previous.slice(0, 4) !== current.slice(0, 4)) return 'year';
  if (previous.slice(0, 7) !== current.slice(0, 7)) return 'month';
  if (isoWeekStart(previous) !== isoWeekStart(current)) return 'week';
  return 'day';
}

function segmentSlotStart(seg: Segment, offset: number, durationMs: number | null): UnixMs {
  return durationMs === null ? seg.start : seg.start + offset * durationMs;
}

/** Index of the last item whose key is <= value, or -1. Items are sorted by key. */
function lastIndexAtOrBefore<T>(items: readonly T[], value: number, key: (t: T) => number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]!) <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Index of the first item whose key is >= value, or items.length. */
function firstIndexAtOrAfter<T>(items: readonly T[], value: number, key: (t: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]!) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
