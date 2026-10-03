/** Indicator value formatting for legends and pane axes (presentation lives in the chart). */
import type { IndicatorValueFormat } from '@fume/indicators';

/** Compact volume: 950, 12.5K, 3.42M, 1.2B. */
export function formatVolume(value: number): string {
  const abs = Math.abs(value);
  const unit = (div: number, suffix: string) => {
    const v = value / div;
    return `${Math.abs(v) < 10 ? v.toFixed(2) : Math.abs(v) < 100 ? v.toFixed(1) : v.toFixed(0)}${suffix}`;
  };
  if (abs >= 1e9) return unit(1e9, 'B');
  if (abs >= 1e6) return unit(1e6, 'M');
  if (abs >= 1e3) return unit(1e3, 'K');
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function formatLegendValue(
  format: IndicatorValueFormat,
  value: number,
  formatPrice: (price: number) => string,
): string {
  if (format === 'price') return formatPrice(value);
  if (format === 'volume') return formatVolume(value);
  return value.toFixed(2);
}

/** Axis labels are terser than legend values (whole numbers without decimals). */
export function formatAxisValue(
  format: IndicatorValueFormat,
  value: number,
  formatPrice: (price: number) => string,
): string {
  if (format === 'price') return formatPrice(value);
  if (format === 'volume') return formatVolume(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
