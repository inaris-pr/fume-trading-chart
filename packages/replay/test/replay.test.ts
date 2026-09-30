import { describe, expect, test } from 'vitest';
import {
  aggregateBars,
  compareTradeOrder,
  createSessionTimeScale,
  LiveCandleAggregator,
  slotSpecForTimeframe,
  type Bar,
  type Instrument,
  type MarketEvent,
  type TimeframeId,
} from '@fume/core';
import {
  FINAL_BAR_DELAY_MS,
  ManualScheduler,
  REPLAY_START_MS,
  REPLAY_SYMBOLS,
  ReplayClock,
  ReplayDataset,
  ReplayMarketDataProvider,
  replayGaps,
} from '../src/index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const dataset = new ReplayDataset();
const nyTime = (t: number) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(t);

function provider(speed = 60, startMs = REPLAY_START_MS) {
  const scheduler = new ManualScheduler();
  return {
    scheduler,
    p: new ReplayMarketDataProvider({ dataset, scheduler, speed, startMs, tickMs: 50 }),
  };
}

function collect(p: ReplayMarketDataProvider) {
  const events: MarketEvent[] = [];
  const stream = p.openStream({ onEvents: (batch) => events.push(...batch) });
  return { events, stream };
}

const spy = (p: ReplayMarketDataProvider) => p.dataset.instrument('SPY')!;

describe('dataset', () => {
  test('171 data sessions from 2026-02-02; the calendar continues beyond the data', () => {
    expect(dataset.dataSessions).toHaveLength(171);
    expect(dataset.dataSessions.at(-1)!.sessionDate).toBe('2026-09-28');
    expect(dataset.calendar.length).toBeGreaterThan(171);
  });

  test('deterministic: a second dataset produces identical history and tape', () => {
    const other = new ReplayDataset();
    for (const s of REPLAY_SYMBOLS) {
      expect(other.minuteBars(s)).toEqual(dataset.minuteBars(s));
      expect(JSON.stringify(other.tape(s))).toBe(JSON.stringify(dataset.tape(s)));
    }
  });

  test('symbols are distinct and use provider-neutral metadata', () => {
    const closes = REPLAY_SYMBOLS.map((s) => dataset.minuteBars(s).at(-1)!.close);
    expect(new Set(closes).size).toBe(5);
    expect(dataset.instrument('NVDA')!.marketDataRef.providerId).toBe('replay');
    expect(dataset.instrument('MSFT')).toBeNull();
  });

  test('gaps: the Friday halt and one missing minute per replayed session', () => {
    const minutes = dataset.minuteBars('SPY');
    expect(minutes).toHaveLength(171 * 390 - replayGaps(171).length);
    const fri1400 = REPLAY_START_MS;
    const fri1437 = fri1400 + 37 * MIN;
    expect(minutes.some((b) => b.start === fri1437)).toBe(false);
    const trades = dataset.tape('SPY').filter((e) => e.event.kind === 'trade');
    expect(
      trades.some(
        (e) =>
          e.event.kind === 'trade' && Math.floor(e.event.trade.time.ms / MIN) * MIN === fri1437,
      ),
    ).toBe(false);
  });
});

describe('tape edge cases', () => {
  const tape = dataset.tape('SPY');
  const trades = tape.flatMap((e) => (e.event.kind === 'trade' ? [e.event.trade] : []));

  test('trades built per minute equal the official final bar (except odd-lot minutes)', () => {
    const byMinute = new Map<number, typeof trades>();
    for (const t of trades) {
      const m = Math.floor(t.time.ms / MIN) * MIN;
      if (!byMinute.has(m)) byMinute.set(m, []);
      byMinute.get(m)!.push(t);
    }
    const finals = tape.flatMap((e) =>
      e.event.kind === 'bar' && e.event.phase === 'final' ? [e.event.bar] : [],
    );
    let mismatches = 0;
    for (const bar of finals) {
      const ts = [
        ...new Map(
          (byMinute.get(bar.start) ?? []).map((t) => [`${t.venue}|${t.tradeId}`, t]),
        ).values(),
      ].sort(compareTradeOrder);
      const regular = ts.filter((t) => !t.conditions?.includes('I'));
      expect(regular[0]!.price).toBe(bar.open);
      expect(regular.at(-1)!.price).toBe(bar.close);
      expect(Math.max(...regular.map((t) => t.price))).toBe(bar.high);
      expect(Math.min(...regular.map((t) => t.price))).toBe(bar.low);
      expect(regular.reduce((n, t) => n + t.size, 0)).toBe(bar.volume);
      if (regular.length !== ts.length) mismatches++;
    }
    expect(mismatches).toBeGreaterThan(5); // odd-lot minutes exist
  });

  test('contains out-of-order arrivals, duplicate deliveries and revised bars', () => {
    let outOfOrder = 0;
    for (let i = 1; i < trades.length; i++) {
      if (compareTradeOrder(trades[i]!, trades[i - 1]!) < 0) outOfOrder++;
    }
    const ids = trades.map((t) => `${t.venue}|${t.tradeId}`);
    const duplicates = ids.length - new Set(ids).size;
    const revised = tape.filter((e) => e.event.kind === 'bar' && e.event.phase === 'revised');
    expect(outOfOrder).toBeGreaterThan(5);
    expect(duplicates).toBeGreaterThan(5);
    expect(revised.length).toBeGreaterThan(5);
  });

  test('tape is ordered by emit time and final bars come after their minute', () => {
    for (let i = 1; i < tape.length; i++)
      expect(tape[i]!.emitMs).toBeGreaterThanOrEqual(tape[i - 1]!.emitMs);
    for (const e of tape) {
      if (e.event.kind === 'bar' && e.event.phase === 'final')
        expect(e.emitMs).toBe(e.event.bar.start + MIN + FINAL_BAR_DELAY_MS);
    }
  });
});

describe('replay clock', () => {
  test('advances speed x real time in open windows and jumps over closed time', () => {
    const clock = new ReplayClock(dataset.dataSessions, REPLAY_START_MS, 60, 0);
    expect(clock.marketTime(0)).toBe(REPLAY_START_MS);
    expect(clock.marketTime(1000)).toBe(REPLAY_START_MS + MIN);
    // 2h to the Friday close, then the weekend is skipped: Monday 09:30 EDT.
    const monOpen = Date.UTC(2026, 8, 28, 13, 30);
    expect(clock.marketTime(120 * 1000)).toBe(monOpen); // exactly 2h of market time
    expect(clock.marketTime(1000)).toBe(monOpen); // never goes backwards
  });

  test('stops at the end of the last session', () => {
    const clock = new ReplayClock(dataset.dataSessions, REPLAY_START_MS, 1e6, 0);
    const end = clock.marketTime(1e9);
    expect(end).toBe(dataset.dataSessions.at(-1)!.windows.find((w) => w.kind === 'regular')!.end);
    expect(clock.finished()).toBe(true);
  });
});

describe('provider history', () => {
  test('only minutes published by now; newest page first; hasMore', async () => {
    const { scheduler, p } = provider(60);
    const page = await p.getBars({
      instrument: spy(p),
      intervalMinutes: 1,
      end: Number.MAX_SAFE_INTEGER,
      limit: 100,
    });
    expect(page.bars).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(page.bars.at(-1)!.start).toBeLessThan(REPLAY_START_MS);
    scheduler.advance(10 * 1000); // 10 market minutes
    const later = await p.getBars({
      instrument: spy(p),
      intervalMinutes: 1,
      end: Number.MAX_SAFE_INTEGER,
      limit: 5,
    });
    expect(later.bars.at(-1)!.start).toBeGreaterThanOrEqual(REPLAY_START_MS + 8 * MIN);
    expect(later.bars.at(-1)!.start + MIN + FINAL_BAR_DELAY_MS).toBeLessThanOrEqual(p.marketNow());
    const older = await p.getBars({
      instrument: spy(p),
      intervalMinutes: 1,
      end: page.bars[0]!.start,
      limit: 100,
    });
    expect(older.bars.at(-1)!.start).toBeLessThan(page.bars[0]!.start);
  });

  test('revised minutes appear in history only after their revision is published', async () => {
    const { scheduler, p } = provider(60);
    const [start, rev] = [...dataset.revisions('SPY').entries()][0]!;
    const fetchMinute = async () =>
      (await p.getBars({ instrument: spy(p), intervalMinutes: 1, end: start + 1, limit: 1 }))
        .bars[0];
    scheduler.advance((start + MIN + FINAL_BAR_DELAY_MS - REPLAY_START_MS) / 60 + 20);
    expect((await fetchMinute())!.revision).toBe(0);
    scheduler.advance((rev.emitMs - p.marketNow()) / 60 + 20);
    expect((await fetchMinute())!.revision).toBe(1);
  });

  test('rejects non-1m intervals, unknown instruments and aborted requests', async () => {
    const { p } = provider();
    await expect(
      p.getBars({ instrument: spy(p), intervalMinutes: 5, end: 1e15, limit: 1 }),
    ).rejects.toThrow(/1-minute/);
    const ghost = { ...spy(p), id: 'eq:NOPE' } as Instrument;
    await expect(
      p.getBars({ instrument: ghost, intervalMinutes: 1, end: 1e15, limit: 1 }),
    ).rejects.toThrow(/Unknown/);
    const signal = { aborted: true, addEventListener: () => {} };
    await expect(
      p.getBars({ instrument: spy(p), intervalMinutes: 1, end: 1e15, limit: 1, signal }),
    ).rejects.toThrow(/aborted/);
  });

  test('sessions carry the requested instrument id', async () => {
    const { p } = provider();
    const sessions = await p.getSessions(spy(p), REPLAY_START_MS - 3 * 86_400_000, REPLAY_START_MS);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.instrumentId === 'eq:SPY')).toBe(true);
  });
});

describe('stream subscriptions', () => {
  const sub = (id: string) => [
    { instrumentId: id as Instrument['id'], channels: ['trades', 'minuteBars'] as const },
  ];

  test('subscribed symbol receives its events; ingestSeq increases; no backlog on subscribe', () => {
    const { scheduler, p } = provider(60);
    scheduler.advance(5_000); // 5 market minutes pass before anyone subscribes
    const { events, stream } = collect(p);
    stream.setSubscriptions(sub('eq:SPY'));
    scheduler.advance(3_000);
    const trades = events.flatMap((e) => (e.kind === 'trade' ? [e.trade] : []));
    expect(trades.length).toBeGreaterThan(10);
    expect(trades.every((t) => t.instrumentId === 'eq:SPY')).toBe(true);
    expect(trades[0]!.time.ms).toBeGreaterThanOrEqual(REPLAY_START_MS + 5 * MIN - 1000);
    trades.forEach((t, i) =>
      expect(t.ingestSeq).toBe(i === 0 ? t.ingestSeq : trades[i - 1]!.ingestSeq! + 1),
    );
    expect(events[0]).toEqual({ kind: 'stream_status', state: { status: 'live' } });
    stream.close();
  });

  test('switching SPY -> NVDA: no SPY events afterwards', () => {
    const { scheduler, p } = provider(60);
    const { events, stream } = collect(p);
    stream.setSubscriptions(sub('eq:SPY'));
    scheduler.advance(2_000);
    stream.setSubscriptions(sub('eq:NVDA'));
    const mark = events.length;
    scheduler.advance(3_000);
    const after = events.slice(mark).filter((e) => e.kind === 'trade' || e.kind === 'bar');
    expect(after.length).toBeGreaterThan(0);
    expect(
      after.every(
        (e) =>
          (e.kind === 'trade' ? e.trade.instrumentId : e.kind === 'bar' ? e.instrumentId : '') ===
          'eq:NVDA',
      ),
    ).toBe(true);
    stream.close();
  });

  test('unsubscribing everything stops market events; close stops all and leaves no timers', () => {
    const { scheduler, p } = provider(60);
    const { events, stream } = collect(p);
    stream.setSubscriptions(sub('eq:SPY'));
    scheduler.advance(1_000);
    stream.setSubscriptions([]);
    const mark = events.length;
    scheduler.advance(2_000);
    expect(events.length).toBe(mark);
    stream.setSubscriptions(sub('eq:SPY'));
    stream.close();
    scheduler.advance(5_000);
    expect(events.length).toBe(mark);
    expect(scheduler.pendingTimers()).toBe(0);
    stream.setSubscriptions(sub('eq:SPY')); // no effect after close
    scheduler.advance(1_000);
    expect(events.length).toBe(mark);
  });

  test('two independent runs emit byte-identical event sequences', () => {
    const run = () => {
      const { scheduler, p } = provider(120);
      const { events, stream } = collect(p);
      stream.setSubscriptions(sub('eq:TSLA'));
      for (let i = 0; i < 40; i++) scheduler.advance(137);
      stream.close();
      return JSON.stringify(events);
    };
    expect(run()).toBe(run());
  });
});

describe('end to end: replay -> live aggregator', () => {
  test('after finals and revisions, live minutes equal the official history; reconciliation happened', () => {
    const { scheduler, p } = provider(120);
    const inst = spy(p);
    const minuteScale = createSessionTimeScale({
      sessions: dataset.dataSessions,
      sessionMode: 'regular',
      slot: slotSpecForTimeframe('1m'),
    });
    const agg = new LiveCandleAggregator({ instrumentId: inst.id, minuteScale });
    agg.seedOfficialMinutes([], REPLAY_START_MS);
    const { stream } = (() => {
      const s = p.openStream({ onEvents: (batch) => agg.apply(batch) });
      return { stream: s };
    })();
    stream.setSubscriptions([{ instrumentId: inst.id, channels: ['trades', 'minuteBars'] }]);
    scheduler.advance(60 * 1000); // 2 market hours at 120x: the rest of Friday
    stream.close();
    const live = agg.effectiveMinutes().filter((b) => b.status === 'final');
    expect(live.length).toBeGreaterThan(100);
    const now = p.marketNow();
    for (const bar of live) {
      const official = dataset.minuteBars('SPY').find((m) => m.start === bar.start)!;
      expect(bar).toEqual({ ...dataset.officialMinute('SPY', official, now), status: 'final' });
    }
    const d = agg.diagnostics();
    expect(d.duplicateTrades).toBeGreaterThan(0);
    expect(d.acceptedOfficialBars).toBeGreaterThan(100);
  });
});

describe('canonical timeframes from replay history (moved from the Stage 2 catalog tests)', () => {
  const minutes = dataset.minuteBars('SPY');
  const fold = (tf: TimeframeId) =>
    aggregateBars({
      bars: minutes,
      sourceDurationMs: MIN,
      target: createSessionTimeScale({
        sessions: dataset.dataSessions,
        sessionMode: 'regular',
        slot: slotSpecForTimeframe(tf),
      }),
    }).bars;

  test('bar counts per timeframe', () => {
    expect(fold('1h')).toHaveLength(171 * 7);
    expect(fold('4h')).toHaveLength(171 * 2);
    expect(fold('1d')).toHaveLength(171);
  });

  test('4H is session-aligned: 09:30-13:30 and a short 13:30-16:00; halves sum to the day', () => {
    const fourH = fold('4h');
    const day = fold('1d');
    expect(fourH.slice(0, 2).map((b) => nyTime(b.start))).toEqual(['09:30', '13:30']);
    expect(fourH[0]!.volume + fourH[1]!.volume).toBe(day[0]!.volume);
    expect(fourH[1]!.start - fourH[0]!.start).toBe(4 * HOUR);
  });

  test('daily candle = the whole session of minutes', () => {
    const [day] = fold('1d');
    const first: Bar[] = minutes.slice(0, 390);
    expect(day).toMatchObject({
      open: first[0]!.open,
      close: first.at(-1)!.close,
      high: Math.max(...first.map((m) => m.high)),
      low: Math.min(...first.map((m) => m.low)),
      volume: first.reduce((n, m) => n + m.volume, 0),
    });
  });
});
