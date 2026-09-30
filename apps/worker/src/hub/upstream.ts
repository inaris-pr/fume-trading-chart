/**
 * Outbound (hub -> provider) WebSocket connector for the Workers runtime: a `fetch` with
 * `Upgrade: websocket`, then `accept()` (the workerd client-socket API). Provider-neutral: stream
 * adapters receive it through the composition root and tests replace it with a fake.
 */
export interface UpstreamSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

export interface UpstreamSocketHandlers {
  onMessage(text: string): void;
  onClose(code: number, reason: string): void;
}

export type UpstreamConnector = (
  url: string,
  handlers: UpstreamSocketHandlers,
) => Promise<UpstreamSocket>;

interface WorkerdClientSocket {
  accept(): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: () => void): void;
}

export const workerdConnector: UpstreamConnector = async (url, handlers) => {
  const response = await fetch(url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'), {
    headers: { Upgrade: 'websocket' },
  });
  const ws = (response as unknown as { webSocket: WorkerdClientSocket | null }).webSocket;
  if (!ws) throw new Error(`upstream WebSocket upgrade failed (HTTP ${response.status})`);
  ws.accept();
  let closed = false;
  ws.addEventListener('message', (event) => {
    if (typeof event.data === 'string') handlers.onMessage(event.data);
  });
  ws.addEventListener('close', (event) => {
    if (closed) return;
    closed = true;
    handlers.onClose(event.code, event.reason);
  });
  ws.addEventListener('error', () => {
    if (closed) return;
    closed = true;
    handlers.onClose(1006, 'error');
  });
  return {
    send: (text) => ws.send(text),
    close: (code, reason) => {
      try {
        ws.close(code, reason);
      } catch {
        // already closed
      }
    },
  };
};
