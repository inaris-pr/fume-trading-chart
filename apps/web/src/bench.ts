/**
 * Dev-only render benchmark (open /?bench). Measures the synchronous CPU cost of
 * FumeChart.render() (frame model + Canvas 2D commands) at several dataset sizes, in the default
 * view and with every bar squeezed into view. GPU rasterization is not included.
 */
import { FumeChart, type ChartEnvironment } from '@fume/chart';
import { buildDemoDataset } from './demo/dataset.ts';

/**
 * Benchmark environment: sizes the canvas synchronously from layout and schedules frames with
 * setTimeout, so the run also works in a background/hidden tab where requestAnimationFrame and
 * ResizeObserver callbacks are paused. Rendering itself is the production code path.
 */
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

interface Row {
  bars: number;
  view: 'default' | 'all bars visible';
  drawnCandles: number;
  indexMs: number;
  firstRenderMs: number;
  redrawMedianMs: number;
  redrawP95Ms: number;
}

const SIZES = [500, 1_000, 10_000] as const;
const REDRAWS = 60;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function timeRedraws(chart: FumeChart): { median: number; p95: number } {
  const samples: number[] = [];
  for (let i = 0; i < REDRAWS; i++) {
    const t = performance.now();
    chart.render();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return {
    median: samples[Math.floor(samples.length / 2)]!,
    p95: samples[Math.floor(samples.length * 0.95)]!,
  };
}

export async function runBenchmark(root: HTMLElement): Promise<void> {
  root.innerHTML =
    '<div class="bench"><h3>Fume render benchmark</h3><div class="bench-stage"></div><pre id="bench-results">running…</pre></div>';
  const stage = root.querySelector<HTMLDivElement>('.bench-stage')!;
  const output = root.querySelector<HTMLPreElement>('#bench-results')!;
  const rows: Row[] = [];

  for (const size of SIZES) {
    const data = buildDemoDataset('spy', size);
    const chart = new FumeChart(
      stage,
      {
        timeScale: data.timeScale,
        formatPrice: data.formatPrice,
        formatTime: data.formatTime,
        minPriceStep: data.minPriceStep,
      },
      benchEnvironment,
    );
    await tick();

    let t = performance.now();
    chart.setBars(data.bars);
    const indexMs = performance.now() - t;
    t = performance.now();
    chart.render();
    const firstRenderMs = performance.now() - t;
    const defaultRun = timeRedraws(chart);
    const defaultFrame = chart.getLastFrame()!;
    rows.push({
      bars: data.bars.length,
      view: 'default',
      drawnCandles: defaultFrame.candles.count,
      indexMs,
      firstRenderMs,
      redrawMedianMs: defaultRun.median,
      redrawP95Ms: defaultRun.p95,
    });

    chart.setOptions({
      barSpacing: defaultFrame.layout.plot.width / data.bars.length,
      rightOffset: 0,
    });
    t = performance.now();
    chart.render();
    const firstAll = performance.now() - t;
    const allRun = timeRedraws(chart);
    rows.push({
      bars: data.bars.length,
      view: 'all bars visible',
      drawnCandles: chart.getLastFrame()!.candles.count,
      indexMs: 0,
      firstRenderMs: firstAll,
      redrawMedianMs: allRun.median,
      redrawP95Ms: allRun.p95,
    });
    await tick();
    chart.destroy();
  }

  const environment = {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    stage: `${stage.clientWidth}x${stage.clientHeight} CSS px`,
  };
  const fmt = (n: number) => n.toFixed(2).padStart(8);
  output.textContent = [
    JSON.stringify(environment, null, 2),
    '',
    'bars    view               drawn  index(ms) first(ms) median(ms) p95(ms)',
    ...rows.map(
      (r) =>
        `${String(r.bars).padEnd(7)} ${r.view.padEnd(18)} ${String(r.drawnCandles).padStart(5)} ${fmt(r.indexMs)} ${fmt(r.firstRenderMs)} ${fmt(r.redrawMedianMs)} ${fmt(r.redrawP95Ms)}`,
    ),
  ].join('\n');
  (window as unknown as { __fumeBench: unknown }).__fumeBench = { environment, rows };
}
