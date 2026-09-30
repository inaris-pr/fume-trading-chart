import { describe, expect, test } from 'vitest';
import type { ChartData, PrependOptions } from '@fume/chart';
/**
 * ChartSession over the deterministic ReplayDataFeed (the former replay controller's scenarios):
 * history then live trade-driven candles, buffering during load, symbol/timeframe switches,
 * paging, dispose, determinism, and live minutes matching the official ones.
 */
import type { Bar } from '@fume/core';
import {
  ManualScheduler,
  REPLAY_START_MS,
  ReplayDataset,
  ReplayMarketDataProvider,
} from '@fume/replay';
import {
  aggregateBars,
  createSessionTimeScale,
  slotSpecForTimeframe,
  type TimeframeId,
} from '@fume/core';
import { REPLAY_SESSIONS_PER_PAGE, ReplayDataFeed } from '../src/replay/replay-feed.ts';
import { ChartSession } from '../src/session.ts';
import type { BarsQuery, ChartSink } from '../src/types.ts';

const dataset = new ReplayDataset();
const nyTime = (t: number) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(t);

class RecordingChart implements ChartSink {
  readonly setDataCalls: ChartData[] = [];
  readonly upserts: Bar[][] = [];
  readonly prepends: { bars: readonly Bar[]; options?: PrependOptions }[] = [];
  readonly resolved: boolean[] = [];
  setData(data: ChartData): void {
    this.setDataCalls.push(data);
  }
  upsertBars(bars: readonly Bar[]): void {
    this.upserts.push([...bars]);
  }
  prependBars(bars: readonly Bar[], options?: PrependOptions): void {
    this.prepends.push({ bars, ...(options ? { options } : {}) });
  }
  resolveOlderDataRequest(hasMore: boolean): void {
    this.resolved.push(hasMore);
  }
  get last(): ChartData {
    return this.setDataCalls.at(-1)!;
  }
  /** setData calls that carried bars (a switch first clears the chart). */
  get loads(): ChartData[] {
    return this.setDataCalls.filter((d) => d.bars.length > 0);
  }
}

function setup(speed = 60) {
  const scheduler = new ManualScheduler();
  const provider = new ReplayMarketDataProvider({ dataset, scheduler, speed, tickMs: 50 });
  const chart = new RecordingChart();
  const datafeed = new ReplayDataFeed({ provider, olderPageDelayMs: 0 });
  // The standalone app's replay settings: previous candles stay until the new data is ready.
  const controller = new ChartSession({ datafeed, chart, settings: { clearOnSwitch: false } });
  return { scheduler, provider, datafeed, chart, controller };
}

describe('ChartSession + ReplayDataFeed', () => {
  test('parity: history = the newest N WHOLE sessions of official minutes, aggregated by core', async () => {
    for (const tf of ['1m', '5m', '1h', '1d'] as TimeframeId[]) {
      const { provider, chart, controller } = setup();
      await controller.select('SPY', tf);
      const instrument = provider.dataset.instrument('SPY')!;
      const now = provider.marketNow();
      const sessions = (await provider.getSessions(instrument, 0, Number.MAX_SAFE_INTEGER)).filter(
        (s) =>
          s.windows[0]!.start < now + 1 &&
          s.sessionDate >= provider.dataset.dataSessions[0]!.sessionDate,
      );
      const picked = sessions.slice(-REPLAY_SESSIONS_PER_PAGE[tf]);
      const from = picked[0]!.windows.find((w) => w.kind === 'regular')!.start;
      let minutes: Bar[] = [];
      for (let end = now + 1; ;) {
        const page = await provider.getBars({
          instrument,
          intervalMinutes: 1,
          start: from,
          end,
          limit: 10_000,
        });
        minutes = [...page.bars, ...minutes];
        if (!page.hasMore || page.bars.length === 0 || page.bars[0]!.start <= from) break;
        end = page.bars[0]!.start;
      }
      minutes = minutes.filter((m) => m.start >= from);
      const mapping = createSessionTimeScale({
        sessions: picked,
        sessionMode: 'regular',
        slot: slotSpecForTimeframe(tf),
      });
      const expected = aggregateBars({
        bars: minutes,
        sourceDurationMs: 60_000,
        target: mapping,
      }).bars;
      const shown = chart.last.bars;
      expect(shown.map((b) => [b.start, b.open, b.high, b.low, b.close, b.volume])).toEqual(
        expected.map((b) => [b.start, b.open, b.high, b.low, b.close, b.volume]),
      );
      controller.dispose();
    }
  });

  test('switching keeps the previous candles on screen until the new ones are ready (no clear)', async () => {
    const { chart, controller } = setup();
    await controller.select('SPY', '5m');
    await controller.select('NVDA', '5m');
    await controller.setTimeframe('1h');
    expect(chart.setDataCalls.every((d) => d.bars.length > 0)).toBe(true);
    expect(chart.setDataCalls).toHaveLength(3);
    controller.dispose();
  });

  test('select: history first, then live upserts of the active candle', async () => {
    const { scheduler, chart, controller } = setup();
    await controller.select('SPY', '1m');
    expect(chart.setDataCalls).toHaveLength(1); // no clearing call before the data
    const history = chart.last.bars;
    expect(history.at(-1)!.start).toBeLessThan(REPLAY_START_MS);
    expect(history.length).toBeGreaterThan(REPLAY_SESSIONS_PER_PAGE['1m'] * 300);
    scheduler.advance(3_000); // 3 market minutes
    const upserts = chart.upserts.flat();
    expect(upserts.length).toBeGreaterThan(20);
    expect(upserts.every((b) => b.start >= REPLAY_START_MS)).toBe(true);
    // Every accepted trade produced an upsert: many upserts for the same active minute.
    const firstMinute = upserts.filter((b) => b.start === REPLAY_START_MS);
    expect(firstMinute.length).toBeGreaterThan(3);
    controller.dispose();
  });

  test('buffers events that arrive while history loads, then applies them (no gap)', async () => {
    const scheduler = new ManualScheduler();
    const provider = new ReplayMarketDataProvider({ dataset, scheduler, speed: 60, tickMs: 50 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const datafeed = new ReplayDataFeed({ provider, olderPageDelayMs: 0 });
    const getBars = datafeed.getBars.bind(datafeed);
    datafeed.getBars = async (q: BarsQuery) => {
      const page = await getBars(q);
      await gate;
      return page;
    };
    const chart = new RecordingChart();
    const controller = new ChartSession({ datafeed, chart, settings: { clearOnSwitch: false } });
    const loading = controller.select('SPY', '1m');
    await Promise.resolve();
    await Promise.resolve();
    scheduler.advance(2_000); // events flow while history is still loading
    release();
    await loading;
    const bars = chart.last.bars;
    // The minutes that traded during loading are already in the first setData.
    expect(bars.some((b) => b.start === REPLAY_START_MS)).toBe(true);
    expect(controller.state()!.liveDiagnostics!.acceptedTrades).toBeGreaterThan(0);
    controller.dispose();
  });

  test('symbol switch: resubscribes; no events from the previous symbol afterwards', async () => {
    const { scheduler, chart, controller } = setup();
    await controller.select('SPY', '1m');
    scheduler.advance(1_000);
    await controller.select('NVDA', '1m');
    const mark = chart.upserts.length;
    scheduler.advance(3_000);
    const after = chart.upserts.slice(mark).flat();
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((b) => b.close < 300)).toBe(true); // NVDA ~100, SPY ~600
    expect(controller.state()!.symbol).toBe('NVDA');
    controller.dispose();
  });

  test('a superseded load is abandoned (rapid switching)', async () => {
    const { chart, controller } = setup();
    const a = controller.select('SPY', '1m');
    const b = controller.select('TSLA', '1m');
    await Promise.all([a, b]);
    expect(chart.setDataCalls).toHaveLength(1);
    expect(controller.state()!.symbol).toBe('TSLA');
    controller.dispose();
  });

  test('timeframe switch reloads canonical 4H candles; live upserts are canonical 4H buckets', async () => {
    const { scheduler, chart, controller } = setup();
    await controller.select('SPY', '1m');
    scheduler.advance(2_000);
    await controller.setTimeframe('4h');
    expect(chart.setDataCalls).toHaveLength(2); // the 1m candles stayed until the 4H ones replaced them
    const fourH = chart.last.bars;
    expect(fourH.map((b) => nyTime(b.start)).every((t) => t === '09:30' || t === '13:30')).toBe(
      true,
    );
    expect(controller.state()!.timeframe).toBe('4h');
    const mark = chart.upserts.length;
    scheduler.advance(2_000);
    const upserts = chart.upserts.slice(mark).flat();
    expect(upserts.length).toBeGreaterThan(0);
    expect(new Set(upserts.map((b) => nyTime(b.start)))).toEqual(new Set(['13:30']));
    controller.dispose();
  });

  test('older data: prepends canonical bars strictly before the loaded history', async () => {
    const { chart, controller } = setup();
    await controller.select('SPY', '15m');
    const oldest = chart.last.bars[0]!.start;
    await controller.requestOlderData({ before: oldest });
    expect(chart.prepends).toHaveLength(1);
    const { bars, options } = chart.prepends[0]!;
    expect(bars.length).toBeGreaterThan(20 * REPLAY_SESSIONS_PER_PAGE['15m']);
    expect(bars.every((b) => b.start < oldest)).toBe(true);
    // Whole sessions: the older page ends with the previous session's last bucket.
    expect(nyTime(bars.at(-1)!.start)).toBe('15:45');
    expect(options).toMatchObject({ hasMore: true });
  });

  test('older data when nothing older exists resolves with hasMore=false', async () => {
    const { chart, controller } = setup();
    await controller.select('SPY', '1d');
    for (let i = 0; i < 5; i++) await controller.requestOlderData({ before: 0 });
    expect(
      chart.resolved.at(-1) === false || chart.prepends.at(-1)?.options?.hasMore === false,
    ).toBe(true);
  });

  test('dispose stops live updates', async () => {
    const { scheduler, chart, controller } = setup();
    await controller.select('SPY', '5m');
    controller.dispose();
    const mark = chart.upserts.length;
    scheduler.advance(5_000);
    expect(chart.upserts.length).toBe(mark);
    expect(scheduler.pendingTimers()).toBe(0);
  });

  test('deterministic: the same session twice produces identical chart calls', async () => {
    const run = async () => {
      const { scheduler, chart, controller } = setup(90);
      await controller.select('AAPL', '5m');
      for (let i = 0; i < 30; i++) scheduler.advance(173);
      controller.dispose();
      return JSON.stringify({
        data: chart.loads.map((d) => d.bars),
        upserts: chart.upserts,
      });
    };
    expect(await run()).toBe(await run());
  });

  test('live minute candles match the official minutes once finals arrive', async () => {
    const { scheduler, chart, controller } = setup(120);
    await controller.select('QQQ', '1m');
    scheduler.advance(30_000); // 60 market minutes
    const finalized = new Map<number, Bar>();
    for (const b of chart.upserts.flat()) if (b.status === 'final') finalized.set(b.start, b);
    expect(finalized.size).toBeGreaterThan(40);
    const official = new Map(dataset.minuteBars('QQQ').map((b) => [b.start, b]));
    for (const [start, bar] of finalized) {
      const o = official.get(start)!;
      expect([bar.open, bar.high, bar.low, bar.close]).toEqual([o.open, o.high, o.low, o.close]);
      expect(bar.volume === o.volume || bar.volume === o.volume + 150).toBe(true); // +150 = revised
    }
    controller.dispose();
  });
});
