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
      /massive/i,
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

describe('core, chart, replay and web stay provider-neutral (Stages 2-5)', () => {
  const providerSpecific = [
    /alpaca/i,
    /massive/i,
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

  test('web: never names a provider or host and makes no network calls itself (the DataFeed does)', () => {
    for (const file of sourceFiles(join(root, 'apps/web/src'))) {
      const source = code(file);
      for (const pattern of [...providerSpecific, ...network])
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      for (const spec of importsOf(read(file))) expect(spec, file).not.toMatch(/worker/);
    }
  });

  test('web consumes packages only through their public entry points', () => {
    for (const file of sourceFiles(join(root, 'apps/web/src'))) {
      for (const spec of importsOf(read(file))) {
        if (spec.startsWith('.')) continue;
        expect(spec, file).toMatch(
          /^(@fume\/(core|chart|datafeed|react|replay)|react|react-dom(\/client)?)$/,
        );
      }
    }
  });

  test('@fume/datafeed: provider-neutral; network only in its API client files, relative default base', () => {
    const dir = join(root, 'packages/datafeed/src');
    const http = join(dir, 'api', 'http-client.ts');
    const stream = join(dir, 'api', 'stream-connection.ts');
    for (const file of sourceFiles(dir)) {
      const source = code(file);
      for (const pattern of providerSpecific)
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      for (const pattern of network) {
        if (file === http && pattern.source.includes('fetch')) continue;
        if (file === stream && pattern.source.includes('WebSocket')) continue;
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
      for (const spec of importsOf(read(file))) {
        expect(spec, file).toMatch(/^(\.\.?\/|@fume\/(core|chart|replay)$)/);
      }
      // The chart engine is used for types only (the host owns the FumeChart instance).
      for (const m of read(file).matchAll(
        /import\s+(type\s+)?[^;]*?from\s+['"]@fume\/chart['"]/g,
      )) {
        expect(m[1], `${file}: ${m[0]}`).toBe('type ');
      }
    }
    expect(code(http)).toMatch(/API_BASE = '\/api\/v1'/);
    // Stream URLs are built from the configured base on the page origin (no host compiled in).
    expect(code(stream)).toMatch(/location\.href/);
  });

  test('@fume/react: a thin binding over core/chart/datafeed; React is a peer dependency', () => {
    const dir = join(root, 'packages/react/src');
    for (const file of sourceFiles(dir)) {
      const source = code(file);
      for (const pattern of [...providerSpecific, ...network, /\bwindow\./])
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      for (const spec of importsOf(read(file))) {
        expect(spec, file).toMatch(/^(\.\.?\/|@fume\/(core|chart|datafeed)$|react$)/);
      }
    }
    const pkg = JSON.parse(read(join(root, 'packages/react/package.json'))) as Record<
      string,
      Record<string, string> | undefined
    >;
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      '@fume/chart',
      '@fume/core',
      '@fume/datafeed',
    ]);
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual(['react']);
    expect(pkg.dependencies?.react).toBeUndefined();
  });

  test('core, chart, replay and datafeed never import @fume/react (dependency direction)', () => {
    for (const dir of [
      'packages/core/src',
      'packages/chart/src',
      'packages/replay/src',
      'packages/datafeed/src',
    ]) {
      for (const file of sourceFiles(join(root, dir))) {
        for (const spec of importsOf(read(file))) expect(spec, file).not.toMatch(/@fume\/react/);
      }
    }
  });

  test('core, chart and replay never import @fume/datafeed (dependency direction)', () => {
    for (const dir of ['packages/core/src', 'packages/chart/src', 'packages/replay/src']) {
      for (const file of sourceFiles(join(root, dir))) {
        for (const spec of importsOf(read(file))) expect(spec, file).not.toMatch(/@fume\/datafeed/);
      }
    }
  });

  test('ticker and timeframe logic lives in the app shell, not in the chart engine', () => {
    for (const file of sourceFiles(join(root, 'packages/chart/src'))) {
      const code = read(file);
      expect(code, file).not.toMatch(/\b(QQQ|AAPL|NVDA|TSLA)\b/);
      expect(code, file).not.toMatch(/['"](1m|5m|15m|1h|4h|1d)['"]/);
    }
  });
});

describe('Worker boundaries (Stages 4-5)', () => {
  const workerSrc = join(root, 'apps/worker/src');
  const providersDir = join(workerSrc, 'providers');
  const alpacaDir = join(providersDir, 'alpaca');
  const massiveDir = join(providersDir, 'massive');
  const hubDir = join(workerSrc, 'hub');
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

  test('provider specifics live only in their providers/<name> directory (plus the composition root)', () => {
    const rules: [string, RegExp[]][] = [
      [alpacaDir, [/alpaca/i, /\bAPCA\b/i, /next_page_token|page_token/]],
      [massiveDir, [/massive/i, /next_url/, /\bev\s*===?\s*['"]AM?['"]/]],
    ];
    for (const file of files) {
      if (file === compositionRoot) continue;
      const source = code(file);
      for (const [dir, patterns] of rules) {
        if (file.startsWith(dir)) continue;
        for (const pattern of patterns)
          expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
      // Hosts and URLs only inside provider adapters.
      if (!file.startsWith(providersDir)) {
        expect(source, `${file} names a URL`).not.toMatch(/['"`](?:https?|wss?):\/\//);
      }
    }
  });

  test('the Worker entry module exports only the fetch handler and Durable Object classes', () => {
    // workerd rejects any other export (e.g. a constant) at startup.
    const exports = read(compositionRoot)
      .split('\n')
      .filter((l) => /^export\b/.test(l));
    expect(exports.length).toBeGreaterThan(0);
    for (const line of exports) expect(line).toMatch(/^export (default \{|class \w+ extends \w+)/);
  });

  test('only the composition root imports provider adapters', () => {
    for (const file of files) {
      if (file === compositionRoot || file.startsWith(providersDir)) continue;
      for (const spec of importsOf(read(file))) expect(spec, file).not.toMatch(/providers\//);
    }
  });

  test('providers never import each other, the router, the registry or the hub (upstream socket types only)', () => {
    for (const file of files) {
      if (!file.startsWith(providersDir)) continue;
      const other = file.startsWith(alpacaDir) ? /massive/ : /alpaca/;
      for (const spec of importsOf(read(file))) {
        expect(spec, file).not.toMatch(other);
        expect(spec, file).not.toMatch(/router|registry|durable-object|feed-hub|protocol/);
      }
    }
  });

  test('core, chart, replay and web never import the Worker', () => {
    for (const dir of [
      'packages/core/src',
      'packages/chart/src',
      'packages/replay/src',
      'packages/datafeed/src',
      'apps/web/src',
    ]) {
      for (const file of sourceFiles(join(root, dir))) {
        for (const spec of importsOf(read(file)))
          expect(spec, file).not.toMatch(/@fume\/worker|apps\/worker/);
      }
    }
  });

  test('Stage 5 scope: WebSocket/Durable Object code only in hub/, stream adapters and the root; no storage services or trading code', () => {
    const streamAdapters = [join(massiveDir, 'stream.ts')];
    // The router only validates the upgrade request and forwards it to the hub.
    const router = join(workerSrc, 'router.ts');
    for (const file of files) {
      const source = code(file);
      const allowed =
        file.startsWith(hubDir) ||
        streamAdapters.includes(file) ||
        file === compositionRoot ||
        file === router;
      if (!allowed) {
        for (const pattern of [/WebSocket/, /DurableObject/])
          expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
      for (const pattern of [
        /\bKVNamespace\b|\bD1Database\b|\bR2Bucket\b/,
        /\/v2\/orders|\/v2\/positions|\/v2\/account|submitOrder|cancelOrder/,
      ])
        expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  });

  test('wrangler.jsonc: local only, no secrets, only the feed-hub Durable Object binding', () => {
    const config = read(join(root, 'apps/worker/wrangler.jsonc'));
    expect(config).toMatch(/"workers_dev":\s*false/);
    expect(config).toMatch(/"preview_urls":\s*false/);
    expect(config).not.toMatch(
      /ALPACA_API_KEY_ID"\s*:|ALPACA_API_SECRET_KEY"\s*:|MASSIVE_API_KEY"\s*:/,
    );
    expect(config).not.toMatch(/kv_namespaces|d1_databases|r2_buckets|"routes"|"route"/);
    expect(config).toMatch(/"name":\s*"FEED_HUB",\s*"class_name":\s*"FeedHubObject"/);
    expect(config).toMatch(/"new_sqlite_classes":\s*\["FeedHubObject"\]/);
    expect(config).toMatch(/"ALPACA_DATA_FEED":\s*"iex"/);
    expect(config).toMatch(/"ALPACA_TRADING_BASE_URL":\s*"https:\/\/paper-api\.alpaca\.markets"/);
    expect(config).toMatch(
      /"MASSIVE_FUTURES_STREAM_URL":\s*"wss:\/\/delayed\.massive\.com\/futures"/,
    );
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
      expect(text, file).not.toMatch(
        /APCA-API|apca-api|Authorization|Bearer|secret|key_id|keyId|apiKey|"action"\s*:\s*"auth"/i,
      );
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
