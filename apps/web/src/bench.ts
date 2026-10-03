/**
 * Dev-only benchmark (open /?bench). Synchronous CPU cost of:
 * 1. chart layers on SPY 1-minute replay history (full repaint, overlay-only, max zoom-out);
 * 2. the LIVE path per trade: aggregator apply + canonical re-fold, chart upsert + repaint.
 * GPU rasterization is not included. Frames are scheduled with setTimeout so it runs in a hidden tab.
 */
import { FumeChart, type ChartEnvironment } from '@fume/chart';
import {
  addNs,
  aggregateBars,
  createPriceFormatter,
  createSessionTimeScale,
  createTimeFormatter,
  epochMsToNs,
  eventTimeFromNs,
  LiveCandleAggregator,
  slotSpecForTimeframe,
  type Bar,
  type MarketEvent,
  type TimeframeId,
} from '@fume/core';
import { ReplayDataset } from '@fume/replay';

const benchEnvironment: ChartEnvironment = {
  createCanvas: (container) => container.ownerDocument.createElement('canvas'),
  devicePixelRatio: () => window.devicePixelRatio || 1,
  requestFrame: (callback) => window.setTimeout(callback, 0),
  cancelFrame: (handle) => window.clearTimeout(handle),
  observeResize: (target, callback) => {
    callback({ cssWidth: target.clientWidth, cssHeight: target.clientHeight });
    return () => {};
  },
  watchPixelRatio: () => () => {},
};

const RUNS = 60;
const MIN = 60_000;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function median(fn: () => void, runs = RUNS): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

export async function runBenchmark(root: HTMLElement): Promise<void> {
  root.innerHTML =
    '<div class="bench"><h3>Fume benchmark</h3><div class="bench-stage"></div><pre id="bench-results">running…</pre></div>';
  const stage = root.querySelector<HTMLDivElement>('.bench-stage')!;
  const output = root.querySelector<HTMLPreElement>('#bench-results')!;
  const dataset = new ReplayDataset();
  const instrument = dataset.instrument('SPY')!;
  const allMinutes = dataset.minuteBars('SPY').filter((b) => b.start < dataset.replayStartMs);
  const sessions = dataset.dataSessions;
  const mapping = (tf: TimeframeId) =>
    createSessionTimeScale({ sessions, sessionMode: 'regular', slot: slotSpecForTimeframe(tf) });
  const common = {
    formatPrice: createPriceFormatter(instrument.priceFormat),
    formatTime: createTimeFormatter(instrument.session.timezone),
    minPriceStep: 0.01,
  };
  const render: string[] = [];
  const live: string[] = [];
  const withIndicators: string[] = [];
  const addIndicators = (chart: FumeChart) => {
    for (const type of ['sma', 'ema', 'volume', 'rsi']) chart.addIndicator(type);
  };

  // 1. Rendering on 1k / 10k / all 1m bars.
  for (const size of [1_000, 10_000, Number.POSITIVE_INFINITY]) {
    const bars = Number.isFinite(size) ? allMinutes.slice(-size) : allMinutes;
    const chart = new FumeChart(stage, { ...common, timeScale: mapping('1m') }, benchEnvironment);
    await tick();
    let t = performance.now();
    chart.setData({ ...common, bars, timeScale: mapping('1m') });
    const setDataMs = performance.now() - t;
    chart.renderAll();
    const full = median(() => chart.renderAll());
    const overlayCanvas = stage.querySelectorAll('canvas')[1]!;
    const rect = overlayCanvas.getBoundingClientRect();
    const at = { clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 };
    overlayCanvas.dispatchEvent(new PointerEvent('pointermove', { ...at, pointerId: 1 }));
    const overlay = median(() => chart.renderOverlayOnly());
    for (let i = 0; i < 12; i++)
      overlayCanvas.dispatchEvent(
        new WheelEvent('wheel', { ...at, deltaY: 1000, cancelable: true }),
      );
    chart.renderAll();
    const zoomed = median(() => chart.renderAll());
    render.push(
      `${String(bars.length).padEnd(7)} setData ${setDataMs.toFixed(1).padStart(6)} ms | full ${full.toFixed(2)} ms | overlay ${overlay.toFixed(2)} ms | max zoom-out (${chart.getLastFrame()!.candles.count} candles) ${zoomed.toFixed(2)} ms`,
    );
    chart.destroy();
    await tick();
  }

  // 2. Live path: one trade at a time into the current minute, with the full 1m history loaded.
  for (const tf of ['1m', '5m', '1h', '4h', '1d'] as const) {
    const target = mapping(tf);
    const minuteScale = mapping('1m');
    const history =
      tf === '1m'
        ? allMinutes
        : aggregateBars({ bars: allMinutes, sourceDurationMs: MIN, target }).bars;
    const chart = new FumeChart(stage, { ...common, timeScale: target }, benchEnvironment);
    await tick();
    chart.setData({ ...common, bars: history, timeScale: target });
    chart.renderAll();
    const agg = new LiveCandleAggregator({ instrumentId: instrument.id, minuteScale });
    const lastSession = sessions.findIndex((s) =>
      s.windows.some(
        (w) => w.start <= allMinutes.at(-1)!.start && w.end > allMinutes.at(-1)!.start,
      ),
    );
    const seedFrom = sessions[lastSession - 1]!.windows.find((w) => w.kind === 'regular')!.start;
    agg.seedOfficialMinutes(
      allMinutes.filter((b: Bar) => b.start >= seedFrom),
      seedFrom,
    );
    const minuteStart = dataset.replayStartMs;
    let seq = 0;
    let price = allMinutes.at(-1)!.close;
    const makeTrade = (): MarketEvent => {
      price = Math.round((price + (seq % 2 ? 0.01 : -0.01)) * 100) / 100;
      const ns = addNs(epochMsToNs(minuteStart), BigInt(1_000_000 + seq * 10_000));
      return {
        kind: 'trade',
        trade: {
          instrumentId: instrument.id,
          time: eventTimeFromNs(ns),
          price,
          size: 10,
          ingestSeq: seq++,
        },
      };
    };
    let upserts: Bar[] = [];
    const aggMs = median(() => {
      upserts = agg.foldBuckets(target, agg.apply([makeTrade()]));
    }, 400);
    const chartMs = median(() => {
      chart.upsertBars(agg.foldBuckets(target, agg.apply([makeTrade()])));
      chart.render();
    }, 400);
    live.push(
      `${tf.padEnd(3)} history ${String(history.length).padStart(6)} bars | aggregator apply+fold ${aggMs.toFixed(3)} ms | apply+fold+chart upsert+repaint ${chartMs.toFixed(3)} ms | upserts/trade ${upserts.length}`,
    );
    chart.destroy();
    await tick();
  }

  // 3. The same paths with SMA 20, EMA 20, Volume and RSI 14 (two overlays, two panes).
  {
    // setData + first render (which calculates every indicator over all bars), measured in
    // alternating pairs with and without indicators so JIT/GC noise hits both alike.
    const firstRender = async (indicators: boolean) => {
      const c = new FumeChart(stage, { ...common, timeScale: mapping('1m') }, benchEnvironment);
      if (indicators) addIndicators(c);
      await tick();
      const t = performance.now();
      c.setData({ ...common, bars: allMinutes, timeScale: mapping('1m') });
      c.renderAll();
      const ms = performance.now() - t;
      c.destroy();
      await tick();
      return ms;
    };
    const plain: number[] = [];
    const calc: number[] = [];
    for (let i = 0; i < 5; i++) {
      plain.push(await firstRender(false));
      calc.push(await firstRender(true));
    }
    const mid = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
    const chart = new FumeChart(stage, { ...common, timeScale: mapping('1m') }, benchEnvironment);
    addIndicators(chart);
    await tick();
    chart.setData({ ...common, bars: allMinutes, timeScale: mapping('1m') });
    chart.renderAll();
    const firstMs = mid(calc);
    const plainMs = mid(plain);
    const full = median(() => chart.renderAll());
    const overlayCanvas = stage.querySelectorAll('canvas')[1]!;
    const rect = overlayCanvas.getBoundingClientRect();
    overlayCanvas.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: rect.left + rect.width * 0.5,
        clientY: rect.top + rect.height * 0.3,
        pointerId: 1,
      }),
    );
    const overlay = median(() => chart.renderOverlayOnly());
    withIndicators.push(
      `${String(allMinutes.length).padEnd(7)} setData + first render: without ${plainMs.toFixed(1)} ms, with indicators (full calc) ${firstMs.toFixed(1)} ms (median of 5) | full ${full.toFixed(2)} ms | overlay ${overlay.toFixed(2)} ms`,
    );
    // Live: suffix invalidation, so each update recomputes only the last position.
    const last = allMinutes.at(-1)!;
    const next = mapping('1m').slotStart(mapping('1m').toSlot(last.start)! + 1);
    let close = last.close;
    const liveMs = median(() => {
      close = Math.round((close + 0.01) * 100) / 100;
      chart.upsertBars([{ ...last, start: next, close, high: Math.max(last.high, close) }]);
      chart.render();
    }, 400);
    withIndicators.push(
      `1m  history ${String(allMinutes.length).padStart(6)} bars | live bar upsert+recalc+repaint ${liveMs.toFixed(3)} ms`,
    );
    chart.destroy();
    await tick();
  }

  const environment = {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    stage: `${stage.clientWidth}x${stage.clientHeight} CSS px`,
  };
  output.textContent = [
    JSON.stringify(environment, null, 2),
    '',
    'RENDER',
    ...render,
    '',
    'LIVE (per trade, median)',
    ...live,
    '',
    'INDICATORS (SMA 20, EMA 20, Volume, RSI 14)',
    ...withIndicators,
  ].join('\n');
}
