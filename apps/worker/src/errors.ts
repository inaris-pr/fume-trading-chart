/**
 * Fume HTTP error contract (docs/http-api.md). Every non-2xx response is
 * `{ "error": { code, message, retryable, details? } }`. Provider adapters throw ProviderFailure
 * (the core ProviderError shape); the router maps it to an ApiError here, so no raw upstream
 * payload, status text, header or stack trace ever reaches a client.
 */
import type { ProviderError } from '@fume/core';

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden_origin'
  | 'invalid_request'
  | 'not_found'
  | 'rejected'
  | 'insufficient_entitlement'
  | 'rate_limited'
  | 'unavailable'
  | 'internal';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, string> | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    retryable = false,
    details?: Record<string, string>,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
  }
}

export const invalidRequest = (message: string, field?: string) =>
  new ApiError(400, 'invalid_request', message, false, field ? { field } : undefined);

/** A normalized provider failure (core ProviderError semantics), thrown by adapters. */
export class ProviderFailure extends Error implements ProviderError {
  readonly code: ProviderError['code'];
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** Raw provider code for logs only. */
  readonly providerCode?: string;

  constructor(error: ProviderError) {
    super(error.message);
    this.name = 'ProviderFailure';
    this.code = error.code;
    this.retryable = error.retryable;
    if (error.retryAfterMs !== undefined) this.retryAfterMs = error.retryAfterMs;
    if (error.providerCode !== undefined) this.providerCode = error.providerCode;
  }
}

/** Maps a provider failure to the client-facing error. Messages are Fume's own, never upstream text. */
export function fromProviderFailure(failure: ProviderFailure): ApiError {
  switch (failure.code) {
    case 'invalid_request':
      return new ApiError(400, 'invalid_request', 'The market-data provider rejected the request');
    case 'not_found':
      return new ApiError(404, 'not_found', 'Not found');
    case 'insufficient_entitlement':
      return new ApiError(
        403,
        'insufficient_entitlement',
        'The market-data subscription does not include this data',
      );
    case 'rate_limited':
      return new ApiError(
        429,
        'rate_limited',
        'Market-data provider rate limit reached; retry later',
        true,
        undefined,
        failure.retryAfterMs,
      );
    case 'unauthorized':
      // The backend's own provider credentials were rejected: not the caller's fault.
      return new ApiError(
        503,
        'unavailable',
        'The market-data provider rejected the backend credentials',
      );
    case 'rejected':
      return new ApiError(422, 'rejected', 'The provider rejected the request');
    case 'internal':
      return new ApiError(
        502,
        'unavailable',
        'The market-data provider returned an invalid response',
      );
    case 'unavailable':
      return new ApiError(
        503,
        'unavailable',
        'The market-data provider is unavailable',
        failure.retryable,
      );
  }
}

/** Anything thrown while handling a request, as an ApiError (unknown errors become 500 internal). */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ProviderFailure) return fromProviderFailure(error);
  return new ApiError(500, 'internal', 'Internal error');
}

export function errorBody(error: ApiError) {
  return {
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

/** Retry-After header value in whole seconds (rounded up), or null. */
export function retryAfterSeconds(error: ApiError): string | null {
  if (error.retryAfterMs === undefined || !(error.retryAfterMs >= 0)) return null;
  return String(Math.max(1, Math.ceil(error.retryAfterMs / 1000)));
}
