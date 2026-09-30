/**
 * Default ChartSession settings (all overridable through ChartSessionSettings). These are the
 * values the standalone app used before the extraction; changing them changes chart behavior.
 */
import type { TimeframeId } from '@fume/core';

/** Initial view per timeframe, applied on every symbol/timeframe switch. */
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
 * Canonical candles per request (initial load and each older page); the Fume API allows up to
 * 2000. Sized so one request stays at a few upstream calls on the equities plan: upstream pages
 * hold about one month of bars (observed 2026-09-29), so 4H/1D pages are ~75/150 sessions.
 */
export const HISTORY_PAGE: Readonly<Record<TimeframeId, number>> = {
  '1m': 1000,
  '5m': 800,
  '15m': 600,
  '1h': 500,
  '4h': 150,
  '1d': 150,
};

/** 1-minute bars requested to seed live updates: covers the current bucket of any timeframe. */
export const LIVE_SEED_MINUTES = 1600;
