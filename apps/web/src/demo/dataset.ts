/**
 * Deterministic demo datasets. Everything here is derived from Stage 0 domain types:
 * Instrument -> weekly sessions -> session time scale -> seeded synthetic bars.
 */
import {
  addDays,
  createPriceFormatter,
  createSessionTimeScale,
  createTimeFormatter,
  resolveWeeklySessions,
  tickSizeAt,
  type Bar,
  type Instrument,
  type MarketSession,
  type PriceFormatter,
  type TimeFormatter,
  type TimeScaleMapping,
} from '@fume/core';
import { generateSyntheticBars, type SyntheticBarsOptions } from '@fume/core/fixtures';
import { DEMO_SPY } from './instrument.ts';

export type Scenario = 'spy' | 'flat' | 'negative' | 'subpenny';

export interface DemoDataset {
  instrument: Instrument;
  scenario: Scenario;
  timeframeLabel: string;
  sessions: MarketSession[];
  bars: Bar[];
  timeScale: TimeScaleMapping;
  formatPrice: PriceFormatter;
  formatTime: TimeFormatter;
  minPriceStep: number;
}

export const DEMO_SEED = 20260302;
export const DEMO_BAR_COUNT = 780;
const FIVE_MINUTES = 5 * 60_000;
/** Fixed start: includes the 2026-03-08 US DST change so the axis crosses it. */
const FIRST_SESSION_DATE = '2026-03-02';

type WalkPreset = Pick<
  SyntheticBarsOptions,
  | 'startPrice'
  | 'tickSize'
  | 'walk'
  | 'volatility'
  | 'gapVolatility'
  | 'drift'
  | 'dojiProbability'
  | 'longWickProbability'
  | 'baseVolume'
>;

const PRESETS: Record<Scenario, { instrument: Instrument; walk: WalkPreset }> = {
  spy: {
    instrument: DEMO_SPY,
    walk: {
      startPrice: 574.25,
      tickSize: 0.01,
      walk: 'multiplicative',
      volatility: 0.0008,
      gapVolatility: 0.0045,
      dojiProbability: 0.05,
      longWickProbability: 0.03,
      baseVolume: 42_000,
    },
  },
  flat: {
    instrument: DEMO_SPY,
    walk: {
      startPrice: 574.25,
      tickSize: 0.01,
      walk: 'additive',
      volatility: 0,
      gapVolatility: 0,
      dojiProbability: 1,
      longWickProbability: 0,
      baseVolume: 1_000,
    },
  },
  negative: {
    instrument: {
      ...DEMO_SPY,
      displaySymbol: 'SYN-NEG',
      description: 'Synthetic series crossing zero (scale test)',
      tickRules: [{ fromPrice: '0', tickSize: '0.01' }],
    },
    walk: {
      // Chosen so the series crosses zero inside the default (latest) view.
      startPrice: 7.5,
      tickSize: 0.01,
      walk: 'additive',
      volatility: 0.04,
      gapVolatility: 0.1,
      drift: -0.009,
      dojiProbability: 0.05,
      longWickProbability: 0.03,
      baseVolume: 5_000,
    },
  },
  subpenny: {
    instrument: {
      ...DEMO_SPY,
      displaySymbol: 'SYN-SUB',
      description: 'Synthetic sub-penny series (scale test)',
      tickRules: [{ fromPrice: '0', tickSize: '0.0001' }],
      priceFormat: { kind: 'decimal', decimals: 4 },
    },
    walk: {
      startPrice: 0.0142,
      tickSize: 0.0001,
      walk: 'multiplicative',
      volatility: 0.006,
      gapVolatility: 0.02,
      dojiProbability: 0.08,
      longWickProbability: 0.03,
      baseVolume: 900_000,
    },
  },
};

export function buildDemoDataset(scenario: Scenario, barCount: number): DemoDataset {
  const { instrument, walk } = PRESETS[scenario];
  const barsPerSession = 78;
  // Weekdays only, no holiday calendar: ~7/5 calendar days per session plus slack.
  const calendarDays = Math.ceil((barCount / barsPerSession) * 1.5) + 7;
  const sessions = resolveWeeklySessions({
    instrumentId: instrument.id,
    spec: instrument.session,
    from: FIRST_SESSION_DATE,
    to: addDays(FIRST_SESSION_DATE, calendarDays),
  });
  const bars = generateSyntheticBars({
    ...walk,
    seed: DEMO_SEED,
    sessions,
    sessionMode: 'regular',
    durationMs: FIVE_MINUTES,
    count: barCount,
    // One deliberately missing bar in the latest session: a genuine in-session gap (empty slot).
    dropIndices: [barCount - 24],
  });
  const lastPrice = bars[bars.length - 1]?.close ?? walk.startPrice;
  return {
    instrument,
    scenario,
    timeframeLabel: '5m',
    sessions,
    bars,
    timeScale: createSessionTimeScale({
      sessions,
      sessionMode: 'regular',
      slot: { kind: 'intraday', durationMs: FIVE_MINUTES },
    }),
    formatPrice: createPriceFormatter(instrument.priceFormat),
    formatTime: createTimeFormatter(instrument.session.timezone),
    minPriceStep: tickSizeAt(instrument.tickRules, lastPrice),
  };
}

export function parseScenario(value: string | null): Scenario {
  return value === 'flat' || value === 'negative' || value === 'subpenny' ? value : 'spy';
}
