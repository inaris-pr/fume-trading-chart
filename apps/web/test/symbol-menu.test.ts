/** Selector entries: tickers first, friendly labels, ETFs labeled as ETFs, futures order. */
import { describe, expect, test } from 'vitest';
import { EQUITY_MENU, FUTURES_MENU, FUTURES_ROOTS, optionText } from '../src/symbol-menu.ts';

describe('symbol menu', () => {
  test('futures: the six supported roots, equity-index futures first', () => {
    expect(FUTURES_ROOTS).toEqual(['ES', 'NQ', 'YM', 'GC', 'SI', 'CL']);
    expect(FUTURES_MENU.map((e) => optionText(e.symbol, FUTURES_MENU))).toEqual([
      'ES — S&P 500',
      'NQ — Nasdaq-100',
      'YM — Dow Jones',
      'GC — Gold',
      'SI — Silver',
      'CL — Crude Oil',
    ]);
  });

  test('stocks & ETFs: DIA is offered; index ETFs are labeled as ETFs, not as the index', () => {
    const text = (s: string) => optionText(s, EQUITY_MENU);
    expect(EQUITY_MENU.map((e) => e.symbol)).toContain('DIA');
    expect(text('SPY')).toBe('SPY — S&P 500 ETF');
    expect(text('QQQ')).toBe('QQQ — Nasdaq-100 ETF');
    expect(text('DIA')).toBe('DIA — Dow Jones ETF');
    // Tickers stay the primary identifier; unknown symbols show as themselves.
    for (const e of EQUITY_MENU) expect(text(e.symbol).startsWith(`${e.symbol} — `)).toBe(true);
    expect(optionText('MSFT', EQUITY_MENU)).toBe('MSFT');
  });

  test('no ticker appears in both groups', () => {
    const equities = new Set(EQUITY_MENU.map((e) => e.symbol));
    expect(FUTURES_ROOTS.filter((r) => equities.has(r))).toEqual([]);
  });
});
