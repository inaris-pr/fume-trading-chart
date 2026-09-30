/**
 * Fume stream protocol v1 (docs/websocket-api.md): client <-> hub frames. Provider-neutral: market
 * payloads are core MarketEvents; stream health is a sanitized core StreamState.
 */
import type { DataFeedInfo, MarketEvent, ProviderError, StreamState, UnixMs } from '@fume/core';

export const PROTOCOL_VERSION = 1;

export type ClientFrame =
  | { type: 'hello'; protocol: number }
  | { type: 'subscribe'; subId: string; instrumentId: string; streams: readonly string[] }
  | { type: 'unsubscribe'; subId: string }
  | { type: 'ping'; t: number };

export type ServerFrame =
  | {
      type: 'welcome';
      protocol: number;
      serverTime: UnixMs;
      connectionId: string;
      feed: DataFeedInfo;
      tradingEnvironment: 'paper';
    }
  | { type: 'subscribed'; subId: string; instrumentId: string }
  | { type: 'unsubscribed'; subId: string }
  | { type: 'market'; events: readonly MarketEvent[] }
  | { type: 'status'; market: StreamState }
  | { type: 'resync'; scope: 'market'; reason: string }
  | { type: 'pong'; t: number; serverTime: UnixMs }
  | { type: 'error'; code: string; message: string; subId?: string };

const SUB_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Parses one client text frame; null when it is not a valid v1 frame. */
export function parseClientFrame(text: string): ClientFrame | null {
  if (text.length > 4096) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const f = v as Record<string, unknown>;
  switch (f.type) {
    case 'hello':
      return typeof f.protocol === 'number' ? { type: 'hello', protocol: f.protocol } : null;
    case 'subscribe':
      return typeof f.subId === 'string' &&
        SUB_ID.test(f.subId) &&
        typeof f.instrumentId === 'string' &&
        f.instrumentId.length <= 64 &&
        Array.isArray(f.streams) &&
        f.streams.every((s) => typeof s === 'string')
        ? {
            type: 'subscribe',
            subId: f.subId,
            instrumentId: f.instrumentId,
            streams: f.streams as string[],
          }
        : null;
    case 'unsubscribe':
      return typeof f.subId === 'string' && SUB_ID.test(f.subId)
        ? { type: 'unsubscribe', subId: f.subId }
        : null;
    case 'ping':
      return typeof f.t === 'number' && Number.isFinite(f.t) ? { type: 'ping', t: f.t } : null;
    default:
      return null;
  }
}

/** Stream state for clients: provider-neutral fields only (no raw provider codes). */
export function sanitizeState(state: StreamState): StreamState {
  const clean = (e: ProviderError | undefined): ProviderError | undefined =>
    e
      ? {
          code: e.code,
          message: e.message,
          retryable: e.retryable,
          ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
          ...(e.reason !== undefined ? { reason: e.reason } : {}),
        }
      : undefined;
  if (state.status === 'reconnecting') {
    const lastError = clean(state.lastError);
    return {
      status: 'reconnecting',
      attempt: state.attempt,
      nextRetryAt: state.nextRetryAt,
      ...(lastError ? { lastError } : {}),
    };
  }
  if (state.status === 'closed') {
    const error = clean(state.error);
    return { status: 'closed', ...(error ? { error } : {}) };
  }
  return state;
}
