import { EventEmitter } from 'events';

/**
 * HedgeExecutor - Executes hedge orders on Kraken to flatten accumulated inventory risk.
 *
 * Events emitted:
 *   'hedge-placed'    - { side, size, price, orderId, type }
 *   'hedge-filled'    - { side, size, price, orderId, slippage }
 *   'hedge-timeout'   - { orderId }
 *   'hedge-failed'    - { error, side, size }
 *   'hedge-cancelled' - { orderId }
 */
export class HedgeExecutor extends EventEmitter {
  constructor(options = {}) {
    super();

    // Dependencies (injected)
    this.krakenClient = options.krakenClient;
    this.priceAggregator = options.priceAggregator;
    this.logger = options.logger || console;

    // Config
    this.config = {
      hedgeVenue: options.hedgeVenue || 'kraken',
      hedgeSymbol: options.hedgeSymbol || 'XBTUSD',
      hedgeOrderType: options.hedgeOrderType || 'limit',
      limitTimeoutMs: options.limitTimeoutMs || 5000,
      minHedgeSizeBTC: options.minHedgeSizeBTC || 0.001,
      maxHedgeSizeBTC: options.maxHedgeSizeBTC || 1.0,
      limitPriceOffsetBps: options.limitPriceOffsetBps || 5,
      pollIntervalMs: options.pollIntervalMs || 1000,
    };

    // State
    this.openHedges = new Map();   // orderId -> { side, size, price, placedAt, status }
    this.hedgeHistory = [];         // completed hedges
    this.isHedging = false;
    this.pollTimer = null;

    // Stats
    this.stats = {
      totalHedges: 0,
      totalHedgedBTC: 0,
      totalSlippage: 0,
      limitFills: 0,
      marketFills: 0,
      failedHedges: 0,
    };
  }

  /**
   * Main entry point for executing a hedge.
   * @param {string} side - 'buy' or 'sell'
   * @param {number} size - size in BTC
   * @param {string} urgency - 'normal' or 'urgent'
   */
  async executeHedge(side, size, urgency = 'normal') {
    // Validate inputs
    if (!side || (side !== 'buy' && side !== 'sell')) {
      this.emit('hedge-failed', { error: 'Invalid side', side, size });
      return null;
    }

    if (!size || size <= 0) {
      this.emit('hedge-failed', { error: 'Invalid size: must be positive', side, size });
      return null;
    }

    if (size < this.config.minHedgeSizeBTC) {
      this.emit('hedge-failed', {
        error: `Size ${size} below minimum ${this.config.minHedgeSizeBTC}`,
        side,
        size,
      });
      return null;
    }

    // Clamp to max
    const clampedSize = Math.min(size, this.config.maxHedgeSizeBTC);

    // Prevent concurrent hedges
    if (this.isHedging) {
      this.emit('hedge-failed', { error: 'Hedge already in progress', side, size: clampedSize });
      return null;
    }

    this.isHedging = true;

    try {
      // For urgent hedges, go straight to market
      if (urgency === 'urgent') {
        return await this._executeMarketHedge(side, clampedSize);
      }

      return await this._executeLimitThenMarket(side, clampedSize);
    } catch (err) {
      this.stats.failedHedges++;
      this.emit('hedge-failed', { error: err.message || String(err), side, size: clampedSize });
      return null;
    } finally {
      this.isHedging = false;
    }
  }

  /**
   * Execute a limit order, then fall back to market if it times out.
   */
  async _executeLimitThenMarket(side, size) {
    const price = this._getCurrentPrice(side);
    const limitPrice = this._calculateLimitPrice(side, price);

    // Place limit order
    const limitResult = await this.placeLimitOrder(side, size, limitPrice);
    const orderId = limitResult.txid[0];

    this.openHedges.set(orderId, {
      side,
      size,
      price: limitPrice,
      placedAt: Date.now(),
      status: 'open',
    });

    this.emit('hedge-placed', {
      side,
      size,
      price: limitPrice,
      orderId,
      type: 'limit',
    });

    // Poll for fill within timeout
    const fillResult = await this._pollForFill(orderId, this.config.limitTimeoutMs);

    if (fillResult && fillResult.status === 'closed') {
      // Limit order filled
      const filledSize = parseFloat(fillResult.filledSize);
      const avgPrice = parseFloat(fillResult.avgPrice);
      const slippage = this._calculateSlippage(side, limitPrice, avgPrice);

      this.openHedges.delete(orderId);
      this._recordFill(side, filledSize, avgPrice, slippage, 'limit', orderId);

      return { orderId, side, size: filledSize, price: avgPrice, slippage, type: 'limit' };
    }

    // Timed out - cancel limit and go to market
    this.emit('hedge-timeout', { orderId });

    try {
      await this.cancelHedge(orderId);
    } catch (cancelErr) {
      this.logger.warn(`[HedgeExecutor] Failed to cancel limit order ${orderId}: ${cancelErr.message}`);
    }

    this.openHedges.delete(orderId);

    // Place market order
    return await this._executeMarketHedge(side, size);
  }

  /**
   * Execute a market order directly.
   */
  async _executeMarketHedge(side, size) {
    const expectedPrice = this._getCurrentPrice(side);

    const marketResult = await this.placeMarketOrder(side, size);
    const orderId = marketResult.txid[0];

    this.openHedges.set(orderId, {
      side,
      size,
      price: expectedPrice,
      placedAt: Date.now(),
      status: 'open',
    });

    this.emit('hedge-placed', {
      side,
      size,
      price: expectedPrice,
      orderId,
      type: 'market',
    });

    // Poll for market fill (should be near-instant, but poll briefly)
    const fillResult = await this._pollForFill(orderId, this.config.limitTimeoutMs);

    if (fillResult && fillResult.status === 'closed') {
      const filledSize = parseFloat(fillResult.filledSize);
      const avgPrice = parseFloat(fillResult.avgPrice);
      const slippage = this._calculateSlippage(side, expectedPrice, avgPrice);

      this.openHedges.delete(orderId);
      this._recordFill(side, filledSize, avgPrice, slippage, 'market', orderId);

      return { orderId, side, size: filledSize, price: avgPrice, slippage, type: 'market' };
    }

    // Market order not filled (unusual)
    this.stats.failedHedges++;
    this.openHedges.delete(orderId);
    this.emit('hedge-failed', { error: 'Market order did not fill', side, size });
    return null;
  }

  /**
   * Place a limit order on Kraken.
   */
  async placeLimitOrder(side, size, price) {
    const params = {
      pair: this.config.hedgeSymbol,
      type: side,
      ordertype: 'limit',
      price: price.toString(),
      volume: size.toString(),
    };
    return await this.krakenClient.addOrder(params);
  }

  /**
   * Place a market order on Kraken.
   */
  async placeMarketOrder(side, size) {
    const params = {
      pair: this.config.hedgeSymbol,
      type: side,
      ordertype: 'market',
      volume: size.toString(),
    };
    return await this.krakenClient.addOrder(params);
  }

  /**
   * Check the status of a hedge order.
   */
  async checkHedgeStatus(orderId) {
    const result = await this.krakenClient.queryOrders({ txid: orderId });
    const order = result[orderId];
    if (!order) {
      return { status: 'unknown', filledSize: '0', avgPrice: '0' };
    }
    return {
      status: order.status,
      filledSize: order.vol_exec || '0',
      avgPrice: order.price || '0',
    };
  }

  /**
   * Cancel a hedge order.
   */
  async cancelHedge(orderId) {
    const result = await this.krakenClient.cancelOrder({ txid: orderId });
    this.emit('hedge-cancelled', { orderId });
    return result;
  }

  /**
   * Get current open hedge orders.
   */
  getHedgePosition() {
    const openOrders = [];
    let totalPendingSize = 0;
    let lastHedgeAt = null;

    for (const [orderId, hedge] of this.openHedges) {
      openOrders.push({ orderId, ...hedge });
      totalPendingSize += hedge.size;
      if (!lastHedgeAt || hedge.placedAt > lastHedgeAt) {
        lastHedgeAt = hedge.placedAt;
      }
    }

    return { openOrders, totalPendingSize, lastHedgeAt };
  }

  /**
   * Get cumulative hedge statistics.
   */
  getHedgeStats() {
    const avgSlippage = this.stats.totalHedges > 0
      ? this.stats.totalSlippage / this.stats.totalHedges
      : 0;

    const limitFillRate = (this.stats.limitFills + this.stats.marketFills) > 0
      ? this.stats.limitFills / (this.stats.limitFills + this.stats.marketFills)
      : 0;

    return {
      totalHedges: this.stats.totalHedges,
      totalHedgedBTC: this.stats.totalHedgedBTC,
      avgSlippage,
      limitFillRate,
      failedHedges: this.stats.failedHedges,
      limitFills: this.stats.limitFills,
      marketFills: this.stats.marketFills,
    };
  }

  // --- Private helpers ---

  /**
   * Get the current price relevant for the hedge side.
   */
  _getCurrentPrice(side) {
    if (this.priceAggregator) {
      const prices = this.priceAggregator.getAggregatedPrice();
      if (side === 'sell') return prices.bestBid;
      return prices.bestAsk;
    }
    throw new Error('No price source available');
  }

  /**
   * Calculate aggressive limit price (crosses the spread slightly).
   */
  _calculateLimitPrice(side, referencePrice) {
    const offsetFraction = this.config.limitPriceOffsetBps / 10000;
    if (side === 'sell') {
      // Sell below bid to be aggressive
      return referencePrice * (1 - offsetFraction);
    }
    // Buy above ask to be aggressive
    return referencePrice * (1 + offsetFraction);
  }

  /**
   * Calculate slippage: positive = better than expected, negative = worse.
   */
  _calculateSlippage(side, expectedPrice, fillPrice) {
    if (side === 'sell') {
      return fillPrice - expectedPrice;
    }
    return expectedPrice - fillPrice;
  }

  /**
   * Poll Kraken for order fill status.
   */
  async _pollForFill(orderId, timeoutMs) {
    const startTime = Date.now();
    const pollInterval = this.config.pollIntervalMs;

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.checkHedgeStatus(orderId);
      if (status.status === 'closed') {
        return status;
      }
      if (status.status === 'canceled' || status.status === 'expired') {
        return null;
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    return null; // Timed out
  }

  /**
   * Record a completed fill in history and stats.
   */
  _recordFill(side, filledSize, avgPrice, slippage, type, orderId) {
    this.stats.totalHedges++;
    this.stats.totalHedgedBTC += filledSize;
    this.stats.totalSlippage += slippage;

    if (type === 'limit') {
      this.stats.limitFills++;
    } else {
      this.stats.marketFills++;
    }

    this.hedgeHistory.push({
      orderId,
      side,
      size: filledSize,
      price: avgPrice,
      slippage,
      type,
      filledAt: Date.now(),
    });

    this.emit('hedge-filled', {
      side,
      size: filledSize,
      price: avgPrice,
      orderId,
      slippage,
    });
  }
}
