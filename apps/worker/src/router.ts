/**
 * /api/v1 router. Provider-neutral: it sees only the MarketDataRegistry (core provider ports plus
 * routing metadata) and an optional stream-hub forwarder.
 *
 * Every request passes, in order: (1) origin policy, (2) authentication, (3) method + route,
 * (4) parameter validation, (5) the handler. Every error, including 404 and 405, uses the Fume
 * envelope (errors.ts). Responses are JSON with `Cache-Control: no-store`, except a successful
 * WebSocket upgrade on /api/v1/stream, which is the stream hub's own 101 response.
 */
import type { BarSeriesMeta, HistoricalMarketDataProvider, Instrument, UnixMs } from '@fume/core';
import { authenticate } from './auth.ts';
import { loadCanonicalPage } from './canonical-history.ts';
import { checkOrigin, corsHeaders, preflightResponse } from './cors.ts';
import { ApiError, errorBody, reasonMessage, retryAfterSeconds, toApiError } from './errors.ts';
import type { MarketDataRegistry, RegisteredFeed } from './registry.ts';
import {
  parseAssetClass,
  parseInstrumentId,
  parseLimit,
  parseOptionalEnd,
  parseRange,
  parseSessionMode,
  parseStreamKey,
  parseSymbol,
  parseTimeframe,
} from './validate.ts';

export const FUME_VERSION = '0.5.0-dev';
/** Retry-After sent with a 429 when the provider did not supply one. */
const DEFAULT_RETRY_AFTER_MS = 60_000;
const STREAM_PATH = '/api/v1/stream';

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

/** Forwards an authenticated, validated WebSocket upgrade to the hub serving `key`. */
export type StreamForwarder = (key: string, request: Request) => Promise<Response>;

export interface RouterDeps {
  fumeEnv: string | undefined;
  allowedOrigins: ReadonlySet<string>;
  registry: MarketDataRegistry;
  now: () => UnixMs;
  /** Null/absent when no stream hub is bound (history only). */
  stream?: StreamForwarder | null;
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
  const isStream = url.pathname === STREAM_PATH;
  const route = ROUTES[url.pathname] || isStream ? url.pathname : 'unmatched';
  let origin: string | null = null;
  let logExtra: Partial<RequestLog> = {};
  let response: Response;
  try {
    origin = checkOrigin(request, deps.allowedOrigins);
    if (request.method === 'OPTIONS') {
      response = preflightResponse(origin);
    } else {
      authenticate(request, deps.fumeEnv);
      if (isStream) {
        response = await forwardStream(url, deps, request);
      } else {
        const handler = ROUTES[url.pathname];
        if (!handler) throw new ApiError(404, 'not_found', 'No such route');
        if (request.method !== 'GET') {
          throw new ApiError(405, 'invalid_request', 'Method not allowed');
        }
        const result = await handler(url, deps, request);
        logExtra = result.log ?? {};
        response = json(200, result.body, origin);
      }
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

function requireProvider(feed: RegisteredFeed | null): HistoricalMarketDataProvider {
  if (!feed?.provider) {
    throw new ApiError(503, 'unavailable', 'Market data is not configured on this backend');
  }
  return feed.provider;
}

// ---------------------------------------------------------------------------------------------
// Handlers

/** Non-sensitive status only. Makes no upstream request. */
async function health(_url: URL, deps: RouterDeps) {
  const equity = deps.registry.forAssetClass('equity');
  return {
    body: {
      ok: true,
      version: FUME_VERSION,
      tradingEnvironment: 'paper',
      marketDataFeed: equity?.provider ? equity.feed.feedId : null,
      marketDataConfigured: equity?.provider != null,
      feeds: deps.registry.feeds.map((f) => ({
        assetClasses: f.assetClasses,
        feedId: f.feed.feedId,
        delayMs: f.feed.delayMs,
        configured: f.provider !== null,
        streaming: f.provider !== null && f.streamKey !== null && deps.stream != null,
      })),
    },
  };
}

async function resolveInstrument(url: URL, deps: RouterDeps) {
  const symbol = parseSymbol(url.searchParams.get('symbol'));
  const assetClass = parseAssetClass(url.searchParams.get('assetClass'));
  const feed = deps.registry.forAssetClass(assetClass);
  const instrument = await requireProvider(feed).resolveInstrument(symbol);
  if (!instrument) {
    throw assetClass === 'future'
      ? new ApiError(404, 'not_found', reasonMessage('contract_not_found'), false, {
          reason: 'contract_not_found',
        })
      : new ApiError(404, 'not_found', `Unknown or inactive symbol ${symbol}`);
  }
  return { body: { instrument, stream: streamInfo(feed!, deps) } };
}

/** Where the browser gets live data for an instrument (an opaque key), or null (history only). */
function streamInfo(feed: RegisteredFeed, deps: RouterDeps): { key: string } | null {
  return feed.streamKey !== null && deps.stream ? { key: feed.streamKey } : null;
}

async function loadInstrument(
  deps: RouterDeps,
  rawId: string | null,
): Promise<{
  instrument: Instrument;
  feed: RegisteredFeed;
  provider: HistoricalMarketDataProvider;
}> {
  const { id, symbol } = parseInstrumentId(rawId);
  const feed = deps.registry.forInstrumentId(id);
  if (!feed) throw new ApiError(404, 'not_found', `Unknown instrument ${id}`);
  const provider = requireProvider(feed);
  const instrument = provider.getInstrument
    ? await provider.getInstrument(id)
    : symbol !== null
      ? await provider.resolveInstrument(symbol)
      : null;
  if (!instrument || instrument.id !== id) {
    throw new ApiError(404, 'not_found', `Unknown or inactive instrument ${id}`);
  }
  return { instrument, feed, provider };
}

async function sessions(url: URL, deps: RouterDeps) {
  const { from, to } = parseRange(url.searchParams.get('from'), url.searchParams.get('to'));
  const { instrument, provider } = await loadInstrument(deps, url.searchParams.get('instrumentId'));
  const result = [...(await provider.getSessions(instrument, from, to))].sort((a, b) =>
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
  const { instrument, feed, provider } = await loadInstrument(deps, params.get('instrumentId'));
  const now = deps.now();
  const page = await loadCanonicalPage({
    provider,
    instrument,
    timeframe,
    mode: sessionMode,
    ...(end !== undefined ? { end } : {}),
    limit,
    // A delayed feed's data is complete only up to now - delay: a bucket that has ended in wall
    // time but not in delayed time is still missing minutes, so it must stay provisional.
    now: now - provider.feed.delayMs,
    historyFloor: feed.historyFloor(),
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

/**
 * GET /api/v1/stream?key=<opaque> with `Upgrade: websocket`: after the origin and authentication
 * checks, the upgrade is handed to the stream hub for that key (one hub per provider feed).
 */
async function forwardStream(url: URL, deps: RouterDeps, request: Request): Promise<Response> {
  if (request.method !== 'GET') throw new ApiError(405, 'invalid_request', 'Method not allowed');
  if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
    throw new ApiError(426, 'invalid_request', 'WebSocket upgrade required');
  }
  const key = parseStreamKey(url.searchParams.get('key'));
  const feed = deps.registry.forStreamKey(key);
  if (!feed) throw new ApiError(404, 'not_found', 'Unknown stream');
  requireProvider(feed);
  if (!deps.stream) throw new ApiError(503, 'unavailable', 'Streaming is not configured');
  return deps.stream(key, request);
}
