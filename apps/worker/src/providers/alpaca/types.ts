/**
 * Alpaca payload shapes, as documented (docs/research.md) and as recorded in S1 fixtures.
 * These types never leave apps/worker/src/providers/alpaca/: everything is normalized into
 * @fume/core types at this boundary. Fields are `unknown`-validated at runtime in normalize.ts;
 * these interfaces only document what is read.
 */

/** GET {data}/v2/stocks/{symbol}/bars */
export interface AlpacaBarsResponse {
  bars: AlpacaBar[] | null;
  symbol?: string;
  next_page_token: string | null;
}

export interface AlpacaBar {
  /** RFC 3339 bar START (verified by S1). */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Trade count. */
  n?: number;
  /** Volume-weighted average price. */
  vw?: number;
}

/** GET {trading}/v2/assets/{symbol} */
export interface AlpacaAsset {
  id: string;
  class: string;
  exchange: string;
  symbol: string;
  name?: string;
  status: string;
  tradable: boolean;
  shortable?: boolean;
  fractionable?: boolean;
}

/** GET {trading}/v2/calendar -> AlpacaCalendarDay[] */
export interface AlpacaCalendarDay {
  /** "YYYY-MM-DD" (America/New_York). */
  date: string;
  /** "HH:MM" regular open, America/New_York wall time. */
  open: string;
  /** "HH:MM" regular close (early closes appear here). */
  close: string;
}

/** Error body (shape varies; only `message` is read, and only for logs). */
export interface AlpacaErrorBody {
  code?: number;
  message?: string;
}
