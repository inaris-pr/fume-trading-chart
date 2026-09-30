/**
 * The single Massive REST client. It owns authentication, URL construction, `next_url` cursor
 * following, timeout/abort, JSON parsing, error normalization (ProviderFailure) and the per-call
 * budget. `fetch` is injected, so tests run against an offline fake.
 *
 * The API key goes ONLY into the `Authorization: Bearer` header. It is never put in a URL (any
 * `apiKey` query parameter on a returned cursor is removed), logged, thrown, or included in any
 * error message or diagnostic.
 */
import { ProviderFailure } from '../../errors.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
export type QueryValue = string | number | undefined;

export interface MassiveClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  /** Per upstream call. Default 15 s (large aggregate pages). */
  timeoutMs?: number;
  /** Maximum upstream calls this client may make (one client per incoming request or hub). */
  maxCalls?: number;
}

export class MassiveHttpClient {
  private readonly options: MassiveClientOptions;
  private readonly origin: string;
  private callCount = 0;

  constructor(options: MassiveClientOptions) {
    this.options = options;
    this.origin = new URL(options.baseUrl).origin;
  }

  /** Upstream calls made so far (diagnostics). */
  get calls(): number {
    return this.callCount;
  }

  /** Allows a long-lived owner (the stream hub) to reuse one client with a fresh budget. */
  resetBudget(): void {
    this.callCount = 0;
  }

  /**
   * GET JSON from `path` (relative to the base URL, with `query`) or from a `next_url` cursor the
   * API returned. Resolves with the parsed body of a 2xx; rejects with a ProviderFailure otherwise.
   */
  async getJson(
    pathOrCursor: string,
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

    const url = this.buildUrl(pathOrCursor, query);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);

    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
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
        reason: 'history_unavailable',
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) throw await failureFor(response);
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

  /**
   * Builds the request URL. A cursor must stay on the configured origin (never follow a URL the
   * API points elsewhere), and any key-bearing query parameter is dropped.
   */
  private buildUrl(pathOrCursor: string, query: Readonly<Record<string, QueryValue>>): string {
    const url = /^https?:\/\//.test(pathOrCursor)
      ? new URL(pathOrCursor)
      : new URL(pathOrCursor.replace(/^\//, ''), `${this.origin}/`);
    if (url.origin !== this.origin) {
      throw new ProviderFailure({
        code: 'internal',
        message: 'Upstream cursor points to an unexpected host',
        retryable: false,
      });
    }
    url.searchParams.delete('apiKey');
    url.searchParams.delete('apikey');
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

function aborted(): ProviderFailure {
  return new ProviderFailure({ code: 'unavailable', message: 'Request aborted', retryable: false });
}

/** Maps a non-2xx upstream response. The body is read only for a short log-safe status code. */
async function failureFor(response: Response): Promise<ProviderFailure> {
  const status = response.status;
  let providerCode = String(status);
  try {
    const body = (await response.json()) as { status?: unknown };
    if (typeof body.status === 'string') providerCode = `${status}/${body.status.slice(0, 16)}`;
  } catch {
    // Non-JSON error bodies are ignored.
  }
  const base = { providerCode };
  switch (true) {
    case status === 400 || status === 422:
      return new ProviderFailure({
        ...base,
        code: 'invalid_request',
        message: 'Upstream rejected the request',
        retryable: false,
      });
    case status === 401:
      return new ProviderFailure({
        ...base,
        code: 'unauthorized',
        message: 'Upstream authentication failed',
        retryable: false,
        reason: 'auth_failed',
      });
    case status === 403:
      return new ProviderFailure({
        ...base,
        code: 'insufficient_entitlement',
        message: 'Upstream subscription does not permit this request',
        retryable: false,
        reason: 'entitlement',
      });
    case status === 404:
      return new ProviderFailure({
        ...base,
        code: 'not_found',
        message: 'Upstream resource not found',
        retryable: false,
      });
    case status === 429: {
      const seconds = Number(response.headers.get('Retry-After'));
      return new ProviderFailure({
        ...base,
        code: 'rate_limited',
        message: 'Upstream rate limit reached',
        retryable: true,
        ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: seconds * 1000 } : {}),
      });
    }
    default:
      return new ProviderFailure({
        ...base,
        code: 'unavailable',
        message: 'Upstream unavailable',
        retryable: status >= 500,
        reason: 'history_unavailable',
      });
  }
}
