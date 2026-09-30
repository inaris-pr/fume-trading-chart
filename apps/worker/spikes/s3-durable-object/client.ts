/**
 * SPIKE S3 test harness (Node). Drives the S3 spike Worker over HTTP/WebSocket and prints only
 * counts and timings. The optional access token is read from the file named by S3_TOKEN_FILE
 * and sent as the X-S3-Token header; it is never printed.
 *
 *   node client.ts functional <baseUrl>
 *   node client.ts watch <baseUrl> <minutes>
 *   node client.ts start <baseUrl> hold|clients
 *   node client.ts stats <baseUrl>
 *   node client.ts stop <baseUrl>
 *   node client.ts force <baseUrl>
 */
import { readFileSync } from 'node:fs';

const [, , command = 'stats', base = 'http://127.0.0.1:8788', arg = ''] = process.argv;
const token = process.env.S3_TOKEN_FILE
  ? readFileSync(process.env.S3_TOKEN_FILE, 'utf8').trim()
  : '';
const headers: Record<string, string> = token ? { 'X-S3-Token': token } : {};
const t0 = Date.now();
const log = (line: string) =>
  console.log(`+${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s  ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http(path: string, method = 'GET'): Promise<any> {
  const res = await fetch(`${base}${path}`, { method, headers });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: res.status, body: text.slice(0, 80) };
  }
}

interface Client {
  name: string;
  ws: WebSocket;
  messages: number;
  counts: number;
  tradesReported: number;
  resyncs: number;
  seqGaps: number;
  lastSeq: number;
  closed: boolean;
}

function connect(name: string): Promise<Client> {
  const url = `${base.replace(/^http/, 'ws')}/s3/ws`;
  const ws = new (WebSocket as unknown as new (u: string, o: object) => WebSocket)(url, {
    headers,
  });
  const client: Client = {
    name,
    ws,
    messages: 0,
    counts: 0,
    tradesReported: 0,
    resyncs: 0,
    seqGaps: 0,
    lastSeq: 0,
    closed: false,
  };
  ws.addEventListener('message', (event) => {
    const m = JSON.parse(String(event.data)) as {
      seq: number;
      type: string;
      trades?: number;
      reason?: string;
    };
    client.messages++;
    // seq is hub-global across clients; a per-client jump > 1 is expected when others joined.
    client.lastSeq = m.seq;
    if (m.type === 'counts') {
      client.counts++;
      client.tradesReported += m.trades ?? 0;
    } else if (m.type === 'resync') {
      client.resyncs++;
      log(`${name}: RESYNC (${m.reason})`);
    } else if (m.type !== 'hello') log(`${name}: ${m.type}`);
  });
  ws.addEventListener('close', () => (client.closed = true));
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      log(`${name}: connected`);
      resolve(client);
    });
    ws.addEventListener('error', () => reject(new Error(`${name}: websocket error`)));
  });
}

async function close(c: Client): Promise<void> {
  c.ws.close(1000, 'done');
  for (let i = 0; i < 50 && !c.closed; i++) await sleep(100);
  log(
    `${c.name}: closed (messages=${c.messages} counts=${c.counts} trades=${c.tradesReported} resyncs=${c.resyncs})`,
  );
}

async function waitLive(timeoutMs = 20_000): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await http('/s3/stats');
    if (s.upstream === 'live') return Date.now() - start;
    await sleep(250);
  }
  return null;
}

function brief(s: any) {
  const c = s.counters ?? {};
  return {
    ctor: s.ctorCount,
    instance: s.instanceId,
    upstream: s.upstream,
    upstreamOpenMs: s.upstreamOpenMs,
    clients: s.clients,
    connects: c.connectAttempts,
    auth: c.authenticated,
    subs: c.subscribed,
    e406: c.error406,
    closes: (c.upstreamCloses ?? []).map((x: any) => `${x.code}${x.onPurpose ? '(purpose)' : ''}`),
    recoveries: c.recoveries,
    trades: c.trades,
    text: c.framesText,
    binary: c.framesBinary,
    binaryKinds: c.binaryKinds,
    decodeErrors: c.decodeErrors,
    dupIds: c.duplicateTradeIds,
    otherErrors: c.otherErrors,
  };
}

async function functional(): Promise<void> {
  log('== baseline');
  log(JSON.stringify(brief(await http('/s3/stats'))));

  log('== two clients share one upstream');
  const a = await connect('A');
  const live1 = await waitLive();
  log(`upstream live ${live1} ms after first client`);
  const b = await connect('B');
  await sleep(8000);
  let s = brief(await http('/s3/stats'));
  log(
    `stats: connects=${s.connects} clients=${s.clients} upstream=${s.upstream} trades=${s.trades}`,
  );
  log(
    `A counts=${a.counts} trades=${a.tradesReported} | B counts=${b.counts} trades=${b.tradesReported}`,
  );

  log('== disconnect A, B keeps receiving');
  const bBefore = b.counts;
  await close(a);
  await sleep(5000);
  log(`B counts +${b.counts - bBefore} in 5 s after A left`);

  log('== last client leaves; reconnect BEFORE the 60 s idle close');
  await close(b);
  await sleep(20_000);
  const c = await connect('C');
  await sleep(3000);
  s = brief(await http('/s3/stats'));
  log(
    `after reconnect at ~20 s: connects=${s.connects} closes=${JSON.stringify(s.closes)} upstream=${s.upstream}`,
  );

  log('== last client leaves; wait past the 60 s idle close');
  await close(c);
  await sleep(70_000);
  s = brief(await http('/s3/stats'));
  log(`after 70 s idle: upstream=${s.upstream} closes=${JSON.stringify(s.closes)}`);

  log('== reconnect after idle close: fresh Alpaca slot');
  const d = await connect('D');
  const live2 = await waitLive();
  s = brief(await http('/s3/stats'));
  log(`fresh upstream live ${live2} ms after client D; connects=${s.connects} e406=${s.e406}`);

  log('== forced upstream loss (spike-only diagnostic)');
  await sleep(3000);
  await http('/s3/force-upstream-loss', 'POST');
  const recovered = await waitLive(40_000);
  await sleep(3000);
  s = brief(await http('/s3/stats'));
  log(
    `recovered in ~${recovered} ms (poll); recoveries=${JSON.stringify(s.recoveries)} D.resyncs=${d.resyncs}`,
  );

  await close(d);
  log('== final stats');
  log(JSON.stringify(brief(await http('/s3/stats'))));
  log('(upstream will idle-close 60 s after the last client left)');
}

async function watch(minutes: number): Promise<void> {
  const w = await connect('W');
  const end = Date.now() + minutes * 60_000;
  let lastCounts = 0;
  let lastTrades = 0;
  while (Date.now() < end && !w.closed) {
    await sleep(60_000);
    log(
      `W minute: counts=${w.counts - lastCounts} trades=${w.tradesReported - lastTrades} resyncs=${w.resyncs}`,
    );
    lastCounts = w.counts;
    lastTrades = w.tradesReported;
  }
  await close(w);
}

/**
 * Run B (regular session): one client W connected throughout; NO other requests for the first
 * 20 minutes (crosses the 15-minute threshold with only a downstream socket as activity); client
 * X joins at 20 min and leaves at 22; forced upstream loss at 32; W leaves at 35; stats after the
 * 60 s idle close.
 */
async function runB(totalMin = 35): Promise<void> {
  const w = await connect('W');
  let x: Client | null = null;
  let lastCounts = 0;
  let lastTrades = 0;
  let lastResyncs = 0;
  for (let minute = 1; minute <= totalMin; minute++) {
    await sleep(60_000);
    log(
      `W minute ${minute}: counts=${w.counts - lastCounts} trades=${w.tradesReported - lastTrades} resyncs+${w.resyncs - lastResyncs} closed=${w.closed}` +
        (x ? ` | X counts=${x.counts} trades=${x.tradesReported}` : ''),
    );
    lastCounts = w.counts;
    lastTrades = w.tradesReported;
    lastResyncs = w.resyncs;
    if (minute === 20) x = await connect('X');
    if (minute === 22 && x) {
      await close(x);
      log(`W still connected after X left: ${!w.closed}`);
    }
    if (minute === 32) {
      log('forced upstream loss (spike-only)');
      await http('/s3/force-upstream-loss', 'POST');
    }
  }
  const s = brief(await http('/s3/stats'));
  log(`before W leaves: ${JSON.stringify(s)}`);
  await close(w);
  await sleep(75_000);
  log(`75 s after W left: ${JSON.stringify(brief(await http('/s3/stats')))}`);
}

async function main(): Promise<void> {
  if (command === 'functional') await functional();
  else if (command === 'runb') await runB(Number(arg || 35));
  else if (command === 'watch') await watch(Number(arg || 30));
  else if (command === 'start')
    log(JSON.stringify(await http(`/s3/start?mode=${arg || 'hold'}`, 'POST')));
  else if (command === 'stop') log(JSON.stringify(await http('/s3/stop', 'POST')));
  else if (command === 'force') log(JSON.stringify(await http('/s3/force-upstream-loss', 'POST')));
  else if (command === 'stats-full') console.log(JSON.stringify(await http('/s3/stats'), null, 2));
  else log(JSON.stringify(brief(await http('/s3/stats'))));
  process.exit(0);
}

main().catch((e: unknown) => {
  console.log(`client failed: ${(e as Error).message}`);
  process.exit(1);
});
