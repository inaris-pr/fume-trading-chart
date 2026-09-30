/**
 * Replay instruments: provider-neutral Instrument metadata plus the seeded random-walk parameters
 * that generate each symbol's deterministic history.
 */
import type { Instrument, InstrumentId, SessionWindow } from '@fume/core';
import type { SyntheticBarsOptions } from '@fume/core/fixtures';

export const REPLAY_SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA'] as const;
/** Edge-case series for QA (scale tests); resolvable but not offered in the default selector. */
export const REPLAY_DEV_SYMBOLS = ['SYN-FLAT', 'SYN-NEG', 'SYN-SUB'] as const;
export type ReplaySymbol = (typeof REPLAY_SYMBOLS)[number] | (typeof REPLAY_DEV_SYMBOLS)[number];

export function isReplaySymbol(value: string | null | undefined): value is ReplaySymbol {
  return (
    typeof value === 'string' &&
    ((REPLAY_SYMBOLS as readonly string[]).includes(value) ||
      (REPLAY_DEV_SYMBOLS as readonly string[]).includes(value))
  );
}

const weekdays = (start: string, end: string): SessionWindow[] =>
  ([1, 2, 3, 4, 5] as const).map((startDay) => ({ startDay, start, end }));

export const US_EQUITY_SESSION: Instrument['session'] = {
  timezone: 'America/New_York',
  regular: weekdays('09:30', '16:00'),
  extended: [...weekdays('04:00', '09:30'), ...weekdays('16:00', '20:00')],
  calendarId: 'XNYS',
};

export type WalkPreset = Omit<
  SyntheticBarsOptions,
  'sessions' | 'sessionMode' | 'durationMs' | 'count' | 'dropIndices'
>;

export interface ReplayInstrumentSpec {
  instrument: Instrument;
  walk: WalkPreset;
}

function instrument(
  symbol: ReplaySymbol,
  assetClass: Instrument['assetClass'],
  exchange: string,
  description: string,
  overrides: Partial<Instrument> = {},
): Instrument {
  return {
    id: `eq:${symbol}` as InstrumentId,
    assetClass,
    displaySymbol: symbol,
    description: `${description} (synthetic replay data)`,
    exchange,
    currency: 'USD',
    tickRules: [
      { fromPrice: '0', tickSize: '0.0001' },
      { fromPrice: '1', tickSize: '0.01' },
    ],
    priceFormat: { kind: 'decimal', decimals: 2 },
    quantityStep: '1',
    quantityUnit: 'shares',
    contractMultiplier: '1',
    session: US_EQUITY_SESSION,
    tradable: false,
    shortable: 'unknown',
    marketDataRef: { providerId: 'replay', symbol },
    ...overrides,
  };
}

function walk(
  seed: number,
  startPrice: number,
  volatility: number,
  gapVolatility: number,
  baseVolume: number,
  overrides: Partial<WalkPreset> = {},
): WalkPreset {
  return {
    seed,
    startPrice,
    tickSize: 0.01,
    walk: 'multiplicative',
    volatility,
    gapVolatility,
    dojiProbability: 0.08,
    longWickProbability: 0.02,
    baseVolume,
    ...overrides,
  };
}

/** Illustrative prices and volatilities; seeds make every symbol distinct and stable. */
export const REPLAY_INSTRUMENTS: Readonly<Record<ReplaySymbol, ReplayInstrumentSpec>> = {
  SPY: {
    instrument: instrument('SPY', 'etf', 'ARCX', 'SPDR S&P 500 ETF Trust'),
    walk: walk(1101, 574.25, 0.00045, 0.004, 60_000),
  },
  QQQ: {
    instrument: instrument('QQQ', 'etf', 'XNAS', 'Invesco QQQ Trust'),
    walk: walk(1202, 496.4, 0.00055, 0.005, 40_000),
  },
  AAPL: {
    instrument: instrument('AAPL', 'equity', 'XNAS', 'Apple Inc.'),
    walk: walk(1303, 228.1, 0.0007, 0.007, 50_000),
  },
  NVDA: {
    instrument: instrument('NVDA', 'equity', 'XNAS', 'NVIDIA Corporation'),
    walk: walk(1404, 118.35, 0.0012, 0.012, 250_000),
  },
  TSLA: {
    instrument: instrument('TSLA', 'equity', 'XNAS', 'Tesla, Inc.'),
    walk: walk(1505, 249.8, 0.0015, 0.015, 90_000),
  },
  'SYN-FLAT': {
    instrument: instrument('SYN-FLAT', 'equity', 'TEST', 'Flat series'),
    walk: walk(2001, 574.25, 0, 0, 1_000, {
      walk: 'additive',
      dojiProbability: 1,
      longWickProbability: 0,
    }),
  },
  'SYN-NEG': {
    instrument: instrument('SYN-NEG', 'equity', 'TEST', 'Series crossing zero', {
      tickRules: [{ fromPrice: '0', tickSize: '0.01' }],
    }),
    // Drifts from 36 through zero late in the period, so recent views cross zero.
    walk: walk(2002, 36, 0.012, 0.05, 5_000, { walk: 'additive', drift: -0.0009 }),
  },
  'SYN-SUB': {
    instrument: instrument('SYN-SUB', 'equity', 'TEST', 'Sub-penny series', {
      tickRules: [{ fromPrice: '0', tickSize: '0.0001' }],
      priceFormat: { kind: 'decimal', decimals: 4 },
    }),
    walk: walk(2003, 0.0142, 0.003, 0.02, 900_000, { tickSize: 0.0001 }),
  },
};
