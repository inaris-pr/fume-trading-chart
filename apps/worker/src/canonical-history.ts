/**
 * Canonical history pages for GET /api/v1/bars (docs/market-data.md). Provider-neutral: it only
 * uses the HistoricalMarketDataProvider port and @fume/core. The canonical candle math itself is
 * core's buildCanonicalBars (TimeScaleMapping + aggregateBars); this module only plans which
 * sessions and base bars a page of N candles needs, with bounded provider calls.
 *
 * Paging contract: bars ascending, `end` exclusive, the client asks for older data with
 * end = bars[0].start. Provider page tokens never leave the adapter.
 */
import {
  buildCanonicalBars,
  canonicalSlotsBefore,
  selectBaseInterval,
  selectWindows,
  type Bar,
  type HistoricalMarketDataProvider,
  type Instrument,
  type MarketSession,
  type SessionMode,
  type TimeframeId,
  type UnixMs,
} from '@fume/core';

const DAY = 86_400_000;
const MINUTE = 60_000;
/** Calendar look-back attempts before giving up on filling `limit` (each widens the range). */
const MAX_CALENDAR_ATTEMPTS = 4;
/** Upper bound on base bars fetched for one page (bounds provider pages and Worker memory). */
export const MAX_BASE_BARS = 60_000;

export interface CanonicalPageRequest {
  provider: HistoricalMarketDataProvider;
  instrument: Instrument;
  timeframe: TimeframeId;
  mode: SessionMode;
  /** Exclusive upper bound on candle start; omitted = latest (includes the in-progress bucket). */
  end?: UnixMs;
  limit: number;
  now: UnixMs;
  /** Oldest time the provider serves history for (e.g. IEX on Basic: 2016). */
  historyFloor: UnixMs;
  signal?: AbortSignal;
}

export interface CanonicalPage {
  bars: Bar[];
  hasMore: boolean;
  diagnostics: {
    baseIntervalMinutes: number | null;
    baseBars: number;
    sessions: number;
    droppedOutsideSession: number;
    truncated: boolean;
  };
}

export async function loadCanonicalPage(request: CanonicalPageRequest): Promise<CanonicalPage> {
  const { provider, instrument, timeframe, mode, limit, now, historyFloor } = request;
  const end = request.end ?? now + 1;
  const empty = (hasMore: boolean): CanonicalPage => ({
    bars: [],
    hasMore,
    diagnostics: {
      baseIntervalMinutes: null,
      baseBars: 0,
      sessions: 0,
      droppedOutsideSession: 0,
      truncated: false,
    },
  });
  if (end <= historyFloor) return empty(false);

  // 1. Newest sessions (before `end`) whose canonical slots cover `limit` candles.
  const { sessions, reachedFloor } = await sessionsForLimit(request, end);
  if (sessions.length === 0) return empty(!reachedFloor);
  const from = firstWindowStart(sessions, mode);

  // 2. Coarsest verified native interval that nests exactly for these sessions.
  const baseMinutes = selectBaseInterval(
    provider.nativeIntervalsMinutes,
    timeframe,
    sessions,
    mode,
  );

  // 3. One ranged base-bar fetch: [first session start, end). Providers may also return bars
  //    outside the selected windows (e.g. pre/post-market), so the limit is sized on the
  //    wall-clock span; those bars are dropped by the canonical fold.
  const spanBars = Math.ceil((end - from) / (baseMinutes * MINUTE));
  const page = await provider.getBars({
    instrument,
    intervalMinutes: baseMinutes,
    start: from,
    end,
    limit: Math.min(MAX_BASE_BARS, spanBars + 16),
    ...(request.signal ? { signal: request.signal } : {}),
  });

  // 4. Canonical candles (core), newest `limit` before `end`.
  const built = buildCanonicalBars({
    baseBars: page.bars,
    baseIntervalMinutes: baseMinutes,
    sessions,
    timeframe,
    mode,
    asOf: now,
  });
  // A truncated fetch (provider limit or page cap) is missing the OLDEST base bars. A canonical
  // bucket that starts before the oldest fetched base bar may be incomplete, so it is dropped:
  // never return a partial candle. The client pages on from the oldest candle returned.
  const oldestBase = page.bars[0]?.start;
  const truncated = page.hasMore && oldestBase !== undefined && oldestBase > from;
  const complete = truncated ? built.bars.filter((b) => b.start >= oldestBase) : built.bars;
  const bars = complete.filter((b) => b.start < end).slice(-limit);
  return {
    bars,
    // Older history may exist whenever the fetch was truncated or did not reach the floor.
    hasMore: truncated || (!reachedFloor && from > historyFloor),
    diagnostics: {
      baseIntervalMinutes: baseMinutes,
      baseBars: page.bars.length,
      sessions: sessions.length,
      droppedOutsideSession: built.droppedOutsideSession,
      truncated,
    },
  };
}

/**
 * Walks the calendar backwards from `end` until the selected sessions hold at least `limit`
 * canonical slots before `end`, or the history floor is reached. The first guess is a month; each
 * further attempt scales the range by the observed slots per calendar day.
 */
async function sessionsForLimit(
  request: CanonicalPageRequest,
  end: UnixMs,
): Promise<{ sessions: MarketSession[]; reachedFloor: boolean }> {
  const { provider, instrument, timeframe, mode, limit, historyFloor } = request;
  let days = 31;
  for (let attempt = 1; ; attempt++) {
    const from = Math.max(historyFloor, end - days * DAY);
    const all = await provider.getSessions(instrument, from, end);
    const candidates = [...all]
      .filter((s) => {
        const first = selectWindows(s, mode)[0];
        return first !== undefined && first.start < end && first.start >= historyFloor;
      })
      .sort((a, b) => a.sessionDate.localeCompare(b.sessionDate));

    const picked: MarketSession[] = [];
    let slots = 0;
    for (let i = candidates.length - 1; i >= 0 && slots < limit; i--) {
      const session = candidates[i]!;
      slots += canonicalSlotsBefore(session, timeframe, mode, end);
      picked.unshift(session);
    }
    const reachedFloor = from <= historyFloor;
    if (slots >= limit || reachedFloor || attempt >= MAX_CALENDAR_ATTEMPTS) {
      return { sessions: picked, reachedFloor: reachedFloor && slots < limit };
    }
    const perDay = slots / days;
    days = perDay > 0 ? Math.ceil((limit / perDay) * 1.2) + 7 : days * 4;
  }
}

function firstWindowStart(sessions: readonly MarketSession[], mode: SessionMode): UnixMs {
  return Math.min(...sessions.map((s) => selectWindows(s, mode)[0]?.start ?? Infinity));
}
