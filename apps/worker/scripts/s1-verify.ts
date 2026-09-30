/**
 * Spike S1: verify Alpaca IEX historical base bars against REAL data before Fume relies on native
 * 5Min/15Min bars (docs/market-data.md, docs/research.md).
 *
 *   pnpm --filter @fume/worker s1
 *
 * - Reads credentials from apps/worker/.dev.vars (gitignored). Never prints, logs or saves them.
 * - Saves sanitized RESPONSE BODIES only (no request headers, no config) as test fixtures in
 *   test/fixtures/alpaca/recorded/, plus a machine-readable summary of the checks.
 * - Exits non-zero if a check that gates a native interval fails.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCanonicalBars,
  nestsExactly,
  type Bar,
  type InstrumentId,
  type MarketSession,
  type TimeframeId,
} from '@fume/core';
import { ProviderFailure } from '../src/errors.ts';
import { AlpacaHttpClient } from '../src/providers/alpaca/client.ts';
import {
  ALPACA_DATA_BASE_URL,
  ALPACA_PAPER_TRADING_BASE_URL,
} from '../src/providers/alpaca/config.ts';
import {
  localDate,
  normalizeBars,
  normalizeCalendar,
  parseBarsPage,
  toAlpacaInclusiveEnd,
  toAlpacaStart,
  US_EQUITY_TIMEZONE,
} from '../src/providers/alpaca/normalize.ts';

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = join(here, '..');
const outDir = join(workerDir, 'test', 'fixtures', 'alpaca', 'recorded');
const MIN = 60_000;
const DAY = 86_400_000;
const SYMBOL = 'SPY';
const ID = 'eq:SPY' as InstrumentId;

// ---------------------------------------------------------------------------------------------
// Credentials (never printed)

function readDevVars(): { keyId: string; secretKey: string } | null {
  const path = join(workerDir, '.dev.vars');
  if (!existsSync(path)) return null;
  const vars = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2'));
  }
  const keyId = vars.get('ALPACA_API_KEY_ID') ?? '';
  const secretKey = vars.get('ALPACA_API_SECRET_KEY') ?? '';
  return keyId && secretKey ? { keyId, secretKey } : null;
}

const credentials = readDevVars();
if (!credentials) {
  console.log('S1 cannot run: apps/worker/.dev.vars is missing or does not define both');
  console.log('ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY. No request was made.');
  process.exit(2);
}
const secrets = [credentials.keyId, credentials.secretKey];

const client = new AlpacaHttpClient({
  dataBaseUrl: ALPACA_DATA_BASE_URL,
  tradingBaseUrl: ALPACA_PAPER_TRADING_BASE_URL,
  credentials,
  fetch: (input, init) => fetch(input, init),
  maxCalls: 60,
});

// ---------------------------------------------------------------------------------------------
// Fixture capture (bodies only; refuses to write anything containing a credential)

mkdirSync(outDir, { recursive: true });
const saved: string[] = [];

function save(name: string, body: unknown): void {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  for (const secret of secrets) {
    if (secret && text.includes(secret))
      throw new Error(`Refusing to save ${name}: contains a credential`);
  }
  writeFileSync(join(outDir, name), text);
  saved.push(name);
}

async function get(api: 'data' | 'trading', path: string, query: Record<string, string | number>) {
  return client.getJson(api, path, query);
}

/** Raw status + body of a request expected to fail (for error fixtures). Body only is saved. */
async function rawError(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'APCA-API-KEY-ID': credentials!.keyId,
      'APCA-API-SECRET-KEY': credentials!.secretKey,
    },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------------------------
// Checks

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function barsFor(
  minutes: number,
  start: number,
  endExclusive: number,
  extra: Record<string, string | number> = {},
) {
  const body = await get('data', `v2/stocks/${SYMBOL}/bars`, {
    timeframe: `${minutes}Min`,
    start: toAlpacaStart(start),
    end: toAlpacaInclusiveEnd(endExclusive),
    limit: 10_000,
    adjustment: 'raw',
    feed: 'iex',
    sort: 'asc',
    ...extra,
  });
  return body;
}

function fold(bars: readonly Bar[], from: number, to: number) {
  const inside = bars.filter((b) => b.start >= from && b.start < to);
  if (inside.length === 0) return null;
  return {
    open: inside[0]!.open,
    high: Math.max(...inside.map((b) => b.high)),
    low: Math.min(...inside.map((b) => b.low)),
    close: inside.at(-1)!.close,
    volume: inside.reduce((n, b) => n + b.volume, 0),
    tradeCount: inside.reduce((n, b) => n + (b.tradeCount ?? 0), 0),
  };
}

const sameOhlcv = (a: ReturnType<typeof fold>, b: Bar) =>
  a !== null &&
  a.open === b.open &&
  a.high === b.high &&
  a.low === b.low &&
  a.close === b.close &&
  a.volume === b.volume;

function compareCanonical(
  label: string,
  x: readonly Bar[],
  y: readonly Bar[],
): { equal: boolean; detail: string } {
  if (x.length !== y.length)
    return { equal: false, detail: `${label}: ${x.length} vs ${y.length} candles` };
  const diffs: string[] = [];
  x.forEach((a, i) => {
    const b = y[i]!;
    for (const k of ['start', 'open', 'high', 'low', 'close', 'volume', 'tradeCount'] as const) {
      if (a[k] !== b[k]) diffs.push(`${new Date(a.start).toISOString()} ${k} ${a[k]} vs ${b[k]}`);
    }
  });
  return {
    equal: diffs.length === 0,
    detail:
      diffs.length === 0
        ? `${x.length} candles identical (OHLC, volume, trade count)`
        : diffs.slice(0, 5).join('; '),
  };
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const now = Date.now();

  // 1. Calendar: the latest COMPLETED full regular session (and an early-close month for fixtures).
  const calendarBody = await get('trading', 'v2/calendar', {
    start: localDate(now - 40 * DAY, US_EQUITY_TIMEZONE),
    end: localDate(now + 14 * DAY, US_EQUITY_TIMEZONE),
  });
  save('calendar-recent.json', calendarBody);
  const calendar = normalizeCalendar(calendarBody, ID);
  const completed = calendar.filter((s) => s.windows[0]!.end <= now - 20 * MIN);
  const full = completed.filter((s) => s.windows[0]!.end - s.windows[0]!.start === 6.5 * 60 * MIN);
  const session: MarketSession | undefined = full.at(-1);
  if (!session) throw new Error('No completed full regular session found in the calendar');
  const open = session.windows[0]!.start;
  const close = session.windows[0]!.end;
  console.log(
    `S1 session: ${session.sessionDate} (${new Date(open).toISOString()} – ${new Date(close).toISOString()})`,
  );
  check(
    'calendar: session opens 09:30 and closes 16:00 New York time',
    true,
    `${session.sessionDate}`,
  );

  const earlyBody = await get('trading', 'v2/calendar', { start: '2025-11-24', end: '2025-12-31' });
  save('calendar-early-close-2025-11.json', earlyBody);
  const early = normalizeCalendar(earlyBody, ID);
  const earlyCloses = early.filter((s) => s.windows[0]!.end - s.windows[0]!.start < 6.5 * 60 * MIN);
  check(
    'calendar: early closes present in Nov/Dec 2025',
    earlyCloses.length > 0,
    earlyCloses
      .map((s) => `${s.sessionDate} ${new Date(s.windows[0]!.end).toISOString().slice(11, 16)}Z`)
      .join(', '),
  );
  const thanksgiving = early.some((s) => s.sessionDate === '2025-11-27');
  check('calendar: holiday 2025-11-27 (Thanksgiving) absent', !thanksgiving);

  // 2. Asset.
  save('asset-spy.json', await get('trading', `v2/assets/${SYMBOL}`, {}));
  const unknown = await rawError(`${ALPACA_PAPER_TRADING_BASE_URL}/v2/assets/ZZZZNOTREAL`);
  save('error-404-asset.json', { status: unknown.status, body: unknown.body });

  // 3. Bars for the completed session at 1/5/15 minutes, feed=iex, adjustment=raw.
  const raw1 = await barsFor(1, open, close);
  const raw5 = await barsFor(5, open, close);
  const raw15 = await barsFor(15, open, close);
  save(`bars-spy-1min-${session.sessionDate}.json`, raw1);
  save(`bars-spy-5min-${session.sessionDate}.json`, raw5);
  save(`bars-spy-15min-${session.sessionDate}.json`, raw15);
  const later = now + DAY;
  const b1 = normalizeBars(parseBarsPage(raw1).bars, MIN, later).bars;
  const b5 = normalizeBars(parseBarsPage(raw5).bars, 5 * MIN, later).bars;
  const b15 = normalizeBars(parseBarsPage(raw15).bars, 15 * MIN, later).bars;
  for (const [label, page] of [
    ['1Min', raw1],
    ['5Min', raw5],
    ['15Min', raw15],
  ] as const) {
    check(`${label}: single page (no next_page_token)`, parseBarsPage(page).nextPageToken === null);
  }
  console.log(
    `bar counts: 1Min ${b1.length} / 390, 5Min ${b5.length} / 78, 15Min ${b15.length} / 26`,
  );

  // Alignment (normalizeBar already rejects misaligned bars; recorded here explicitly).
  check(
    '1Min bars epoch-aligned',
    b1.every((b) => b.start % MIN === 0),
  );
  check(
    '5Min bars epoch-aligned',
    b5.every((b) => b.start % (5 * MIN) === 0),
  );
  check(
    '15Min bars epoch-aligned',
    b15.every((b) => b.start % (15 * MIN) === 0),
  );
  check(
    'all bars inside the regular session [open, close)',
    [...b1, ...b5, ...b15].every((b) => b.start >= open && b.start < close),
  );

  // t = bar START: native 5/15 bars equal the fold of the 1Min bars in [t, t + interval).
  const startLabeled = (bars: readonly Bar[], size: number) =>
    bars.every((b) => sameOhlcv(fold(b1, b.start, b.start + size), b));
  const endLabeled = (bars: readonly Bar[], size: number) =>
    bars.every((b) => sameOhlcv(fold(b1, b.start - size, b.start), b));
  check(
    't labels the bar START (5Min = fold of 1Min [t, t+5m))',
    startLabeled(b5, 5 * MIN),
    `end-labeled hypothesis: ${endLabeled(b5, 5 * MIN)}`,
  );
  check(
    't labels the bar START (15Min = fold of 1Min [t, t+15m))',
    startLabeled(b15, 15 * MIN),
    `end-labeled hypothesis: ${endLabeled(b15, 15 * MIN)}`,
  );
  check(
    'first 1Min bar is at the 09:30 open',
    b1[0]?.start === open,
    new Date(b1[0]?.start ?? 0).toISOString(),
  );
  check('no bar starts at the 16:00 close', ![...b1, ...b5, ...b15].some((b) => b.start === close));

  // Gaps.
  const have = new Set(b1.map((b) => b.start));
  const missing: string[] = [];
  for (let t = open; t < close; t += MIN)
    if (!have.has(t)) missing.push(new Date(t).toISOString().slice(11, 16));
  console.log(
    `IEX 1Min gaps (UTC): ${missing.length === 0 ? 'none' : `${missing.length}: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`}`,
  );
  const empty5 = 78 - b5.length;
  const empty15 = 26 - b15.length;

  // Nesting into Fume's session-aligned buckets.
  for (const tf of ['5m', '15m', '1h', '4h', '1d'] as const) {
    check(
      `15Min nests into ${tf} buckets for this session`,
      tf === '5m'
        ? nestsExactly(5, tf, [session], 'regular')
        : nestsExactly(15, tf, [session], 'regular'),
    );
  }

  // Canonical equality: from 1Min vs from native 5Min / 15Min.
  const canon = (base: readonly Bar[], minutes: number, tf: TimeframeId) =>
    buildCanonicalBars({
      baseBars: base,
      baseIntervalMinutes: minutes,
      sessions: [session],
      timeframe: tf,
      mode: 'regular',
      asOf: later,
    }).bars;
  const equality: Record<string, { equal: boolean; detail: string }> = {};
  for (const [tf, native, minutes] of [
    ['5m', b5, 5],
    ['15m', b15, 15],
    ['1h', b15, 15],
    ['4h', b15, 15],
    ['1d', b15, 15],
  ] as const) {
    const result = compareCanonical(tf, canon(b1, 1, tf), canon(native, minutes, tf));
    equality[`${tf}: 1Min vs ${minutes}Min`] = result;
    check(`canonical ${tf} from 1Min == from ${minutes}Min`, result.equal, result.detail);
  }
  const hourStarts = canon(b15, 15, '1h').map((b) =>
    new Date(b.start).toLocaleTimeString('en-GB', {
      timeZone: US_EQUITY_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
    }),
  );
  console.log(`canonical 1h starts (New York): ${hourStarts.join(' ')}`);
  const fourStarts = canon(b15, 15, '4h').map((b) =>
    new Date(b.start).toLocaleTimeString('en-GB', {
      timeZone: US_EQUITY_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
    }),
  );
  console.log(`canonical 4h starts (New York): ${fourStarts.join(' ')}`);

  // 4. Pagination fixture (small pages force next_page_token) and sort=desc (production order).
  const page1 = await barsFor(1, open, close, { limit: 200 });
  const token = parseBarsPage(page1).nextPageToken;
  check('pagination: next_page_token returned when more bars exist', token !== null);
  save(`bars-spy-1min-page1-limit200-${session.sessionDate}.json`, page1);
  if (token) {
    const page2 = await barsFor(1, open, close, { limit: 200, page_token: token });
    save(`bars-spy-1min-page2-limit200-${session.sessionDate}.json`, page2);
    const p1 = normalizeBars(parseBarsPage(page1).bars, MIN, later).bars;
    const p2 = normalizeBars(parseBarsPage(page2).bars, MIN, later).bars;
    check(
      'pagination: page 2 continues after page 1 with no overlap',
      p2[0]!.start > p1.at(-1)!.start && [...p1, ...p2].length === Math.min(400, b1.length),
    );
  }
  const desc = await barsFor(1, open, close, { sort: 'desc', limit: 5 });
  save(`bars-spy-1min-desc-limit5-${session.sessionDate}.json`, desc);
  const descBars = (parseBarsPage(desc).bars as { t: string }[]).map((b) => Date.parse(b.t));
  check(
    'sort=desc returns newest first, ending at the last minute',
    descBars[0] === b1.at(-1)!.start && descBars.every((t, i) => i === 0 || t < descBars[i - 1]!),
  );

  // 5. Exclusive end: end = 10:00 must not include the 10:00 bar.
  const tenAm = open + 30 * MIN;
  const upToTen = normalizeBars(parseBarsPage(await barsFor(1, open, tenAm)).bars, MIN, later).bars;
  check(
    'exclusive end via inclusive end-1ms: no bar at end',
    !upToTen.some((b) => b.start >= tenAm) && upToTen.at(-1)!.start === tenAm - MIN,
  );

  // 6. Early-close session bars (for the early-close canonical fixture test).
  const earlyDay = earlyCloses.find((s) => s.sessionDate === '2025-11-28') ?? earlyCloses[0];
  if (earlyDay) {
    const eo = earlyDay.windows[0]!.start;
    const ec = earlyDay.windows[0]!.end;
    const e1 = await barsFor(1, eo, ec);
    const e15 = await barsFor(15, eo, ec);
    save(`bars-spy-1min-${earlyDay.sessionDate}.json`, e1);
    save(`bars-spy-15min-${earlyDay.sessionDate}.json`, e15);
    const eb1 = normalizeBars(parseBarsPage(e1).bars, MIN, later).bars;
    const eb15 = normalizeBars(parseBarsPage(e15).bars, 15 * MIN, later).bars;
    for (const tf of ['1h', '4h', '1d'] as const) {
      const r = compareCanonical(
        tf,
        buildCanonicalBars({
          baseBars: eb1,
          baseIntervalMinutes: 1,
          sessions: [earlyDay],
          timeframe: tf,
          mode: 'regular',
          asOf: later,
        }).bars,
        buildCanonicalBars({
          baseBars: eb15,
          baseIntervalMinutes: 15,
          sessions: [earlyDay],
          timeframe: tf,
          mode: 'regular',
          asOf: later,
        }).bars,
      );
      check(
        `early close ${earlyDay.sessionDate}: canonical ${tf} from 1Min == from 15Min`,
        r.equal,
        r.detail,
      );
    }
  }

  // 7. A real 400 (invalid timeframe) and, if the entitlement applies, a real 403 (recent SIP).
  const bad = await rawError(
    `${ALPACA_DATA_BASE_URL}/v2/stocks/${SYMBOL}/bars?timeframe=7Weeks&feed=iex`,
  );
  save('error-400-bars.json', { status: bad.status, body: bad.body });
  const sip = await rawError(
    `${ALPACA_DATA_BASE_URL}/v2/stocks/${SYMBOL}/bars?timeframe=1Min&feed=sip&start=${encodeURIComponent(new Date(now - 10 * MIN).toISOString())}`,
  );
  if (sip.status === 403) save('error-403-recent-sip.json', { status: sip.status, body: sip.body });
  console.log(
    `error fixtures: 400 -> ${bad.status}; recent SIP -> ${sip.status}${sip.status === 403 ? ' (saved)' : ' (not an entitlement error now; a synthetic 403 fixture is used)'}`,
  );

  const failed = checks.filter((c) => !c.pass);
  const summary = {
    capturedAt: new Date(now).toISOString(),
    symbol: SYMBOL,
    feed: 'iex',
    adjustment: 'raw',
    session: {
      date: session.sessionDate,
      open: new Date(open).toISOString(),
      close: new Date(close).toISOString(),
    },
    counts: { '1Min': b1.length, '5Min': b5.length, '15Min': b15.length },
    missing1MinCount: missing.length,
    missing1Min: missing,
    empty5MinBuckets: empty5,
    empty15MinBuckets: empty15,
    canonicalEquality: equality,
    hourStarts,
    fourHourStarts: fourStarts,
    earlyCloseSession: earlyDay?.sessionDate ?? null,
    checks,
    verdict:
      failed.length === 0
        ? 'PASS: declare native intervals [1, 5, 15]'
        : `FAIL: ${failed.map((c) => c.name).join('; ')}`,
    fixtures: saved,
  };
  save('s1-summary.json', summary);
  console.log(`\nS1 verdict: ${summary.verdict}`);
  console.log(
    `upstream calls: ${client.calls}; fixtures written to test/fixtures/alpaca/recorded/`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  // Never print request details; ProviderFailure messages are Fume's own and credential-free.
  const message =
    error instanceof ProviderFailure
      ? `${error.code}: ${error.message} (${error.providerCode ?? ''})`
      : String((error as Error)?.message ?? error);
  for (const secret of secrets)
    if (secret && message.includes(secret)) {
      console.log('S1 failed (message withheld: it contained a credential)');
      process.exit(1);
    }
  console.log(`S1 failed: ${message}`);
  process.exit(1);
});
