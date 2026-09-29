import type { Decimal, EventTime, InstrumentId, ProviderId, UnixMs } from './primitives.ts';

export interface Account {
  accountId: string;
  providerId: ProviderId;
  environment: 'paper' | 'live';
  currency: string;
  cash: Decimal;
  equity: Decimal;
  buyingPower: Decimal;
  shortingEnabled: boolean;
  tradingBlocked: boolean;
  asOf: UnixMs;
}

export interface Position {
  instrumentId: InstrumentId;
  side: 'long' | 'short';
  /** Absolute quantity (always >= 0); direction is in `side`. */
  quantity: Decimal;
  avgEntryPrice: Decimal;
  /** Broker-reported values; may be computed from a different price source than the chart. */
  brokerMarketValue?: Decimal;
  brokerUnrealizedPnl?: Decimal;
  asOf: UnixMs;
}

export type OrderSide = 'buy' | 'sell';
/** MVP scope. Extend only with explicit approval. */
export type OrderType = 'market' | 'limit';
export type TimeInForce = 'day' | 'gtc';

export type OrderStatus =
  | 'pending_new'
  | 'accepted'
  | 'working'
  | 'partially_filled'
  | 'filled'
  | 'pending_cancel'
  | 'canceled'
  | 'rejected'
  | 'expired'
  | 'done_for_day'
  | 'replaced'
  | 'suspended'
  | 'unknown';

/** Statuses after which an order can never change again. */
export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'filled',
  'canceled',
  'rejected',
  'expired',
  'replaced',
]);

export interface Order {
  orderId: string;
  clientOrderId: string;
  instrumentId: InstrumentId;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  quantity: Decimal;
  filledQuantity: Decimal;
  avgFillPrice?: Decimal;
  limitPrice?: Decimal;
  extendedHours: boolean;
  status: OrderStatus;
  submittedAt: EventTime;
  /** Broker's last-update time; used to discard out-of-order (older) order states. */
  updatedAt: EventTime;
  rejectReason?: string;
}

/** Validated server-side before reaching a BrokerageProvider. */
export interface OrderRequest {
  /** Client-generated idempotency key (UUID). Passed through to the broker. */
  clientOrderId: string;
  instrumentId: InstrumentId;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  quantity: Decimal;
  limitPrice?: Decimal;
  /**
   * MVP: regular-session orders only (owner decision Q6). Widening this to `boolean` requires
   * explicit approval; the broker additionally allows it only for limit orders.
   */
  extendedHours: false;
}

/** One execution. A partially filled order has several. */
export interface Fill {
  executionId: string;
  orderId: string;
  instrumentId: InstrumentId;
  side: OrderSide;
  price: Decimal;
  quantity: Decimal;
  time: EventTime;
  /** Signed position quantity after this fill, when the broker reports it. */
  positionQuantityAfter?: Decimal;
}

export type OrderEventType =
  | 'new'
  | 'accepted'
  | 'pending_new'
  | 'partial_fill'
  | 'fill'
  | 'pending_cancel'
  | 'canceled'
  | 'cancel_rejected'
  | 'rejected'
  | 'expired'
  | 'done_for_day'
  | 'replaced'
  | 'other';

export type TradingEvent =
  | {
      kind: 'order_update';
      eventType: OrderEventType;
      /** Order state as reported with this event. */
      order: Order;
      /** Present for fill / partial_fill. */
      fill?: Fill;
      time: EventTime;
    }
  | {
      /** Emitted by Fume (not the broker) when events may have been missed; consumers must re-snapshot. */
      kind: 'resync_required';
      reason: 'stream_reconnected' | 'sequence_gap' | 'server_restart';
    };

/**
 * Where a client-side trading value came from.
 * - snapshot: broker REST snapshot. Authoritative; replaces any other value.
 * - stream:   a value the broker itself reported in a streamed event (order status, filled qty,
 *             fill price/qty, resulting position qty). Broker-confirmed but not yet reconciled.
 * - derived:  a value Fume COMPUTED from streamed events (e.g. average entry after a fill, and
 *             anything calculated from it such as unrealized P&L). An estimate.
 */
export type StateSource = 'snapshot' | 'stream' | 'derived';

/**
 * A value plus its provenance. Invariant: `provisional === (source !== 'snapshot')`.
 * Provisional values are displayed immediately and replaced by the next authoritative snapshot.
 */
export type Sourced<T> =
  | { value: T; source: 'snapshot'; provisional: false; receivedAt: UnixMs }
  | { value: T; source: 'stream' | 'derived'; provisional: true; receivedAt: UnixMs };

/**
 * Client-side position projection for one instrument. Each field carries its own provenance,
 * because after a streamed fill the quantity is broker-reported (`stream`) while the average
 * entry is a Fume estimate (`derived`) until the position snapshot arrives.
 */
export interface PositionProjection {
  instrumentId: InstrumentId;
  side: Sourced<'long' | 'short' | 'flat'>;
  /** Absolute quantity. */
  quantity: Sourced<Decimal>;
  /** null when flat. */
  avgEntryPrice: Sourced<Decimal | null>;
}

/** Everything a client needs to rebuild trading state for one instrument. */
export interface TradingSnapshot {
  account: Account;
  position: Position | null;
  openOrders: readonly Order[];
  /** Recent executions for chart markers. */
  fills: readonly Fill[];
  asOf: UnixMs;
}
