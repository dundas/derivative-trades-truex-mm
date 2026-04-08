export class CoinbaseMarketDataAdapter {
  constructor({ ingest, priceAggregator, exchange = 'coinbase' } = {}) {
    this.ingest = ingest;
    this.priceAggregator = priceAggregator;
    this.exchange = exchange;
    this._connectPromise = null;
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
    if (this._connectPromise) return this._connectPromise;

    const connectPromise = (async () => {
      if (this.isLoggedOn) return;

      if (this.ingest.connected) {
        await this.ingest.restart();
        return;
      }

      await this.ingest.start();
    })();

    this._connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (this._connectPromise === connectPromise) {
        this._connectPromise = null;
      }
    }
  }

  async subscribe() {
    // No-op: CoinbaseWsIngest subscribes during start()/restart().
  }

  async disconnect() {
    this.ingest?.stop();
  }
}
