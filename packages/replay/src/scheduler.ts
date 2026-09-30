/**
 * Time sources for the replay. Production uses timers; tests use ManualScheduler and advance time
 * explicitly, so no test depends on wall-clock timing.
 */
import type { MarketSession } from '@fume/core';

export interface ReplayScheduler {
  /** Monotonic real time in ms. */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface TimerGlobals {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  performance?: { now(): number };
}

/** Real timers (browser or Node). */
export function timerScheduler(): ReplayScheduler {
  const g = globalThis as unknown as TimerGlobals;
  return {
    now: () => (g.performance ? g.performance.now() : Date.now()),
    setTimeout: (callback, ms) => g.setTimeout(callback, ms),
    clearTimeout: (handle) => g.clearTimeout(handle),
  };
}

/** Deterministic scheduler: time only moves when advance() is called. */
export class ManualScheduler implements ReplayScheduler {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { due: this.time + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  /** Advances time by `ms`, running due timers in (due time, creation) order. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | null = null;
      let next: { due: number; callback: () => void } | null = null;
      for (const [id, timer] of this.timers) {
        if (
          timer.due <= target &&
          (!next || timer.due < next.due || (timer.due === next.due && id < nextId!))
        ) {
          next = timer;
          nextId = id;
        }
      }
      if (!next || nextId === null) break;
      this.timers.delete(nextId);
      this.time = Math.max(this.time, next.due);
      next.callback();
    }
    this.time = target;
  }
}

/**
 * Market-time clock for the replay: advances `speed` market-ms per real ms while a session window
 * is open, and jumps across closed time (nights, weekends) instantly. Stops at the end of the last
 * window. Monotonic and deterministic for a given sequence of real times.
 */
export class ReplayClock {
  private readonly windows: { start: number; end: number }[];
  private cursor: number;
  private lastReal: number;

  constructor(
    sessions: readonly MarketSession[],
    startMs: number,
    readonly speed: number,
    realNow: number,
  ) {
    if (!(speed > 0)) throw new Error('Replay speed must be positive');
    this.windows = sessions
      .flatMap((s) => s.windows.filter((w) => w.kind === 'regular'))
      .map((w) => ({ start: w.start, end: w.end }))
      .sort((a, b) => a.start - b.start);
    this.cursor = this.snapForward(startMs);
    this.lastReal = realNow;
  }

  /** Market time at real time `realNow` (never decreases). */
  marketTime(realNow: number): number {
    const elapsed = Math.max(0, realNow - this.lastReal);
    this.lastReal = Math.max(this.lastReal, realNow);
    let remaining = elapsed * this.speed;
    while (remaining > 0) {
      const w = this.windowAt(this.cursor);
      if (!w) break; // past the last window
      const step = Math.min(remaining, w.end - this.cursor);
      this.cursor += step;
      remaining -= step;
      if (this.cursor >= w.end) {
        const next = this.windows.find((x) => x.start >= w.end);
        if (!next) break;
        this.cursor = next.start; // skip closed time instantly
      }
    }
    return this.cursor;
  }

  /** True once the cursor has passed the last open window. */
  finished(): boolean {
    const last = this.windows[this.windows.length - 1];
    return !last || this.cursor >= last.end;
  }

  private windowAt(t: number): { start: number; end: number } | undefined {
    return this.windows.find((w) => t >= w.start && t < w.end);
  }

  private snapForward(t: number): number {
    if (this.windowAt(t)) return t;
    const next = this.windows.find((w) => w.start >= t);
    return next ? next.start : t;
  }
}
