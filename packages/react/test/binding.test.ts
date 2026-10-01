/**
 * ChartViewBinding (the lifecycle unit behind <FumeChartView />) without a DOM: the chart renders
 * into the chart package's FakeEnvironment, data comes from the real ReplayDataFeed (manual clock)
 * or the real FumeApiDataFeed over a fake backend + fake WebSocket. Covers prop application,
 * StrictMode-style create/dispose/create, datafeed replacement, sharing one feed between views,
 * the imperative operations, and that nothing leaks (sessions, subscriptions, sockets, resize
 * observers, pixel-ratio watchers, canvas listeners, animation frames).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ManualScheduler, ReplayDataset, ReplayMarketDataProvider } from '@fume/replay';
import { FumeApiDataFeed, ReplayDataFeed } from '@fume/datafeed';
import type { ChartStatus } from '@fume/datafeed';
import type { Drawing } from '@fume/chart';
import { FakeEnvironment, fakeContainer } from '../../chart/test/fakes.ts';
import { fakeFetch, FakeSocket } from '../../datafeed/test/fake-backend.ts';
import { ChartViewBinding } from '../src/binding.ts';

const dataset = new ReplayDataset();

function replayFeed() {
  const scheduler = new ManualScheduler();
  const provider = new ReplayMarketDataProvider({ dataset, scheduler, speed: 60, tickMs: 50 });
  const openStream = vi.spyOn(provider, 'openStream');
  const feed = new ReplayDataFeed({ provider, olderPageDelayMs: 0 });
  const resolve = vi.spyOn(feed, 'resolveInstrument');
  const getBars = vi.spyOn(feed, 'getBars');
  return { scheduler, provider, feed, openStream, resolve, getBars };
}

/** Live listeners on all canvases the environment created. */
function liveListeners(env: FakeEnvironment): number {
  let n = 0;
  for (const c of env.canvases) {
    for (const set of (
      c as unknown as { listeners: Map<string, Set<unknown>> }
    ).listeners.values()) {
      n += set.size;
    }
  }
  return n;
}

function mount(
  feed: ConstructorParameters<typeof ChartViewBinding>[1]['datafeed'],
  env = new FakeEnvironment(),
) {
  const statuses: ChartStatus[] = [];
  const binding = new ChartViewBinding(fakeContainer(), {
    datafeed: feed,
    environment: env,
    onStatus: (s) => statuses.push(s),
  });
  return { binding, env, statuses };
}

describe('prop application', () => {
  test('apply: first call selects; same target is a no-op; timeframe change only switches timeframe', async () => {
    const r = replayFeed();
    const { binding, statuses } = mount(r.feed);
    await binding.apply({ symbol: 'SPY', assetClass: 'equity', timeframe: '5m' });
    expect(r.resolve).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toMatchObject({ kind: 'ready', symbol: 'SPY', timeframe: '5m' });
    const bars = r.getBars.mock.calls.length;
    await binding.apply({ symbol: 'SPY', assetClass: 'equity', timeframe: '5m' }); // re-render
    expect(r.getBars.mock.calls.length).toBe(bars);
    await binding.apply({ symbol: 'SPY', assetClass: 'equity', timeframe: '1h' });
    expect(r.resolve).toHaveBeenCalledTimes(1); // cached instrument, no re-resolve
    expect(binding.state()).toMatchObject({ symbol: 'SPY', timeframe: '1h', streaming: true });
    await binding.apply({ symbol: 'NVDA', assetClass: 'equity', timeframe: '1h' });
    expect(binding.state()).toMatchObject({ symbol: 'NVDA', timeframe: '1h' });
    binding.dispose();
  });

  test('imperative operations: setTimeframe, selectInstrument, goToLatest, state', async () => {
    const r = replayFeed();
    const { binding } = mount(r.feed);
    expect(binding.state()).toBeNull();
    await binding.apply({ symbol: 'SPY', assetClass: 'equity', timeframe: '5m' });
    await binding.setTimeframe('15m');
    expect(binding.state()).toMatchObject({ symbol: 'SPY', timeframe: '15m' });
    await binding.selectInstrument('AAPL');
    expect(binding.state()).toMatchObject({ symbol: 'AAPL', timeframe: '15m' });
    expect(typeof binding.goToLatest()).toBe('boolean');
    expect(binding.state()!.followingLatest).toBe(true);
    binding.dispose();
    expect(binding.state()).toBeNull();
    expect(binding.goToLatest()).toBe(false);
  });
});

describe('lifecycle: nothing leaks', () => {
  test('dispose releases the session subscription, observers, watchers, listeners and frames', async () => {
    const r = replayFeed();
    const env = new FakeEnvironment();
    const { binding } = mount(r.feed, env);
    await binding.apply({ symbol: 'SPY', assetClass: 'equity', timeframe: '1m' });
    expect(env.activeObservers).toBe(1);
    expect(env.activeRatioWatchers).toBe(1);
    expect(liveListeners(env)).toBeGreaterThan(0);
    expect(r.scheduler.pendingTimers()).toBeGreaterThan(0); // live replay stream
    binding.dispose();
    expect(env.activeObservers).toBe(0);
    expect(env.activeRatioWatchers).toBe(0);
    expect(liveListeners(env)).toBe(0);
    expect(env.frames.size).toBe(0);
    expect(r.scheduler.pendingTimers()).toBe(0); // the last subscription closed the stream
    binding.dispose(); // idempotent
  });

  test('StrictMode-style mount -> unmount -> remount leaves exactly one live view', async () => {
    const r = replayFeed();
    const env = new FakeEnvironment();
    const first = mount(r.feed, env).binding;
    void first.apply({ symbol: 'SPY', assetClass: 'equity', timeframe: '5m' });
    first.dispose(); // StrictMode unmounts before the load finishes
    const second = mount(r.feed, env).binding;
    await second.apply({ symbol: 'SPY', assetClass: 'equity', timeframe: '5m' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(env.activeObservers).toBe(1);
    expect(second.state()).toMatchObject({ symbol: 'SPY', streaming: true });
    expect(first.state()).toBeNull();
    // A late completion of the first load never touches the disposed view.
    r.scheduler.advance(2_000);
    expect(first.state()).toBeNull();
    second.dispose();
    expect(env.activeObservers).toBe(0);
    expect(r.scheduler.pendingTimers()).toBe(0);
  });

  test('datafeed replacement: the old feed loses its subscription, the new one gets it', async () => {
    const a = replayFeed();
    const b = replayFeed();
    const env = new FakeEnvironment();
    const v1 = mount(a.feed, env).binding;
    await v1.apply({ symbol: 'SPY', assetClass: 'equity', timeframe: '5m' });
    v1.dispose();
    const v2 = mount(b.feed, env).binding;
    await v2.apply({ symbol: 'SPY', assetClass: 'equity', timeframe: '5m' });
    expect(a.scheduler.pendingTimers()).toBe(0);
    expect(b.scheduler.pendingTimers()).toBeGreaterThan(0);
    expect(env.activeObservers).toBe(1);
    v2.dispose();
  });
});

describe('drawings pass through to the chart engine', () => {
  const line = (id: string): Drawing => ({
    id,
    type: 'horizontal-line',
    anchors: [{ time: 0, price: 500 }],
    style: { color: '#fff', lineWidth: 1, lineStyle: 'solid' },
    visible: true,
    locked: false,
  });

  test('initial drawings, host replacement, no-op for the reported set, tool and user edits', async () => {
    const r = replayFeed();
    const env = new FakeEnvironment();
    const initial = [line('a')];
    const changes: (readonly Drawing[])[] = [];
    const tools: string[] = [];
    const binding = new ChartViewBinding(fakeContainer(), {
      datafeed: r.feed,
      environment: env,
      drawings: initial,
      onDrawingsChange: (d) => changes.push(d),
      onDrawingToolChange: (t) => tools.push(t),
    });
    expect(binding.getDrawings()).toBe(initial);
    await binding.apply({ symbol: 'SPY', assetClass: 'equity', timeframe: '5m' });
    env.resizeCallback!({ cssWidth: 800, cssHeight: 500 });
    env.flushFrames();

    // A user edit through the engine's own pointer handling (horizontal line: one click).
    binding.setDrawingTool('horizontal-line');
    expect(binding.getDrawingTool()).toBe('horizontal-line');
    const overlay = env.canvases[1]!;
    overlay.dispatch('pointerdown', { offsetX: 300, offsetY: 200, pointerId: 1, button: 0 });
    overlay.dispatch('pointerup', { offsetX: 300, offsetY: 200, pointerId: 1, button: 0 });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toHaveLength(2);
    expect(tools).toEqual(['horizontal-line', 'cursor']);

    // Passing the reported set back (a controlled prop) does nothing; a new set replaces.
    binding.setDrawings(changes[0]!);
    expect(binding.getDrawings()).toBe(changes[0]);
    const replaced = [line('z')];
    binding.setDrawings(replaced);
    expect(binding.getDrawings()).toBe(replaced);
    expect(changes).toHaveLength(1); // host replacements are not echoed

    binding.dispose();
    binding.setDrawingTool('rectangle');
    expect(tools).toEqual(['horizontal-line', 'cursor']);
  });
});

describe('a shared FumeApiDataFeed stays shareable', () => {
  beforeEach(() => {
    vi.stubGlobal('location', {
      href: 'http://localhost:5173/?source=api',
      host: 'localhost:5173',
      protocol: 'http:',
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  test('two views (NQ 5m + ES 1h) on one feed: one socket, two subscriptions; disposing views never closes the shared feed early', async () => {
    const sockets: FakeSocket[] = [];
    const feed = new FumeApiDataFeed({
      fetch: fakeFetch,
      createWebSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
    });
    const nq = mount(feed).binding;
    const es = mount(feed).binding;
    await Promise.all([
      nq.apply({ symbol: 'NQ', assetClass: 'future', timeframe: '5m' }),
      es.apply({ symbol: 'ES', assetClass: 'future', timeframe: '1h' }),
    ]);
    sockets[0]!.open();
    expect(sockets).toHaveLength(1);
    expect(feed.streamDiagnostics()['futures-delayed']).toMatchObject({
      subscriptions: 2,
      socketsCreated: 1,
    });
    nq.dispose();
    expect(feed.streamDiagnostics()['futures-delayed']).toMatchObject({
      subscriptions: 1,
      open: true,
    });
    // A new view on the same feed reuses the open socket.
    const again = mount(feed).binding;
    await again.apply({ symbol: 'NQ', assetClass: 'future', timeframe: '15m' });
    expect(sockets).toHaveLength(1);
    expect(feed.streamDiagnostics()['futures-delayed']).toMatchObject({ subscriptions: 2 });
    es.dispose();
    again.dispose();
    expect(feed.streamDiagnostics()['futures-delayed']).toMatchObject({ subscriptions: 0 });
    feed.dispose(); // the host owns the feed
    expect(sockets[0]!.readyState).toBe(3);
  });
});
