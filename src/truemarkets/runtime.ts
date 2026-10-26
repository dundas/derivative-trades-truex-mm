import { ExecutionController, OrderJournal, type OrderIntent, type TradingPolicy } from './execution';

export interface FeedQuote { symbol: string; bid: number; ask: number; sourceAt: number; receivedAt: number; sourceTimeKind?: string }
export interface FeedView { connected: boolean; quotes: Map<string, FeedQuote>; active?: Set<string> }
export type Signal = Omit<OrderIntent, 'reference'>;
/** Strategy-neutral bridge: feeds supply reference prices; controller owns all mutations. */
export class TradingRuntime {
  private accepting = false;
  private tail: Promise<void> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(fn);
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private ticking = false;
  private stopping = false;
  constructor(private controller: ExecutionController, private journal: OrderJournal, private policy: TradingPolicy,
    private external: FeedView, private venue: FeedView, private now = Date.now) {}
  health() {
    const issues: string[] = [];
    if (this.policy.enabled && !(Date.parse(this.policy.eligibleUntil) > this.now())) issues.push('account_eligibility_expired');
    for (const p of this.policy.instruments) {
      if (this.policy.enabled && !p.unitsVerified) issues.push(`${p.symbol}:units_unverified`);
      const source = this.external.quotes.get(p.referenceSymbol), target = this.venue.quotes.get(p.symbol);
      for (const [label, feed, quote] of [['external', this.external, source], ['venue', this.venue, target]] as const) {
        if (!feed.connected || !quote) { issues.push(`${p.symbol}:${label}_disconnected_or_missing`); continue; }
        if (![quote.bid, quote.ask].every(v => Number.isFinite(v) && v > 0) || quote.bid >= quote.ask)
          issues.push(`${p.symbol}:${label}_invalid_bbo`);
        for (const at of [quote.sourceAt, quote.receivedAt]) {
          if (!Number.isFinite(at) || this.now() - at < 0 || this.now() - at > this.policy.maxQuoteAgeMs) {
            issues.push(`${p.symbol}:${label}_stale_or_future`); break;
          }
        }
      }
      if (this.venue.active && !this.venue.active.has(p.symbol)) issues.push(`${p.symbol}:instrument_inactive`);
      // Existing tastytrade streaming Quote events returned zero bid/ask times.
      // Only the validated REST adapter's provider record time is accepted here.
      if (source && source.sourceTimeKind !== 'provider_updated_at') issues.push(`${p.symbol}:external_timestamp_unverified`);
    }
    return { healthy: issues.length === 0, issues };
  }
  tick() { return this.serial(async () => {
    if (this.ticking || this.stopping) return;
    this.ticking = true; this.accepting = false;
    try {
      try { await this.controller.reconcile(); }
      catch (error) {
        if (this.policy.enabled) await this.controller.cancelOwned();
        throw error;
      }
      const health = this.health();
      if (!health.healthy && this.policy.enabled) await this.controller.cancelOwned();
      this.accepting = health.healthy && this.policy.enabled;
      return health;
    } finally { this.ticking = false; }
  }); }
  submit(signal: Signal) { return this.serial(async () => {
    if (!this.accepting || this.stopping || !this.health().healthy) throw new Error('Runtime is not accepting entries');
    const p = this.policy.instruments.find(p => p.symbol === signal.symbol);
    if (!p) throw new Error('Unknown instrument');
    const quote = this.external.quotes.get(p.referenceSymbol)!;
    return this.controller.submit({ ...signal, reference: { symbol: p.referenceSymbol, bid: String(quote.bid), ask: String(quote.ask),
      sourceAt: quote.sourceAt, receivedAt: quote.receivedAt, tokenToShareRatio: p.tokenToShareRatio, usdToUsdc: p.usdToUsdc } });
  }); }
  stop() {
    this.stopping = true; this.accepting = false;
    return this.serial(async () => {
    // Drain any in-flight entry before cancellation; caller releases the writer lock after this promise.
    if (this.policy.enabled) await this.controller.cancelOwned();
    });
  }
}
