export class CoinbaseMarketDataAdapter {
  constructor({ ingest, priceAggregator, exchange = 'coinbase' } = {}) {
    this.ingest = ingest;
    this.priceAggregator = priceAggregator;
    this.exchange = exchange;
  }

  _feedStatus() {
    return this.priceAggregator?.getStatus?.().feeds?.[this.exchange] ?? null;
  }

  _isFeedUsable() {
    const status = this._feedStatus();
    if (!status) return false;
    return status.hasData === true && status.isStale === false;
  }

  get isLoggedOn() {
    return this.ingest?.connected === true && this._isFeedUsable();
  }

  get isSubscribed() {
    return this.ingest?.connected === true;
  }

  getSpread() {
    return this.priceAggregator?.getAggregatedPrice?.()?.spread ?? null;
  }

  async connect() {
    if (this.isLoggedOn) return;
    if (!this.ingest) throw new Error('Coinbase ingest is not configured');

    if (this.ingest.connected) {
      await this.ingest.restart();
      return;
    }

    await this.ingest.start();
  }

  async subscribe() {
    // No-op: CoinbaseWsIngest subscribes during start()/restart().
  }

  async disconnect() {
    this.ingest?.stop();
  }
}
