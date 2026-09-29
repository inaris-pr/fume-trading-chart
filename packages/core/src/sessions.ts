import type { InstrumentId } from './primitives.ts';
import type { SessionWindow, TradingSessionSpec } from './instrument.ts';
import type { MarketSession, SessionMode } from './market-data.ts';
import {
  addDays,
  isoWeekday,
  wallTimeMinutes,
  zonedWallTimeToUtc,
  type LocalDate,
} from './time-zone.ts';

export type SessionWindowKind = MarketSession['windows'][number]['kind'];

/** Windows of a session that are open in the given session mode, in time order. */
export function selectWindows(session: MarketSession, mode: SessionMode): MarketSession['windows'] {
  return mode === 'extended'
    ? session.windows
    : session.windows.filter((w) => w.kind === 'regular');
}

interface ResolvedWindow {
  start: number;
  end: number;
  source: 'regular' | 'extended';
  crossesMidnight: boolean;
}

/**
 * Resolves a recurring weekly session spec into concrete sessions for every session date in
 * [from, to] (inclusive, session-timezone calendar dates).
 *
 * This applies the weekly schedule ONLY: no holidays, no early closes. Those come from an
 * exchange calendar (Stage 3/4) and must be applied by the caller before trusting the result.
 *
 * A window whose end is not after its start crosses midnight and belongs to the session date
 * on which it ENDS (futures convention, see SessionWindow).
 */
export function resolveWeeklySessions(args: {
  instrumentId: InstrumentId;
  spec: TradingSessionSpec;
  from: LocalDate;
  to: LocalDate;
}): MarketSession[] {
  const { spec, from, to, instrumentId } = args;
  const byDate = new Map<LocalDate, ResolvedWindow[]>();

  const place = (date: LocalDate, w: SessionWindow, source: ResolvedWindow['source']): void => {
    const crossesMidnight = wallTimeMinutes(w.end) <= wallTimeMinutes(w.start);
    const endDate = crossesMidnight ? addDays(date, 1) : date;
    if (endDate < from || endDate > to) return;
    const resolved: ResolvedWindow = {
      start: zonedWallTimeToUtc(date, w.start, spec.timezone),
      end: zonedWallTimeToUtc(endDate, w.end, spec.timezone),
      source,
      crossesMidnight,
    };
    const list = byDate.get(endDate);
    if (list) list.push(resolved);
    else byDate.set(endDate, [resolved]);
  };

  // Start one day early so windows that begin the evening before `from` are included.
  for (let date = addDays(from, -1); date <= to; date = addDays(date, 1)) {
    const weekday = isoWeekday(date);
    for (const w of spec.regular) if (w.startDay === weekday) place(date, w, 'regular');
    for (const w of spec.extended) if (w.startDay === weekday) place(date, w, 'extended');
  }

  const sessions: MarketSession[] = [];
  for (const sessionDate of [...byDate.keys()].sort()) {
    const resolved = byDate.get(sessionDate)!.sort((a, b) => a.start - b.start);
    const regular = resolved.filter((w) => w.source === 'regular');
    const firstRegularStart = regular[0]?.start ?? Number.POSITIVE_INFINITY;
    const lastRegularEnd = regular[regular.length - 1]?.end ?? Number.NEGATIVE_INFINITY;
    sessions.push({
      instrumentId,
      sessionDate,
      windows: resolved.map((w) => ({
        start: w.start,
        end: w.end,
        kind: classifyWindow(w, firstRegularStart, lastRegularEnd),
      })),
    });
  }
  return sessions;
}

function classifyWindow(
  w: ResolvedWindow,
  firstRegularStart: number,
  lastRegularEnd: number,
): SessionWindowKind {
  if (w.source === 'regular') return 'regular';
  if (w.crossesMidnight) return 'overnight';
  if (w.end <= firstRegularStart) return 'pre';
  if (w.start >= lastRegularEnd) return 'post';
  return 'overnight';
}
