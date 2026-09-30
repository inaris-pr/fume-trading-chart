import { describe, expect, test } from 'vitest';
import {
  addNs,
  applyBufferedHandoff,
  BoundedKeySet,
  createSessionTimeScale,
  epochMsToNs,
  LiveCandleAggregator,
  mergeCanonicalBars,
  slotSpecForTimeframe,
  tradeIdentity,
  type Bar,
  type EpochNs,
  type MarketEvent,
  type MarketSession,
  type SessionMode,
  type TimeframeId,
} from '../src/index.ts';
import { HOUR, MIN, TEST_ID } from './helpers.ts';

// ---------------------------------------------------------------------------------------------
// Hand-built sessions (no calendar code involved)

const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) =>
  Date.UTC(y, mo - 1, d, h, mi, s);

/** US RTH session in UTC for a date with the given UTC offset hours (5 = EST, 4 = EDT). */
function rth(date: string, utcOffset: number, closeLocal = '16:00'): MarketSession {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [ch, cm] = closeLocal.split(':').map(Number) as [number, number];
  return {
    instrumentId: TEST_ID,
    sessionDate: date,
    windows: [
      { start: at(y, m, d, 4 + utcOffset, 0), end: at(y, m, d, 9 + utcOffset, 30), kind: 'pre' },
      {
        start: at(y, m, d, 9 + utcOffset, 30),
        end: at(y, m, d, ch + utcOffset, cm),
        kind: 'regular',
      },
      { start: at(y, m, d, ch + utcOffset, cm), end: at(y, m, d, 20 + utcOffset, 0), kind: 'post' },
    ],
  };
}

const THU = rth('2026-03-05', 5);
const FRI = rth('2026-03-06', 5);
const OPEN = THU.windows[1]!.start; // Thu 09:30 EST

function engine(sessions: readonly MarketSession[], mode: SessionMode = 'regular', opts = {}) {
  const minuteScale = createSessionTimeScale({
    sessions,
    sessionMode: mode,
    slot: slotSpecForTimeframe('1m'),
  });
  const agg = new LiveCandleAggregator({ instrumentId: TEST_ID, minuteScale, ...opts });
  const target = (tf: TimeframeId) =>
    createSessionTimeScale({ sessions, sessionMode: mode, slot: slotSpecForTimeframe(tf) });
  return { agg, minuteScale, target };
}

let seq = 0;
function trade(
  ms: number,
  price: number,
  size = 100,
  extra: { subNs?: bigint; id?: string; venue?: string; ingestSeq?: number } = {},
): MarketEvent {
  const ns = addNs(epochMsToNs(Math.floor(ms)), extra.subNs ?? 0n) as EpochNs;
  return {
    kind: 'trade',
    trade: {
      instrumentId: TEST_ID,
      time: { ns, ms: Math.floor(ms) },
      price,
      size,
      ingestSeq: extra.ingestSeq ?? seq++,
      ...(extra.id !== undefined ? { tradeId: extra.id } : {}),
      ...(extra.venue !== undefined ? { venue: extra.venue } : {}),
    },
  };
}

const minuteBar = (
  start: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
  revision = 0,
): Bar => ({
  start,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
  status: 'final',
  revision,
});

const barEvent = (phase: 'final' | 'revised' | 'provisional', bar: Bar): MarketEvent => ({
  kind: 'bar',
  instrumentId: TEST_ID,
  interval: '1m',
  phase,
  bar,
});

const ohlcv = (b: Bar | null | undefined) =>
  b && [b.start, b.open, b.high, b.low, b.close, b.volume];

// ---------------------------------------------------------------------------------------------

describe('trade-built minutes', () => {
  test('OHLCV from trades; out-of-order arrival gives the identical candle', () => {
    const tape = [
      trade(OPEN + 1_000, 10.0, 100, { ingestSeq: 1 }),
      trade(OPEN + 5_000, 10.5, 200, { ingestSeq: 2 }),
      trade(OPEN + 9_000, 9.5, 50, { ingestSeq: 3 }),
      trade(OPEN + 40_000, 10.2, 70, { ingestSeq: 4 }),
    ];
    const inOrder = engine([THU]);
    inOrder.agg.seedOfficialMinutes([], OPEN);
    inOrder.agg.apply(tape);
    const shuffled = engine([THU]);
    shuffled.agg.seedOfficialMinutes([], OPEN);
    shuffled.agg.apply([tape[3]!, tape[1]!, tape[0]!, tape[2]!]);
    const a = inOrder.agg.effectiveMinute(OPEN)!;
    expect(ohlcv(a)).toEqual([OPEN, 10.0, 10.5, 9.5, 10.2, 420]);
    expect(a.tradeCount).toBe(4);
    expect(a.status).toBe('provisional');
    expect(shuffled.agg.effectiveMinute(OPEN)).toEqual(a);
  });

  test('exact-nanosecond ties are broken by ingestSeq, independent of arrival', () => {
    const t1 = trade(OPEN, 11, 1, { subNs: 7n, ingestSeq: 20 });
    const t2 = trade(OPEN, 12, 1, { subNs: 7n, ingestSeq: 21 });
    for (const order of [
      [t1, t2],
      [t2, t1],
    ]) {
      const { agg } = engine([THU]);
      agg.seedOfficialMinutes([], OPEN);
      agg.apply(order);
      const bar = agg.effectiveMinute(OPEN)!;
      expect(bar.open).toBe(11);
      expect(bar.close).toBe(12);
    }
  });

  test('sub-millisecond order beyond 2^53 is respected (ns strings, not floats)', () => {
    const early = trade(OPEN + 100, 1, 1, { subNs: 1n, ingestSeq: 999 });
    const late = trade(OPEN + 100, 2, 1, { subNs: 2n, ingestSeq: 0 });
    const { agg } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN);
    agg.apply([late, early]);
    expect(agg.effectiveMinute(OPEN)!.open).toBe(1); // ns order beats ingestSeq
    expect(agg.effectiveMinute(OPEN)!.close).toBe(2);
  });

  test('regular mode rejects extended-hours trades; extended mode accepts them', () => {
    const pre = trade(OPEN - 10 * MIN, 5);
    const reg = engine([THU]);
    reg.agg.seedOfficialMinutes([], OPEN - 60 * MIN);
    expect(reg.agg.apply([pre])).toEqual([]);
    expect(reg.agg.diagnostics().outsideSessionTrades).toBe(1);
    const ext = engine([THU], 'extended');
    ext.agg.seedOfficialMinutes([], OPEN - 60 * MIN);
    expect(ext.agg.apply([pre])).toEqual([OPEN - 10 * MIN]);
  });

  test('an empty minute produces no synthetic bar', () => {
    const { agg, target } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN);
    const changed = agg.apply([trade(OPEN + 1000, 10), trade(OPEN + 2 * MIN + 1000, 11)]);
    expect(changed).toEqual([OPEN, OPEN + 2 * MIN]);
    expect(agg.effectiveMinute(OPEN + MIN)).toBeNull();
    expect(agg.foldBuckets(target('1m'), changed).map((b) => b.start)).toEqual([
      OPEN,
      OPEN + 2 * MIN,
    ]);
    const [fiveMin] = agg.foldBuckets(target('5m'), changed);
    expect(ohlcv(fiveMin)).toEqual([OPEN, 10, 11, 10, 11, 200]);
  });
});

describe('de-duplication', () => {
  test('same venue + tradeId is ignored; same id on another venue is a different trade', () => {
    const { agg } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN);
    agg.apply([
      trade(OPEN + 1000, 10, 100, { id: 'T1', venue: 'V' }),
      trade(OPEN + 1000, 10, 100, { id: 'T1', venue: 'V' }),
      trade(OPEN + 2000, 10, 100, { id: 'T1', venue: 'W' }),
    ]);
    expect(agg.effectiveMinute(OPEN)!.volume).toBe(200);
    expect(agg.diagnostics().duplicateTrades).toBe(1);
  });

  test('trades without an id are never de-duplicated (documented limitation)', () => {
    const { agg } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN);
    const t = trade(OPEN + 1000, 10, 100);
    agg.apply([t, t]);
    expect(agg.effectiveMinute(OPEN)!.volume).toBe(200);
    expect(tradeIdentity({})).toBeNull();
  });

  test('dedupe state is bounded (oldest identities are evicted)', () => {
    const set = new BoundedKeySet(3);
    for (const k of ['a', 'b', 'c', 'd']) expect(set.add(k)).toBe(true);
    expect(set.size).toBe(3);
    expect(set.has('a')).toBe(false);
    expect(set.add('d')).toBe(false);
    const { agg } = engine([THU], 'regular', { dedupeCapacity: 2 });
    agg.seedOfficialMinutes([], OPEN);
    agg.apply(['x', 'y', 'z', 'x'].map((id, i) => trade(OPEN + 1000 + i, 10, 1, { id })));
    expect(agg.effectiveMinute(OPEN)!.volume).toBe(4); // 'x' was evicted, so its redelivery counts
  });
});

describe('official minute precedence', () => {
  const trades = [trade(OPEN + 1000, 10, 100), trade(OPEN + 30_000, 12, 50)];

  test('final replaces trade-built; trade after final is ignored', () => {
    const { agg } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN);
    agg.apply(trades);
    expect(agg.apply([barEvent('final', minuteBar(OPEN, 10, 12.5, 9.9, 11.9, 170))])).toEqual([
      OPEN,
    ]);
    expect(ohlcv(agg.effectiveMinute(OPEN))).toEqual([OPEN, 10, 12.5, 9.9, 11.9, 170]);
    expect(agg.effectiveMinute(OPEN)!.status).toBe('final');
    expect(agg.apply([trade(OPEN + 50_000, 99)])).toEqual([]);
    expect(agg.effectiveMinute(OPEN)!.high).toBe(12.5);
    expect(agg.diagnostics().tradesAfterOfficial).toBe(1);
  });

  test('revised replaces final; stale revisions and duplicates are ignored', () => {
    const { agg } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN);
    agg.apply([barEvent('final', minuteBar(OPEN, 10, 11, 9, 10.5, 100))]);
    expect(agg.apply([barEvent('final', minuteBar(OPEN, 10, 11, 9, 10.5, 100))])).toEqual([]); // duplicate
    expect(agg.apply([barEvent('revised', minuteBar(OPEN, 10, 11, 9, 10.6, 130, 1))])).toEqual([
      OPEN,
    ]);
    expect(agg.apply([barEvent('revised', minuteBar(OPEN, 10, 11, 9, 10.4, 90, 1))])).toEqual([]); // same revision
    expect(agg.apply([barEvent('final', minuteBar(OPEN, 1, 1, 1, 1, 1, 5))])).toEqual([]); // final can't beat revised
    expect(agg.apply([barEvent('revised', minuteBar(OPEN, 10, 11, 9, 10.7, 140, 2))])).toEqual([
      OPEN,
    ]);
    expect(agg.apply([barEvent('revised', minuteBar(OPEN, 10, 11, 9, 10.1, 10, 1))])).toEqual([]); // stale
    expect(ohlcv(agg.effectiveMinute(OPEN))).toEqual([OPEN, 10, 11, 9, 10.7, 140]);
    expect(agg.diagnostics().staleOfficialBars).toBe(4);
  });

  test('a provider provisional minute beats trade-built but loses to official', () => {
    const { agg } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN);
    agg.apply(trades);
    agg.apply([
      barEvent('provisional', { ...minuteBar(OPEN, 10, 13, 9, 12, 300), status: 'provisional' }),
    ]);
    expect(agg.effectiveMinute(OPEN)!.high).toBe(13);
    agg.apply([barEvent('final', minuteBar(OPEN, 10, 12, 10, 12, 150))]);
    expect(agg.effectiveMinute(OPEN)!.high).toBe(12);
  });

  test('higher timeframes re-fold after reconciliation (15m, 1h, 4h, 1d)', () => {
    const { agg, target } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN);
    const changed = agg.apply([trade(OPEN + 1000, 10, 100), trade(OPEN + MIN + 1000, 10.2, 100)]);
    for (const tf of ['15m', '1h', '4h', '1d'] as const) {
      expect(agg.foldBuckets(target(tf), changed)[0]!.volume).toBe(200);
    }
    const reconciled = agg.apply([barEvent('final', minuteBar(OPEN, 10, 10.1, 9.8, 10, 175))]);
    for (const tf of ['15m', '1h', '4h', '1d'] as const) {
      const [bar] = agg.foldBuckets(target(tf), reconciled);
      expect(bar!.volume).toBe(275);
      expect(bar!.low).toBe(9.8);
      expect(bar!.status).toBe('provisional'); // bucket not complete yet
    }
  });
});

describe('active candle changes on every accepted trade, for every timeframe', () => {
  test.each(['1m', '5m', '15m', '1h', '4h', '1d'] as const)('%s', (tf) => {
    const { agg, target } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN);
    const mapping = target(tf);
    let previous: string | null = null;
    for (let i = 0; i < 25; i++) {
      const changed = agg.apply([trade(OPEN + i * 1500, 100 + i * 0.01, 10)]);
      const upserts = agg.foldBuckets(mapping, changed);
      expect(upserts).toHaveLength(1);
      const now = JSON.stringify(upserts[0]);
      expect(now).not.toBe(previous);
      previous = now;
    }
  });
});

describe('rollover', () => {
  const cases: [TimeframeId, number, number][] = [
    ['1m', OPEN + 59_999, OPEN + MIN],
    ['5m', OPEN + 5 * MIN - 1, OPEN + 5 * MIN], // 09:34:59.999 -> 09:35:00
    ['15m', OPEN + 15 * MIN - 1, OPEN + 15 * MIN],
    ['1h', OPEN + HOUR - 1, OPEN + HOUR], // 10:29:59.999 -> 10:30
    ['4h', OPEN + 4 * HOUR - 1, OPEN + 4 * HOUR], // 13:29:59.999 -> 13:30
    ['1d', OPEN + 390 * MIN - 1, FRI.windows[1]!.start], // 15:59:59.999 -> next session
  ];
  test.each(cases)(
    '%s: the first trade of the next bucket rolls the candle',
    (tf, before, after) => {
      const { agg, target } = engine([THU, FRI]);
      agg.seedOfficialMinutes([], OPEN);
      const mapping = target(tf);
      const [a] = agg.foldBuckets(mapping, agg.apply([trade(before, 10)]));
      const [b] = agg.foldBuckets(mapping, agg.apply([trade(after, 11)]));
      expect(b!.start).toBeGreaterThan(a!.start);
      expect(mapping.toSlot(b!.start)! - mapping.toSlot(a!.start)!).toBe(1); // no empty buckets fabricated
      // The previous candle is still available for late corrections.
      const minuteOfA = before - ((before - OPEN) % MIN);
      const [late] = agg.foldBuckets(
        mapping,
        agg.apply([barEvent('final', minuteBar(minuteOfA, 10, 10, 9, 9.5, 42))]),
      );
      expect(late!.start).toBe(a!.start);
      expect(late!.low).toBe(9);
    },
  );

  test('buckets between two events are not fabricated', () => {
    const { agg, target } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN);
    const changed = agg.apply([trade(OPEN + 1000, 10), trade(OPEN + 3 * HOUR, 11)]);
    expect(agg.foldBuckets(target('15m'), changed).map((b) => (b.start - OPEN) / MIN)).toEqual([
      0, 180,
    ]);
  });

  test('a completed bucket becomes final once all its minutes are official', () => {
    const { agg, target } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN);
    const five = target('5m');
    const bars = Array.from({ length: 5 }, (_, i) =>
      barEvent('final', minuteBar(OPEN + i * MIN, 10, 11, 9, 10, 1)),
    );
    let [b] = agg.foldBuckets(five, agg.apply(bars.slice(0, 4)));
    expect(b!.status).toBe('provisional');
    [b] = agg.foldBuckets(five, agg.apply(bars.slice(4)));
    expect(b!.status).toBe('final');
  });
});

describe('retention and coverage', () => {
  test('buckets starting before the covered minutes are not folded (never guessed)', () => {
    const { agg, target } = engine([THU]);
    agg.seedOfficialMinutes([], OPEN + 15 * MIN); // minute data only complete from 09:45
    const changed = agg.apply([trade(OPEN + 25 * MIN, 10)]);
    expect(agg.foldBuckets(target('15m'), changed)).toHaveLength(1); // 09:45 bucket is covered
    expect(agg.foldBuckets(target('1h'), changed)).toHaveLength(0); // 09:30 bucket is not
    expect(agg.diagnostics().uncoveredBuckets).toBeGreaterThanOrEqual(1);
  });

  test('corrections older than the retention window are dropped and counted', () => {
    const { agg } = engine([THU, FRI], 'regular', { retentionMinutes: 60 });
    agg.seedOfficialMinutes([], OPEN);
    agg.apply([trade(OPEN + 1000, 10)]);
    agg.apply([trade(FRI.windows[1]!.start + 110 * MIN, 11)]); // Friday 11:20, far ahead
    const before = agg.diagnostics().eventsOutsideRetention;
    expect(agg.apply([barEvent('final', minuteBar(OPEN, 1, 1, 1, 1, 1))])).toEqual([]);
    expect(agg.diagnostics().eventsOutsideRetention).toBe(before + 1);
    expect(agg.coverageStart()).toBeGreaterThan(OPEN);
  });

  test('retained state stays bounded', () => {
    const { agg } = engine([THU, FRI], 'regular', { retentionMinutes: 30 });
    agg.seedOfficialMinutes([], OPEN);
    for (let i = 0; i < 700; i++) agg.apply([trade(OPEN + i * MIN + 1000, 10)]);
    expect(agg.retainedMinuteCount()).toBeLessThanOrEqual(30 + 256);
  });
});

describe('historical/live handoff', () => {
  test('seed + buffered bars + buffered trades merge into history without duplicates', () => {
    const { agg, target } = engine([THU]);
    const five = target('5m');
    // History already contains canonical 5m bars up to and including an in-progress 09:40 bucket.
    const history: Bar[] = [
      { ...minuteBar(OPEN, 10, 11, 9, 10.5, 500) },
      { ...minuteBar(OPEN + 5 * MIN, 10.5, 11, 10, 10.8, 300) },
      { ...minuteBar(OPEN + 10 * MIN, 10.8, 10.9, 10.7, 10.8, 40), status: 'provisional' },
    ];
    // Seed: official minutes of the current 5m bucket (09:40, 09:41).
    const seed = [
      minuteBar(OPEN + 10 * MIN, 10.8, 10.9, 10.7, 10.8, 20),
      minuteBar(OPEN + 11 * MIN, 10.8, 10.85, 10.75, 10.8, 20),
    ];
    // Buffered while loading: 09:42 trades (one duplicated), then the official 09:42 bar, then 09:43 trades.
    const buffered: MarketEvent[] = [
      trade(OPEN + 12 * MIN + 1000, 10.9, 5, { id: 'a' }),
      trade(OPEN + 12 * MIN + 1000, 10.9, 5, { id: 'a' }),
      barEvent('final', minuteBar(OPEN + 12 * MIN, 10.9, 11.0, 10.9, 10.95, 8)),
      trade(OPEN + 13 * MIN + 1000, 11.1, 3, { id: 'b' }),
    ];
    const changed = applyBufferedHandoff(agg, {
      seedMinutes: seed,
      coverageFrom: OPEN + 10 * MIN,
      buffered,
    });
    const merged = mergeCanonicalBars(history, agg.foldBuckets(five, changed));
    expect(merged.map((b) => (b.start - OPEN) / MIN)).toEqual([0, 5, 10]);
    expect(ohlcv(merged[2])).toEqual([OPEN + 10 * MIN, 10.8, 11.1, 10.7, 11.1, 20 + 20 + 8 + 3]);
    expect(agg.effectiveMinute(OPEN + 12 * MIN)!.volume).toBe(8); // official beat the buffered trades
  });

  test('mergeCanonicalBars replaces by start and keeps order', () => {
    const a = minuteBar(1, 1, 1, 1, 1, 1);
    const b = minuteBar(2, 2, 2, 2, 2, 2);
    const b2 = minuteBar(2, 3, 3, 3, 3, 3);
    const c = minuteBar(3, 4, 4, 4, 4, 4);
    expect(mergeCanonicalBars([a, b], [c, b2])).toEqual([a, b2, c]);
    expect(mergeCanonicalBars([a], [])).toEqual([a]);
  });
});

describe('determinism', () => {
  test('replaying the same tape twice gives byte-identical bars', () => {
    const tape: MarketEvent[] = [];
    for (let i = 0; i < 300; i++) {
      tape.push(
        trade(OPEN + i * 3_700, 100 + Math.sin(i) * 2, 1 + (i % 7), {
          id: `t${i}`,
          venue: i % 3 ? 'A' : 'B',
          ingestSeq: i,
        }),
      );
      if (i % 16 === 15)
        tape.push(
          barEvent(
            'final',
            minuteBar(OPEN + Math.floor((i * 3_700) / MIN) * MIN - MIN, 100, 101, 99, 100, 50),
          ),
        );
    }
    const run = () => {
      const { agg, target } = engine([THU]);
      agg.seedOfficialMinutes([], OPEN);
      const out: Bar[] = [];
      for (const e of tape) out.push(...agg.foldBuckets(target('15m'), agg.apply([e])));
      return JSON.stringify({ out, minutes: agg.effectiveMinutes(), diag: agg.diagnostics() });
    };
    expect(run()).toBe(run());
  });
});

describe('explicit session cases', () => {
  test('early close (13:00): trades after the close are rejected; the 12:30 hour is short', () => {
    const early = rth('2026-11-27', 5, '13:00');
    const open = early.windows[1]!.start;
    const { agg, target } = engine([early]);
    agg.seedOfficialMinutes([], open);
    const changed = agg.apply([
      trade(open + 3 * HOUR + 10 * MIN, 10),
      trade(open + 3.5 * HOUR + 5 * MIN, 11),
    ]);
    expect(changed).toHaveLength(1);
    expect(agg.diagnostics().outsideSessionTrades).toBe(1);
    const [hour] = agg.foldBuckets(target('1h'), changed);
    expect(hour!.start).toBe(open + 3 * HOUR); // 12:30-13:00
  });

  test('DST spring (Mon 2026-03-09, EDT): 09:30 local = 13:30 UTC', () => {
    const mon = rth('2026-03-09', 4);
    const { agg, target } = engine([FRI, mon]);
    agg.seedOfficialMinutes([], FRI.windows[1]!.start);
    const changed = agg.apply([trade(at(2026, 3, 9, 13, 30, 5), 10)]);
    expect(changed).toEqual([at(2026, 3, 9, 13, 30)]);
    expect(agg.foldBuckets(target('1d'), changed)[0]!.start).toBe(at(2026, 3, 9, 13, 30));
  });

  test('DST fall (Mon 2026-11-02, EST): 09:30 local = 14:30 UTC', () => {
    const fri = rth('2026-10-30', 4);
    const mon = rth('2026-11-02', 5);
    const { agg, target } = engine([fri, mon]);
    agg.seedOfficialMinutes([], fri.windows[1]!.start);
    const changed = agg.apply([
      trade(at(2026, 11, 2, 14, 30, 1), 10),
      trade(at(2026, 11, 2, 13, 45), 9),
    ]);
    expect(changed).toEqual([at(2026, 11, 2, 14, 30)]); // 13:45 UTC is 08:45 EST: pre-market
    expect(agg.foldBuckets(target('1h'), changed)[0]!.start).toBe(at(2026, 11, 2, 14, 30));
  });

  test('futures-style overnight session with a scheduled break', () => {
    // Monday session: Sun 17:00 CT -> Mon 08:00 (overnight), break, 08:30 -> 16:00. CST = UTC-6.
    const fut: MarketSession = {
      instrumentId: TEST_ID,
      sessionDate: '2026-03-02',
      windows: [
        { start: at(2026, 3, 1, 23, 0), end: at(2026, 3, 2, 14, 0), kind: 'regular' },
        { start: at(2026, 3, 2, 14, 30), end: at(2026, 3, 2, 22, 0), kind: 'regular' },
      ],
    };
    const { agg, target } = engine([fut]);
    agg.seedOfficialMinutes([], fut.windows[0]!.start);
    const changed = agg.apply([
      trade(at(2026, 3, 1, 23, 0, 1), 5000), // Sunday evening
      trade(at(2026, 3, 2, 6, 0, 1), 5010), // after midnight, same session
      trade(at(2026, 3, 2, 14, 10), 9999), // inside the break: rejected
      trade(at(2026, 3, 2, 21, 59, 59), 5020), // last minute before the close
    ]);
    expect(changed).toHaveLength(3);
    const [day] = agg.foldBuckets(target('1d'), changed);
    expect(ohlcv(day)).toEqual([at(2026, 3, 1, 23, 0), 5000, 5020, 5000, 5020, 300]);
    expect(agg.foldBuckets(target('1h'), changed).map((b) => b.start)).toEqual([
      at(2026, 3, 1, 23, 0),
      at(2026, 3, 2, 6, 0),
      at(2026, 3, 2, 21, 30),
    ]);
  });

  test('regular vs extended filtering of a post-market trade', () => {
    const post = trade(at(2026, 3, 5, 21, 30), 12);
    const reg = engine([THU]);
    reg.agg.seedOfficialMinutes([], OPEN);
    expect(reg.agg.apply([post])).toEqual([]);
    const ext = engine([THU], 'extended');
    ext.agg.seedOfficialMinutes([], THU.windows[0]!.start);
    const changed = ext.agg.apply([post]);
    expect(ext.agg.foldBuckets(ext.target('1d'), changed)[0]!.start).toBe(THU.windows[0]!.start);
  });
});
