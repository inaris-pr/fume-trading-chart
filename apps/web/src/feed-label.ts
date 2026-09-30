import type { DataFeedInfo, StreamState } from '@fume/core';

/**
 * Header label for a backend feed, built only from the provider-neutral DataFeedInfo and stream
 * state the backend reports (the web app never names or special-cases a provider itself):
 *   history only:          "Alpaca · IEX · historical"
 *   streamed, delayed:     "CME futures · Delayed ~10m"   (never "live")
 *   streamed, real-time:   "<name> · Live"
 * plus a short suffix while the stream is not delivering.
 */
export function feedLabel(
  feed: DataFeedInfo,
  streaming = false,
  state: StreamState | null = null,
): string {
  const provider = feed.providerId.charAt(0).toUpperCase() + feed.providerId.slice(1);
  if (!streaming) return `${provider} · ${feed.feedId.toUpperCase()} · historical`;
  const name = feed.displayName ?? `${provider} · ${feed.feedId.toUpperCase()}`;
  const timing = feed.delayMs > 0 ? `Delayed ~${delayText(feed.delayMs)}` : 'Live';
  const suffix = streamSuffix(state);
  return suffix ? `${name} · ${timing} · ${suffix}` : `${name} · ${timing}`;
}

export function feedTitle(
  feed: DataFeedInfo,
  streaming = false,
  state: StreamState | null = null,
): string {
  if (!streaming) {
    return feed.consolidated
      ? 'Consolidated feed. Historical candles only; no live updates yet.'
      : `Single-venue ${feed.feedId.toUpperCase()} feed, not consolidated (not SIP/NBBO). Historical candles only; no live updates yet.`;
  }
  const delay =
    feed.delayMs > 0
      ? `Market data is delayed by about ${delayText(feed.delayMs)}; the newest candle is the newest delayed data, not wall-clock time.`
      : 'Real-time market data.';
  const issue = state ? streamIssue(state) : null;
  return issue ? `${delay} ${issue}` : delay;
}

/** "10m", "15m", "1h", "30s". */
export function delayText(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function streamSuffix(state: StreamState | null): string | null {
  if (!state) return null;
  switch (state.status) {
    case 'live':
      return null;
    case 'connecting':
    case 'authenticating':
      return 'connecting';
    case 'reconnecting':
      return state.lastError?.reason === 'connection_conflict'
        ? 'feed in use elsewhere'
        : 'reconnecting';
    case 'closed':
      return 'offline';
  }
}

function streamIssue(state: StreamState): string | null {
  if (state.status === 'reconnecting') {
    const when = new Date(state.nextRetryAt).toLocaleTimeString();
    return state.lastError?.reason === 'connection_conflict'
      ? `The upstream feed connection is in use by another process; retrying at ${when}.`
      : `Reconnecting (attempt ${state.attempt}); next try at ${when}.`;
  }
  if (state.status === 'closed') return 'The stream is offline.';
  return null;
}
