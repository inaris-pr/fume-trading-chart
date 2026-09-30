/**
 * SPIKE S3 completeness check: per-minute trade counts streamed through the Durable Object vs
 * the trade count `n` of Alpaca's official IEX 1-minute bars for the same minutes.
 *
 *   S3_TOKEN_FILE=... node compare.ts <spikeBaseUrl> [fromIso] [toIso]
 *
 * Reads Alpaca credentials from apps/worker/.dev.vars only to call the historical bars API; they
 * are never printed. Prints counts only.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlpacaHttpClient } from '../../src/providers/alpaca/client.ts';
import { parseBarsPage } from '../../src/providers/alpaca/normalize.ts';

const [, , base = '', fromIso = '', toIso = ''] = process.argv;
const here = dirname(fileURLToPath(import.meta.url));
const devVars = join(here, '..', '..', '.dev.vars');
if (!existsSync(devVars) || !process.env.S3_TOKEN_FILE) {
  console.log('missing .dev.vars or S3_TOKEN_FILE');
  process.exit(2);
}
const vars = new Map<string, string>();
for (const line of readFileSync(devVars, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) vars.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2'));
}
const token = readFileSync(process.env.S3_TOKEN_FILE, 'utf8').trim();

const stats = (await (
  await fetch(`${base}/s3/stats`, { headers: { 'X-S3-Token': token } })
).json()) as {
  tradesByTradeMinute: Record<string, number>;
};
const streamed = stats.tradesByTradeMinute ?? {};
const minutes = Object.keys(streamed)
  .sort()
  .filter((m) => (!fromIso || m >= fromIso.slice(0, 16)) && (!toIso || m < toIso.slice(0, 16)));
if (minutes.length === 0) {
  console.log('no streamed minutes in range');
  process.exit(0);
}
const client = new AlpacaHttpClient({
  dataBaseUrl: 'https://data.alpaca.markets',
  tradingBaseUrl: 'https://paper-api.alpaca.markets',
  credentials: {
    keyId: vars.get('ALPACA_API_KEY_ID') ?? '',
    secretKey: vars.get('ALPACA_API_SECRET_KEY') ?? '',
  },
  fetch: (i, n) => fetch(i, n),
});
const start = `${minutes[0]}:00Z`;
const end = new Date(Date.parse(`${minutes.at(-1)}:00Z`) + 59_000).toISOString();
const body = await client.getJson('data', 'v2/stocks/SPY/bars', {
  timeframe: '1Min',
  start,
  end,
  limit: 10_000,
  adjustment: 'raw',
  feed: 'iex',
});
const official = new Map<string, number>();
for (const b of parseBarsPage(body).bars as { t: string; n?: number }[])
  official.set(b.t.slice(0, 16), b.n ?? 0);

let equal = 0;
let streamedMore = 0;
let streamedLess = 0;
let sumStreamed = 0;
let sumOfficial = 0;
const diffs: string[] = [];
for (const m of minutes) {
  const s = streamed[m] ?? 0;
  const o = official.get(m);
  sumStreamed += s;
  if (o === undefined) {
    diffs.push(`${m} streamed=${s} official=none`);
    continue;
  }
  sumOfficial += o;
  if (s === o) equal++;
  else {
    if (s > o) streamedMore++;
    else streamedLess++;
    diffs.push(`${m} streamed=${s} official=${o} diff=${s - o}`);
  }
}
console.log(
  JSON.stringify(
    {
      minutes: minutes.length,
      first: minutes[0],
      last: minutes.at(-1),
      equalMinutes: equal,
      streamedMoreMinutes: streamedMore,
      streamedLessMinutes: streamedLess,
      sumStreamed,
      sumOfficialN: sumOfficial,
      diffs: diffs.slice(0, 40),
    },
    null,
    2,
  ),
);
process.exit(0);
