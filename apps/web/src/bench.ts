/**
 * Dev-only render benchmark (open /?bench). Measures the synchronous CPU cost of the chart's
 * layers on SPY 1-minute demo data: full repaint (frame model + candles), overlay-only repaint
 * (crosshair move), and full repaint at maximum zoom-out. GPU rasterization is not included.
 */
import { FumeChart, type ChartEnvironment } from '@fume/chart';
import { DemoCatalog } from './demo/catalog.ts';

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
  setDataMs: number;
  fullMedianMs: number;
  overlayMedianMs: number;
  zoomedOutCandles: number;
  zoomedOutMedianMs: number;
}

const SIZES = [1_000, 10_000, Number.POSITIVE_INFINITY] as const;
const RUNS = 60;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function median(fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

export async function runBenchmark(root: HTMLElement): Promise<void> {
  root.innerHTML =
    '<div class="bench"><h3>Fume render benchmark</h3><div class="bench-stage"></div><pre id="bench-results">running…</pre></div>';
  const stage = root.querySelector<HTMLDivElement>('.bench-stage')!;
  const output = root.querySelector<HTMLPreElement>('#bench-results')!;
  const catalog = new DemoCatalog();
  const spy = catalog.get('SPY', '1m');
  const rows: Row[] = [];

  for (const size of SIZES) {
    const bars = Number.isFinite(size) ? spy.bars.slice(-size) : spy.bars;
    const chart = new FumeChart(stage, spy, benchEnvironment);
    await tick();
    let t = performance.now();
    chart.setData({ ...spy, bars });
    const setDataMs = performance.now() - t;
    chart.renderAll();
    const fullMedianMs = median(() => chart.renderAll());

    // Put the crosshair in the middle of the plot, then time overlay-only repaints.
    const overlay = stage.querySelectorAll('canvas')[1]!;
    const rect = overlay.getBoundingClientRect();
    const at = { clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 };
    overlay.dispatchEvent(new PointerEvent('pointermove', { ...at, pointerId: 1 }));
    const overlayMedianMs = median(() => chart.renderOverlayOnly());

    // Zoom out to the minimum bar spacing with wheel events at the plot center.
    for (let i = 0; i < 12; i++) {
      overlay.dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: 1000, cancelable: true }));
    }
    chart.renderAll();
    const zoomedOutCandles = chart.getLastFrame()!.candles.count;
    const zoomedOutMedianMs = median(() => chart.renderAll());
    rows.push({
      bars: bars.length,
      setDataMs,
      fullMedianMs,
      overlayMedianMs,
      zoomedOutCandles,
      zoomedOutMedianMs,
    });
    chart.destroy();
    await tick();
  }

  const environment = {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    stage: `${stage.clientWidth}x${stage.clientHeight} CSS px`,
  };
  const fmt = (n: number) => n.toFixed(2).padStart(9);
  output.textContent = [
    JSON.stringify(environment, null, 2),
    '',
    'bars     setData(ms) full(ms)  overlay(ms) zoomedOut:candles full(ms)',
    ...rows.map(
      (r) =>
        `${String(r.bars).padEnd(8)}${fmt(r.setDataMs)}${fmt(r.fullMedianMs)}${fmt(r.overlayMedianMs)}   ${String(r.zoomedOutCandles).padStart(8)}${fmt(r.zoomedOutMedianMs)}`,
    ),
  ].join('\n');
  (window as unknown as { __fumeBench: unknown }).__fumeBench = { environment, rows };
}
