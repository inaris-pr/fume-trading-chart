/**
 * /api/v1 router. Provider-neutral: it sees only the core HistoricalMarketDataProvider port.
 *
 * Every request passes, in order: (1) origin policy, (2) authentication, (3) method + route,
 * (4) parameter validation, (5) the handler. Every error, including 404 and 405, uses the Fume
 * envelope (errors.ts). Responses are JSON with `Cache-Control: no-store`.
 */
import type { BarSeriesMeta, HistoricalMarketDataProvider, UnixMs } from '@fume/core';
import { authenticate } from './auth.ts';
import { loadCanonicalPage } from './canonical-history.ts';
import { checkOrigin, corsHeaders, preflightResponse } from './cors.ts';
import { ApiError, errorBody, retryAfterSeconds, toApiError } from './errors.ts';
import {
  parseInstrumentId,
  parseLimit,
  parseOptionalEnd,
  parseRange,
  parseSessionMode,
  parseSymbol,
  parseTimeframe,
} from './validate.ts';

export const FUME_VERSION = '0.4.0-dev';
/** Retry-After sent with a 429 when the provider did not supply one. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

export interface RequestLog {
  route: string;
  status: number;
  ms: number;
  code?: string;
  providerCalls?: number;
  baseIntervalMinutes?: number | null;
  baseBars?: number;
  bars?: number;
  sessions?: number;
  truncated?: boolean;
}

export interface RouterDeps {
  fumeEnv: string | undefined;
  allowedOrigins: ReadonlySet<string>;
  /** Null when the market-data provider is not configured (missing credentials etc.). */
  provider: HistoricalMarketDataProvider | null;
  historyFloor: UnixMs;
  now: () => UnixMs;
  /** Upstream calls made while handling this request (diagnostics only). */
  providerCalls?: () => number;
  /** Structured diagnostics only; never headers, credentials or config. */
  log?: (entry: RequestLog) => void;
}

type Handler = (
  url: URL,
  deps: RouterDeps,
  request: Request,
) => Promise<{ body: unknown; log?: Partial<RequestLog> }>;

const ROUTES: Readonly<Record<string, Handler>> = {
  '/api/v1/health': health,
  '/api/v1/instruments/resolve': resolveInstrument,
  '/api/v1/sessions': sessions,
  '/api/v1/bars': bars,
};

export async function handleRequest(request: Request, deps: RouterDeps): Promise<Response> {
  const started = deps.now();
  const url = new URL(request.url);
  const route = ROUTES[url.pathname] ? url.pathname : 'unmatched';
  let origin: string | null = null;
  let logExtra: Partial<RequestLog> = {};
  let response: Response;
  try {
    origin = checkOrigin(request, deps.allowedOrigins);
    if (request.method === 'OPTIONS') {
      response = preflightResponse(origin);
    } else {
      authenticate(request, deps.fumeEnv);
      const handler = ROUTES[url.pathname];
      if (!handler) throw new ApiError(404, 'not_found', 'No such route');
      if (request.method !== 'GET') {
        throw new ApiError(405, 'invalid_request', 'Method not allowed');
      }
      const result = await handler(url, deps, request);
      logExtra = result.log ?? {};
      response = json(200, result.body, origin);
    }
  } catch (error) {
    const apiError = toApiError(error);
    logExtra = { ...logExtra, code: apiError.code };
    const headers: Record<string, string> = {};
    if (apiError.code === 'rate_limited') {
      headers['Retry-After'] =
        retryAfterSeconds(apiError) ?? String(Math.ceil(DEFAULT_RETRY_AFTER_MS / 1000));
    }
    if (apiError.status === 405) headers.Allow = 'GET, OPTIONS';
    // A rejected origin gets no CORS headers (the browser must not read the response).
    response = json(
      apiError.status,
      errorBody(apiError),
      apiError.code === 'forbidden_origin' ? null : origin,
      headers,
    );
  }
  deps.log?.({
    route,
    status: response.status,
    ms: deps.now() - started,
    ...(deps.providerCalls ? { providerCalls: deps.providerCalls() } : {}),
    ...logExtra,
  });
  return response;
}

function json(
  status: number,
  body: unknown,
  origin: string | null,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...corsHeaders(origin),
      ...extra,
    },
  });
}

function requireProvider(deps: RouterDeps): HistoricalMarketDataProvider {
  if (!deps.provider) {
    throw new ApiError(503, 'unavailable', 'Market data is not configured on this backend');
  }
  return deps.provider;
}

// ---------------------------------------------------------------------------------------------
// Handlers

/** Non-sensitive status only. Makes no upstream request. */
async function health(_url: URL, deps: RouterDeps) {
  return {
    body: {
      ok: true,
      version: FUME_VERSION,
      tradingEnvironment: 'paper',
      marketDataFeed: deps.provider?.feed.feedId ?? null,
      marketDataConfigured: deps.provider !== null,
    },
  };
}

async function resolveInstrument(url: URL, deps: RouterDeps) {
  const symbol = parseSymbol(url.searchParams.get('symbol'));
  const instrument = await requireProvider(deps).resolveInstrument(symbol);
  if (!instrument) throw new ApiError(404, 'not_found', `Unknown or inactive symbol ${symbol}`);
  return { body: { instrument } };
}

async function loadInstrument(deps: RouterDeps, rawId: string | null) {
  const { id, symbol } = parseInstrumentId(rawId);
  const instrument = await requireProvider(deps).resolveInstrument(symbol);
  if (!instrument || instrument.id !== id) {
    throw new ApiError(404, 'not_found', `Unknown or inactive instrument ${id}`);
  }
  return instrument;
}

async function sessions(url: URL, deps: RouterDeps) {
  const { from, to } = parseRange(url.searchParams.get('from'), url.searchParams.get('to'));
  const instrument = await loadInstrument(deps, url.searchParams.get('instrumentId'));
  const result = [...(await requireProvider(deps).getSessions(instrument, from, to))].sort((a, b) =>
    a.sessionDate.localeCompare(b.sessionDate),
  );
  return { body: { sessions: result }, log: { sessions: result.length } };
}

async function bars(url: URL, deps: RouterDeps, request: Request) {
  const params = url.searchParams;
  const timeframe = parseTimeframe(params.get('timeframe'));
  const sessionMode = parseSessionMode(params.get('session'));
  const end = parseOptionalEnd(params.get('end'));
  const limit = parseLimit(params.get('limit'));
  const instrument = await loadInstrument(deps, params.get('instrumentId'));
  const provider = requireProvider(deps);
  const now = deps.now();
  const page = await loadCanonicalPage({
    provider,
    instrument,
    timeframe,
    mode: sessionMode,
    ...(end !== undefined ? { end } : {}),
    limit,
    now,
    historyFloor: deps.historyFloor,
    signal: request.signal,
  });
  const meta: BarSeriesMeta = {
    instrumentId: instrument.id,
    timeframe,
    sessionMode,
    feed: provider.feed,
  };
  return {
    body: { meta, bars: page.bars, hasMore: page.hasMore, serverTime: now },
    log: {
      baseIntervalMinutes: page.diagnostics.baseIntervalMinutes,
      baseBars: page.diagnostics.baseBars,
      bars: page.bars.length,
      sessions: page.diagnostics.sessions,
      truncated: page.diagnostics.truncated,
    },
  };
}
