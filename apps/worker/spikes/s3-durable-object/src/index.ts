/**
 * SPIKE S3 ONLY: NOT the Stage 5 StreamHub, NOT /api/v1/stream, not production code.
 *
 * One Durable Object (S3Hub, a single named instance) owns ONE outbound Alpaca IEX WebSocket and
 * records lifecycle evidence: constructor/restart count, upstream opens/closes, 406s, reconnect
 * timing, frame types, trade counts and duplicate trade ids. Optional downstream WebSocket
 * clients receive once-per-second COUNT summaries only (no prices, no raw trades), which is
 * enough to test fan-out without redistributing market data.
 *
 * Provider-neutrality note: this spike is about "can a DO own an upstream socket". Everything
 * Alpaca-specific is in the small `alpaca*` helpers; the lifecycle bookkeeping is generic.
 *
 * Access: every route requires the `X-S3-Token` header to equal the S3_TOKEN secret, except in
 * local mode (S3_LOCAL=1 AND a loopback host). Credentials are never logged or returned.
 */

interface Env {
  HUB: DurableObjectNamespace;
  ALPACA_API_KEY_ID?: string;
  ALPACA_API_SECRET_KEY?: string;
  S3_TOKEN?: string;
  S3_LOCAL?: string;
  SPIKE_IDLE_CLOSE_MS?: string;
}

const ALPACA_IEX_STREAM = 'https://stream.data.alpaca.markets/v2/iex';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const local = env.S3_LOCAL === '1' && LOOPBACK.has(url.hostname);
    const token = request.headers.get('X-S3-Token');
    if (!local && (!env.S3_TOKEN || token !== env.S3_TOKEN)) {
      return new Response('not found', { status: 404 });
    }
    if (!url.pathname.startsWith('/s3/')) return new Response('not found', { status: 404 });
    const stub = env.HUB.get(env.HUB.idFromName('s3-spike'));
    return stub.fetch(request);
  },
};

type Mode = 'idle' | 'hold' | 'clients';
type UpstreamState = 'closed' | 'connecting' | 'authenticating' | 'live' | 'backoff';

interface MinuteSummary {
  minute: string;
  ctor: number;
  trades: number;
  text: number;
  binary: number;
  upstream: UpstreamState;
  clients: number;
}

export class S3Hub {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly instanceId = crypto.randomUUID().slice(0, 8);
  private readonly bootAt = Date.now();
  private ctorCount = 0;
  private mode: Mode = 'idle';

  // Upstream bookkeeping.
  private upstream: WorkerdWebSocket | null = null;
  private upstreamState: UpstreamState = 'closed';
  private upstreamOpenedAt: number | null = null;
  private closingOnPurpose = false;
  private backoffMs = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lossAt: number | null = null;
  private lossReason = '';
  private lastTradeBeforeLoss: string | null = null;
  private firstTradeAfterLossPending = false;

  // Counters (never raw data).
  private readonly c = {
    connectAttempts: 0,
    authenticated: 0,
    subscribed: 0,
    error406: 0,
    otherErrors: [] as string[],
    upstreamCloses: [] as { at: string; code: number; reason: string; onPurpose: boolean }[],
    recoveries: [] as { reason: string; msToLive: number; tradeGap?: string }[],
    framesText: 0,
    framesBinary: 0,
    binaryKinds: {} as Record<string, number>,
    decodeErrors: 0,
    trades: 0,
    duplicateTradeIds: 0,
    clientsConnected: 0,
    clientsDisconnected: 0,
    downstreamMessagesSent: 0,
  };
  private readonly seenTradeIds = new Set<number>();
  private lastTradeT: string | null = null;

  // Downstream clients.
  private readonly clients = new Map<WorkerdWebSocket, { id: number; since: number }>();
  private clientSeq = 0;
  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private tradesSinceBroadcast = 0;
  private downstreamSeq = 0;

  // Per-minute summaries (driven by inbound frames; no timers in hold mode).
  private currentMinute = '';
  private minuteTrades = 0;
  private minuteText = 0;
  private minuteBinary = 0;
  private history: MinuteSummary[] = [];
  private tradesByTradeMinute: Record<string, number> = {};

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    void state.blockConcurrencyWhile(async () => {
      this.ctorCount = ((await state.storage.get<number>('ctorCount')) ?? 0) + 1;
      await state.storage.put('ctorCount', this.ctorCount);
      this.history = (await state.storage.get<MinuteSummary[]>('history')) ?? [];
      this.tradesByTradeMinute =
        (await state.storage.get<Record<string, number>>('tradesByTradeMinute')) ?? {};
      const persistedMode = (await state.storage.get<Mode>('mode')) ?? 'idle';
      this.log(
        `CONSTRUCTOR #${this.ctorCount} instance=${this.instanceId} persistedMode=${persistedMode}`,
      );
      // A re-created instance in hold mode re-establishes the upstream (tests the slot/406 race).
      if (persistedMode === 'hold') {
        this.mode = 'hold';
        this.ensureUpstream('constructor (persisted hold mode)');
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/s3/start': {
        const mode = url.searchParams.get('mode') === 'clients' ? 'clients' : 'hold';
        this.mode = mode;
        await this.state.storage.put('mode', mode);
        this.ensureUpstream(`start(${mode})`);
        return this.json({ ok: true, mode });
      }
      case '/s3/stop': {
        this.mode = 'idle';
        await this.state.storage.put('mode', 'idle');
        this.closeUpstream('stop');
        return this.json({ ok: true });
      }
      case '/s3/force-upstream-loss':
        // SPIKE-ONLY diagnostic: drop the upstream as if the network failed, then observe recovery.
        if (!this.upstream) return this.json({ ok: false, reason: 'no upstream' });
        this.lossAt = Date.now();
        this.lossReason = 'forced';
        this.lastTradeBeforeLoss = this.lastTradeT;
        this.upstream.close(4000, 'spike forced loss');
        return this.json({ ok: true });
      case '/s3/reset-counters':
        await this.state.storage.put('ctorCount', 0);
        await this.state.storage.put('history', []);
        await this.state.storage.put('tradesByTradeMinute', {});
        this.tradesByTradeMinute = {};
        return this.json({ ok: true });
      case '/s3/stats':
        return this.json(this.stats());
      case '/s3/ws':
        return this.acceptClient(request);
      default:
        return new Response('not found', { status: 404 });
    }
  }

  // ------------------------------------------------------------------------------------------
  // Upstream (Alpaca IEX)

  private ensureUpstream(reason: string): void {
    if (this.upstream || this.upstreamState === 'connecting' || this.reconnectTimer) return;
    void this.connectUpstream(reason);
  }

  private async connectUpstream(reason: string): Promise<void> {
    this.upstreamState = 'connecting';
    this.c.connectAttempts++;
    this.log(`upstream connect #${this.c.connectAttempts} (${reason})`);
    let ws: WorkerdWebSocket | null;
    try {
      const resp = await fetch(ALPACA_IEX_STREAM, { headers: { Upgrade: 'websocket' } });
      ws = resp.webSocket;
      if (!ws) throw new Error(`no webSocket in response (HTTP ${resp.status})`);
    } catch (error) {
      this.c.otherErrors.push(`connect: ${String((error as Error).message).slice(0, 120)}`);
      this.upstreamState = 'closed';
      this.scheduleReconnect('connect failed');
      return;
    }
    ws.accept();
    this.upstream = ws;
    this.upstreamOpenedAt = Date.now();
    this.upstreamState = 'authenticating';
    ws.addEventListener('message', (event) => void this.onUpstreamFrame(event.data));
    ws.addEventListener('close', (event) => this.onUpstreamClose(ws!, event.code, event.reason));
    ws.addEventListener('error', () => this.log('upstream error event'));
  }

  private async onUpstreamFrame(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === 'string') {
      this.c.framesText++;
      this.minuteText++;
      text = data;
    } else {
      this.c.framesBinary++;
      this.minuteBinary++;
      const kind =
        data instanceof ArrayBuffer ? 'ArrayBuffer' : data instanceof Blob ? 'Blob' : typeof data;
      this.c.binaryKinds[kind] = (this.c.binaryKinds[kind] ?? 0) + 1;
      try {
        text =
          data instanceof ArrayBuffer
            ? new TextDecoder().decode(data)
            : data instanceof Blob
              ? await data.text()
              : String(data);
      } catch {
        this.c.decodeErrors++;
        return;
      }
    }
    let items: { T?: string; msg?: string; code?: number; i?: number; t?: string }[];
    try {
      items = JSON.parse(text);
    } catch {
      this.c.decodeErrors++;
      return;
    }
    for (const m of items) {
      if (m.T === 't') this.onTrade(m.i, m.t);
      else if (m.T === 'success' && m.msg === 'connected') this.alpacaAuth();
      else if (m.T === 'success' && m.msg === 'authenticated') {
        this.c.authenticated++;
        this.upstream?.send(JSON.stringify({ action: 'subscribe', trades: ['SPY'] }));
      } else if (m.T === 'subscription') {
        this.c.subscribed++;
        this.markLive();
      } else if (m.T === 'error') {
        if (m.code === 406) this.c.error406++;
        else this.c.otherErrors.push(`${m.code} ${String(m.msg ?? '').slice(0, 60)}`);
        this.log(`upstream error code=${m.code} msg=${JSON.stringify(m.msg ?? '')}`);
        // 406 = the Alpaca slot is held elsewhere: close this socket and retry with backoff.
        if (m.code === 406) {
          this.lossReason ||= '406';
          this.upstream?.close(1000, '406 slot busy');
        }
      }
    }
    this.rollMinute();
  }

  private alpacaAuth(): void {
    const key = this.env.ALPACA_API_KEY_ID;
    const secret = this.env.ALPACA_API_SECRET_KEY;
    if (!key || !secret) {
      this.c.otherErrors.push('missing credentials');
      this.closeUpstream('missing credentials');
      return;
    }
    this.upstream?.send(JSON.stringify({ action: 'auth', key, secret }));
  }

  private markLive(): void {
    this.upstreamState = 'live';
    this.backoffMs = 0;
    if (this.lossAt !== null) {
      this.c.recoveries.push({
        reason: this.lossReason || 'unknown',
        msToLive: Date.now() - this.lossAt,
      });
      this.firstTradeAfterLossPending = true;
      this.broadcast({ type: 'resync', reason: this.lossReason || 'upstream_reconnected' });
      this.lossAt = null;
      this.lossReason = '';
    }
    this.log(`upstream LIVE (subscribed SPY trades)`);
  }

  private onTrade(id: number | undefined, t: string | undefined): void {
    this.c.trades++;
    this.minuteTrades++;
    this.tradesSinceBroadcast++;
    if (typeof id === 'number') {
      if (this.seenTradeIds.has(id)) this.c.duplicateTradeIds++;
      else {
        this.seenTradeIds.add(id);
        if (this.seenTradeIds.size > 200_000) this.seenTradeIds.clear();
      }
    }
    if (this.firstTradeAfterLossPending && t) {
      const last = this.c.recoveries.at(-1);
      if (last && this.lastTradeBeforeLoss) last.tradeGap = `${this.lastTradeBeforeLoss} -> ${t}`;
      this.firstTradeAfterLossPending = false;
    }
    if (t) {
      this.lastTradeT = t;
      // Counted by the trade's own timestamp minute (UTC), to compare with the official minute
      // bar's trade count `n` after the run (a completeness check). Counts only, no prices.
      const minute = t.slice(0, 16);
      this.tradesByTradeMinute[minute] = (this.tradesByTradeMinute[minute] ?? 0) + 1;
    }
  }

  private onUpstreamClose(ws: WorkerdWebSocket, code: number, reason: string): void {
    if (ws !== this.upstream) return;
    const onPurpose = this.closingOnPurpose;
    this.c.upstreamCloses.push({
      at: new Date().toISOString(),
      code,
      reason: reason.slice(0, 60),
      onPurpose,
    });
    this.log(
      `upstream CLOSED code=${code} reason=${JSON.stringify(reason)} onPurpose=${onPurpose} openMs=${Date.now() - (this.upstreamOpenedAt ?? Date.now())}`,
    );
    this.upstream = null;
    this.upstreamOpenedAt = null;
    this.upstreamState = 'closed';
    this.closingOnPurpose = false;
    if (onPurpose) return;
    if (this.lossAt === null) {
      this.lossAt = Date.now();
      this.lossReason ||= `closed ${code}`;
      this.lastTradeBeforeLoss = this.lastTradeT;
    }
    this.broadcast({ type: 'upstream_down', code });
    if (this.wantsUpstream()) this.scheduleReconnect(`closed ${code}`);
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer) return;
    // Bounded exponential backoff: 1 s, 2 s, 4 s ... capped at 30 s.
    this.backoffMs = Math.min(30_000, this.backoffMs ? this.backoffMs * 2 : 1000);
    this.upstreamState = 'backoff';
    this.log(`reconnect in ${this.backoffMs} ms (${reason})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantsUpstream()) void this.connectUpstream(`reconnect after ${reason}`);
      else this.upstreamState = 'closed';
    }, this.backoffMs);
  }

  private closeUpstream(reason: string): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.upstream) {
      this.closingOnPurpose = true;
      this.log(`closing upstream on purpose (${reason})`);
      this.upstream.close(1000, reason.slice(0, 60));
    }
  }

  private wantsUpstream(): boolean {
    return this.mode === 'hold' || (this.mode === 'clients' && this.clients.size > 0);
  }

  // ------------------------------------------------------------------------------------------
  // Downstream clients (fan-out test; counts only)

  private acceptClient(request: Request): Response {
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    const id = ++this.clientSeq;
    this.clients.set(server, { id, since: Date.now() });
    this.c.clientsConnected++;
    this.log(`client #${id} connected (clients=${this.clients.size})`);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.log('idle-close cancelled by a new client');
    }
    if (this.mode === 'idle') this.mode = 'clients';
    this.ensureUpstream(`client #${id}`);
    if (!this.broadcastTimer) this.broadcastTimer = setInterval(() => this.tick(), 1000);
    server.addEventListener('close', () => this.dropClient(server));
    server.addEventListener('error', () => this.dropClient(server));
    this.send(server, {
      type: 'hello',
      clientId: id,
      instance: this.instanceId,
      ctor: this.ctorCount,
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private dropClient(ws: WorkerdWebSocket): void {
    const info = this.clients.get(ws);
    if (!info) return;
    this.clients.delete(ws);
    this.c.clientsDisconnected++;
    this.log(`client #${info.id} disconnected (clients=${this.clients.size})`);
    if (this.clients.size === 0) {
      if (this.broadcastTimer) clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
      if (this.mode === 'clients') {
        const ms = Number(this.env.SPIKE_IDLE_CLOSE_MS ?? 60_000);
        this.log(`no clients: idle-close in ${ms} ms`);
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (this.clients.size === 0) this.closeUpstream('idle (no clients)');
        }, ms);
      }
    }
  }

  private tick(): void {
    this.broadcast({
      type: 'counts',
      trades: this.tradesSinceBroadcast,
      total: this.c.trades,
      upstream: this.upstreamState,
    });
    this.tradesSinceBroadcast = 0;
  }

  private broadcast(payload: object): void {
    for (const ws of this.clients.keys()) this.send(ws, payload);
  }

  private send(ws: WorkerdWebSocket, payload: object): void {
    try {
      ws.send(JSON.stringify({ seq: ++this.downstreamSeq, ...payload }));
      this.c.downstreamMessagesSent++;
    } catch {
      this.dropClient(ws);
    }
  }

  // ------------------------------------------------------------------------------------------

  private rollMinute(): void {
    const minute = new Date().toISOString().slice(0, 16);
    if (minute === this.currentMinute) return;
    if (this.currentMinute) {
      const summary: MinuteSummary = {
        minute: this.currentMinute,
        ctor: this.ctorCount,
        trades: this.minuteTrades,
        text: this.minuteText,
        binary: this.minuteBinary,
        upstream: this.upstreamState,
        clients: this.clients.size,
      };
      this.history = [...this.history, summary].slice(-240);
      void this.state.storage.put('history', this.history);
      const keys = Object.keys(this.tradesByTradeMinute).sort().slice(-300);
      this.tradesByTradeMinute = Object.fromEntries(
        keys.map((k) => [k, this.tradesByTradeMinute[k]!]),
      );
      void this.state.storage.put('tradesByTradeMinute', this.tradesByTradeMinute);
      this.log(
        `MINUTE ${summary.minute} trades=${summary.trades} text=${summary.text} binary=${summary.binary} upstream=${summary.upstream} clients=${summary.clients} ctor=${summary.ctor}`,
      );
    }
    this.currentMinute = minute;
    this.minuteTrades = 0;
    this.minuteText = 0;
    this.minuteBinary = 0;
  }

  private stats() {
    return {
      instanceId: this.instanceId,
      ctorCount: this.ctorCount,
      instanceUptimeMs: Date.now() - this.bootAt,
      mode: this.mode,
      upstream: this.upstreamState,
      upstreamOpenMs: this.upstreamOpenedAt ? Date.now() - this.upstreamOpenedAt : null,
      clients: this.clients.size,
      counters: this.c,
      lastTradeT: this.lastTradeT,
      history: this.history.slice(-60),
      tradesByTradeMinute: this.tradesByTradeMinute,
    };
  }

  private json(body: unknown): Response {
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  }

  private log(line: string): void {
    console.log(`[S3 ${new Date().toISOString()} ${this.instanceId}] ${line}`);
  }
}
