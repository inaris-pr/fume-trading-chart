import { afterEach, beforeAll, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { readFileSync } from 'node:fs';
import { MASSIVE_ENV } from './fake-massive.ts';

const HOST = 'https://fume.example.test';
const ISSUER = 'https://fume-test.cloudflareaccess.com';
const AUD = 'test-audience';
const ENV = {
  FUME_ENV: 'production',
  FUME_ALLOWED_ORIGINS: HOST,
  FUME_ACCESS_TEAM_DOMAIN: ISSUER,
  FUME_ACCESS_AUD: AUD,
};
let key: CryptoKey;
let wrongKey: CryptoKey;
let jwks: { keys: unknown[] };
let worker: typeof import('../src/index.ts').default;
let authenticate: typeof import('../src/auth.ts').authenticate;
let fetchMock: Mock<(url: string | URL) => Promise<Response>>;
let assetFetch: Mock<(request: Request) => Promise<Response>>;
let hubFetch: Mock<(request: Request) => Promise<Response>>;
let logs: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  key = pair.privateKey;
  wrongKey = (await generateKeyPair('RS256')).privateKey;
  jwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }],
  };
});
beforeEach(async () => {
  vi.resetModules();
  fetchMock = vi.fn(async (url: string | URL) => {
    expect(String(url)).toBe(ISSUER + '/cdn-cgi/access/certs');
    return Response.json(jwks);
  });
  vi.stubGlobal('fetch', fetchMock);
  assetFetch = vi.fn(
    async () => new Response('<html>app</html>', { headers: { 'Content-Type': 'text/html' } }),
  );
  hubFetch = vi.fn(async () => new Response('upgraded-by-test-hub'));
  logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  worker = (await import('../src/index.ts')).default;
  authenticate = (await import('../src/auth.ts')).authenticate;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function token(overrides: JWTPayload = {}, signingKey = key, omit: string[] = []) {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    iss: ISSUER,
    aud: AUD,
    sub: 'test-user',
    iat: now - 10,
    exp: now + 300,
    ...overrides,
  };
  for (const name of omit) delete payload[name];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(signingKey);
}
function request(path: string, assertion?: string, headers: Record<string, string> = {}) {
  return new Request(HOST + path, {
    headers: { ...(assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {}), ...headers },
  });
}
function runtime(overrides = {}) {
  return { ...ENV, ASSETS: { fetch: assetFetch }, ...overrides };
}
function streamingEnv() {
  return runtime({
    ...MASSIVE_ENV,
    FUME_MASSIVE_ENABLED: 'true', // synthetic test only; never authorization for real cloud data
    FEED_HUB: { idFromName: (name: string) => name, get: () => ({ fetch: hubFetch }) },
  });
}
const streamPath = '/api/v1/stream?key=futures-delayed';

describe('production Access authentication', () => {
  test('accepts signed JWT and caches trusted public keys; no claims or token in response/logs', async () => {
    const assertion = await token();
    for (let i = 0; i < 2; i++) {
      const response = await worker.fetch(request('/api/v1/health', assertion), runtime());
      expect(response.status).toBe(200);
      expect(await response.text()).not.toMatch(/test-user|cloudflareaccess|test-audience/);
      expect(JSON.stringify([...response.headers])).not.toContain(assertion);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain(assertion);
  });

  test.each([
    ['missing', async () => undefined],
    ['malformed', async () => 'not-a-jwt'],
    ['wrong signature', () => token({}, wrongKey)],
    ['wrong audience', () => token({ aud: 'another-app' })],
    ['wrong issuer', () => token({ iss: 'https://attacker.example' })],
    ['expired', () => token({ exp: Math.floor(Date.now() / 1000) - 1 })],
    ['future nbf', () => token({ nbf: Math.floor(Date.now() / 1000) + 300 })],
    ['future issued-at', () => token({ iat: Math.floor(Date.now() / 1000) + 30 })],
    ['missing expiry', () => token({}, key, ['exp'])],
    ['missing issued-at', () => token({}, key, ['iat'])],
    ['missing subject', () => token({}, key, ['sub'])],
  ])('rejects %s on API and WebSocket before dispatch', async (_name, makeToken) => {
    const assertion = await makeToken();
    for (const path of ['/api/v1/health', streamPath]) {
      const response = await worker.fetch(
        request(path, assertion, { Origin: HOST, Upgrade: 'websocket' }),
        streamingEnv(),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: 'unauthorized', message: 'Authentication required' },
      });
    }
    expect(hubFetch).not.toHaveBeenCalled();
    expect(assetFetch).not.toHaveBeenCalled();
  });

  test('rejects algorithm confusion', async () => {
    const assertion = await new SignJWT({
      iss: ISSUER,
      aud: AUD,
      sub: 'user',
      iat: 1,
      exp: 9999999999,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new Uint8Array(32));
    expect((await worker.fetch(request('/api/v1/health', assertion), runtime())).status).toBe(401);
  });

  test.each([
    { FUME_ACCESS_TEAM_DOMAIN: '' },
    { FUME_ACCESS_AUD: '' },
    { FUME_ACCESS_TEAM_DOMAIN: 'http://fume-test.cloudflareaccess.com' },
    { FUME_ACCESS_TEAM_DOMAIN: 'https://attacker.example' },
    { FUME_ENV: 'prod' },
    { FUME_ENV: 'local' },
  ])('fails closed for missing/unsafe configuration %j', async (override) => {
    expect(
      (await worker.fetch(request('/api/v1/health', await token()), runtime(override))).status,
    ).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('JWKS network failure is sanitized', async () => {
    fetchMock.mockRejectedValue(new Error('private upstream diagnostic'));
    const response = await worker.fetch(request('/api/v1/health', await token()), runtime());
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain('private upstream');
  });

  test('unknown signing key is denied', async () => {
    fetchMock.mockResolvedValue(Response.json({ keys: [] }));
    expect((await worker.fetch(request('/api/v1/health', await token()), runtime())).status).toBe(
      401,
    );
  });

  test('does not accept tokens from query, Authorization, cookie or claimed email', async () => {
    const assertion = await token();
    const response = await worker.fetch(
      request('/api/v1/health?token=' + assertion, undefined, {
        Authorization: 'Bearer ' + assertion,
        Cookie: 'CF_Authorization=' + assertion,
        'Cf-Access-Authenticated-User-Email': 'owner@example.test',
      }),
      runtime(),
    );
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('local isolation', () => {
  test.each(['localhost', '127.0.0.1', '[::1]'])(
    'preserves local mode for %s without Access',
    async (host) => {
      expect(
        await authenticate(new Request('http://' + host + ':8787/api/v1/health'), 'local'),
      ).toEqual({ kind: 'local-dev' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  test('production never uses loopback bypass; spoofed headers never make remote local', async () => {
    await expect(
      authenticate(new Request('https://localhost/api/v1/health'), 'production'),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticate(
        request('/api/v1/health', undefined, {
          Host: 'localhost',
          'X-Forwarded-Host': 'localhost',
          'X-Forwarded-Proto': 'http',
        }),
        'local',
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticate(new Request('http://fume.example.test/'), 'production'),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('frontend and API separation', () => {
  test.each(['/', '/charts/SPY', '/assets/app.js'])(
    'authenticated %s delegates to static asset binding',
    async (path) => {
      const assertion = await token();
      const response = await worker.fetch(
        request(path, assertion, { Cookie: 'CF_Authorization=' + assertion }),
        runtime(),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<html>app</html>');
      const forwarded = assetFetch.mock.calls[0]![0] as Request;
      expect(new URL(forwarded.url).pathname).toBe(path);
      expect(forwarded.headers.has('Cf-Access-Jwt-Assertion')).toBe(false);
      expect(forwarded.headers.has('Cookie')).toBe(false);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    },
  );
  test.each(['/', '/charts/SPY', '/assets/app.js'])(
    'unauthenticated %s cannot fetch an asset',
    async (path) => {
      expect((await worker.fetch(request(path), runtime())).status).toBe(401);
      expect(assetFetch).not.toHaveBeenCalled();
    },
  );
  test.each(['/api', '/api/unknown', '/api/v1/missing', '/api/v1/health/'])(
    'API failure at %s never becomes HTML',
    async (path) => {
      const response = await worker.fetch(request(path, await token()), runtime());
      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Type')).toContain('application/json');
      expect(assetFetch).not.toHaveBeenCalled();
    },
  );
  test('API method failures and arbitrary provider destination stay inside API', async () => {
    const assertion = await token();
    const post = new Request(HOST + '/api/v1/health', {
      method: 'POST',
      headers: { 'Cf-Access-Jwt-Assertion': assertion },
    });
    expect((await worker.fetch(post, runtime())).status).toBe(405);
    const response = await worker.fetch(
      request('/api/v1/proxy?url=https://attacker.example', assertion),
      runtime(),
    );
    expect(response.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only configured Access keys
    expect(assetFetch).not.toHaveBeenCalled();
  });
  test('asset binding missing or failing is sanitized; upgrades cannot become SPA', async () => {
    const assertion = await token();
    expect((await worker.fetch(request('/', assertion), ENV)).status).toBe(503);
    assetFetch.mockRejectedValueOnce(new Error('sensitive runtime detail'));
    const response = await worker.fetch(request('/', assertion), runtime());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('sensitive runtime detail');
    expect(
      (await worker.fetch(request('/charts', assertion, { Upgrade: 'websocket' }), runtime()))
        .status,
    ).toBe(404);
  });
  test('preserves asset 404 instead of masking failures', async () => {
    assetFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    expect(
      (await worker.fetch(request('/assets/missing.js', await token()), runtime())).status,
    ).toBe(404);
  });
});

describe('WebSocket and production futures gate', () => {
  test('valid origin and Access assertion reach the existing hub; auth headers are stripped', async () => {
    const assertion = await token();
    const response = await worker.fetch(
      request(streamPath, assertion, { Origin: HOST, Upgrade: 'websocket', Cookie: 'session' }),
      streamingEnv(),
    );
    expect(response.status).toBe(200); // Node test double, real hub returns 101 in workerd
    expect(hubFetch).toHaveBeenCalledTimes(1);
    const forwarded = hubFetch.mock.calls[0]![0] as Request;
    expect(forwarded.headers.get('X-Fume-Stream-Key')).toBe('futures-delayed');
    expect(forwarded.headers.has('Cf-Access-Jwt-Assertion')).toBe(false);
    expect(forwarded.headers.has('Cookie')).toBe(false);
    expect(assetFetch).not.toHaveBeenCalled();
  });
  test('wrong origin blocks an otherwise valid WebSocket', async () => {
    expect(
      (
        await worker.fetch(
          request(streamPath, await token(), {
            Origin: 'https://other.example',
            Upgrade: 'websocket',
          }),
          streamingEnv(),
        )
      ).status,
    ).toBe(403);
    expect(hubFetch).not.toHaveBeenCalled();
  });
  test.each([undefined, 'false', 'TRUE'])(
    'production Massive disabled for flag %s even with key',
    async (flag) => {
      const env = { ...streamingEnv(), FUME_MASSIVE_ENABLED: flag };
      const assertion = await token();
      expect(
        (
          await worker.fetch(
            request('/api/v1/instruments/resolve?symbol=NQ&assetClass=future', assertion),
            env,
          )
        ).status,
      ).toBe(503);
      expect(
        (
          await worker.fetch(
            request(streamPath, assertion, { Origin: HOST, Upgrade: 'websocket' }),
            env,
          )
        ).status,
      ).toBe(503);
      expect(hubFetch).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { massiveSettingsFromEnv } = await import('../src/providers/massive/config.ts');
      expect(massiveSettingsFromEnv(env)).toEqual({ ok: false, reason: 'disabled' });
    },
  );
  test('local Massive behavior remains enabled by credentials; explicit opt-out works', async () => {
    const { massiveSettingsFromEnv } = await import('../src/providers/massive/config.ts');
    expect(massiveSettingsFromEnv({ ...MASSIVE_ENV, FUME_ENV: 'local' }).ok).toBe(true);
    expect(
      massiveSettingsFromEnv({ ...MASSIVE_ENV, FUME_ENV: 'local', FUME_MASSIVE_ENABLED: 'false' })
        .ok,
    ).toBe(false);
  });
});

test('production deployment configuration has authenticated worker-first assets and existing DO migration', () => {
  const raw = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'));
  expect(config.vars.FUME_ENV).toBe('local');
  expect(config.assets).toBeUndefined(); // pnpm dev:worker requires no frontend build
  const prod = config.env.production;
  expect(prod.assets).toMatchObject({
    binding: 'ASSETS',
    directory: '../web/dist',
    run_worker_first: true,
    not_found_handling: 'single-page-application',
  });
  expect(prod.vars).toMatchObject({
    FUME_ENV: 'production',
    FUME_MASSIVE_ENABLED: 'false',
    FUME_ACCESS_TEAM_DOMAIN: '',
    FUME_ACCESS_AUD: '',
  });
  expect(prod.durable_objects.bindings).toEqual([
    { name: 'FEED_HUB', class_name: 'FeedHubObject' },
  ]);
  expect(prod.migrations).toEqual([{ tag: 'v1', new_sqlite_classes: ['FeedHubObject'] }]);
  expect(prod.workers_dev).toBe(false);
  expect(prod.preview_urls).toBe(false);
  expect(prod.routes).toEqual([]);
  expect(Object.keys(prod.vars)).not.toContain('ALPACA_API_KEY_ID');
  expect(Object.keys(prod.vars)).not.toContain('ALPACA_API_SECRET_KEY');
  expect(Object.keys(prod.vars)).not.toContain('MASSIVE_API_KEY');
});
