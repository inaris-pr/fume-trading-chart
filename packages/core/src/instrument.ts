import type { Decimal, InstrumentId, ProviderId, UnixMs } from './primitives.ts';

export type AssetClass = 'equity' | 'etf' | 'future';

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * A recurring session window in the session timezone.
 * If `end` <= `start` the window crosses midnight; the session belongs to the trading
 * day on which it ENDS (futures convention, e.g. Sunday 18:00 -> Monday 17:00 is Monday's session).
 */
export interface SessionWindow {
  /** Weekday on which the window starts. */
  startDay: IsoWeekday;
  /** "HH:MM" local time. */
  start: string;
  /** "HH:MM" local time. */
  end: string;
}

export interface TradingSessionSpec {
  /** IANA timezone, e.g. "America/New_York", "America/Chicago". */
  timezone: string;
  regular: readonly SessionWindow[];
  /** Pre/post/overnight windows where the provider/broker supports them. */
  extended: readonly SessionWindow[];
  /** Holiday / early-close calendar reference resolved by the backend, e.g. "XNYS". */
  calendarId: string;
}

/**
 * Minimum price increment. Equities have price-dependent ticks (e.g. sub-$1 stocks),
 * futures usually a single tick. Sorted by `fromPrice` ascending; the last matching rule wins.
 */
export interface TickRule {
  fromPrice: Decimal;
  tickSize: Decimal;
}

/** How prices are displayed. Fractional formats exist for e.g. Treasury futures (32nds). */
export type PriceFormat =
  | { kind: 'decimal'; decimals: number }
  | { kind: 'fraction'; denominator: number; subDenominator?: number };

export interface FutureContractSpec {
  rootSymbol: string;
  /** "YYYY-MM" */
  contractMonth: string;
  expiration: UnixMs;
  lastTradeTime?: UnixMs;
  firstNoticeTime?: UnixMs;
  /** Monetary value of one tick per contract, in `Instrument.currency`. */
  tickValue: Decimal;
}

export interface ProviderSymbolRef {
  providerId: ProviderId;
  symbol: string;
}

export interface Instrument {
  id: InstrumentId;
  assetClass: AssetClass;
  displaySymbol: string;
  description?: string;
  /** ISO 10383 MIC where known. */
  exchange?: string;
  /** ISO 4217. */
  currency: string;
  tickRules: readonly TickRule[];
  priceFormat: PriceFormat;
  /** Smallest quantity increment the broker accepts, e.g. "1" (whole shares/contracts). */
  quantityStep: Decimal;
  /** Display label only. */
  quantityUnit: 'shares' | 'contracts' | 'units';
  /** "1" for stocks/ETFs; e.g. "50" for ES. P&L = priceDelta * qty * multiplier. */
  contractMultiplier: Decimal;
  session: TradingSessionSpec;
  tradable: boolean;
  shortable: boolean | 'unknown';
  future?: FutureContractSpec;
  marketDataRef: ProviderSymbolRef;
  brokerageRef?: ProviderSymbolRef;
}
