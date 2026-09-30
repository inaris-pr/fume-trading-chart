import { describe, expect, test, vi } from 'vitest';
import { ProviderFailure } from '../src/errors.ts';
import {
  AlpacaHttpClient,
  buildUrl,
  parseRetryAfter,
  type FetchLike,
} from '../src/providers/alpaca/client.ts';
import { TEST_KEY_ID, TEST_SECRET } from './fake-alpaca.ts';

const DATA = 'https://data.alpaca.markets';
const TRADING = 'https://paper-api.alpaca.markets';

function client(
  fetch: FetchLike,
  extra: Partial<ConstructorParameters<typeof AlpacaHttpClient>[0]> = {},
) {
  return new AlpacaHttpClient({
    dataBaseUrl: DATA,
    tradingBaseUrl: TRADING,
    credentials: { keyId: TEST_KEY_ID, secretKey: TEST_SECRET },
    fetch,
    ...extra,
  });
}

async function failure(promise: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderFailure);
    return error as ProviderFailure;
  }
  throw new Error('expected a ProviderFailure');
}

const respond =
  (status: number, body: unknown, headers: Record<string, string> = {}): FetchLike =>
  async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

describe('AlpacaHttpClient', () => {
  test('sends credentials only in the APCA-API-* headers, never in the URL', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const c = client(async (url, init) => {
      seen.push({ url, init });
      return Response.json({ ok: true });
    });
    await c.getJson('data', 'v2/stocks/SPY/bars', { timeframe: '1Min', feed: 'iex' });
    const { url, init } = seen[0]!;
    const headers = new Headers(init.headers);
    expect(headers.get('APCA-API-KEY-ID')).toBe(TEST_KEY_ID);
    expect(headers.get('APCA-API-SECRET-KEY')).toBe(TEST_SECRET);
    expect(url).toBe('https://data.alpaca.markets/v2/stocks/SPY/bars?timeframe=1Min&feed=iex');
    expect(url).not.toContain(TEST_KEY_ID);
    expect(url).not.toContain(TEST_SECRET);
    expect(init.method).toBe('GET');
  });

  test('routes trading-API paths to the paper host', async () => {
    const urls: string[] = [];
    await client(async (url) => {
      urls.push(url);
      return Response.json([]);
    }).getJson('trading', 'v2/calendar', { start: '2026-01-01', end: '2026-12-31' });
    expect(urls).toEqual([
      'https://paper-api.alpaca.markets/v2/calendar?start=2026-01-01&end=2026-12-31',
    ]);
  });

  test('buildUrl skips undefined values and never drops the base path', () => {
    expect(buildUrl('https://x.test/base', 'v2/a', { a: 1, b: undefined })).toBe(
      'https://x.test/base/v2/a?a=1',
    );
  });

  test.each([
    [400, 'data', 'invalid_request', false],
    [422, 'data', 'invalid_request', false],
    [401, 'data', 'unauthorized', false],
    [403, 'data', 'insufficient_entitlement', false],
    [403, 'trading', 'unauthorized', false],
    [404, 'trading', 'not_found', false],
    [500, 'data', 'unavailable', true],
    [503, 'data', 'unavailable', true],
  ] as const)('HTTP %i from %s -> %s', async (status, api, code, retryable) => {
    const f = await failure(
      client(respond(status, { code: 40010001, message: 'upstream text' })).getJson(api, 'x'),
    );
    expect(f.code).toBe(code);
    expect(f.retryable).toBe(retryable);
    expect(f.providerCode).toBe(`${status}/40010001`);
    expect(f.message).not.toContain('upstream text'); // upstream text never propagates
  });

  test('429 is rate_limited and preserves Retry-After (seconds and HTTP date)', async () => {
    const f = await failure(
      client(respond(429, { message: 'too many requests' }, { 'Retry-After': '7' })).getJson(
        'data',
        'x',
      ),
    );
    expect(f).toMatchObject({ code: 'rate_limited', retryable: true, retryAfterMs: 7000 });
    const noHeader = await failure(client(respond(429, 'rate limit')).getJson('data', 'x'));
    expect(noHeader.retryAfterMs).toBeUndefined();
    expect(parseRetryAfter('Wed, 30 Sep 2026 00:00:10 GMT', Date.UTC(2026, 8, 30))).toBe(10_000);
    expect(parseRetryAfter('soon')).toBeUndefined();
  });

  test('non-JSON error bodies (HTML) are tolerated and not echoed', async () => {
    const f = await failure(client(respond(502, '<html>Bad gateway</html>')).getJson('data', 'x'));
    expect(f).toMatchObject({ code: 'unavailable', retryable: true, providerCode: '502' });
  });

  test('malformed JSON on 200 is an internal (malformed upstream) failure', async () => {
    const f = await failure(client(respond(200, '{"bars": [')).getJson('data', 'x'));
    expect(f).toMatchObject({ code: 'internal', retryable: false });
  });

  test('network errors are unavailable and retryable', async () => {
    const f = await failure(
      client(async () => {
        throw new TypeError('fetch failed');
      }).getJson('data', 'x'),
    );
    expect(f).toMatchObject({
      code: 'unavailable',
      retryable: true,
      message: 'Upstream network error',
    });
  });

  test('times out via AbortController', async () => {
    vi.useFakeTimers();
    try {
      const hanging: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      const pending = failure(client(hanging, { timeoutMs: 50 }).getJson('data', 'x'));
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toMatchObject({
        code: 'unavailable',
        message: 'Upstream request timed out',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('a caller abort cancels the upstream request and is not retryable', async () => {
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        upstreamSignal = init.signal ?? undefined;
        init.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
    const pending = failure(client(hanging).getJson('data', 'x', {}, controller.signal));
    controller.abort();
    expect(await pending).toMatchObject({
      code: 'unavailable',
      retryable: false,
      message: 'Request aborted',
    });
    expect(upstreamSignal?.aborted).toBe(true);
  });

  test('enforces the per-request upstream call budget', async () => {
    const c = client(async () => Response.json({}), { maxCalls: 2 });
    await c.getJson('data', 'a');
    await c.getJson('data', 'b');
    const f = await failure(c.getJson('data', 'c'));
    expect(f.message).toMatch(/budget/);
    expect(c.calls).toBe(2);
  });
});
