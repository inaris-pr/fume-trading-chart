/**
 * Provider-neutral canonical HISTORY helpers (docs/market-data.md, "Historical canonical candles").
 *
 * A backend fetches provider BASE bars (e.g. 1m/5m/15m) and turns them into canonical,
 * session-aligned candles with the same TimeScaleMapping + aggregateBars used everywhere else.
 * Nothing here knows about a specific provider or market: base-interval choice, bucket ends and
 * candle status follow only from the resolved MarketSessions and the timeframe.
 */
import { aggregateBars } from './aggregate.ts';
import type { Bar, MarketSession, SessionMode, TimeframeId } from './market-data.ts';
import type { UnixMs } from './primitives.ts';
import { selectWindows } from './sessions.ts';
import { createSessionTimeScale, slotSpecForTimeframe } from './time-scale.ts';

const MINUTE = 60_000;

/**
 * True when epoch-aligned base bars of `baseMinutes` nest exactly into the canonical buckets of
 * `timeframe`: every canonical bucket boundary (each selected window's start and end, and every
 * intraday bucket boundary inside it) is a multiple of the base interval since the Unix epoch.
 * Then no base bar can straddle a canonical boundary.
 */
export function nestsExactly(
  baseMinutes: number,
  timeframe: TimeframeId,
  sessions: readonly MarketSession[],
  mode: SessionMode,
): boolean {
  if (!Number.isInteger(baseMinutes) || baseMinutes < 1) return false;
  const baseMs = baseMinutes * MINUTE;
  const slot = slotSpecForTimeframe(timeframe);
  if (slot.kind === 'intraday' && slot.durationMs % baseMs !== 0) return false;
  for (const session of sessions) {
    for (const w of selectWindows(session, mode)) {
      if (w.start % baseMs !== 0 || w.end % baseMs !== 0) return false;
    }
  }
  return true;
}

/**
 * Coarsest provider-native interval that nests exactly (see nestsExactly) for these sessions, or
 * 1 minute when none does. `native` must contain 1; order does not matter.
 */
export function selectBaseInterval(
  native: readonly number[],
  timeframe: TimeframeId,
  sessions: readonly MarketSession[],
  mode: SessionMode,
): number {
  if (!native.includes(1)) throw new Error('A provider must serve 1-minute base bars');
  const candidates = [...native].sort((a, b) => b - a);
  for (const minutes of candidates) {
    if (nestsExactly(minutes, timeframe, sessions, mode)) return minutes;
  }
  return 1;
}

/**
 * End (exclusive) of the canonical bucket that starts at `start`, or null when `start` is not in
 * a selected window (intraday: min(start + duration, window end); daily: the session's last
 * selected window end).
 */
export function canonicalBucketEnd(
  start: UnixMs,
  timeframe: TimeframeId,
  sessions: readonly MarketSession[],
  mode: SessionMode,
): UnixMs | null {
  return bucketEndLookup(timeframe, sessions, mode)(start);
}

/** Binary-searchable version of canonicalBucketEnd for many lookups over the same sessions. */
function bucketEndLookup(
  timeframe: TimeframeId,
  sessions: readonly MarketSession[],
  mode: SessionMode,
): (start: UnixMs) => UnixMs | null {
  const slot = slotSpecForTimeframe(timeframe);
  const windows: { start: number; end: number; sessionEnd: number }[] = [];
  for (const session of sessions) {
    const selected = selectWindows(session, mode);
    const sessionEnd = selected[selected.length - 1]?.end;
    if (sessionEnd === undefined) continue;
    for (const w of selected) windows.push({ start: w.start, end: w.end, sessionEnd });
  }
  windows.sort((a, b) => a.start - b.start);
  return (start) => {
    let lo = 0;
    let hi = windows.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (windows[mid]!.start <= start) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const w = windows[found];
    if (!w || start >= w.end) return null;
    return slot.kind === 'session' ? w.sessionEnd : Math.min(start + slot.durationMs, w.end);
  };
}

/**
 * Number of canonical buckets of `timeframe` in the selected windows of `session` that start
 * before `before` (exclusive). Used to decide how many sessions a page of N candles needs.
 */
export function canonicalSlotsBefore(
  session: MarketSession,
  timeframe: TimeframeId,
  mode: SessionMode,
  before: UnixMs,
): number {
  const windows = selectWindows(session, mode);
  const slot = slotSpecForTimeframe(timeframe);
  if (slot.kind === 'session') return windows[0] && windows[0].start < before ? 1 : 0;
  let n = 0;
  for (const w of windows) {
    const end = Math.min(w.end, before);
    if (end > w.start) n += Math.ceil((end - w.start) / slot.durationMs);
  }
  return n;
}

export interface CanonicalHistoryOptions {
  /** Provider base bars, strictly ascending, each `baseIntervalMinutes` long and epoch-aligned. */
  baseBars: readonly Bar[];
  baseIntervalMinutes: number;
  /** Sessions covering every base bar that should be kept (others are dropped as outside). */
  sessions: readonly MarketSession[];
  timeframe: TimeframeId;
  mode: SessionMode;
  /** Server "now". A canonical bucket that has not ended by then is provisional. */
  asOf: UnixMs;
}

export interface CanonicalHistoryResult {
  bars: Bar[];
  /** Base bars outside every selected window (e.g. extended hours in regular mode). */
  droppedOutsideSession: number;
}

/**
 * Builds canonical candles from base bars with the shared TimeScaleMapping + aggregateBars (no
 * second copy of candle math), then applies the history status rule: a candle is `final` only if
 * its bucket has ENDED at `asOf` AND every base bar folded into it is final. No bars are
 * fabricated for missing or future base intervals. A base bar that straddles a canonical boundary
 * throws (configuration error), exactly as aggregateBars does.
 */
export function buildCanonicalBars(options: CanonicalHistoryOptions): CanonicalHistoryResult {
  const { baseBars, baseIntervalMinutes, sessions, timeframe, mode, asOf } = options;
  const target = createSessionTimeScale({
    sessions,
    sessionMode: mode,
    slot: slotSpecForTimeframe(timeframe),
  });
  const result = aggregateBars({
    bars: baseBars,
    sourceDurationMs: baseIntervalMinutes * MINUTE,
    target,
  });
  const bucketEnd = bucketEndLookup(timeframe, sessions, mode);
  const bars = result.bars.map((bar) => {
    if (bar.status !== 'final') return bar;
    const end = bucketEnd(bar.start);
    return end !== null && end <= asOf ? bar : { ...bar, status: 'provisional' as const };
  });
  return { bars, droppedOutsideSession: result.droppedOutsideSession };
}
