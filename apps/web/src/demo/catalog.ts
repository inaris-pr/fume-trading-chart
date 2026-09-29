/**
 * Deterministic demo/replay catalog (Stage 2). No market data: every symbol is a seeded synthetic
 * 1-minute series on a shared weekly RTH calendar, and every timeframe is built from those minutes
 * with @fume/core's canonical aggregation, the same way real data will be built later.
 */
import {
  addDays,
  aggregateBars,
  createPriceFormatter,
  createSessionTimeScale,
  createTimeFormatter,
  resolveWeeklySessions,
  slotSpecForTimeframe,
  tickSizeAt,
  type Bar,
  type Instrument,
  type InstrumentId,
  type MarketSession,
  type PriceFormatter,
  type SessionWindow,
  type TimeFormatter,
  type TimeframeId,
  type TimeScaleMapping,
} from '@fume/core';
import { generateSyntheticBars, type SyntheticBarsOptions } from '@fume/core/fixtures';

export const DEMO_SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'NVDA', 'TSLA'] as const;
/** Edge-case series for QA, reachable only via ?symbol=... (not in the selector). */
export const DEV_SYMBOLS = ['SYN-FLAT', 'SYN-NEG', 'SYN-SUB'] as const;
export type DemoSymbol = (typeof DEMO_SYMBOLS)[number] | (typeof DEV_SYMBOLS)[number];

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

/** Monday 2026-02-02 .. Friday 2026-09-25: 34 weeks = 170 sessions, crossing the March DST change. */
export const FIRST_SESSION_DATE = '2026-02-02';
export const LAST_SESSION_DATE = addDays(FIRST_SESSION_DATE, 34 * 7 - 3);
/**
 * The calendar is resolved beyond the data (like a real exchange calendar), so the empty area
 * right of the latest bar shows real upcoming session times instead of nothing.
 */
const CALENDAR_END_DATE = addDays(LAST_SESSION_DATE, 8 * 7);
const MINUTE = 60_000;
const MINUTES_PER_SESSION = 390;

/** Default view per timeframe (applied on every symbol/timeframe switch). */
const DEFAULT_VIEW: Record<TimeframeId, { barSpacing: number; rightOffset: number }> = {
  '1m': { barSpacing: 6, rightOffset: 6 },
  '5m': { barSpacing: 7, rightOffset: 6 },
  '15m': { barSpacing: 8, rightOffset: 6 },
  '1h': { barSpacing: 12, rightOffset: 4 },
  '4h': { barSpacing: 16, rightOffset: 3 },
  '1d': { barSpacing: 10, rightOffset: 3 },
};

const weekdays = (start: string, end: string): SessionWindow[] =>
  ([1, 2, 3, 4, 5] as const).map((startDay) => ({ startDay, start, end }));

const US_EQUITY_SESSION: Instrument['session'] = {
  timezone: 'America/New_York',
  regular: weekdays('09:30', '16:00'),
  extended: [...weekdays('04:00', '09:30'), ...weekdays('16:00', '20:00')],
  calendarId: 'XNYS',
};

function demoInstrument(
  symbol: DemoSymbol,
  assetClass: Instrument['assetClass'],
  exchange: string,
  description: string,
  overrides: Partial<Instrument> = {},
): Instrument {
  return {
    id: `eq:${symbol}` as InstrumentId,
    assetClass,
    displaySymbol: symbol,
    description,
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

type WalkPreset = Omit<
  SyntheticBarsOptions,
  'sessions' | 'sessionMode' | 'durationMs' | 'count' | 'dropIndices'
>;

interface SymbolPreset {
  instrument: Instrument;
  walk: WalkPreset;
}

/** Illustrative starting prices and volatilities; seeds make every symbol distinct and stable. */
const PRESETS: Record<DemoSymbol, SymbolPreset> = {
  SPY: preset('SPY', 'etf', 'ARCX', 'SPDR S&P 500 ETF Trust', 1101, 574.25, 0.00045, 0.004, 60_000),
  QQQ: preset('QQQ', 'etf', 'XNAS', 'Invesco QQQ Trust', 1202, 496.4, 0.00055, 0.005, 40_000),
  AAPL: preset('AAPL', 'equity', 'XNAS', 'Apple Inc.', 1303, 228.1, 0.0007, 0.007, 50_000),
  NVDA: preset(
    'NVDA',
    'equity',
    'XNAS',
    'NVIDIA Corporation',
    1404,
    118.35,
    0.0012,
    0.012,
    250_000,
  ),
  TSLA: preset('TSLA', 'equity', 'XNAS', 'Tesla, Inc.', 1505, 249.8, 0.0015, 0.015, 90_000),
  'SYN-FLAT': {
    instrument: demoInstrument('SYN-FLAT', 'equity', 'TEST', 'Synthetic flat series (scale test)'),
    walk: walk(2001, 574.25, 0, 0, 1_000, {
      walk: 'additive',
      dojiProbability: 1,
      longWickProbability: 0,
    }),
  },
  'SYN-NEG': {
    instrument: demoInstrument(
      'SYN-NEG',
      'equity',
      'TEST',
      'Synthetic series crossing zero (scale test)',
      {
        tickRules: [{ fromPrice: '0', tickSize: '0.01' }],
      },
    ),
    // Drifts from 36 through zero late in the replay period, so recent views cross zero.
    walk: walk(2002, 36, 0.012, 0.05, 5_000, { walk: 'additive', drift: -0.0009 }),
  },
  'SYN-SUB': {
    instrument: demoInstrument(
      'SYN-SUB',
      'equity',
      'TEST',
      'Synthetic sub-penny series (scale test)',
      {
        tickRules: [{ fromPrice: '0', tickSize: '0.0001' }],
        priceFormat: { kind: 'decimal', decimals: 4 },
      },
    ),
    walk: walk(2003, 0.0142, 0.003, 0.02, 900_000, { tickSize: 0.0001 }),
  },
};

function preset(
  symbol: DemoSymbol,
  assetClass: Instrument['assetClass'],
  exchange: string,
  description: string,
  seed: number,
  startPrice: number,
  volatility: number,
  gapVolatility: number,
  baseVolume: number,
): SymbolPreset {
  return {
    instrument: demoInstrument(
      symbol,
      assetClass,
      exchange,
      `${description} (deterministic demo data)`,
    ),
    walk: walk(seed, startPrice, volatility, gapVolatility, baseVolume),
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

export interface DemoSeries {
  symbol: DemoSymbol;
  timeframe: TimeframeId;
  instrument: Instrument;
  bars: readonly Bar[];
  timeScale: TimeScaleMapping;
  formatPrice: PriceFormatter;
  formatTime: TimeFormatter;
  minPriceStep: number;
  barSpacing: number;
  rightOffset: number;
}

/**
 * Builds and caches series per (symbol, timeframe). Owned by the app shell (one instance), so no
 * module-level state.
 */
export class DemoCatalog {
  /** Sessions that have data (the replay period). */
  readonly sessions: readonly MarketSession[];
  /** All resolved sessions, including future ones after the replay period. */
  readonly calendar: readonly MarketSession[];
  private readonly minutes = new Map<DemoSymbol, Bar[]>();
  private readonly series = new Map<string, DemoSeries>();
  private readonly mappings = new Map<TimeframeId, TimeScaleMapping>();

  constructor() {
    // All demo symbols share the US equity weekly schedule (no holiday calendar in Stage 2).
    this.calendar = resolveWeeklySessions({
      instrumentId: 'eq:DEMO' as InstrumentId,
      spec: US_EQUITY_SESSION,
      from: FIRST_SESSION_DATE,
      to: CALENDAR_END_DATE,
    });
    this.sessions = this.calendar.filter((s) => s.sessionDate <= LAST_SESSION_DATE);
  }

  get(symbol: DemoSymbol, timeframe: TimeframeId): DemoSeries {
    const key = `${symbol}|${timeframe}`;
    const cached = this.series.get(key);
    if (cached) return cached;
    const { instrument } = PRESETS[symbol];
    const timeScale = this.mapping(timeframe);
    const minutes = this.minuteBars(symbol);
    const bars =
      timeframe === '1m'
        ? minutes
        : aggregateBars({ bars: minutes, sourceDurationMs: MINUTE, target: timeScale }).bars;
    const last = bars[bars.length - 1];
    const series: DemoSeries = {
      symbol,
      timeframe,
      instrument,
      bars,
      timeScale,
      formatPrice: createPriceFormatter(instrument.priceFormat),
      formatTime: createTimeFormatter(instrument.session.timezone),
      minPriceStep: tickSizeAt(instrument.tickRules, last?.close ?? 1),
      ...DEFAULT_VIEW[timeframe],
    };
    this.series.set(key, series);
    return series;
  }

  /** Canonical 1-minute bars for a symbol (the source for every other timeframe). */
  minuteBars(symbol: DemoSymbol): Bar[] {
    let bars = this.minutes.get(symbol);
    if (!bars) {
      const count = this.sessions.length * MINUTES_PER_SESSION;
      bars = generateSyntheticBars({
        ...PRESETS[symbol].walk,
        sessions: this.sessions,
        sessionMode: 'regular',
        durationMs: MINUTE,
        count,
        dropIndices: demoGaps(count),
      });
      this.minutes.set(symbol, bars);
    }
    return bars;
  }

  mapping(timeframe: TimeframeId): TimeScaleMapping {
    let mapping = this.mappings.get(timeframe);
    if (!mapping) {
      mapping = createSessionTimeScale({
        sessions: this.calendar,
        sessionMode: 'regular',
        slot: slotSpecForTimeframe(timeframe),
      });
      this.mappings.set(timeframe, mapping);
    }
    return mapping;
  }
}

/**
 * Deliberately missing minutes (genuine in-session gaps): a 20-minute halt 13:00-13:19 in the
 * latest session, plus isolated missing minutes. Visible on 1m, and the halt also empties 5m slots.
 */
export function demoGaps(count: number): number[] {
  const lastSession = count - MINUTES_PER_SESSION;
  const halt = Array.from({ length: 20 }, (_, i) => lastSession + 210 + i);
  return [lastSession - MINUTES_PER_SESSION + 120, lastSession + 45, ...halt, lastSession + 301];
}

export function isDemoSymbol(value: string | null): value is DemoSymbol {
  return (
    value !== null &&
    ((DEMO_SYMBOLS as readonly string[]).includes(value) ||
      (DEV_SYMBOLS as readonly string[]).includes(value))
  );
}

export function isTimeframe(value: string | null): value is TimeframeId {
  return value !== null && (TIMEFRAME_ORDER as readonly string[]).includes(value);
}
