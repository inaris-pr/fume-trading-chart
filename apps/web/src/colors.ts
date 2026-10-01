/**
 * Color helpers for the reference drawing controls. A rectangle's fill opacity lives in the
 * existing `fillColor` string as rgba (no schema change); these split and rebuild it.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** #rgb, #rrggbb, rgb(r, g, b) or rgba(r, g, b, a); null for anything else. */
export function parseColor(color: string): Rgba | null {
  const c = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? [...h].map((ch) => ch + ch).join('') : h;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(c);
  if (!fn) return null;
  const [r, g, b] = [fn[1], fn[2], fn[3]].map(Number) as [number, number, number];
  const a = fn[4] === undefined ? 1 : Number(fn[4]);
  if (![r, g, b, a].every(Number.isFinite)) return null;
  return { r, g, b, a: Math.min(1, Math.max(0, a)) };
}

export function rgbaString({ r, g, b, a }: Rgba): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 100) / 100})`;
}

/** `color`'s RGB with alpha `a` (falls back to the color unchanged if it cannot be parsed). */
export function withAlpha(color: string, a: number): string {
  const c = parseColor(color);
  return c ? rgbaString({ ...c, a }) : color;
}

/** The opaque #rrggbb form of a color (for swatch comparison), or null. */
export function opaqueHex(color: string): string | null {
  const c = parseColor(color);
  if (!c) return null;
  const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
