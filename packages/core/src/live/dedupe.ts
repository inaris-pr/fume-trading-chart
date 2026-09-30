/**
 * Bounded set of recently seen keys (insertion-ordered; the oldest key is evicted first).
 * Used to de-duplicate trades by provider-neutral identity.
 */
export class BoundedKeySet {
  private readonly keys = new Set<string>();

  constructor(readonly capacity: number) {
    if (!(capacity >= 1) || !Number.isInteger(capacity)) {
      throw new Error(`BoundedKeySet capacity must be a positive integer, got ${capacity}`);
    }
  }

  get size(): number {
    return this.keys.size;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  /** Adds `key`; returns false if it was already present. Evicts the oldest key when full. */
  add(key: string): boolean {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    if (this.keys.size > this.capacity) {
      const oldest = this.keys.values().next().value;
      if (oldest !== undefined) this.keys.delete(oldest);
    }
    return true;
  }
}

/**
 * Trade identity for de-duplication: venue + trade id. Trades without an id have no identity and
 * are never de-duplicated (a documented limitation: a provider that omits ids can double-count
 * a redelivered trade).
 */
export function tradeIdentity(trade: { tradeId?: string; venue?: string }): string | null {
  return trade.tradeId === undefined ? null : `${trade.venue ?? ''}\u0000${trade.tradeId}`;
}
