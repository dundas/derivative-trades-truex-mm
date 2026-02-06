import { EventEmitter } from 'events';

/**
 * InventoryManager - Tracks position, computes quote skew, enforces limits.
 *
 * Events emitted:
 *   'fill'           - { side, quantity, price, venue, execID, netPosition, avgEntryPrice }
 *   'limit-warning'  - { netPosition, utilizationPct, side }
 *   'emergency'      - { netPosition, reason }
 *   'hedge-signal'   - { shouldHedge, side, size }
 */
export class InventoryManager extends EventEmitter {
  constructor(options = {}) {
    super();

    // Configuration
    this.maxPositionBTC = options.maxPositionBTC || 1.0;
    this.hedgeThresholdBTC = options.hedgeThresholdBTC || 0.5;
    this.maxSkewTicks = options.maxSkewTicks || 5;
    this.skewExponent = options.skewExponent || 2;
    this.emergencyLimitBTC = options.emergencyLimitBTC || (this.maxPositionBTC * 1.2);
    this.tickSize = options.tickSize || 0.5;
    this.limitWarningPct = options.limitWarningPct || 0.8;

    // Position state
    this.netPosition = 0;
    this.avgEntryPrice = 0;

    // VWAP tracking: separate buy/sell cost and quantity
    this.totalBuyCost = 0;
    this.totalBuyQty = 0;
    this.totalSellCost = 0;
    this.totalSellQty = 0;

    // Counters
    this.totalBought = 0;
    this.totalSold = 0;
    this.fillCount = 0;

    this.logger = options.logger || console;
  }

  /**
   * Process a fill and update position state.
   */
  onFill({ side, quantity, price, venue, execID }) {
    if (!side || quantity == null || price == null) {
      this.logger.warn('[InventoryManager] Invalid fill: missing side, quantity, or price');
      return;
    }

    if (quantity <= 0) {
      this.logger.warn('[InventoryManager] Ignoring zero/negative quantity fill');
      return;
    }

    const normalizedSide = side.toLowerCase();

    if (normalizedSide === 'buy') {
      this.netPosition += quantity;
      this.totalBought += quantity;
      this.totalBuyCost += quantity * price;
      this.totalBuyQty += quantity;
    } else if (normalizedSide === 'sell') {
      this.netPosition -= quantity;
      this.totalSold += quantity;
      this.totalSellCost += quantity * price;
      this.totalSellQty += quantity;
    } else {
      this.logger.warn(`[InventoryManager] Unknown side: ${side}`);
      return;
    }

    // Recompute VWAP entry price based on net direction
    this._updateAvgEntryPrice();

    this.fillCount++;

    // Emit fill event
    this.emit('fill', {
      side: normalizedSide,
      quantity,
      price,
      venue,
      execID,
      netPosition: this.netPosition,
      avgEntryPrice: this.avgEntryPrice
    });

    // Check limits
    const utilizationPct = this._getUtilizationPct();

    // Emergency check (absolute position vs emergency limit)
    if (Math.abs(this.netPosition) >= this.emergencyLimitBTC) {
      this.emit('emergency', {
        netPosition: this.netPosition,
        reason: `Position ${this.netPosition.toFixed(8)} exceeds emergency limit ${this.emergencyLimitBTC}`
      });
      return;
    }

    // Limit warning at configurable threshold (default 80%)
    if (utilizationPct >= this.limitWarningPct) {
      this.emit('limit-warning', {
        netPosition: this.netPosition,
        utilizationPct,
        side: this.netPosition > 0 ? 'long' : 'short'
      });
    }

    // Check hedge signal
    const hedge = this.shouldHedge();
    if (hedge.shouldHedge) {
      this.emit('hedge-signal', hedge);
    }
  }

  /**
   * Compute bid/ask skew in ticks based on current position vs limit.
   *
   * When long: widen asks (positive skew), tighten bids (negative skew)
   * When short: widen bids (positive skew), tighten asks (negative skew)
   *
   * Skew values are in ticks. Positive = widen (less aggressive), negative = tighten (more aggressive).
   */
  getSkew() {
    if (this.maxPositionBTC === 0) {
      return { bidSkewTicks: 0, askSkewTicks: 0 };
    }

    const utilizationPct = this._getUtilizationPct();
    const rawSkew = Math.pow(utilizationPct, this.skewExponent) * this.maxSkewTicks;

    let bidSkewTicks = 0;
    let askSkewTicks = 0;

    if (this.netPosition > 0) {
      // Long: widen asks to encourage sells, tighten bids
      askSkewTicks = rawSkew;
      bidSkewTicks = -rawSkew;
    } else if (this.netPosition < 0) {
      // Short: widen bids to encourage buys, tighten asks
      bidSkewTicks = rawSkew;
      askSkewTicks = -rawSkew;
    }

    return { bidSkewTicks, askSkewTicks };
  }

  /**
   * Check if we can quote on a given side.
   * Returns false if at position limit for the accumulating side.
   */
  canQuote(side) {
    const normalizedSide = side.toLowerCase();
    const absPosition = Math.abs(this.netPosition);

    if (absPosition >= this.maxPositionBTC) {
      // At limit: block the accumulating side
      if (this.netPosition > 0 && normalizedSide === 'buy') return false;
      if (this.netPosition < 0 && normalizedSide === 'sell') return false;
    }

    return true;
  }

  /**
   * Determine if a hedge is needed.
   */
  shouldHedge() {
    const absPosition = Math.abs(this.netPosition);

    if (absPosition >= this.hedgeThresholdBTC) {
      return {
        shouldHedge: true,
        side: this.netPosition > 0 ? 'sell' : 'buy',
        size: absPosition
      };
    }

    return { shouldHedge: false, side: null, size: 0 };
  }

  /**
   * Get a summary of the current position state.
   */
  getPositionSummary() {
    const absPosition = Math.abs(this.netPosition);
    const utilizationPct = this._getUtilizationPct();
    const skew = this.getSkew();

    return {
      netPosition: this.netPosition,
      avgEntryPrice: this.avgEntryPrice,
      totalBought: this.totalBought,
      totalSold: this.totalSold,
      fillCount: this.fillCount,
      utilizationPct,
      absPosition,
      side: this.netPosition > 0 ? 'long' : this.netPosition < 0 ? 'short' : 'flat',
      bidSkewTicks: skew.bidSkewTicks,
      askSkewTicks: skew.askSkewTicks,
      canQuoteBuy: this.canQuote('buy'),
      canQuoteSell: this.canQuote('sell'),
      hedgeNeeded: this.shouldHedge().shouldHedge
    };
  }

  /**
   * Reset all position state.
   */
  reset() {
    this.netPosition = 0;
    this.avgEntryPrice = 0;
    this.totalBuyCost = 0;
    this.totalBuyQty = 0;
    this.totalSellCost = 0;
    this.totalSellQty = 0;
    this.totalBought = 0;
    this.totalSold = 0;
    this.fillCount = 0;

    this.logger.info('[InventoryManager] State reset');
  }

  // --- Private helpers ---

  _getUtilizationPct() {
    if (this.maxPositionBTC === 0) return 0;
    return Math.abs(this.netPosition) / this.maxPositionBTC;
  }

  /**
   * Recompute VWAP entry price.
   * If net long: avgEntryPrice = totalBuyCost / totalBuyQty
   * If net short: avgEntryPrice = totalSellCost / totalSellQty
   * If flat: avgEntryPrice = 0
   */
  _updateAvgEntryPrice() {
    if (this.netPosition > 0 && this.totalBuyQty > 0) {
      this.avgEntryPrice = this.totalBuyCost / this.totalBuyQty;
    } else if (this.netPosition < 0 && this.totalSellQty > 0) {
      this.avgEntryPrice = this.totalSellCost / this.totalSellQty;
    } else {
      this.avgEntryPrice = 0;
    }
  }
}
