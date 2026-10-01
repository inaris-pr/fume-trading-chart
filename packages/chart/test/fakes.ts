import {
  createPriceFormatter,
  createSessionTimeScale,
  createTimeFormatter,
  resolveWeeklySessions,
  type Bar,
  type InstrumentId,
  type SessionWindow,
  type TimeScaleMapping,
} from '@fume/core';
import { generateSyntheticBars } from '@fume/core/fixtures';
import type { ChartEnvironment, ElementSize } from '../src/environment.ts';

export const MIN = 60_000;

/** Records every draw call; implements the PaintContext subset plus getContext plumbing. */
export class RecordingContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  readonly rects: { x: number; y: number; w: number; h: number; style: string }[] = [];
  readonly texts: { text: string; x: number; y: number; style: string; align: CanvasTextAlign }[] =
    [];
  clears = 0;
  // Path drawing (drawing layer): every stroke()/fill() records the current path and style.
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  readonly strokes: (RecordedPath & { style: string; width: number; dash: number[] })[] = [];
  readonly fills: (RecordedPath & { style: string })[] = [];
  private path: RecordedPath = emptyPath();
  private dash: number[] = [];
  setTransform(): void {}
  clearRect(): void {
    this.clears++;
  }
  /** Forget recorded calls (e.g. between two renders). */
  reset(): void {
    this.rects.length = 0;
    this.texts.length = 0;
    this.strokes.length = 0;
    this.fills.length = 0;
    this.clears = 0;
  }
  save(): void {}
  restore(): void {}
  beginPath(): void {
    this.path = emptyPath();
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.path.rects.push({ x, y, w, h });
  }
  clip(): void {}
  moveTo(x: number, y: number): void {
    this.path.points.push({ x, y });
  }
  lineTo(x: number, y: number): void {
    this.path.points.push({ x, y });
  }
  arc(x: number, y: number, r: number): void {
    this.path.arcs.push({ x, y, r });
  }
  setLineDash(segments: number[]): void {
    this.dash = [...segments];
  }
  stroke(): void {
    this.strokes.push({
      ...clonePath(this.path),
      style: String(this.strokeStyle),
      width: this.lineWidth,
      dash: [...this.dash],
    });
  }
  fill(): void {
    this.fills.push({ ...clonePath(this.path), style: String(this.fillStyle) });
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rects.push({ x, y, w, h, style: String(this.fillStyle) });
  }
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y, style: String(this.fillStyle), align: this.textAlign });
  }
  measureText(text: string): TextMetrics {
    return { width: text.length * 7 } as TextMetrics;
  }
}

export interface RecordedPath {
  points: { x: number; y: number }[];
  arcs: { x: number; y: number; r: number }[];
  rects: { x: number; y: number; w: number; h: number }[];
}

const emptyPath = (): RecordedPath => ({ points: [], arcs: [], rects: [] });
const clonePath = (p: RecordedPath): RecordedPath => ({
  points: [...p.points],
  arcs: [...p.arcs],
  rects: [...p.rects],
});

type Listener = (event: unknown) => void;

export interface FakeCanvas {
  width: number;
  height: number;
  style: Record<string, string>;
  removed: boolean;
  ctx: RecordingContext;
  listeners: Map<string, Set<Listener>>;
  captured: Set<number>;
  getContext(): RecordingContext;
  remove(): void;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  setPointerCapture(id: number): void;
  releasePointerCapture(id: number): void;
  hasPointerCapture(id: number): boolean;
  tabIndex: number;
  focused: boolean;
  focus(): void;
  /** Total registered listeners across all event types. */
  listenerCount(): number;
  /** Dispatches a fake event to the registered listeners; returns whether preventDefault ran. */
  dispatch(type: string, event: Record<string, unknown>): boolean;
}

export function fakeCanvas(): FakeCanvas {
  const ctx = new RecordingContext();
  const listeners = new Map<string, Set<Listener>>();
  const captured = new Set<number>();
  return {
    width: 0,
    height: 0,
    style: {},
    removed: false,
    ctx,
    listeners,
    captured,
    getContext: () => ctx,
    remove() {
      this.removed = true;
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    setPointerCapture: (id) => void captured.add(id),
    releasePointerCapture: (id) => void captured.delete(id),
    hasPointerCapture: (id) => captured.has(id),
    tabIndex: 0,
    focused: false,
    focus() {
      this.focused = true;
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    dispatch(type, event) {
      let prevented = false;
      const e = { ...event, preventDefault: () => (prevented = true) };
      for (const listener of listeners.get(type) ?? []) listener(e);
      return prevented;
    },
  };
}

/** Pointer event fields the chart reads. */
export const pointer = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
  offsetX: x,
  offsetY: y,
  pointerId: 1,
  button: 0,
  ...extra,
});

/** Fake browser: manual animation frames, manual resize, disposers that are tracked. */
export class FakeEnvironment implements ChartEnvironment {
  dpr = 1;
  readonly canvases: FakeCanvas[] = [];
  readonly frames = new Map<number, () => void>();
  resizeCallback: ((size: ElementSize) => void) | null = null;
  pixelRatioCallback: (() => void) | null = null;
  activeObservers = 0;
  activeRatioWatchers = 0;
  private nextHandle = 1;

  createCanvas(): HTMLCanvasElement {
    const canvas = fakeCanvas();
    this.canvases.push(canvas);
    return canvas as unknown as HTMLCanvasElement;
  }
  devicePixelRatio(): number {
    return this.dpr;
  }
  requestFrame(callback: () => void): number {
    const handle = this.nextHandle++;
    this.frames.set(handle, callback);
    return handle;
  }
  cancelFrame(handle: number): void {
    this.frames.delete(handle);
  }
  observeResize(_target: HTMLElement, callback: (size: ElementSize) => void): () => void {
    this.resizeCallback = callback;
    this.activeObservers++;
    return () => {
      this.activeObservers--;
      this.resizeCallback = null;
    };
  }
  watchPixelRatio(callback: () => void): () => void {
    this.pixelRatioCallback = callback;
    this.activeRatioWatchers++;
    return () => {
      this.activeRatioWatchers--;
      this.pixelRatioCallback = null;
    };
  }
  /** Runs all pending animation frames; returns how many ran. */
  flushFrames(): number {
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const f of pending) f();
    return pending.length;
  }
}

export function fakeContainer(): HTMLElement & { children: unknown[] } {
  const children: unknown[] = [];
  return {
    children,
    appendChild: (node: unknown) => children.push(node),
  } as unknown as HTMLElement & {
    children: unknown[];
  };
}

const weekdays = (start: string, end: string): SessionWindow[] =>
  ([1, 2, 3, 4, 5] as const).map((startDay) => ({ startDay, start, end }));

/** 10 RTH sessions of deterministic 5m bars (780 slots) plus the mapping and formatters. */
export function demoSeries(options: { dropIndices?: number[]; count?: number } = {}): {
  bars: Bar[];
  mapping: TimeScaleMapping;
  formatPrice: (p: number) => string;
  formatTime: ReturnType<typeof createTimeFormatter>;
} {
  const sessions = resolveWeeklySessions({
    instrumentId: 'eq:TEST' as InstrumentId,
    spec: {
      timezone: 'America/New_York',
      regular: weekdays('09:30', '16:00'),
      extended: [],
      calendarId: 'TEST',
    },
    from: '2026-03-02',
    to: '2026-03-20',
  });
  const bars = generateSyntheticBars({
    seed: 7,
    sessions,
    sessionMode: 'regular',
    durationMs: 5 * MIN,
    count: options.count ?? 780,
    startPrice: 574.25,
    tickSize: 0.01,
    walk: 'multiplicative',
    volatility: 0.0008,
    gapVolatility: 0.0045,
    dojiProbability: 0.05,
    longWickProbability: 0.03,
    baseVolume: 42_000,
    ...(options.dropIndices ? { dropIndices: options.dropIndices } : {}),
  });
  return {
    bars,
    mapping: createSessionTimeScale({
      sessions,
      sessionMode: 'regular',
      slot: { kind: 'intraday', durationMs: 5 * MIN },
    }),
    formatPrice: createPriceFormatter({ kind: 'decimal', decimals: 2 }),
    formatTime: createTimeFormatter('America/New_York'),
  };
}

export function bar(start: number, open: number, high: number, low: number, close: number): Bar {
  return { start, open, high, low, close, volume: 1, status: 'final', revision: 0 };
}
