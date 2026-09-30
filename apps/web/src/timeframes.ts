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

/** Default view applied on every symbol/timeframe switch. */
export const DEFAULT_VIEW: Readonly<
  Record<TimeframeId, { barSpacing: number; rightOffset: number }>
> = {
  '1m': { barSpacing: 6, rightOffset: 6 },
  '5m': { barSpacing: 7, rightOffset: 6 },
  '15m': { barSpacing: 8, rightOffset: 6 },
  '1h': { barSpacing: 12, rightOffset: 4 },
  '4h': { barSpacing: 16, rightOffset: 3 },
  '1d': { barSpacing: 10, rightOffset: 3 },
};

/**
 * Sessions of 1-minute history loaded initially per timeframe, and per older-data page. Kept small
 * so panning left visibly triggers delayed older-history loading.
 */
export const HISTORY_SESSIONS: Readonly<Record<TimeframeId, number>> = {
  '1m': 2,
  '5m': 5,
  '15m': 10,
  '1h': 20,
  '4h': 40,
  '1d': 60,
};

export function isTimeframe(value: string | null): value is TimeframeId {
  return value !== null && (TIMEFRAME_ORDER as readonly string[]).includes(value);
}
