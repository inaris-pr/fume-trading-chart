/**
 * Authentication (docs/security.md, step 2). Stage 4 has exactly one authenticator: the dev-only
 * local path, enabled only when FUME_ENV is "local" AND the request targets a loopback host.
 * Everything else fails closed with 401 until a later stage adds Cloudflare Access.
 */
import { ApiError } from './errors.ts';

export interface Principal {
  kind: 'local-dev';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function authenticate(request: Request, fumeEnv: string | undefined): Principal {
  if (fumeEnv === 'local' && LOOPBACK_HOSTS.has(new URL(request.url).hostname)) {
    return { kind: 'local-dev' };
  }
  throw new ApiError(401, 'unauthorized', 'Authentication required');
}
