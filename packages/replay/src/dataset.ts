/**
 * Deterministic replay dataset: calendar, 1-minute history and a live event tape per symbol.
 *
 * Timeline (market time, America/New_York):
 * - data sessions: Mon 2026-02-02 .. Mon 2026-09-28 (171 weekday RTH sessions, no holidays);
 * - the calendar continues 8 weeks further (future sessions, no data);
 * - REPLAY_START = Fri 2026-09-25 14:00 ET. Minutes before it are history; from it on, each minute
 *   is replayed as trades, then its official final bar (and for some minutes a later revision).
 *
 * The official final bar of a replayed minute equals the minute built from its trades, except in
 * deliberate edge cases: an excluded odd-lot trade, an out-of-order pair, a duplicate delivery,
 * a revised bar that adds late volume, and empty minutes (no trades, no bar).
 */
import {
  addDays,
  addNs,
  createSessionTimeScale,
  epochMsToNs,
  eventTimeFromNs,
  resolveWeeklySessions,
  slotSpecForTimeframe,
  type Bar,
  type Instrument,
  type InstrumentId,
  type MarketEvent,
  type MarketSession,
  type TimeScaleMapping,
  type Trade,
} from '@fume/core';
import { createRng, generateSyntheticBars } from '@fume/core/fixtures';
import {
  isReplaySymbol,
  REPLAY_INSTRUMENTS,
  US_EQUITY_SESSION,
  type ReplaySymbol,
} from './instruments.ts';

export const FIRST_SESSION_DATE = '2026-02-02';
/** Last session with data (a Monday, so the replay crosses a weekend-free session rollover). */
export const LAST_DATA_SESSION_DATE = '2026-09-28';
const CALENDAR_END_DATE = addDays(LAST_DATA_SESSION_DATE, 8 * 7);
/** Fri 2026-09-25 14:00 America/New_York (EDT, UTC-4). */
export const REPLAY_START_MS = Date.UTC(2026, 8, 25, 18, 0);

const MINUTE = 60_000;
const PER_SESSION = 390;
/** Official final bars are published this long after the minute ends. */
export const FINAL_BAR_DELAY_MS = 800;
/** Revised bars (late trade corrections) are published this long after the minute ends. */
export const REVISED_BAR_DELAY_MS = 30_000;

/** One tape entry: an event and the market time at which the replay emits it. */
export interface TapeEntry {
  emitMs: number;
  event: MarketEvent;
}

interface SymbolData {
  instrument: Instrument;
  /** Official minute bars (revision 0) for every data session. */
  minutes: Bar[];
  /** Revised minute bars and when they are published. */
  revisions: Map<number, { bar: Bar; emitMs: number }>;
  /** Live events from REPLAY_START, ascending by emit time (stable). */
  tape: TapeEntry[];
}

/** Builds and caches per-symbol data. One instance per app/provider; no module-level state. */
export class ReplayDataset {
  /** Resolved sessions for the whole calendar (data + future). */
  readonly calendar: readonly MarketSession[];
  /** Sessions that have data. */
  readonly dataSessions: readonly MarketSession[];
  readonly replayStartMs = REPLAY_START_MS;
  private readonly bySymbol = new Map<ReplaySymbol, SymbolData>();
  private readonly minuteScale: TimeScaleMapping;

  constructor() {
    this.calendar = resolveWeeklySessions({
      instrumentId: 'eq:REPLAY' as InstrumentId,
      spec: US_EQUITY_SESSION,
      from: FIRST_SESSION_DATE,
      to: CALENDAR_END_DATE,
    });
    this.dataSessions = this.calendar.filter((s) => s.sessionDate <= LAST_DATA_SESSION_DATE);
    this.minuteScale = createSessionTimeScale({
      sessions: this.dataSessions,
      sessionMode: 'regular',
      slot: slotSpecForTimeframe('1m'),
    });
  }

  instrument(symbol: string): Instrument | null {
    return isReplaySymbol(symbol) ? REPLAY_INSTRUMENTS[symbol].instrument : null;
  }

  symbolFor(instrumentId: InstrumentId): ReplaySymbol | null {
    const symbol = instrumentId.startsWith('eq:') ? instrumentId.slice(3) : '';
    return isReplaySymbol(symbol) ? symbol : null;
  }

  /** Calendar sessions (with the given instrument id) overlapping [from, to]. */
  sessionsFor(instrumentId: InstrumentId, from: number, to: number): MarketSession[] {
    return this.calendar
      .filter((s) => s.windows.some((w) => w.end > from && w.start <= to))
      .map((s) => ({ ...s, instrumentId }));
  }

  /** Official revision-0 minute bars for every data session (the static history view). */
  minuteBars(symbol: ReplaySymbol): readonly Bar[] {
    return this.data(symbol).minutes;
  }

  /** The minute bar the provider reports as history at market time `nowMs` (revised if published). */
  officialMinute(symbol: ReplaySymbol, bar: Bar, nowMs: number): Bar {
    const revised = this.data(symbol).revisions.get(bar.start);
    return revised && revised.emitMs <= nowMs ? revised.bar : bar;
  }

  revisions(symbol: ReplaySymbol): ReadonlyMap<number, { bar: Bar; emitMs: number }> {
    return this.data(symbol).revisions;
  }

  tape(symbol: ReplaySymbol): readonly TapeEntry[] {
    return this.data(symbol).tape;
  }

  private data(symbol: ReplaySymbol): SymbolData {
    let data = this.bySymbol.get(symbol);
    if (!data) {
      data = buildSymbolData(symbol, this.dataSessions, this.minuteScale);
      this.bySymbol.set(symbol, data);
    }
    return data;
  }
}

/**
 * Deliberately missing minutes (genuine in-session gaps): a 20-minute halt Fri 13:00-13:19 and a
 * missing minute Thu 11:30 (history), plus one missing minute on each replayed session.
 */
export function replayGaps(sessionCount: number): number[] {
  const fri = (sessionCount - 2) * PER_SESSION;
  const mon = (sessionCount - 1) * PER_SESSION;
  const halt = Array.from({ length: 20 }, (_, i) => fri + 210 + i);
  return [fri - PER_SESSION + 120, ...halt, fri + 307, mon + 41];
}

function buildSymbolData(
  symbol: ReplaySymbol,
  sessions: readonly MarketSession[],
  minuteScale: TimeScaleMapping,
): SymbolData {
  const spec = REPLAY_INSTRUMENTS[symbol];
  const count = sessions.length * PER_SESSION;
  const minutes = generateSyntheticBars({
    ...spec.walk,
    sessions,
    sessionMode: 'regular',
    durationMs: MINUTE,
    count,
    dropIndices: replayGaps(sessions.length),
  });
  const revisions = new Map<number, { bar: Bar; emitMs: number }>();
  const tape = buildTape(
    spec.instrument.id,
    spec.walk.seed,
    spec.walk.tickSize,
    minutes,
    revisions,
    minuteScale,
  );
  return { instrument: spec.instrument, minutes, revisions, tape };
}

function buildTape(
  instrumentId: InstrumentId,
  seed: number,
  tick: number,
  minutes: readonly Bar[],
  revisions: Map<number, { bar: Bar; emitMs: number }>,
  minuteScale: TimeScaleMapping,
): TapeEntry[] {
  const rng = createRng((seed * 7919) ^ 0x5eed);
  const decimals = Math.max(0, Math.round(-Math.log10(tick)));
  const round = (p: number) => Number((Math.round(p / tick) * tick).toFixed(decimals));
  const entries: (TapeEntry & { order: number })[] = [];
  let order = 0;
  const push = (emitMs: number, event: MarketEvent) =>
    entries.push({ emitMs, event, order: order++ });

  const live = minutes.filter((m) => m.start >= REPLAY_START_MS);
  live.forEach((bar, liveIndex) => {
    // Number of trades scales with volume; always at least 4 so O, H, L, C can be distinct trades.
    const n = Math.max(4, Math.min(28, Math.round(bar.volume / 4_000) + 4, bar.volume));
    const offsets = Array.from(
      { length: n },
      () => Math.floor(rng.next() * 58_000_000_000) + 500_000_000,
    )
      .sort((a, b) => a - b)
      .map((o, i) => o + i); // strictly increasing, sub-ms precision
    const hiIndex = 1 + Math.floor(rng.next() * (n - 2));
    let loIndex = 1 + Math.floor(rng.next() * (n - 2));
    if (loIndex === hiIndex) loIndex = hiIndex === 1 ? n - 2 : 1;
    const weights = Array.from({ length: n }, () => 0.2 + rng.next());
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const sizes = weights.map((w) => Math.max(1, Math.floor((w / totalWeight) * bar.volume)));
    sizes[n - 1] = Math.max(1, bar.volume - sizes.slice(0, n - 1).reduce((a, b) => a + b, 0));

    const trades: Trade[] = offsets.map((offsetNs, k) => {
      const price =
        k === 0
          ? bar.open
          : k === n - 1
            ? bar.close
            : k === hiIndex
              ? bar.high
              : k === loIndex
                ? bar.low
                : round(bar.low + rng.next() * (bar.high - bar.low));
      return {
        instrumentId,
        time: eventTimeFromNs(addNs(epochMsToNs(bar.start), BigInt(offsetNs))),
        price,
        size: sizes[k]!,
        tradeId: `${bar.start}-${k}`,
        venue: ['A', 'B', 'C'][k % 3]!,
      };
    });

    // Emitted at their trade time, except in some minutes where trade #2 arrives late (just
    // after trade #3): its timestamp is unchanged, so arrival order != time order.
    const lateIndex = liveIndex % 13 === 7 && n > 4 ? 2 : -1;
    trades.forEach((t, k) => {
      const emitMs = k === lateIndex ? trades[3]!.time.ms + 1 : t.time.ms;
      push(emitMs, { kind: 'trade', trade: t });
    });
    if (liveIndex % 11 === 3) {
      const dup = trades[1]!;
      push(dup.time.ms + 150, { kind: 'trade', trade: dup }); // redelivery: same venue + id
    }
    if (liveIndex % 17 === 5) {
      // Odd-lot print excluded from the official bar: trades and the official bar differ briefly.
      const t1 = trades[1]!.time;
      const oddLot: Trade = {
        instrumentId,
        time: eventTimeFromNs(addNs(t1.ns, 1_000_000n)),
        price: round((bar.high + bar.low) / 2),
        size: 7,
        tradeId: `${bar.start}-x`,
        venue: 'D',
        conditions: ['I'],
      };
      push(oddLot.time.ms, { kind: 'trade', trade: oddLot });
    }

    const minuteEnd = bar.start + MINUTE;
    push(minuteEnd + FINAL_BAR_DELAY_MS, {
      kind: 'bar',
      instrumentId,
      interval: '1m',
      phase: 'final',
      bar,
    });
    if (liveIndex % 23 === 11) {
      const revised: Bar = { ...bar, volume: bar.volume + 150, revision: 1 };
      const emitMs = minuteEnd + REVISED_BAR_DELAY_MS;
      revisions.set(bar.start, { bar: revised, emitMs });
      push(emitMs, { kind: 'bar', instrumentId, interval: '1m', phase: 'revised', bar: revised });
    }
  });

  // Sanity: every live minute maps onto the minute scale.
  for (const bar of live) {
    if (minuteScale.toSlot(bar.start) === null)
      throw new Error(`Replay minute ${bar.start} outside sessions`);
  }
  entries.sort((a, b) => a.emitMs - b.emitMs || a.order - b.order);
  return entries.map(({ emitMs, event }) => ({ emitMs, event }));
}
