/**
 * The single Alpaca HTTP client. It owns: authentication headers, URL construction, query
 * parameters, timeout/abort, JSON parsing, provider error normalization (ProviderFailure) and the
 * per-request call budget. `fetch` is injected, so tests run against recorded fixtures.
 *
 * Credentials go ONLY into the APCA-API-* request headers. They are never put in a URL, logged,
 * thrown, or included in any error message or diagnostic.
 */
import { ProviderFailure } from '../../errors.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AlpacaCredentials {
  keyId: string;
  secretKey: string;
}

export interface AlpacaClientOptions {
  dataBaseUrl: string;
  tradingBaseUrl: string;
  credentials: AlpacaCredentials;
  fetch: FetchLike;
  /** Per upstream call. Default 10 s. */
  timeoutMs?: number;
  /** Maximum upstream calls this client may make (one client per incoming request). */
  maxCalls?: number;
}

export type AlpacaApi = 'data' | 'trading';
export type QueryValue = string | number | undefined;

export class AlpacaHttpClient {
  private readonly options: AlpacaClientOptions;
  private callCount = 0;

  constructor(options: AlpacaClientOptions) {
    this.options = options;
  }

  /** Upstream calls made so far (diagnostics). */
  get calls(): number {
    return this.callCount;
  }

  /** GET JSON. Resolves with the parsed body of a 2xx; rejects with a ProviderFailure otherwise. */
  async getJson(
    api: AlpacaApi,
    path: string,
    query: Readonly<Record<string, QueryValue>> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const maxCalls = this.options.maxCalls ?? 12;
    if (this.callCount >= maxCalls) {
      throw new ProviderFailure({
        code: 'unavailable',
        message: 'Upstream call budget for this request exhausted',
        retryable: true,
      });
    }
    this.callCount++;
    if (signal?.aborted) throw aborted();

    const url = buildUrl(
      api === 'data' ? this.options.dataBaseUrl : this.options.tradingBaseUrl,
      path,
      query,
    );
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000);

    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'APCA-API-KEY-ID': this.options.credentials.keyId,
          'APCA-API-SECRET-KEY': this.options.credentials.secretKey,
        },
        signal: controller.signal,
      });
    } catch {
      if (signal?.aborted) throw aborted();
      throw new ProviderFailure({
        code: 'unavailable',
        message: controller.signal.aborted
          ? 'Upstream request timed out'
          : 'Upstream network error',
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) throw await failureFor(response, api);
    try {
      return await response.json();
    } catch {
      throw new ProviderFailure({
        code: 'internal',
        message: 'Upstream returned malformed JSON',
        retryable: false,
      });
    }
  }
}

/** Builds base + path + query. Only non-secret parameters ever go here. */
export function buildUrl(
  base: string,
  path: string,
  query: Readonly<Record<string, QueryValue>>,
): string {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function aborted(): ProviderFailure {
  return new ProviderFailure({ code: 'unavailable', message: 'Request aborted', retryable: false });
}

/**
 * Maps a non-2xx upstream response. The body is read only for a short log-safe code. A 403 means
 * "subscription does not permit this data" on the data API, but "forbidden for these keys" on the
 * trading API (assets, calendar), so it is mapped by context.
 */
async function failureFor(response: Response, api: AlpacaApi): Promise<ProviderFailure> {
  const status = response.status;
  let providerCode = String(status);
  try {
    const body = (await response.json()) as { code?: unknown };
    if (typeof body.code === 'number' || typeof body.code === 'string') {
      providerCode = `${status}/${String(body.code).slice(0, 16)}`;
    }
  } catch {
    // Non-JSON error bodies (HTML from a proxy, empty) are ignored.
  }
  const base = { providerCode };
  if (status === 400 || status === 422) {
    return new ProviderFailure({
      ...base,
      code: 'invalid_request',
      message: 'Upstream rejected the request',
      retryable: false,
    });
  }
  if (status === 401) {
    return new ProviderFailure({
      ...base,
      code: 'unauthorized',
      message: 'Upstream authentication failed',
      retryable: false,
    });
  }
  if (status === 403) {
    return api === 'data'
      ? new ProviderFailure({
          ...base,
          code: 'insufficient_entitlement',
          message: 'Upstream subscription does not permit this request',
          retryable: false,
        })
      : new ProviderFailure({
          ...base,
          code: 'unauthorized',
          message: 'Upstream refused these credentials',
          retryable: false,
        });
  }
  if (status === 404) {
    return new ProviderFailure({
      ...base,
      code: 'not_found',
      message: 'Upstream resource not found',
      retryable: false,
    });
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
    return new ProviderFailure({
      ...base,
      code: 'rate_limited',
      message: 'Upstream rate limit reached',
      retryable: true,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  return new ProviderFailure({
    ...base,
    code: 'unavailable',
    message: 'Upstream unavailable',
    retryable: status >= 500,
  });
}

/** Retry-After as delta-seconds or an HTTP date, in ms. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
