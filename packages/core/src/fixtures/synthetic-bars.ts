/**
 * Deterministic synthetic OHLCV bars on session-aligned buckets. Same options => identical bars,
 * and a shorter `count` is always an exact prefix of a longer one (same seed).
 */
import type { Bar, MarketSession, SessionMode } from '../market-data.ts';
import { selectWindows } from '../sessions.ts';
import { createRng } from './random.ts';

export interface SyntheticBarsOptions {
  seed: number;
  sessions: readonly MarketSession[];
  sessionMode: SessionMode;
  /** Intraday bucket duration. */
  durationMs: number;
  /** Stop after this many bars (before `dropIndices` are removed). */
  count: number;
  startPrice: number;
  /** Prices are rounded to this grid, e.g. 0.01. */
  tickSize: number;
  /** multiplicative: log-normal returns (prices stay positive); additive: can cross zero. */
  walk: 'multiplicative' | 'additive';
  /** Per-bar return sd (relative for multiplicative, absolute price for additive). */
  volatility: number;
  /** Extra sd applied at each session open (overnight gap). */
  gapVolatility: number;
  /** Per-bar drift (relative or absolute, like volatility). */
  drift?: number;
  /** Probability that a bar is forced to open === close. */
  dojiProbability: number;
  /** Probability of a long wick on one side. */
  longWickProbability: number;
  baseVolume: number;
  /** Bar indices (in generation order) to omit, producing genuine in-session gaps. */
  dropIndices?: readonly number[];
}

/** Volatility regimes; a regime switch happens with probability REGIME_SWITCH per bar. */
const REGIMES = [0.6, 1, 1.9] as const;
const REGIME_SWITCH = 0.02;

export function generateSyntheticBars(options: SyntheticBarsOptions): Bar[] {
  const rng = createRng(options.seed);
  const decimals = decimalsOf(options.tickSize);
  const round = (p: number): number =>
    Number((Math.round(p / options.tickSize) * options.tickSize).toFixed(decimals));
  const multiplicative = options.walk === 'multiplicative';
  const move = (price: number, sd: number, z: number, drift: number): number =>
    multiplicative ? price * Math.exp(sd * z + drift) : price + sd * z + drift;
  const floorPrice = multiplicative ? options.tickSize : Number.NEGATIVE_INFINITY;
  const drop = new Set(options.dropIndices ?? []);

  const bars: Bar[] = [];
  let generated = 0;
  let close = round(options.startPrice);
  let regime = 1;

  for (const [sessionIndex, session] of options.sessions.entries()) {
    const starts = bucketStarts(session, options.sessionMode, options.durationMs);
    for (const [i, start] of starts.entries()) {
      if (generated >= options.count) return bars;
      // Fixed number of draws per bar, regardless of branches, keeps the sequence stable.
      const zRegime = rng.next();
      const zRegimePick = rng.next();
      const zGap = rng.normal();
      const zReturn = rng.normal();
      const zWickUp = Math.abs(rng.normal());
      const zWickDown = Math.abs(rng.normal());
      const uDoji = rng.next();
      const uLongWick = rng.next();
      const uLongWickSide = rng.next();
      const zVolume = rng.normal();

      if (zRegime < REGIME_SWITCH) regime = Math.floor(zRegimePick * REGIMES.length);
      const regimeScale = REGIMES[regime] ?? 1;
      // U-shaped intraday activity: busier near the open and close.
      const x = starts.length > 1 ? i / (starts.length - 1) : 0.5;
      const activity = 1 + 0.9 * (2 * x - 1) ** 2;
      const sd = options.volatility * regimeScale * activity;
      const drift = options.drift ?? 0;

      let open = close;
      if (i === 0 && sessionIndex > 0) open = move(open, options.gapVolatility, zGap, 0);
      open = Math.max(floorPrice, round(open));
      let barClose = Math.max(floorPrice, round(move(open, sd, zReturn, drift)));
      if (uDoji < options.dojiProbability) barClose = open;

      const wickUnit = multiplicative ? open * sd * 0.6 : sd * 0.6;
      let wickUp = zWickUp * wickUnit;
      let wickDown = zWickDown * wickUnit;
      if (uLongWick < options.longWickProbability) {
        if (uLongWickSide < 0.5) wickUp *= 5;
        else wickDown *= 5;
      }
      const high = round(Math.max(open, barClose) + wickUp);
      const low = Math.max(floorPrice, round(Math.min(open, barClose) - wickDown));
      const volume = Math.max(
        1,
        Math.round(options.baseVolume * activity * regimeScale * Math.exp(0.45 * zVolume)),
      );

      if (!drop.has(generated)) {
        bars.push({
          start,
          open,
          high: Math.max(high, open, barClose),
          low: Math.min(low, open, barClose),
          close: barClose,
          volume,
          status: 'final',
          revision: 0,
        });
      }
      generated += 1;
      close = barClose;
    }
  }
  return bars;
}

/** Session-aligned bucket starts: anchored at each open window's start (docs/market-data.md). */
export function bucketStarts(
  session: MarketSession,
  mode: SessionMode,
  durationMs: number,
): number[] {
  const starts: number[] = [];
  for (const w of selectWindows(session, mode)) {
    for (let t = w.start; t < w.end; t += durationMs) starts.push(t);
  }
  return starts;
}

function decimalsOf(step: number): number {
  const text = String(step);
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}
