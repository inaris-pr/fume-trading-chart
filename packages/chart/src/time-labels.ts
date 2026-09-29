/**
 * Chooses time-axis labels and session separators from the injected TimeScaleMapping.
 * No calendar knowledge here: calendar changes come from mapping.boundaries(), times of day are
 * reached by stepping whole slots from a boundary (slots are session-aligned).
 */
import type {
  TimeBoundary,
  TimeBoundaryKind,
  TimeFormatter,
  TimeLabelGranularity,
  TimeScaleMapping,
} from '@fume/core';
import type { Viewport } from './viewport.ts';

export interface TimeLabel {
  slot: number;
  /** Slot center, CSS px. */
  x: number;
  text: string;
  /** 0 for times of day, 1..5 for session/day/week/month/year boundaries. */
  rank: number;
}

export interface TimeAxisModel {
  labels: TimeLabel[];
  /** x (CSS px) of separator lines between sessions, placed between slots. */
  separators: number[];
  /** Detected slot duration in ms, or null for session (daily) slots. */
  slotDurationMs: number | null;
}

const RANK: Record<TimeBoundaryKind, number> = { session: 1, day: 2, week: 3, month: 4, year: 5 };
const GRANULARITY: Record<TimeBoundaryKind, TimeLabelGranularity> = {
  session: 'time',
  day: 'day',
  week: 'day',
  month: 'month',
  year: 'year',
};

/** Label steps, in minutes of wall time, used between boundaries on intraday slots. */
const NICE_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720] as const;
/** Slots are "intraday" if shorter than this; longer slots are session (daily) slots. */
const INTRADAY_LIMIT_MS = 20 * 3_600_000;
/** How far left to look for the boundary that precedes the visible range. */
const LOOKBACK_SLOTS = 3000;

export function buildTimeAxis(args: {
  mapping: TimeScaleMapping;
  viewport: Viewport;
  formatTime: TimeFormatter;
  minLabelSpacing: number;
  /** Labels whose center is closer than this to a plot edge are dropped. */
  edgeMargin: number;
}): TimeAxisModel {
  const { mapping, viewport, formatTime, minLabelSpacing, edgeMargin } = args;
  const { from, to } = viewport.visibleSlots();
  if (from > to) return { labels: [], separators: [], slotDurationMs: null };

  const boundaries = mapping.boundaries(from - LOOKBACK_SLOTS, to);
  const slotDurationMs = detectSlotDuration(mapping, boundaries, from);
  const spacing = viewport.barSpacing;
  const left = viewport.plotLeft + edgeMargin;
  const right = viewport.plotLeft + viewport.plotWidth - edgeMargin;

  const candidates: { slot: number; rank: number; granularity: TimeLabelGranularity }[] = [];
  for (const b of boundaries) {
    if (b.slot >= from && b.slot <= to) {
      candidates.push({ slot: b.slot, rank: RANK[b.kind], granularity: GRANULARITY[b.kind] });
    }
  }

  const step =
    slotDurationMs === null ? null : intradayStep(slotDurationMs, spacing, minLabelSpacing);
  if (step !== null) {
    boundaries.forEach((b, i) => {
      const next = boundaries[i + 1]?.slot ?? Number.POSITIVE_INFINITY;
      const first = b.slot + Math.max(step, Math.ceil((from - b.slot) / step) * step);
      for (let s = first; s < next && s <= to; s += step) {
        candidates.push({ slot: s, rank: 0, granularity: 'time' });
      }
    });
  }

  // Most significant first; within a rank, left to right. Keep labels that do not collide.
  candidates.sort((a, b) => b.rank - a.rank || a.slot - b.slot);
  const accepted: TimeLabel[] = [];
  for (const c of candidates) {
    const x = viewport.slotToX(c.slot);
    if (x < left || x > right) continue;
    if (accepted.some((l) => Math.abs(l.x - x) < minLabelSpacing)) continue;
    accepted.push({
      slot: c.slot,
      x,
      text: formatTime(mapping.slotStart(c.slot), c.granularity),
      rank: c.rank,
    });
  }
  accepted.sort((a, b) => a.slot - b.slot);

  const separators =
    slotDurationMs === null
      ? []
      : boundaries
          .filter((b) => b.slot > from && b.slot <= to)
          .map((b) => viewport.slotToX(b.slot) - spacing / 2);

  return { labels: accepted, separators, slotDurationMs };
}

/**
 * Smallest slot difference between consecutive slot starts near the view. Differences across a
 * closed period are large, so the minimum is the bucket duration. null => session slots.
 */
function detectSlotDuration(
  mapping: TimeScaleMapping,
  boundaries: readonly TimeBoundary[],
  from: number,
): number | null {
  const probes = [from, ...boundaries.slice(-2).map((b) => b.slot)];
  let min = Number.POSITIVE_INFINITY;
  for (const p of probes) {
    for (let s = p; s < p + 3; s++) {
      const d = mapping.slotStart(s + 1) - mapping.slotStart(s);
      if (d > 0 && d < min) min = d;
    }
  }
  return Number.isFinite(min) && min < INTRADAY_LIMIT_MS ? min : null;
}

/** Whole-slot label step whose wall-time length is a nice number of minutes and fits spacing. */
function intradayStep(slotMs: number, barSpacing: number, minLabelSpacing: number): number | null {
  const slotMinutes = slotMs / 60_000;
  for (const minutes of NICE_MINUTES) {
    const slots = minutes / slotMinutes;
    if (!Number.isInteger(slots) || slots < 1) continue;
    if (slots * barSpacing >= minLabelSpacing) return slots;
  }
  return null;
}
