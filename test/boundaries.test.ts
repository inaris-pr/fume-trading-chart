/**
 * Repository guard rails for Stage 0/1 architecture boundaries. These read source files; they do
 * not execute the chart.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(ts|tsx)$/.test(name)
        ? [path]
        : [];
  });
}

const read = (path: string) => readFileSync(path, 'utf8');
const importsOf = (code: string) =>
  [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);

describe('@fume/chart stays framework-independent and provider-neutral', () => {
  const files = sourceFiles(join(root, 'packages/chart/src'));
  const pkg = JSON.parse(read(join(root, 'packages/chart/package.json'))) as Record<
    string,
    Record<string, string> | undefined
  >;

  test('no React (or any UI framework) imports or dependencies', () => {
    for (const file of files) {
      for (const spec of importsOf(read(file))) {
        expect(spec, file).not.toMatch(/^(react|react-dom|preact|vue|svelte|solid-js)(\/|$)/);
      }
    }
    const deps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies };
    expect(Object.keys(deps)).toEqual(['@fume/core']);
  });

  test('no runtime dependency on @fume/core in the manifest (ARCHITECTURE §3)', () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.devDependencies ?? {})).toEqual(['@fume/core']);
  });

  test('no value re-exports or dynamic imports of @fume/core', () => {
    for (const file of files) {
      const code = read(file);
      expect(code, file).not.toMatch(/export\s+(?!type\b)[^;]*from\s+['"]@fume\/core/);
      expect(code, file).not.toMatch(/import\(\s*['"]@fume\/core/);
    }
  });

  test('only type imports from @fume/core (no runtime coupling)', () => {
    for (const file of files) {
      const code = read(file);
      for (const m of code.matchAll(/import\s+(type\s+)?[^;]*?from\s+['"]@fume\/core['"]/g)) {
        expect(m[1], `${file}: ${m[0]}`).toBe('type ');
      }
    }
  });

  test('no market-specific assumptions in the renderer', () => {
    const forbidden = [
      /America\//,
      /\bSPY\b/,
      /09:30|16:00/,
      /\bNYSE\b|\bXNYS\b/,
      /['"]\$|`\$(?!\{)/,
      /alpaca/i,
      /\bUSD\b/,
    ];
    for (const file of files) {
      const code = read(file);
      for (const pattern of forbidden)
        expect(code, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  });
});

describe('@fume/core stays free of DOM and providers', () => {
  test('no DOM, React or provider SDK imports', () => {
    for (const file of sourceFiles(join(root, 'packages/core/src'))) {
      const code = read(file);
      for (const spec of importsOf(code)) expect(spec, file).toMatch(/^\.\.?\//);
      expect(code, file).not.toMatch(/\bdocument\.|\bwindow\./);
    }
  });
});

describe('dependency tree', () => {
  test('no third-party financial chart renderer anywhere in the lockfile', () => {
    const lock = read(join(root, 'pnpm-lock.yaml')).toLowerCase();
    const banned = [
      'lightweight-charts',
      'tradingview',
      'highcharts',
      'apexcharts',
      'plotly',
      'echarts',
      'chart.js',
      'react-financial-charts',
      'techan',
      'anychart',
      'amcharts',
      'klinecharts',
      'd3-financial',
    ];
    for (const name of banned) expect(lock, name).not.toContain(name);
  });
});

// Comments are stripped: doc comments legitimately name Alpaca as an example provider.
const code = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('core, chart, replay and web stay provider-neutral (Stages 2-4)', () => {
  const providerSpecific = [
    /alpaca/i,
    /\bAPCA\b/,
    /['"`](?:https?|wss?):\/\//,
    /wrangler/i,
    /from\s+['"]cloudflare:/,
    /\bDurableObject\b/,
    /\bsecret\s*key\b/i,
  ];
  const network = [/\bfetch\s*\(/, /new\s+WebSocket\s*\(/, /\bXMLHttpRequest\b/, /\bEventSource\b/];

  test('core, chart and replay: no provider names, network calls, endpoints, credentials or Worker code', () => {
    for (const dir of ['packages/core/src', 'packages/chart/src', 'packages/replay/src']) {
      for (const file of sourceFiles(join(root, dir))) {
        const source = code(file);
        for (const pattern of [...providerSpecific, ...network])
          expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  test('web: never names a provider or host; the only network call is the relative /api/v1 client', () => {
    const client = join(root, 'apps/web/src/api/fume-client.ts');
    for (const file of sourceFiles(join(root, 'apps/web/src'))) {
      const source = code(file);
      for (const pattern of providerSpecific)
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      for (const pattern of network) {
        if (file === client && pattern.source.includes('fetch')) continue;
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
      for (const spec of importsOf(read(file))) expect(spec, file).not.toMatch(/worker/);
    }
    expect(code(client)).toMatch(/API_BASE = '\/api\/v1'/);
  });

  test('ticker and timeframe logic lives in the app shell, not in the chart engine', () => {
    for (const file of sourceFiles(join(root, 'packages/chart/src'))) {
      const code = read(file);
      expect(code, file).not.toMatch(/\b(QQQ|AAPL|NVDA|TSLA)\b/);
      expect(code, file).not.toMatch(/['"](1m|5m|15m|1h|4h|1d)['"]/);
    }
  });
});

describe('Stage 4 Worker boundaries', () => {
  const workerSrc = join(root, 'apps/worker/src');
  const alpacaDir = join(workerSrc, 'providers', 'alpaca');
  const compositionRoot = join(workerSrc, 'index.ts');
  const files = sourceFiles(workerSrc);

  test('the Worker imports only @fume/core and its own modules (no router framework, no SDKs)', () => {
    for (const file of files) {
      for (const spec of importsOf(read(file)))
        expect(spec, file).toMatch(/^(\.\.?\/|@fume\/core$)/);
    }
    const pkg = JSON.parse(read(join(root, 'apps/worker/package.json'))) as Record<
      string,
      Record<string, string>
    >;
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@fume/core']);
    expect(Object.keys(pkg.devDependencies ?? {})).toEqual(['wrangler']);
  });

  test('Alpaca specifics live only in providers/alpaca (plus the composition root that wires it)', () => {
    for (const file of files) {
      if (file.startsWith(alpacaDir) || file === compositionRoot) continue;
      const source = code(file);
      for (const pattern of [
        /alpaca/i,
        /\bAPCA\b/i,
        /['"`]https?:\/\//,
        /next_page_token|page_token/,
      ])
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  test('only the composition root imports provider adapters', () => {
    for (const file of files) {
      if (file === compositionRoot || file.startsWith(alpacaDir)) continue;
      for (const spec of importsOf(read(file))) expect(spec, file).not.toMatch(/providers\//);
    }
  });

  test('core, chart, replay and web never import the Worker', () => {
    for (const dir of [
      'packages/core/src',
      'packages/chart/src',
      'packages/replay/src',
      'apps/web/src',
    ]) {
      for (const file of sourceFiles(join(root, dir))) {
        for (const spec of importsOf(read(file)))
          expect(spec, file).not.toMatch(/@fume\/worker|apps\/worker/);
      }
    }
  });

  test('Stage 4 scope: no WebSocket, Durable Object, storage or trading code in the Worker', () => {
    for (const file of files) {
      const source = code(file);
      for (const pattern of [
        /WebSocket/,
        /DurableObject/,
        /\bKVNamespace\b|\bD1Database\b|\bR2Bucket\b/,
        /\/v2\/orders|\/v2\/positions|\/v2\/account|submitOrder|cancelOrder/,
      ])
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  test('wrangler.jsonc: local only, no secrets, no bindings for storage or Durable Objects', () => {
    const config = read(join(root, 'apps/worker/wrangler.jsonc'));
    expect(config).toMatch(/"workers_dev":\s*false/);
    expect(config).toMatch(/"preview_urls":\s*false/);
    expect(config).not.toMatch(/ALPACA_API_KEY_ID"\s*:|ALPACA_API_SECRET_KEY"\s*:/);
    expect(config).not.toMatch(
      /durable_objects|kv_namespaces|d1_databases|r2_buckets|"routes"|"route"/,
    );
    expect(config).toMatch(/"ALPACA_DATA_FEED":\s*"iex"/);
    expect(config).toMatch(/"ALPACA_TRADING_BASE_URL":\s*"https:\/\/paper-api\.alpaca\.markets"/);
  });

  test('.dev.vars is gitignored and its example holds empty values only', () => {
    const ignore = read(join(root, '.gitignore'));
    expect(ignore).toMatch(/^\.dev\.vars$/m);
    const example = read(join(root, 'apps/worker/.dev.vars.example'));
    for (const line of example.split('\n').filter((l) => /^[A-Z_]+=/.test(l))) {
      expect(line, 'example values must be empty').toMatch(/^[A-Z_]+=$/);
    }
  });

  test('recorded fixtures contain no credentials or auth headers', () => {
    const dir = join(root, 'apps/worker/test/fixtures');
    const fixtureFiles = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name));
    for (const file of fixtureFiles) {
      const text = read(file);
      expect(text, file).not.toMatch(/APCA-API|apca-api|Authorization|secret|key_id|keyId/i);
      expect(text, file).not.toMatch(/\bPK[A-Z0-9]{16,}\b|\bAK[A-Z0-9]{16,}\b/);
      expect(text, file).not.toMatch(/account_number|account_id/);
    }
  });
});

describe('Stage 3 package boundaries', () => {
  const pkg = (dir: string) =>
    JSON.parse(read(join(root, dir, 'package.json'))) as Record<
      string,
      Record<string, string> | undefined
    >;

  test('@fume/replay depends only on @fume/core and imports nothing else', () => {
    const p = pkg('packages/replay');
    expect(Object.keys({ ...p.dependencies, ...p.peerDependencies })).toEqual(['@fume/core']);
    for (const file of sourceFiles(join(root, 'packages/replay/src'))) {
      for (const spec of importsOf(read(file))) {
        expect(spec, file).toMatch(/^(\.\.?\/|@fume\/core(\/fixtures)?$)/);
      }
    }
  });

  test('core and chart never import the replay provider (or the web app)', () => {
    for (const dir of ['packages/core/src', 'packages/chart/src']) {
      for (const file of sourceFiles(join(root, dir))) {
        for (const spec of importsOf(read(file))) {
          expect(spec, file).not.toMatch(/@fume\/(replay|web)/);
        }
      }
    }
  });

  test('the provider adapter lives outside core: core has no MarketDataProvider implementation', () => {
    for (const file of sourceFiles(join(root, 'packages/core/src'))) {
      expect(read(file), file).not.toMatch(/implements\s+MarketDataProvider/);
    }
  });
});
