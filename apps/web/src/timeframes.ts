import type { TimeframeId } from '@fume/core';

/** Timeframes offered by the shell, in display order. */
export const TIMEFRAME_ORDER: readonly TimeframeId[] = ['1d', '4h', '1h', '15m', '5m', '1m'];

/** Display labels for the timeframe controls. */
export const TIMEFRAME_LABELS: Readonly<Record<TimeframeId, string>> = {
  '1d': '1D',
  '4h': '4H',
  '1h': '1H',
  '15m': '15m',
  '5m': '5m',
  '1m': '1m',
};

export function isTimeframe(value: string | null): value is TimeframeId {
  return value !== null && (TIMEFRAME_ORDER as readonly string[]).includes(value);
}
