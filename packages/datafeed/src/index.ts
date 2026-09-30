/**
 * @fume/datafeed public entry point (docs/embedding.md): the headless ChartSession, the DataFeed
 * contract, and two feeds (Fume's backend API, deterministic replay). Framework-free.
 */
export {
  DataFeedError,
  type BarsPage,
  type BarsQuery,
  type ChartSink,
  type DataFeed,
  type LiveHandlers,
  type LiveSubscription,
  type OlderDataRequest,
  type ResolveOptions,
  type ResolvedInstrument,
} from './types.ts';
export {
  ChartSession,
  type ChartSessionOptions,
  type ChartSessionSettings,
  type ChartStatus,
} from './session.ts';
export { DEFAULT_VIEW, HISTORY_PAGE, LIVE_SEED_MINUTES } from './defaults.ts';
export { FumeApiDataFeed, type FumeApiDataFeedOptions } from './api/api-feed.ts';
export {
  API_BASE,
  FumeApiError,
  FumeHttpClient,
  type AuthHook,
  type FetchLike,
  type FumeHttpClientOptions,
  type ResolveResult,
} from './api/http-client.ts';
export {
  StreamConnection,
  streamUrl,
  type SocketFactory,
  type SocketLike,
  type StreamConnectionDiagnostics,
  type StreamConnectionOptions,
  type StreamTimers,
} from './api/stream-connection.ts';
export {
  REPLAY_SESSIONS_PER_PAGE,
  ReplayDataFeed,
  type ReplayDataFeedOptions,
} from './replay/replay-feed.ts';
