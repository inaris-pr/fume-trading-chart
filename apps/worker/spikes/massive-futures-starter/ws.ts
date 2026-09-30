/**
 * NON-PRODUCTION SPIKE CODE: Massive Futures Starter WebSocket capability probe (local only, not
 * Cloudflare).
 *
 *   node apps/worker/spikes/massive-futures-starter/ws.ts
 *
 * Subscribes ONLY to per-second (A) and per-minute (AM) aggregates, which Starter includes. No trade
 * (T) or quote (Q) subscriptions. The key is sent only inside the auth frame; control messages are
 * printed, data messages are summarized. Every socket is closed before exit.
 *
 * Phases: 1) one contract, A + AM; 2) the five roots' recommended contracts; 3) a second concurrent
 * connection with the same key; 4) close + reconnect and REST backfill of the gap; 5) REST revision
 * check of minute bars first seen early.
 */
import { ROOTS, apiKey, elapsed, get, iso, log, sleep } from './shared.ts';

const DELAYED = 'wss://delayed.massive.com/futures';
const REALTIME = 'wss://socket.massive.com/futures';

interface Agg {
  ev: string;
  sym: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  dv?: number;
  n?: number;
  s: number;
  e: number;
}
interface Ctl {
  ev: string;
  status?: string;
  message?: string;
}
interface RestAgg {
  window_start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  transactions?: number;
}
interface Contract {
  ticker: string;
  last_trade_date?: string;
}

class Probe {
  readonly name: string;
  readonly ws: WebSocket;
  readonly aggs: { at: number; a: Agg }[] = [];
  readonly other: string[] = [];
  closed: { code: number; reason: string; at: number } | null = null;
  authOk = false;
  fieldTypes = '';
  opened = 0;
  private waiters: (() => void)[] = [];

  constructor(name: string, url: string) {
    this.name = name;
    const t = Date.now();
    this.ws = new WebSocket(url);
    this.ws.addEventListener('open', () => {
      this.opened = Date.now() - t;
      log(`  [${this.name}] ${elapsed()} open (${this.opened} ms)`);
    });
    this.ws.addEventListener('message', (m) => this.onMessage(m.data));
    this.ws.addEventListener('close', (e) => {
      this.closed = { code: e.code, reason: e.reason, at: Date.now() };
      log(`  [${this.name}] ${elapsed()} close code=${e.code} reason="${e.reason}"`);
      this.wake();
    });
    this.ws.addEventListener('error', () => log(`  [${this.name}] ${elapsed()} error event`));
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  private onMessage(data: unknown): void {
    const at = Date.now();
    if (typeof data !== 'string') {
      this.other.push('binary');
      return;
    }
    let arr: unknown;
    try {
      arr = JSON.parse(data);
    } catch {
      this.other.push('non-json');
      return;
    }
    for (const msg of Array.isArray(arr) ? arr : [arr]) {
      const ev = (msg as Ctl).ev;
      if (ev === 'A' || ev === 'AM') {
        // Observed: o/h/l/c/dv arrive as JSON strings; normalize to numbers, record the raw types.
        const r = msg as Record<string, unknown>;
        if (!this.fieldTypes)
          this.fieldTypes = Object.entries(r)
            .map(([k, v]) => `${k}:${typeof v}`)
            .join(' ');
        const num = (k: string) => Number(r[k]);
        this.aggs.push({
          at,
          a: {
            ev,
            sym: String(r['sym']),
            o: num('o'),
            h: num('h'),
            l: num('l'),
            c: num('c'),
            v: num('v'),
            dv: num('dv'),
            n: num('n'),
            s: num('s'),
            e: num('e'),
          },
        });
      } else if (ev === 'status') {
        const c = msg as Ctl;
        if (c.status === 'auth_success') this.authOk = true;
        log(`  [${this.name}] ${elapsed()} status ${c.status}: "${c.message}"`);
      } else this.other.push(String(ev));
    }
    this.wake();
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  async until(pred: () => boolean, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (!pred() && !this.closed && Date.now() < end)
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 250);
      });
    return pred();
  }

  async connect(subscribe: string | null): Promise<boolean> {
    await this.until(() => this.ws.readyState === WebSocket.OPEN, 10_000);
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    await this.until(() => false, 800); // "connected" status
    this.send({ action: 'auth', params: apiKey });
    const ok = await this.until(() => this.authOk || this.closed !== null, 10_000);
    if (ok && this.authOk && subscribe) {
      log(`  [${this.name}] ${elapsed()} subscribe ${subscribe}`);
      this.send({ action: 'subscribe', params: subscribe });
    }
    return this.authOk;
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
      this.ws.close(1000, 'spike done');
  }
}

const ns = (ms: number) => BigInt(ms) * 1_000_000n;
async function restMinutes(t: string, fromMs: number, toMs: number): Promise<RestAgg[]> {
  const r = await get<RestAgg>(
    `/futures/v1/aggs/${t}?resolution=1min&window_start.gte=${ns(fromMs)}&window_start.lt=${ns(toMs)}&limit=500&sort=window_start.asc`,
  );
  return r.body.results ?? [];
}
async function restSeconds(t: string, fromMs: number, toMs: number): Promise<RestAgg[]> {
  const out: RestAgg[] = [];
  let path: string | undefined =
    `/futures/v1/aggs/${t}?resolution=1sec&window_start.gte=${ns(fromMs)}&window_start.lt=${ns(toMs)}&limit=5000&sort=window_start.asc`;
  while (path) {
    const r: Awaited<ReturnType<typeof get<RestAgg>>> = await get<RestAgg>(path);
    out.push(...(r.body.results ?? []));
    path = r.body.next_url;
  }
  return out;
}

function summarize(p: Probe, sym: string, sinceMs = 0): void {
  const a = p.aggs.filter((x) => x.a.sym === sym && x.at >= sinceMs);
  const sec = a.filter((x) => x.a.ev === 'A');
  const min = a.filter((x) => x.a.ev === 'AM');
  const lagS = sec.map((x) => (x.at - x.a.e) / 1000);
  const lagM = min.map((x) => (x.at - x.a.e) / 1000);
  const keys = new Map<number, number>();
  for (const x of sec) keys.set(x.a.s, (keys.get(x.a.s) ?? 0) + 1);
  const repeats = [...keys.values()].filter((n) => n > 1).length;
  const widths = new Set(sec.map((x) => x.a.e - x.a.s));
  const range = (v: number[]) =>
    v.length
      ? `${Math.min(...v).toFixed(1)}–${Math.max(...v).toFixed(1)}s (median ${v
          .slice()
          .sort((x, y) => x - y)
          [Math.floor(v.length / 2)]!.toFixed(1)}s)`
      : '-';
  log(
    `  ${sym}: A=${sec.length} (distinct seconds ${keys.size}, repeated windows ${repeats}, widths ${[...widths].join('/')} ms, arrival - e ${range(lagS)})` +
      ` AM=${min.length} (arrival - e ${range(lagM)})`,
  );
}

async function resolveRecommended(): Promise<Map<string, string>> {
  const today = new Date().toISOString().slice(0, 10);
  const out = new Map<string, string>();
  for (const root of ROOTS) {
    const c = await get<Contract>(
      `/futures/v1/contracts?product_code=${root}&date=${today}&active=true&type=single&limit=1000`,
    );
    const nearest = (c.body.results ?? [])
      .slice()
      .sort((a, b) => (a.last_trade_date ?? '').localeCompare(b.last_trade_date ?? ''))
      .slice(0, 6)
      .map((x) => x.ticker);
    const s = await get<{ details?: { ticker?: string }; session?: { volume?: number } }>(
      `/futures/v1/snapshot?ticker.any_of=${nearest.join(',')}&limit=100`,
    );
    const top = (s.body.results ?? [])
      .slice()
      .sort((a, b) => (b.session?.volume ?? 0) - (a.session?.volume ?? 0))[0];
    if (top?.details?.ticker) out.set(root, top.details.ticker);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
log(`=== setup ${elapsed()} now ${iso(Date.now())}`);
const rec = await resolveRecommended();
log(`  recommended at run time: ${[...rec].map(([k, v]) => `${k}->${v}`).join(' ')}`);
const nq = rec.get('NQ')!;
const firstSeen = await restMinutes(nq, Date.now() - 15 * 60_000, Date.now());
log(
  `  REST 1min snapshot of the latest ${firstSeen.length} ${nq} bars saved for the revision check`,
);

log(`\n=== Phase 1: ${DELAYED}, A + AM for ${nq} (~130 s) ${elapsed()}`);
const p1 = new Probe('P1', DELAYED);
const ok1 = await p1.connect(`A.${nq},AM.${nq}`);
log(`  auth ${ok1 ? 'OK' : 'FAILED'}`);
if (ok1) {
  await sleep(130_000);
  summarize(p1, nq);
  log(`  raw field types: ${p1.fieldTypes}`);
  const secs = p1.aggs.filter((x) => x.a.ev === 'A' && x.a.sym === nq);
  const mins = p1.aggs.filter((x) => x.a.ev === 'AM' && x.a.sym === nq);
  for (const x of secs.slice(0, 3)) log(`    A  ${JSON.stringify(x.a)} recv=${iso(x.at)}`);
  for (const x of mins) log(`    AM ${JSON.stringify(x.a)} recv=${iso(x.at)}`);
  // AM vs REST 1min vs sum of streamed A for the same minute.
  for (const m of mins) {
    const rest = (await restMinutes(nq, m.a.s, m.a.s + 60_000))[0];
    const inMin = secs.filter((x) => x.a.s >= m.a.s && x.a.s < m.a.e).map((x) => x.a);
    const fromA = inMin.length
      ? {
          o: inMin[0]!.o,
          h: Math.max(...inMin.map((x) => x.h)),
          l: Math.min(...inMin.map((x) => x.l)),
          c: inMin.at(-1)!.c,
          v: inMin.reduce((t, x) => t + x.v, 0),
        }
      : null;
    log(
      `    minute ${iso(m.a.s)}: AM O=${m.a.o} H=${m.a.h} L=${m.a.l} C=${m.a.c} V=${m.a.v} | REST ${rest ? `O=${rest.open} H=${rest.high} L=${rest.low} C=${rest.close} V=${rest.volume}` : '-'}` +
        ` | sum(A) ${fromA ? `O=${fromA.o} H=${fromA.h} L=${fromA.l} C=${fromA.c} V=${fromA.v} (${inMin.length} s)` : '-'}` +
        ` | AM=REST ${rest ? m.a.o === rest.open && m.a.h === rest.high && m.a.l === rest.low && m.a.c === rest.close && m.a.v === rest.volume : '-'}`,
    );
  }
  // Streamed seconds vs REST 1sec for a complete streamed minute.
  const full = mins[0];
  if (full) {
    const restS = await restSeconds(nq, full.a.s, full.a.e);
    const streamed = new Map(
      secs.filter((x) => x.a.s >= full.a.s && x.a.s < full.a.e).map((x) => [x.a.s, x.a]),
    );
    let same = 0;
    let diff = 0;
    let missing = 0;
    for (const r of restS) {
      const s = streamed.get(r.window_start / 1e6);
      if (!s) missing++;
      else if (
        s.o === r.open &&
        s.h === r.high &&
        s.l === r.low &&
        s.c === r.close &&
        s.v === r.volume
      )
        same++;
      else diff++;
    }
    log(
      `    seconds of ${iso(full.a.s)}: REST 1sec=${restS.length} streamed=${streamed.size} identical=${same} different=${diff} missing-from-stream=${missing}`,
    );
  }
}

log(
  `\n=== Phase 2: add A + AM for all five recommended contracts on the same connection (~90 s) ${elapsed()}`,
);
const phase2Start = Date.now();
const all = [...rec.values()];
if (ok1 && !p1.closed) {
  const params = all
    .filter((t) => t !== nq)
    .flatMap((t) => [`A.${t}`, `AM.${t}`])
    .join(',');
  log(`  [P1] subscribe ${params}`);
  p1.send({ action: 'subscribe', params });
  await sleep(90_000);
  for (const t of all) summarize(p1, t, phase2Start);
}

log(`
=== Phase 4: close P1, stay disconnected 20 s, reconnect (all five), backfill the gap from REST ${elapsed()}`);
let p4: Probe | null = null;
if (!p1.closed) {
  const lastSecBefore = Math.max(
    0,
    ...p1.aggs.filter((x) => x.a.ev === 'A' && x.a.sym === nq).map((x) => x.a.s),
  );
  p1.close();
  await p1.until(() => p1.closed !== null, 5_000);
  await sleep(20_000);
  const tReconnect = Date.now();
  p4 = new Probe('P4', DELAYED);
  const ok4 = await p4.connect(all.flatMap((t) => [`A.${t}`, `AM.${t}`]).join(','));
  const q = p4;
  const first = await q.until(() => q.aggs.some((x) => x.a.ev === 'A' && x.a.sym === nq), 30_000);
  const firstA = q.aggs.find((x) => x.a.ev === 'A' && x.a.sym === nq);
  log(
    `  P4 auth ${ok4 ? 'OK' : 'FAILED'}; reconnect->first ${nq} A ${first && firstA ? `${firstA.at - tReconnect} ms` : 'none in 30 s'};` +
      ` last streamed second before close ${iso(lastSecBefore)}; first streamed after ${firstA ? iso(firstA.a.s) : '-'}`,
  );
  if (firstA) {
    const gap = await restSeconds(nq, lastSecBefore + 1000, firstA.a.s);
    log(
      `  gap ${((firstA.a.s - lastSecBefore) / 1000).toFixed(0)} s wide, not replayed by the stream; REST 1sec bars inside the gap: ${gap.length} (recoverable via REST)`,
    );
  }
  await sleep(20_000);
}

log(`
=== Phase 3: second concurrent connection with the same key while P4 is open ${elapsed()}`);
if (p4 && !p4.closed) {
  const incumbent = p4;
  const p3 = new Probe('P3', DELAYED);
  const ok3 = await p3.connect(`A.${nq}`);
  await sleep(20_000);
  const recent = incumbent.aggs.filter((x) => x.at > Date.now() - 15_000).length;
  log(
    `  P3 (newer) auth ${ok3 ? 'OK' : 'FAILED'}, closed=${p3.closed ? `yes (${p3.closed.code})` : 'no'}, aggs=${p3.aggs.length};` +
      ` P4 (older) closed=${incumbent.closed ? `yes (${incumbent.closed.code})` : 'no'}, aggs in last 15 s=${recent}`,
  );
  p3.close();
  incumbent.close();
  await p3.until(() => p3.closed !== null, 5_000);
  await incumbent.until(() => incumbent.closed !== null, 5_000);
}

log(
  `\n=== Phase 5: REST revision check of minute bars first seen ~${Math.round((Date.now() - phase2Start) / 60_000) + 3} min earlier ${elapsed()}`,
);
if (firstSeen.length) {
  const again = await restMinutes(
    nq,
    firstSeen[0]!.window_start / 1e6,
    firstSeen.at(-1)!.window_start / 1e6 + 60_000,
  );
  const byT = new Map(again.map((b) => [b.window_start, b]));
  let changed = 0;
  for (const b of firstSeen) {
    const n = byT.get(b.window_start);
    if (
      !n ||
      n.open !== b.open ||
      n.high !== b.high ||
      n.low !== b.low ||
      n.close !== b.close ||
      n.volume !== b.volume
    ) {
      changed++;
      log(
        `    changed ${iso(b.window_start)}: V ${b.volume} -> ${n?.volume ?? 'missing'}; C ${b.close} -> ${n?.close ?? '-'}`,
      );
    }
  }
  log(`  ${firstSeen.length} bars re-fetched; changed=${changed}`);
}

log(`\n=== Phase 6: real-time host with the Starter key (auth only, no subscription) ${elapsed()}`);
const p6 = new Probe('P6', REALTIME);
const ok6 = await p6.connect(null);
await sleep(3_000);
log(`  real-time host auth ${ok6 ? 'OK' : 'not OK'}`);
p6.close();
await p6.until(() => p6.closed !== null, 5_000);

const others = [p1, p6, ...(p4 ? [p4] : [])].flatMap((p) => p.other);
log(
  `\nnon-aggregate, non-status messages: ${others.length ? [...new Set(others)].join(',') : 'none'}`,
);
log(`done ${elapsed()}`);
process.exit(0);
