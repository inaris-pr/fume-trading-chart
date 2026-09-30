export { BoundedKeySet, tradeIdentity } from './dedupe.ts';
export {
  DEFAULT_DEDUPE_CAPACITY,
  DEFAULT_RETENTION_MINUTES,
  LiveCandleAggregator,
  type LiveAggregatorOptions,
  type LiveDiagnostics,
} from './live-aggregator.ts';
export { applyBufferedHandoff, mergeCanonicalBars } from './handoff.ts';
