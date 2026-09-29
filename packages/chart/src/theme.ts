export interface ChartTheme {
  background: string;
  grid: string;
  sessionSeparator: string;
  axisLine: string;
  axisText: string;
  upColor: string;
  downColor: string;
  flatColor: string;
  /** Text drawn on the colored last-price label. */
  lastPriceText: string;
  fontFamily: string;
  /** CSS px. */
  fontSize: number;
}

export const DEFAULT_THEME: Readonly<ChartTheme> = {
  background: '#0e1014',
  grid: 'rgba(255, 255, 255, 0.055)',
  sessionSeparator: 'rgba(255, 255, 255, 0.14)',
  axisLine: 'rgba(255, 255, 255, 0.16)',
  axisText: '#8f98a8',
  upColor: '#26b27a',
  downColor: '#e2484d',
  flatColor: '#8f98a8',
  lastPriceText: '#ffffff',
  fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "Liberation Mono", monospace',
  fontSize: 11,
};
