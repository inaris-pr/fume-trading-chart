/**
 * Symbols offered in the header selector. The ticker is the primary identifier; the label adds a
 * friendly description. ETFs are labeled as ETFs (they are funds, not the underlying indexes), and
 * futures roots name their market; the backend resolves a root to a specific contract.
 */
export interface MenuEntry {
  symbol: string;
  label: string;
}

/** Stocks & ETFs (US equities feed). */
export const EQUITY_MENU: readonly MenuEntry[] = [
  { symbol: 'SPY', label: 'S&P 500 ETF' },
  { symbol: 'QQQ', label: 'Nasdaq-100 ETF' },
  { symbol: 'DIA', label: 'Dow Jones ETF' },
  { symbol: 'AAPL', label: 'Apple' },
  { symbol: 'NVDA', label: 'NVIDIA' },
  { symbol: 'TSLA', label: 'Tesla' },
];

/** Futures roots: the three equity-index futures first, then metals and energy. */
export const FUTURES_MENU: readonly MenuEntry[] = [
  { symbol: 'ES', label: 'S&P 500' },
  { symbol: 'NQ', label: 'Nasdaq-100' },
  { symbol: 'YM', label: 'Dow Jones' },
  { symbol: 'GC', label: 'Gold' },
  { symbol: 'SI', label: 'Silver' },
  { symbol: 'CL', label: 'Crude Oil' },
];

export const FUTURES_ROOTS: readonly string[] = FUTURES_MENU.map((e) => e.symbol);

/** Option text: "SPY — S&P 500 ETF"; a symbol without a description shows as itself. */
export function optionText(symbol: string, menu: readonly MenuEntry[]): string {
  const entry = menu.find((e) => e.symbol === symbol);
  return entry ? `${entry.symbol} — ${entry.label}` : symbol;
}
