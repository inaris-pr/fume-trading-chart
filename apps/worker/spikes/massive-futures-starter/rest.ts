/**
 * NON-PRODUCTION SPIKE CODE: Massive Futures Starter REST capability probe (local only).
 *
 *   node apps/worker/spikes/massive-futures-starter/rest.ts
 *
 * Discovery for GC, SI, CL, NQ, YM (products, contracts, snapshot), 1-minute and 1-second
 * aggregates, pagination, session-date semantics, history depth, schedules, market status and the
 * observed delay. Prints compact summaries only; nothing is saved. Contract tickers are discovered
 * at run time, never hard-coded.
 */
import { ROOTS, elapsed, get, iso, log, show, sleep } from './shared.ts';

interface Product {
  product_code: string;
  name: string;
  trading_venue: string;
  unit_of_measure?: string;
  unit_of_measure_qty?: number;
  price_quotation?: string;
  settlement_method?: string;
  settlement_type?: string;
  trade_currency_code?: string;
  sector?: string;
  asset_class?: string;
  type?: string;
  date?: string;
}
interface Contract {
  ticker: string;
  product_code: string;
  name?: string;
  active?: boolean;
  date?: string;
  first_trade_date?: string;
  last_trade_date?: string;
  settlement_date?: string;
  days_to_maturity?: number;
  trade_tick_size?: number;
  settlement_tick_size?: number;
  spread_tick_size?: number;
  trading_venue?: string;
  group_code?: string;
  type?: string;
}
interface Snapshot {
  product_code?: string;
  details?: { ticker?: string; product_code?: string; settlement_date?: string };
  last_minute?: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    last_updated?: number;
    timeframe?: string;
  };
  last_trade?: Record<string, unknown>;
  last_quote?: Record<string, unknown>;
  session?: Record<string, number>;
}
interface Agg {
  ticker: string;
  window_start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  transactions?: number;
  dollar_volume?: number;
  session_end_date?: string;
  settlement_price?: number;
}
interface ScheduleEvent {
  event: string;
  product_code: string;
  session_end_date: string;
  timestamp: string;
  trading_venue?: string;
}
interface Status {
  product_code: string;
  market_event: string;
  session_end_date?: string;
  timestamp?: string;
  trading_venue?: string;
}

const outcome = (r: {
  http: number;
  body: { status?: string; results?: unknown[]; message?: string; error?: string };
  ms: number;
}) =>
  `HTTP ${r.http} status=${r.body.status ?? '-'} results=${r.body.results?.length ?? 0} ${r.ms}ms` +
  (r.body.message || r.body.error
    ? ` msg="${(r.body.message ?? r.body.error ?? '').slice(0, 160)}"`
    : '');

const bar = (a: Agg) =>
  `${iso(a.window_start)} O=${a.open} H=${a.high} L=${a.low} C=${a.close} V=${a.volume}` +
  (a.transactions !== undefined ? ` n=${a.transactions}` : '') +
  (a.session_end_date ? ` sed=${a.session_end_date}` : '') +
  (a.settlement_price !== undefined ? ` settle=${a.settlement_price}` : '');

async function section(title: string, fn: () => Promise<void>): Promise<void> {
  log(`\n=== ${title} ${elapsed()}`);
  try {
    await fn();
  } catch (e) {
    log(`  ERROR ${(e as Error).message}`);
  }
}

const today = new Date().toISOString().slice(0, 10);
const recommended = new Map<string, string>();
const activeByRoot = new Map<string, Contract[]>();

await section('A1. Products (GC SI CL NQ YM)', async () => {
  const path = `/futures/v1/products?product_code.any_of=${ROOTS.join(',')}&limit=100&sort=date.desc`;
  const r = await get<Product>(path);
  log(`  GET ${show(path)} -> ${outcome(r)}`);
  const seen = new Set<string>();
  for (const p of r.body.results ?? []) {
    if (seen.has(p.product_code)) continue;
    seen.add(p.product_code);
    log(
      `  ${p.product_code.padEnd(3)} venue=${p.trading_venue} type=${p.type} "${p.name}" unit=${p.unit_of_measure_qty} ${p.unit_of_measure}` +
        ` quote="${p.price_quotation}" settle=${p.settlement_method}/${p.settlement_type} ccy=${p.trade_currency_code}` +
        ` class=${p.asset_class}/${p.sector} asOf=${p.date}`,
    );
  }
  log(`  keys: ${Object.keys(r.body.results?.[0] ?? {}).join(',')}`);
});

await section('A2. Exchanges', async () => {
  const r = await get<Record<string, string>>('/futures/v1/exchanges');
  log(`  GET /futures/v1/exchanges -> ${outcome(r)}`);
  for (const x of r.body.results ?? [])
    log(`  ${x['acronym']} mic=${x['mic']} id=${x['id']} "${x['name']}"`);
});

await section(
  'A3. Contracts per root (date=today, active, single; sorted client-side by last_trade_date)',
  async () => {
    const byLastTrade = (a: Contract, b: Contract) =>
      (a.last_trade_date ?? '').localeCompare(b.last_trade_date ?? '');
    for (const root of ROOTS) {
      const path = `/futures/v1/contracts?product_code=${root}&date=${today}&active=true&type=single&limit=1000`;
      const r = await get<Contract>(path);
      const rows = (r.body.results ?? []).slice().sort(byLastTrade);
      activeByRoot.set(root, rows);
      log(`  ${root}: GET ${show(path)} -> ${outcome(r)} next=${r.body.next_url ? 'yes' : 'no'}`);
      for (const c of rows.slice(0, 4))
        log(
          `    ${c.ticker.padEnd(6)} first=${c.first_trade_date} last=${c.last_trade_date} settle=${c.settlement_date}` +
            ` dtm=${c.days_to_maturity} tick=${c.trade_tick_size} settleTick=${c.settlement_tick_size} venue=${c.trading_venue} group=${c.group_code} asOf=${c.date}`,
        );
      if (root === 'GC') log(`    keys: ${Object.keys(rows[0] ?? {}).join(',')}`);
    }
    const noDate = await get<Contract>(`/futures/v1/contracts?product_code=NQ&active=true&limit=5`);
    log(
      `  NQ active=true WITHOUT date -> ${outcome(noDate)}; rows are per (contract, date): ${noDate.body.results?.map((c) => `${c.ticker}@${c.date}`).join(' ')}`,
    );
    const pit = await get<Contract>(
      `/futures/v1/contracts?product_code=NQ&date=2025-06-02&active=true&type=single&limit=100`,
    );
    log(
      `  NQ point-in-time date=2025-06-02 -> ${outcome(pit)}; ${(pit.body.results ?? [])
        .slice()
        .sort(byLastTrade)
        .slice(0, 3)
        .map((c) => `${c.ticker}(last ${c.last_trade_date})`)
        .join(' ')}`,
    );
    const sp = await get<Contract>(
      `/futures/v1/contracts?product_code=NQ&date=${today}&active=true&limit=1000`,
    );
    const types = new Map<string, number>();
    for (const c of sp.body.results ?? [])
      types.set(String(c.type), (types.get(String(c.type)) ?? 0) + 1);
    log(
      `  NQ date=today all types -> ${outcome(sp)}; by type: ${[...types].map(([k, v]) => `${k}:${v}`).join(' ')}`,
    );
  },
);

await section(
  'D. Snapshot of the nearest active outrights per root (recommend the highest session volume)',
  async () => {
    for (const root of ROOTS) {
      const nearest = (activeByRoot.get(root) ?? []).slice(0, 6).map((c) => c.ticker);
      const path = `/futures/v1/snapshot?ticker.any_of=${nearest.join(',')}&limit=100`;
      const r = await get<Snapshot>(path);
      const rows = r.body.results ?? [];
      log(`  ${root}: GET ${show(path)} -> ${outcome(r)}`);
      const tk = (s: Snapshot) => s.details?.ticker ?? '';
      const ranked = rows
        .filter((s) => tk(s) && !tk(s).includes('-'))
        .sort((a, b) => (b.session?.['volume'] ?? 0) - (a.session?.['volume'] ?? 0));
      for (const s of ranked.slice(0, 3)) {
        const lm = s.last_minute;
        log(
          `    ${tk(s).padEnd(6)} settle=${s.details?.settlement_date} sessionVol=${s.session?.['volume']} close=${s.session?.['close']} prevSettle=${s.session?.['previous_settlement']}` +
            ` lastMinute=${lm ? `${lm.close} V=${lm.volume} upd=${iso(lm.last_updated)}` : '-'}` +
            ` lastTrade=${s.last_trade ? `${s.last_trade['timeframe']} @${iso(s.last_trade['last_updated'] as number)}` : 'absent'}` +
            ` lastQuote=${s.last_quote ? `${s.last_quote['timeframe']} @${iso(s.last_quote['last_updated'] as number)}` : 'absent'} (now ${iso(Date.now())})`,
        );
      }
      const top = ranked[0];
      if (top) recommended.set(root, tk(top));
      log(
        `    rows=${rows.length} outrights=${ranked.length} spreads=${rows.length - ranked.length} next=${r.body.next_url ? 'yes' : 'no'}`,
      );
      if (root === 'GC' && top)
        log(
          `    keys: ${Object.keys(top).join(',')}; session keys: ${Object.keys(top.session ?? {}).join(',')}`,
        );
    }
    log(
      `  recommended (by snapshot session volume): ${[...recommended].map(([k, v]) => `${k}->${v}`).join(' ')}`,
    );
  },
);

const nq = recommended.get('NQ') ?? '';

await section(
  `B1. Latest 1-minute aggregates for each recommended contract + observed delay`,
  async () => {
    for (const [root, t] of recommended) {
      const path = `/futures/v1/aggs/${t}?resolution=1min&limit=3&sort=window_start.desc`;
      const r = await get<Agg>(path);
      const now = Date.now();
      const latest = r.body.results?.[0];
      const endMs = latest ? latest.window_start / 1e6 + 60_000 : NaN;
      log(
        `  ${root} ${t}: -> ${outcome(r)}; now=${iso(now)}; latest bar ${latest ? bar(latest) : '-'}; now - bar end = ${((now - endMs) / 60_000).toFixed(2)} min`,
      );
    }
  },
);

await section('B2. 1-minute ordering, fields, pagination (one session, limit=400)', async () => {
  let path: string | undefined =
    `/futures/v1/aggs/${nq}?resolution=1min&window_start.gte=2026-09-28&window_start.lt=2026-09-29&limit=400&sort=window_start.asc`;
  let pages = 0;
  const all: Agg[] = [];
  while (path && pages < 10) {
    const r: Awaited<ReturnType<typeof get<Agg>>> = await get<Agg>(path);
    pages++;
    log(
      `  page ${pages}: GET ${show(path)} -> ${outcome(r)} next=${r.body.next_url ? 'yes' : 'no'}`,
    );
    all.push(...(r.body.results ?? []));
    path = r.body.next_url;
  }
  const ts = all.map((a) => a.window_start);
  const dups = ts.length - new Set(ts).size;
  const sorted = ts.every((t, i) => i === 0 || t > ts[i - 1]!);
  let gaps = 0;
  for (let i = 1; i < ts.length; i++) if (ts[i]! - ts[i - 1]! !== 60e9) gaps++;
  const byDate = new Map<string, number>();
  for (const a of all)
    byDate.set(a.session_end_date ?? '-', (byDate.get(a.session_end_date ?? '-') ?? 0) + 1);
  log(
    `  bars=${all.length} pages=${pages} ascending=${sorted} duplicates=${dups} non-60s steps=${gaps}`,
  );
  log(`  first ${all[0] ? bar(all[0]) : '-'}`);
  log(`  last  ${all.at(-1) ? bar(all.at(-1)!) : '-'}`);
  log(`  session_end_date counts: ${[...byDate].map(([d, n]) => `${d}:${n}`).join(' ')}`);
  log(
    `  keys: ${Object.keys(all[0] ?? {}).join(',')}; window_start unit: ${String(all[0]?.window_start).length} digits (ns if 19)`,
  );
});

await section(
  'B3. Session boundary semantics (NQ, 2026-09-29 20:50–22:10 UTC = 15:50–17:10 CT)',
  async () => {
    const from = BigInt(Date.parse('2026-09-29T20:50:00Z')) * 1_000_000n;
    const to = BigInt(Date.parse('2026-09-29T22:10:00Z')) * 1_000_000n;
    const r = await get<Agg>(
      `/futures/v1/aggs/${nq}?resolution=1min&window_start.gte=${from}&window_start.lt=${to}&limit=200&sort=window_start.asc`,
    );
    log(`  -> ${outcome(r)}`);
    const rows = r.body.results ?? [];
    for (const a of rows.filter((_, i) => i < 3 || i >= rows.length - 3)) log(`    ${bar(a)}`);
    const lastBefore = rows
      .filter(
        (a) => a.window_start < Number(BigInt(Date.parse('2026-09-29T21:30:00Z')) * 1_000_000n),
      )
      .at(-1);
    const firstAfter = rows.find(
      (a) => a.window_start >= Number(BigInt(Date.parse('2026-09-29T21:30:00Z')) * 1_000_000n),
    );
    log(`  last bar before break: ${lastBefore ? bar(lastBefore) : '-'}`);
    log(`  first bar after break: ${firstAfter ? bar(firstAfter) : '-'}`);
  },
);

await section('C. 1-second aggregates (REST) + consistency with the 1-minute bar', async () => {
  const minuteStart = Math.floor((Date.now() - 20 * 60_000) / 60_000) * 60_000;
  const ns = (ms: number) => BigInt(ms) * 1_000_000n;
  const secs = await get<Agg>(
    `/futures/v1/aggs/${nq}?resolution=1sec&window_start.gte=${ns(minuteStart)}&window_start.lt=${ns(minuteStart + 60_000)}&limit=100&sort=window_start.asc`,
  );
  const min = await get<Agg>(
    `/futures/v1/aggs/${nq}?resolution=1min&window_start.gte=${ns(minuteStart)}&window_start.lt=${ns(minuteStart + 60_000)}&limit=5`,
  );
  log(`  1sec for minute ${iso(minuteStart)} -> ${outcome(secs)}; 1min -> ${outcome(min)}`);
  const s = secs.body.results ?? [];
  const m = min.body.results?.[0];
  if (s.length && m) {
    const agg = {
      open: s[0]!.open,
      high: Math.max(...s.map((x) => x.high)),
      low: Math.min(...s.map((x) => x.low)),
      close: s.at(-1)!.close,
      volume: s.reduce((acc, x) => acc + x.volume, 0),
      n: s.reduce((acc, x) => acc + (x.transactions ?? 0), 0),
    };
    log(
      `  from ${s.length} second bars: O=${agg.open} H=${agg.high} L=${agg.low} C=${agg.close} V=${agg.volume} n=${agg.n}`,
    );
    log(`  1min bar:           ${bar(m)}`);
    log(
      `  match: O=${agg.open === m.open} H=${agg.high === m.high} L=${agg.low === m.low} C=${agg.close === m.close} V=${agg.volume === m.volume} n=${agg.n === m.transactions}`,
    );
  }
  const latest = await get<Agg>(
    `/futures/v1/aggs/${nq}?resolution=1sec&limit=1&sort=window_start.desc`,
  );
  const l = latest.body.results?.[0];
  log(
    `  latest 1sec bar ${l ? bar(l) : '-'}; now - bar start = ${l ? ((Date.now() - l.window_start / 1e6) / 60_000).toFixed(2) : '-'} min`,
  );
});

await section('B4. Other resolutions + history depth (2-year plan limit)', async () => {
  for (const res of ['5min', '15min', '1hour', '4hour', '1session']) {
    const r = await get<Agg>(
      `/futures/v1/aggs/${nq}?resolution=${res}&limit=2&sort=window_start.desc`,
    );
    log(
      `  ${res.padEnd(8)} -> ${outcome(r)}; latest ${r.body.results?.[0] ? bar(r.body.results[0]) : '-'}`,
    );
  }
  // Point-in-time contract lookups for older dates, then 1-minute bars for that contract.
  for (const date of ['2025-10-01', '2025-03-03', '2024-12-02', '2024-10-15']) {
    const c = await get<Contract>(
      `/futures/v1/contracts?product_code=NQ&date=${date}&active=true&type=single&limit=100`,
    );
    const t = (c.body.results ?? [])
      .slice()
      .sort((a, b) => (a.last_trade_date ?? '').localeCompare(b.last_trade_date ?? ''))[0]?.ticker;
    log(`  contracts date=${date}: -> ${outcome(c)}; nearest ${t ?? '-'}`);
  }
  // History depth of the aggregates themselves (expired contracts named explicitly; discovery only).
  for (const [t, date] of [
    ['NQZ5', '2025-10-01'],
    ['NQZ4', '2024-11-01'],
    ['NQZ4', '2024-10-01'],
    ['NQU4', '2024-09-03'],
    ['NQZ3', '2023-10-02'],
  ] as const) {
    const r = await get<Agg>(
      `/futures/v1/aggs/${t}?resolution=1min&window_start=${date}&limit=1&sort=window_start.asc`,
    );
    const d = await get<Agg>(
      `/futures/v1/aggs/${t}?resolution=1session&window_start.gte=${date}&limit=1&sort=window_start.asc`,
    );
    log(
      `  ${t} from ${date}: 1min -> ${outcome(r)} ${r.body.results?.[0] ? bar(r.body.results[0]) : ''} | 1session -> ${outcome(d)} ${d.body.results?.[0] ? bar(d.body.results[0]) : ''}`,
    );
  }
});

await section('E1. Schedules (GC, NQ, CL): recent, future, holidays', async () => {
  for (const [label, q] of [
    [
      'NQ this week',
      `product_code=NQ&session_end_date.gte=2026-09-27&session_end_date.lte=2026-10-03&limit=100&sort=session_end_date.asc`,
    ],
    [
      'GC next week (future dates?)',
      `product_code=GC&session_end_date.gte=2026-10-05&session_end_date.lte=2026-10-09&limit=100`,
    ],
    [
      'NQ Thanksgiving 2025',
      `product_code=NQ&session_end_date.gte=2025-11-26&session_end_date.lte=2025-11-28&limit=100`,
    ],
    [
      'CL Christmas 2025',
      `product_code=CL&session_end_date.gte=2025-12-24&session_end_date.lte=2025-12-26&limit=100`,
    ],
    [
      'GC Thanksgiving 2026 (future)',
      `product_code=GC&session_end_date.gte=2026-11-25&session_end_date.lte=2026-11-27&limit=100`,
    ],
    ['YM oldest', `product_code=YM&limit=3&sort=session_end_date.asc`],
  ] as const) {
    const r = await get<ScheduleEvent>(`/futures/v1/schedules?${q}`);
    log(`  ${label}: -> ${outcome(r)}`);
    const byDate = new Map<string, Set<string>>();
    let rows = 0;
    for (const e of r.body.results ?? []) {
      rows++;
      const k = `${e.product_code} ${e.session_end_date}`;
      byDate.set(
        k,
        (byDate.get(k) ?? new Set()).add(`${e.event}@${e.timestamp.replace('+00:00', 'Z')}`),
      );
    }
    const unique = [...byDate.values()].reduce((a, v) => a + v.size, 0);
    log(
      `    rows=${rows} unique events=${unique} (duplicates=${rows - unique}) next=${r.body.next_url ? 'yes' : 'no'}`,
    );
    for (const [k, v] of byDate) log(`    ${k}: ${[...v].join(' ')}`);
  }
  const all = await get<ScheduleEvent>(
    `/futures/v1/schedules?session_end_date=2026-09-30&limit=1000`,
  );
  log(
    `  all products for 2026-09-30 -> ${outcome(all)}; event types: ${[...new Set((all.body.results ?? []).map((e) => e.event))].join(',')}`,
  );
});

await section('E2. Market status', async () => {
  const r = await get<Status>(
    `/futures/v1/market-status?product_code.any_of=${ROOTS.join(',')}&limit=100`,
  );
  log(`  -> ${outcome(r)}`);
  const uniq = new Map<string, number>();
  for (const s of r.body.results ?? []) {
    const k = `${s.product_code} ${s.market_event} sed=${s.session_end_date} at=${s.timestamp} venue=${s.trading_venue}`;
    uniq.set(k, (uniq.get(k) ?? 0) + 1);
  }
  for (const [k, n] of uniq) log(`    ${k} (x${n})`);
});

await section('F. Not in Starter (expect refusal): trades, quotes', async () => {
  for (const p of [`/futures/v1/trades/${nq}?limit=1`, `/futures/v1/quotes/${nq}?limit=1`]) {
    const r = await get<unknown>(p);
    log(`  GET ${show(p)} -> ${outcome(r)}`);
  }
});

await section(
  'G. Delay tracking: poll latest 1sec and 1min bars every 10 s for 2 min',
  async () => {
    for (let i = 0; i < 13; i++) {
      const [s, m] = await Promise.all([
        get<Agg>(`/futures/v1/aggs/${nq}?resolution=1sec&limit=1&sort=window_start.desc`),
        get<Agg>(`/futures/v1/aggs/${nq}?resolution=1min&limit=1&sort=window_start.desc`),
      ]);
      const now = Date.now();
      const sb = s.body.results?.[0];
      const mb = m.body.results?.[0];
      log(
        `  ${iso(now)} latest1sec=${sb ? iso(sb.window_start) : '-'} (lag ${sb ? ((now - sb.window_start / 1e6) / 1000).toFixed(0) : '-'}s)` +
          ` latest1min=${mb ? iso(mb.window_start) : '-'} V=${mb?.volume} (end lag ${mb ? ((now - mb.window_start / 1e6 - 60_000) / 1000).toFixed(0) : '-'}s)`,
      );
      if (i < 12) await sleep(10_000);
    }
  },
);

log(`\ndone ${elapsed()} (today ${today})`);
