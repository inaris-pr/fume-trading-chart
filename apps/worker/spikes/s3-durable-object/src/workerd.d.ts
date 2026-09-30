// Minimal ambient types for the workerd APIs this SPIKE uses (avoids adding a types dependency).
interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
interface DurableObjectState {
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
interface DurableObjectId {}
interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}
interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}
interface WorkerdWebSocket extends WebSocket {
  accept(): void;
}
declare class WebSocketPair {
  0: WorkerdWebSocket;
  1: WorkerdWebSocket;
}
interface ResponseInit {
  webSocket?: WebSocket | null;
}
interface Response {
  readonly webSocket: WorkerdWebSocket | null;
}
