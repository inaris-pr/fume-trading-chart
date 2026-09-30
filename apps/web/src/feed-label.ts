import type { DataFeedInfo } from '@fume/core';

/**
 * Header label for a backend feed, built only from the provider-neutral DataFeedInfo the backend
 * reports (the web app never names a provider itself), e.g. "Alpaca · IEX · historical".
 */
export function feedLabel(feed: DataFeedInfo): string {
  const provider = feed.providerId.charAt(0).toUpperCase() + feed.providerId.slice(1);
  return `${provider} · ${feed.feedId.toUpperCase()} · historical`;
}

export function feedTitle(feed: DataFeedInfo): string {
  return feed.consolidated
    ? 'Consolidated feed. Historical candles only; no live updates yet.'
    : `Single-venue ${feed.feedId.toUpperCase()} feed, not consolidated (not SIP/NBBO). Historical candles only; no live updates yet.`;
}
