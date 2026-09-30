/**
 * Spike S2 (diagnostic only, not production code): observe Alpaca's market-data WebSocket
 * connection limit on the IEX endpoint with ONE credential pair.
 *
 *   node scripts/s2-connection-limit.ts
 *
 * - Reads apps/worker/.dev.vars. Credential values are only placed in the auth frame sent to
 *   Alpaca; they are never printed, logged, saved or put in a URL.
 * - Prints compact, non-sensitive diagnostics: control messages (T/msg/code), close codes,
 *   timings and trade COUNTS. Raw trade traffic and the auth frame are never printed.
 * - Every socket is closed before the process exits.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENDPOINT = 'wss://stream.data.alpaca.markets/v2/iex';
const here = dirname(fileURLToPath(import.meta.url));

function readCredentials(): { key: string; secret: string } | null {
  const path = join(here, '..', '.dev.vars');
  if (!existsSync(path)) return null;
  const vars = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) vars.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2'));
  }
  const key = vars.get('ALPACA_API_KEY_ID') ?? '';
  const secret = vars.get('ALPACA_API_SECRET_KEY') ?? '';
  return key && secret ? { key, secret } : null;
}

const credentials = readCredentials();
if (!credentials) {
  console.log('S2 cannot run: apps/worker/.dev.vars is missing or incomplete. No connection made.');
  process.exit(2);
}
const secrets = [credentials.key, credentials.secret];

const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(6)} ms`;
function log(line: string): void {
  // Defense in depth: never print anything that contains a credential value.
  for (const s of secrets) if (line.includes(s)) line = '[line withheld: contained a credential]';
  console.log(`${ts()}  ${line}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ControlMessage {
  T: string;
  msg?: string;
  code?: number;
  trades?: string[];
}

/** One observed connection. Only control messages are recorded; trades are counted. */
class Probe {
  readonly name: string;
  readonly ws: WebSocket;
  readonly control: { at: number; msg: ControlMessage }[] = [];
  trades = 0;
  opened: number | null = null;
  closed: { at: number; code: number; reason: string } | null = null;
  private waiters: {
    match: (m: ControlMessage) => boolean;
    resolve: (m: ControlMessage | null) => void;
  }[] = [];

  constructor(name: string) {
    this.name = name;
    this.ws = new WebSocket(ENDPOINT);
    this.ws.addEventListener('open', () => {
      this.opened = Date.now();
      log(`${name}: WebSocket open`);
    });
    this.ws.addEventListener('message', (event) => this.onMessage(String(event.data)));
    this.ws.addEventListener('close', (event) => {
      this.closed = { at: Date.now(), code: event.code, reason: event.reason };
      log(`${name}: CLOSED code=${event.code} reason=${JSON.stringify(event.reason)}`);
      for (const w of this.waiters) w.resolve(null);
      this.waiters = [];
    });
    this.ws.addEventListener('error', () => log(`${name}: WebSocket error event`));
  }

  private onMessage(text: string): void {
    let items: ControlMessage[];
    try {
      items = JSON.parse(text) as ControlMessage[];
    } catch {
      log(`${this.name}: non-JSON frame (${text.length} bytes)`);
      return;
    }
    for (const m of items) {
      if (m.T === 't') {
        this.trades++;
        continue;
      }
      if (m.T === 'q' || m.T === 'b' || m.T === 'd' || m.T === 'u') continue;
      this.control.push({ at: Date.now(), msg: m });
      const detail =
        m.T === 'subscription'
          ? `trades=${JSON.stringify(m.trades ?? [])}`
          : `${m.code !== undefined ? `code=${m.code} ` : ''}msg=${JSON.stringify(m.msg ?? '')}`;
      log(`${this.name}: <- T=${m.T} ${detail}`);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(m)) return true;
        w.resolve(m);
        return false;
      });
    }
  }

  /** Next control message matching `match`, or null on close/timeout. */
  next(match: (m: ControlMessage) => boolean, timeoutMs = 10_000): Promise<ControlMessage | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        if (this.waiters.includes(waiter)) {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(payload: object, description: string): boolean {
    if (!this.isOpen()) {
      log(`${this.name}: cannot send ${description} (readyState=${this.ws.readyState})`);
      return false;
    }
    this.ws.send(JSON.stringify(payload));
    log(`${this.name}: -> ${description}`);
    return true;
  }

  /** connected -> auth -> result. Returns the auth reply (success or error) or null. */
  async connectAndAuth(): Promise<{ reply: ControlMessage | null; authMs: number | null }> {
    const connected = await this.next((m) => m.T === 'success' || m.T === 'error');
    if (!connected || connected.T !== 'success') return { reply: connected, authMs: null };
    const sentAt = Date.now();
    this.send(
      { action: 'auth', key: credentials!.key, secret: credentials!.secret },
      'auth (credentials not shown)',
    );
    const reply = await this.next((m) => m.T === 'success' || m.T === 'error');
    return { reply, authMs: reply ? Date.now() - sentAt : null };
  }

  /** Subscribe (or re-subscribe) to SPY trades and wait for the subscription ack. */
  async subscribe(
    label = 'subscribe trades [SPY]',
  ): Promise<{ ack: ControlMessage | null; ms: number }> {
    const sentAt = Date.now();
    if (!this.send({ action: 'subscribe', trades: ['SPY'] }, label)) return { ack: null, ms: 0 };
    const ack = await this.next((m) => m.T === 'subscription' || m.T === 'error');
    return { ack, ms: Date.now() - sentAt };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const done = new Promise<void>((resolve) => this.ws.addEventListener('close', () => resolve()));
    this.ws.close(1000, 'S2 done');
    await Promise.race([done, sleep(5000)]);
  }
}

async function run(round: number): Promise<Record<string, unknown>> {
  log(`===== round ${round}: endpoint ${ENDPOINT} =====`);
  const result: Record<string, unknown> = { round };

  // Phase A: connection #1, authenticated and subscribed, kept open.
  const c1 = new Probe('C1');
  const a1 = await c1.connectAndAuth();
  result.c1Auth = a1.reply
    ? `${a1.reply.T}${a1.reply.code ? ` ${a1.reply.code}` : ''} ${a1.reply.msg ?? ''}`.trim()
    : 'no reply';
  result.c1AuthMs = a1.authMs;
  const s1 = await c1.subscribe();
  result.c1Subscribed = s1.ack?.T === 'subscription';
  await sleep(3000);
  result.c1TradesBeforeC2 = c1.trades;

  // Phase B: connection #2, same credentials, same endpoint, while C1 is open.
  const c2Started = Date.now();
  const c2 = new Probe('C2');
  const a2 = await c2.connectAndAuth();
  result.c2WebSocketOpened = c2.opened !== null;
  result.c2Auth = a2.reply
    ? `${a2.reply.T}${a2.reply.code ? ` ${a2.reply.code}` : ''} ${a2.reply.msg ?? ''}`.trim()
    : 'no reply';
  result.c2AuthReplyMs = a2.authMs;
  await sleep(1500);
  result.c2ClosedByServer = c2.closed
    ? { code: c2.closed.code, reason: c2.closed.reason, msAfterStart: c2.closed.at - c2Started }
    : null;
  if (c2.isOpen()) {
    const s2 = await c2.subscribe('subscribe trades [SPY] on C2');
    result.c2SubscribeResult = s2.ack
      ? `${s2.ack.T}${s2.ack.code ? ` ${s2.ack.code}` : ''}`
      : 'no ack';
  }

  // Is C1 still healthy? Liveness = a server round-trip (re-subscribe ack), not market traffic.
  await sleep(3000);
  result.c1OpenAfterC2 = c1.isOpen();
  result.c1ClosedByServer = c1.closed ? { code: c1.closed.code, reason: c1.closed.reason } : null;
  const probe = await c1.subscribe('liveness probe: re-subscribe trades [SPY] on C1');
  result.c1LivenessAck = probe.ack ? `${probe.ack.T} in ${probe.ms} ms` : 'no ack';
  result.c1TradesTotal = c1.trades;
  result.c2Trades = c2.trades;
  result.c2OpenAtEndOfPhaseB = c2.isOpen();

  // Phase C: close C1 (and C2), then reconnect with the same credentials.
  await c2.close();
  await c1.close();
  const c1ClosedAt = Date.now();
  log('C1 closed cleanly; reconnecting immediately with the same credentials');
  const attempts: Record<string, unknown>[] = [];
  let c3: Probe | null = null;
  for (const delay of [0, 1000, 2000, 4000]) {
    if (delay) await sleep(delay);
    const probe3 = new Probe(`C3#${attempts.length + 1}`);
    const a3 = await probe3.connectAndAuth();
    const ok = a3.reply?.T === 'success' && a3.reply.msg === 'authenticated';
    attempts.push({
      msAfterC1Closed: Date.now() - c1ClosedAt,
      auth: a3.reply
        ? `${a3.reply.T}${a3.reply.code ? ` ${a3.reply.code}` : ''} ${a3.reply.msg ?? ''}`.trim()
        : 'no reply',
      authMs: a3.authMs,
    });
    if (ok) {
      c3 = probe3;
      break;
    }
    await probe3.close();
  }
  result.reconnectAttempts = attempts;
  if (c3) {
    const s3 = await c3.subscribe('subscribe trades [SPY] on replacement');
    result.replacementSubscribed = s3.ack?.T === 'subscription';
    await c3.close();
  }
  result.allClosed = [c1, c2, c3].every((p) => !p || p.closed !== null);
  return result;
}

/**
 * Linger phase: leave the 406-refused C2 open (does Alpaca close it, e.g. auth timeout?), then
 * close C1 and re-send auth on that SAME C2 socket (is a fresh socket required?).
 */
async function linger(): Promise<Record<string, unknown>> {
  log(`===== ${process.argv[2]}: endpoint ${ENDPOINT} =====`);
  const result: Record<string, unknown> = { phase: process.argv[2] };
  const c1 = new Probe('C1');
  const a1 = await c1.connectAndAuth();
  result.c1Auth = a1.reply?.msg ?? 'no reply';
  await c1.subscribe();
  const c2 = new Probe('C2');
  const a2 = await c2.connectAndAuth();
  const refusedAt = Date.now();
  result.c2Auth = a2.reply
    ? `${a2.reply.T} ${a2.reply.code ?? ''} ${a2.reply.msg ?? ''}`.trim()
    : 'no reply';
  // Watch C2 after the refusal without sending anything (20 s; 1 s in "reauth" mode so C1 can be
  // closed inside the ~10 s window and a re-auth on the same socket can be tried).
  const quick = process.argv[2] === 'reauth';
  const serverMsg = await c2.next(() => true, quick ? 1000 : 20_000);
  result.c2AfterRefusal = c2.closed
    ? {
        closedByServer: true,
        code: c2.closed.code,
        reason: c2.closed.reason,
        msAfterRefusal: c2.closed.at - refusedAt,
        lastMessage: serverMsg,
      }
    : { closedByServer: false, stillOpenAfterMs: Date.now() - refusedAt, messageSeen: serverMsg };
  const probe = await c1.subscribe('liveness probe on C1 after linger');
  result.c1LivenessAck = probe.ack ? `${probe.ack.T} in ${probe.ms} ms` : 'no ack';
  // Close C1, then retry auth on the refused C2 socket if it is still open.
  await c1.close();
  const c1ClosedAt = Date.now();
  if (c2.isOpen()) {
    await sleep(500);
    const sentAt = Date.now();
    c2.send(
      { action: 'auth', key: credentials!.key, secret: credentials!.secret },
      're-auth on the same C2 socket (credentials not shown)',
    );
    const reply = await c2.next((m) => m.T === 'success' || m.T === 'error');
    result.c2ReAuthSameSocket = reply
      ? {
          reply: `${reply.T} ${reply.code ?? ''} ${reply.msg ?? ''}`.trim(),
          ms: Date.now() - sentAt,
          msAfterC1Closed: Date.now() - c1ClosedAt,
        }
      : { reply: 'no reply', socketClosed: c2.closed };
    if (reply?.msg === 'authenticated') {
      const s = await c2.subscribe('subscribe on re-authenticated C2');
      result.c2SubscribedAfterReAuth = s.ack?.T === 'subscription';
    }
  }
  await c2.close();
  result.allClosed = c1.closed !== null && c2.closed !== null;
  return result;
}

async function main() {
  if (process.argv[2] === 'linger' || process.argv[2] === 'reauth') {
    const r = await linger();
    console.log('\nSUMMARY');
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }
  const rounds = Number(process.argv[2] ?? 1);
  const results: Record<string, unknown>[] = [];
  for (let r = 1; r <= rounds; r++) {
    results.push(await run(r));
    if (r < rounds) {
      log('pause 15 s between rounds');
      await sleep(15_000);
    }
  }
  console.log('\nSUMMARY');
  for (const r of results) console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

main().catch((error: unknown) => {
  const message = String((error as Error)?.message ?? error);
  console.log(
    secrets.some((s) => message.includes(s))
      ? 'S2 failed (message withheld)'
      : `S2 failed: ${message}`,
  );
  process.exit(1);
});
