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
