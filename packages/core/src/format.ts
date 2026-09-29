/**
 * Display formatting derived from instrument metadata. The chart receives these functions and
 * never hardcodes currencies, decimals or time zones.
 */
import type { UnixMs } from './primitives.ts';
import type { PriceFormat, TickRule } from './instrument.ts';

export type PriceFormatter = (price: number) => string;

export type TimeLabelGranularity = 'year' | 'month' | 'day' | 'time';
export type TimeFormatter = (timeMs: UnixMs, granularity: TimeLabelGranularity) => string;

export function createPriceFormatter(format: PriceFormat): PriceFormatter {
  if (format.kind === 'decimal') {
    const decimals = format.decimals;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
      throw new Error(`Unsupported decimal places: ${decimals}`);
    }
    const halfUnit = 0.5 * 10 ** -decimals;
    // Values that round to zero print as "0.00", never "-0.00".
    return (price) => (Math.abs(price) < halfUnit ? 0 : price).toFixed(decimals);
  }
  const { denominator, subDenominator = 1 } = format;
  if (!(denominator > 1) || !(subDenominator >= 1)) {
    throw new Error(`Unsupported fraction format 1/${denominator} (${subDenominator})`);
  }
  const width = String(denominator - 1).length;
  return (price) => {
    const units = Math.round(Math.abs(price) * denominator * subDenominator);
    const perWhole = denominator * subDenominator;
    const whole = Math.floor(units / perWhole);
    const rest = units - whole * perWhole;
    const main = Math.floor(rest / subDenominator);
    const sub = rest - main * subDenominator;
    const sign = units === 0 || price >= 0 ? '' : '-';
    const subText = subDenominator > 1 ? String(sub) : '';
    return `${sign}${whole}'${String(main).padStart(width, '0')}${subText}`;
  };
}

/**
 * Minimum price increment applicable at `price`. Rules are evaluated on the absolute price; the
 * last rule whose `fromPrice` is <= |price| wins, falling back to the first rule.
 */
export function tickSizeAt(rules: readonly TickRule[], price: number): number {
  const sorted = [...rules].sort((a, b) => Number(a.fromPrice) - Number(b.fromPrice));
  const first = sorted[0];
  if (!first) throw new Error('Instrument has no tick rules');
  let tick = Number(first.tickSize);
  for (const rule of sorted) {
    if (Number(rule.fromPrice) <= Math.abs(price)) tick = Number(rule.tickSize);
  }
  return tick;
}

const TIME_LABEL_OPTIONS: Record<TimeLabelGranularity, Intl.DateTimeFormatOptions> = {
  year: { year: 'numeric' },
  month: { month: 'short' },
  day: { month: 'short', day: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
};

/** Axis-label formatter in the instrument's session time zone. */
export function createTimeFormatter(timeZone: string, locale = 'en-US'): TimeFormatter {
  const formatters = {} as Record<TimeLabelGranularity, Intl.DateTimeFormat>;
  for (const granularity of Object.keys(TIME_LABEL_OPTIONS) as TimeLabelGranularity[]) {
    formatters[granularity] = new Intl.DateTimeFormat(locale, {
      ...TIME_LABEL_OPTIONS[granularity],
      timeZone,
    });
  }
  return (timeMs, granularity) => formatters[granularity].format(timeMs);
}
