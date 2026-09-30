/**
 * NON-PRODUCTION SPIKE CODE (Massive Futures Starter capability spike, 2026-09-30).
 * Not imported by the production Worker. Shared helpers for rest.ts and ws.ts.
 *
 * The API key is read only from the gitignored apps/worker/.dev.vars (MASSIVE_API_KEY). It is sent
 * only in the `Authorization: Bearer` header (REST) or the WebSocket auth frame; it is never
 * printed, logged, saved or put in a URL. Every printed line passes through `log`, which withholds
 * any line that contains the key.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REST_HOST = 'https://api.massive.com';
export const ROOTS = ['GC', 'SI', 'CL', 'NQ', 'YM'] as const;

const here = dirname(fileURLToPath(import.meta.url));

function readKey(): string {
  const path = join(here, '..', '..', '.dev.vars');
  if (!existsSync(path)) return '';
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*MASSIVE_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (m) return m[1]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return '';
}

export const apiKey = readKey();
if (!apiKey) {
  console.log('Spike cannot run: MASSIVE_API_KEY is not defined in apps/worker/.dev.vars.');
  process.exit(2);
}

const t0 = Date.now();
export function log(line: string): void {
  if (line.includes(apiKey)) line = '[line withheld: contained the API key]';
  console.log(line);
}
export const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(7)}s`;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ISO-8601 UTC with seconds, from ms or ns epoch. */
export function iso(t: number | bigint | string | undefined): string {
  if (t === undefined) return '-';
  const n = typeof t === 'string' ? Number(t) : Number(t);
  const ms = n > 1e17 ? n / 1e6 : n > 1e14 ? n / 1e3 : n;
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

export interface Page<T> {
  status?: string;
  results?: T[];
  next_url?: string;
  error?: string;
  message?: string;
  count?: number;
}

export interface HttpResult<T> {
  http: number;
  body: Page<T>;
  ms: number;
}

/** GET a Massive REST path (or a returned next_url on the same host). Key only in the header. */
export async function get<T>(pathOrUrl: string): Promise<HttpResult<T>> {
  const url = new URL(pathOrUrl, REST_HOST);
  if (url.origin !== REST_HOST) throw new Error(`refusing non-Massive origin ${url.origin}`);
  url.searchParams.delete('apiKey');
  const start = Date.now();
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const text = await res.text();
  let body: Page<T>;
  try {
    body = JSON.parse(text) as Page<T>;
  } catch {
    body = { status: 'NON_JSON', message: text.slice(0, 200) };
  }
  return { http: res.status, body, ms: Date.now() - start };
}

/** Path + query shown in logs (never contains the key: it is only sent as a header). */
export function show(pathOrUrl: string): string {
  const u = new URL(pathOrUrl, REST_HOST);
  u.searchParams.delete('apiKey');
  const q = u.searchParams.has('cursor') ? '?cursor=…' : u.search;
  return `${u.pathname}${q}`;
}
