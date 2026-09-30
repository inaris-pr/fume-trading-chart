/** Header feed label: built only from provider-neutral feed metadata and stream state. */
import { describe, expect, test } from 'vitest';
import { delayText, feedLabel, feedTitle } from '../src/feed-label.ts';

const IEX = { providerId: 'alpaca', feedId: 'iex', consolidated: false, delayMs: 0 };
const FUTURES = {
  providerId: 'massive',
  feedId: 'futures-delayed',
  consolidated: true,
  delayMs: 600_000,
  displayName: 'CME futures',
};

describe('feedLabel', () => {
  test('history-only feeds keep the Stage 4 label', () => {
    expect(feedLabel(IEX)).toBe('Alpaca · IEX · historical');
  });

  test('a streamed delayed feed says "Delayed ~10m", never live', () => {
    const label = feedLabel(FUTURES, true, { status: 'live' });
    expect(label).toBe('CME futures · Delayed ~10m');
    expect(label).not.toMatch(/live/i);
    expect(feedTitle(FUTURES, true, { status: 'live' })).toMatch(/delayed by about 10m/);
  });

  test('stream problems show a short suffix', () => {
    expect(
      feedLabel(FUTURES, true, {
        status: 'reconnecting',
        attempt: 1,
        nextRetryAt: 0,
        lastError: {
          code: 'unavailable',
          message: 'x',
          retryable: true,
          reason: 'connection_conflict',
        },
      }),
    ).toBe('CME futures · Delayed ~10m · feed in use elsewhere');
    expect(feedLabel(FUTURES, true, { status: 'connecting' })).toBe(
      'CME futures · Delayed ~10m · connecting',
    );
  });

  test('delay text', () => {
    expect([delayText(600_000), delayText(3_600_000), delayText(15_000)]).toEqual([
      '10m',
      '1h',
      '15s',
    ]);
  });
});
