/**
 * Seeded pseudo-random numbers for deterministic fixtures. Never use Math.random() in fixtures.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal (mean 0, sd 1). */
  normal(): number;
}

/** mulberry32: small, fast, 32-bit state; identical sequence for identical seeds everywhere. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Box-Muller; always consumes exactly two uniforms so draw counts stay predictable.
  const normal = (): number => {
    const u1 = next() || Number.MIN_VALUE;
    const u2 = next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  return { next, normal };
}
