/**
 * HTTP client for Fume's own backend API (`/api/v1`). By default it talks to the relative
 * `/api/v1` path of the page's origin (the Vite dev server proxies it to the local Worker); a host
 * can point it at another base URL and add credentials through the auth hook. It knows nothing
 * about any market-data provider: responses are validated against the provider-neutral
 * @fume/core shapes, and a malformed backend response fails with a clear FumeApiError instead of
 * reaching the chart.
 */
import type {
  AssetClass,
  BarSeriesMeta,
  Bar,
  Instrument,
  InstrumentId,
  MarketSession,
  UnixMs,
} from '@fume/core';
import { DataFeedError, type BarsPage, type BarsQuery } from '../types.ts';

/** Default API base: same origin, relative. */
export const API_BASE = '/api/v1';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Extra request headers for every API call (e.g. a bearer token from the host's session).
 * Called per request, so a host can refresh tokens. Never logged by Fume.
 */
export type AuthHook = () => Record<string, string> | Promise<Record<string, string>>;

export interface FumeHttpClientOptions {
  /** API base, relative ("/api/v1", default) or absolute ("https://fume.example/api/v1"). */
  baseUrl?: string;
  fetch?: FetchLike;
  getAuthHeaders?: AuthHook;
}

/** A non-2xx or malformed backend response (HTTP status kept for diagnostics). */
export class FumeApiError extends DataFeedError {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    retryable: boolean,
    retryAfterMs?: number,
    reason?: string,
  ) {
    super(code, message, retryable, reason);
    this.name = 'FumeApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ResolveResult {
  instrument: Instrument;
  /** Opaque stream-hub key issued by the backend, or null (history only). */
  streamKey: string | null;
}

export class FumeHttpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly getAuthHeaders: AuthHook | null;

  constructor(options: FumeHttpClientOptions | FetchLike = {}) {
    const o = typeof options === 'function' ? { fetch: options } : options;
    this.baseUrl = (o.baseUrl ?? API_BASE).replace(/\/+$/, '');
    this.fetchImpl = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.getAuthHeaders = o.getAuthHeaders ?? null;
  }

  /**
   * Resolves a symbol of an asset class: an equity/ETF ticker (default) or a futures root such as
   * "NQ", which the backend resolves to a specific contract.
   */
  async resolveInstrument(
    symbol: string,
    signal?: AbortSignal,
    assetClass: AssetClass = 'equity',
  ): Promise<ResolveResult> {
    const query = new URLSearchParams({ symbol });
    if (assetClass === 'future') query.set('assetClass', 'future');
    const body = await this.get(`/instruments/resolve?${query}`, signal);
    const instrument = isRecord(body) ? body.instrument : undefined;
    if (!isInstrument(instrument)) throw malformed('instrument');
    const stream = isRecord(body) ? body.stream : undefined;
    const streamKey =
      isRecord(stream) && typeof stream.key === 'string' && /^[a-z0-9-]{1,32}$/.test(stream.key)
        ? stream.key
        : null;
    return { instrument, streamKey };
  }

  async getSessions(
    instrumentId: InstrumentId,
    from: UnixMs,
    to: UnixMs,
    signal?: AbortSignal,
  ): Promise<MarketSession[]> {
    const query = new URLSearchParams({ instrumentId, from: String(from), to: String(to) });
    const body = await this.get(`/sessions?${query}`, signal);
    const sessions = isRecord(body) ? body.sessions : undefined;
    if (!Array.isArray(sessions) || !sessions.every(isSession)) throw malformed('sessions');
    return sessions;
  }

  async getBars(query: BarsQuery): Promise<BarsPage> {
    const params = new URLSearchParams({
      instrumentId: query.instrumentId,
      timeframe: query.timeframe,
      session: 'regular',
      limit: String(query.limit),
    });
    if (query.end !== undefined) params.set('end', String(query.end));
    const body = await this.get(`/bars?${params}`, query.signal);
    if (!isRecord(body)) throw malformed('bars');
    const { meta, bars, hasMore, serverTime } = body;
    if (
      !isMeta(meta) ||
      meta.instrumentId !== query.instrumentId ||
      meta.timeframe !== query.timeframe
    ) {
      throw malformed('bars meta');
    }
    if (!Array.isArray(bars) || !bars.every(isBar) || !ascendingUnique(bars))
      throw malformed('bars');
    if (typeof hasMore !== 'boolean' || !isInt(serverTime)) throw malformed('bars page');
    if (query.end !== undefined && bars.some((b) => b.start >= query.end!))
      throw malformed('bars (end)');
    return { meta, bars, hasMore, serverTime };
  }

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      const auth = this.getAuthHeaders ? await this.getAuthHeaders() : {};
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { ...auth, Accept: 'application/json' },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new FumeApiError(0, 'unavailable', 'Fume backend is unreachable', true);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new FumeApiError(
        response.status,
        'internal',
        'Fume backend returned a non-JSON response',
        false,
      );
    }
    if (!response.ok) {
      const error = isRecord(body) && isRecord(body.error) ? body.error : null;
      const retryAfter = Number(response.headers.get('Retry-After'));
      const details = isRecord(error?.details) ? error.details : null;
      throw new FumeApiError(
        response.status,
        typeof error?.code === 'string' ? error.code : 'internal',
        typeof error?.message === 'string' ? error.message : `HTTP ${response.status}`,
        error?.retryable === true,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
        typeof details?.reason === 'string' ? details.reason : undefined,
      );
    }
    return body;
  }
}

// ---------------------------------------------------------------------------------------------
// Response validation (structural; enough to fail clearly on a malformed backend response)

const malformed = (what: string) =>
  new FumeApiError(200, 'internal', `Malformed backend response (${what})`, false);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);

function isBar(v: unknown): v is Bar {
  if (!isRecord(v)) return false;
  const { start, open, high, low, close, volume, status, revision, tradeCount, vwap } = v;
  return (
    isInt(start) &&
    isFiniteNumber(open) &&
    isFiniteNumber(high) &&
    isFiniteNumber(low) &&
    isFiniteNumber(close) &&
    isFiniteNumber(volume) &&
    high >= low &&
    (status === 'final' || status === 'provisional') &&
    isInt(revision) &&
    (tradeCount === undefined || isFiniteNumber(tradeCount)) &&
    (vwap === undefined || isFiniteNumber(vwap))
  );
}

function ascendingUnique(bars: readonly Bar[]): boolean {
  for (let i = 1; i < bars.length; i++) if (!(bars[i]!.start > bars[i - 1]!.start)) return false;
  return true;
}

function isMeta(v: unknown): v is BarSeriesMeta {
  if (!isRecord(v) || !isRecord(v.feed)) return false;
  return (
    typeof v.instrumentId === 'string' &&
    typeof v.timeframe === 'string' &&
    v.sessionMode === 'regular' &&
    typeof v.feed.providerId === 'string' &&
    typeof v.feed.feedId === 'string' &&
    typeof v.feed.consolidated === 'boolean' &&
    isFiniteNumber(v.feed.delayMs) &&
    (v.feed.displayName === undefined || typeof v.feed.displayName === 'string')
  );
}

function isSession(v: unknown): v is MarketSession {
  if (!isRecord(v) || typeof v.sessionDate !== 'string' || !Array.isArray(v.windows)) return false;
  return v.windows.every(
    (w) =>
      isRecord(w) &&
      isInt(w.start) &&
      isInt(w.end) &&
      (w.end as number) > (w.start as number) &&
      (w.kind === 'regular' || w.kind === 'pre' || w.kind === 'post' || w.kind === 'overnight'),
  );
}

function isInstrument(v: unknown): v is Instrument {
  if (!isRecord(v) || !isRecord(v.session) || !isRecord(v.priceFormat)) return false;
  return (
    typeof v.id === 'string' &&
    typeof v.displaySymbol === 'string' &&
    typeof v.currency === 'string' &&
    Array.isArray(v.tickRules) &&
    typeof v.session.timezone === 'string' &&
    typeof v.tradable === 'boolean'
  );
}
