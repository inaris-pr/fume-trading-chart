import type { Instrument, InstrumentId, SessionWindow } from '@fume/core';

const WEEKDAYS = [1, 2, 3, 4, 5] as const;
const weekdays = (start: string, end: string): SessionWindow[] =>
  WEEKDAYS.map((startDay) => ({ startDay, start, end }));

/**
 * Demo SPY metadata. Illustrative values for the deterministic replay only; real instrument
 * metadata comes from the backend in Stage 4.
 */
export const DEMO_SPY: Instrument = {
  id: 'eq:SPY' as InstrumentId,
  assetClass: 'etf',
  displaySymbol: 'SPY',
  description: 'SPDR S&P 500 ETF Trust (deterministic demo data)',
  exchange: 'ARCX',
  currency: 'USD',
  tickRules: [
    { fromPrice: '0', tickSize: '0.0001' },
    { fromPrice: '1', tickSize: '0.01' },
  ],
  priceFormat: { kind: 'decimal', decimals: 2 },
  quantityStep: '1',
  quantityUnit: 'shares',
  contractMultiplier: '1',
  session: {
    timezone: 'America/New_York',
    regular: weekdays('09:30', '16:00'),
    extended: [...weekdays('04:00', '09:30'), ...weekdays('16:00', '20:00')],
    calendarId: 'XNYS',
  },
  tradable: false,
  shortable: 'unknown',
  marketDataRef: { providerId: 'replay', symbol: 'SPY' },
};
