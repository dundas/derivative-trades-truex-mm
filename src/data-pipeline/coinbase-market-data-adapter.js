export class CoinbaseMarketDataAdapter {
  constructor({ ingest, priceAggregator, exchange = 'coinbase' } = {}) {
    this.ingest = ingest;
    this.priceAggregator = priceAggregator;
    this.exchange = exchange;
    this._connectPromise = null;
    this._hasAttemptedConnect = false;
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

  async _runExclusive(task) {
    if (this._connectPromise) return this._connectPromise;

    const promise = task();
    this._connectPromise = promise;
    try {
      await promise;
    } finally {
      if (this._connectPromise === promise) {
        this._connectPromise = null;
      }
    }
  }

  async connect() {
    if (this.isLoggedOn) return;
    if (!this.ingest) throw new Error('Coinbase ingest is not configured');

    if (!this.ingest.connected && !this._hasAttemptedConnect) {
      this._hasAttemptedConnect = true;
      await this._runExclusive(async () => {
        if (this.isLoggedOn) return;
        await this.ingest.start();
      });
      return;
    }

    this._hasAttemptedConnect = true;
    await this.restart();
  }

  async restart() {
    if (!this.ingest) throw new Error('Coinbase ingest is not configured');
    this._hasAttemptedConnect = true;
    await this._runExclusive(async () => {
      if (typeof this.ingest.restart === 'function') {
        await this.ingest.restart();
        return;
      }

      this.ingest.stop?.();
      await this.ingest.start?.();
    });
  }

  async subscribe() {
    // No-op: CoinbaseWsIngest subscribes during start()/restart().
  }

  async disconnect() {
    this.ingest?.stop();
  }
}
