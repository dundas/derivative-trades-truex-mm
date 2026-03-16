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

    // Balance tracking (populated from REST API at startup)
    this.baseBalance = null;   // e.g. { available: 0.044, held: 0, total: 0.044 } for BTC
    this.quoteBalance = null;  // e.g. { available: 100, held: 0, total: 100 } for PYUSD
    this.balancesInitialized = false;

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
      // Update tracked balances: buying BTC means +BTC, -PYUSD
      // Note: fee deduction not included — maker fees are 0 bps per TrueX agreement.
      // Any taker fills (rare, from cancel-replace races) cause minor drift corrected by 60s refresh.
      if (this.balancesInitialized) {
        if (this.baseBalance) {
          this.baseBalance.available += quantity;
          this.baseBalance.total += quantity;
        }
        if (this.quoteBalance) {
          const quoteDelta = quantity * price;
          this.quoteBalance.available -= quoteDelta;
          this.quoteBalance.total -= quoteDelta;
          if (this.quoteBalance.available < 0) {
            this.logger.warn(`[InventoryManager] Quote balance went negative (${this.quoteBalance.available.toFixed(2)}) — clamping to 0. Will correct on next balance refresh.`);
            this.quoteBalance.available = 0;
          }
          if (this.quoteBalance.total < 0) this.quoteBalance.total = 0;
        }
      }
    } else if (normalizedSide === 'sell') {
      this.netPosition -= quantity;
      this.totalSold += quantity;
      this.totalSellCost += quantity * price;
      this.totalSellQty += quantity;
      // Update tracked balances: selling BTC means -BTC, +PYUSD
      if (this.balancesInitialized) {
        if (this.baseBalance) {
          this.baseBalance.available -= quantity;
          this.baseBalance.total -= quantity;
          if (this.baseBalance.available < 0) {
            this.logger.warn(`[InventoryManager] Base balance went negative (${this.baseBalance.available.toFixed(8)}) — clamping to 0. Will correct on next balance refresh.`);
            this.baseBalance.available = 0;
          }
          if (this.baseBalance.total < 0) this.baseBalance.total = 0;
        }
        if (this.quoteBalance) {
          const quoteDelta = quantity * price;
          this.quoteBalance.available += quoteDelta;
          this.quoteBalance.total += quoteDelta;
        }
      }
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
   * One-time startup initialization from REST API balances.
   * Sets netPosition from base asset total and stores balance snapshots.
   * Only call this ONCE at startup — use refreshBalances() for periodic sync.
   *
   * @param {object} params
   * @param {object} params.baseBalance - { available, held, total } for base asset (e.g. BTC)
   * @param {object} params.quoteBalance - { available, held, total } for quote asset (e.g. PYUSD)
   */
  initializeFromBalances({ baseBalance, quoteBalance }) {
    const base = baseBalance || { available: 0, held: 0, total: 0 };
    const quote = quoteBalance || { available: 0, held: 0, total: 0 };

    // Shallow copy to avoid mutable reference hazard
    this.baseBalance = { ...base };
    this.quoteBalance = { ...quote };
    this.balancesInitialized = true;

    // Initialize net position from actual BTC holdings (one-time only)
    this.netPosition = this.baseBalance.total;

    this.logger.info(
      `[InventoryManager] Balances initialized: ` +
      `base=${this.baseBalance.available} avail / ${this.baseBalance.total} total, ` +
      `quote=${this.quoteBalance.available} avail / ${this.quoteBalance.total} total, ` +
      `netPosition=${this.netPosition}`
    );
  }

  /**
   * Periodic balance refresh — updates available balances from exchange WITHOUT
   * resetting netPosition, VWAP, or counters. Safe to call during active trading.
   * Logs discrepancies between tracked and exchange balances.
   *
   * @param {object} params
   * @param {object} params.baseBalance - { available, held, total } for base asset
   * @param {object} params.quoteBalance - { available, held, total } for quote asset
   */
  refreshBalances({ baseBalance, quoteBalance }) {
    if (!this.balancesInitialized) {
      // First call — delegate to full initialization
      this.initializeFromBalances({ baseBalance, quoteBalance });
      return;
    }

    const newBase = baseBalance || { available: 0, held: 0, total: 0 };
    const newQuote = quoteBalance || { available: 0, held: 0, total: 0 };

    // Log discrepancies between tracked and exchange balances
    const baseDrift = Math.abs((this.baseBalance?.available || 0) - newBase.available);
    const quoteDrift = Math.abs((this.quoteBalance?.available || 0) - newQuote.available);

    if (baseDrift > 0.0001) {
      this.logger.info(
        `[InventoryManager] Balance drift (base): tracked=${this.baseBalance?.available?.toFixed(8)} exchange=${newBase.available.toFixed(8)} drift=${baseDrift.toFixed(8)}`
      );
    }
    if (quoteDrift > 0.01) {
      this.logger.info(
        `[InventoryManager] Balance drift (quote): tracked=${this.quoteBalance?.available?.toFixed(2)} exchange=${newQuote.available.toFixed(2)} drift=${quoteDrift.toFixed(2)}`
      );
    }

    // Update balances from exchange (authoritative source) — do NOT touch netPosition/VWAP
    this.baseBalance = { ...newBase };
    this.quoteBalance = { ...newQuote };
  }

  /**
   * Get available balance for a given side.
   * Buy side needs quote currency (PYUSD), sell side needs base currency (BTC).
   * Returns available minus held (order holds).
   */
  getAvailableForSide(side) {
    const normalizedSide = side.toLowerCase();
    if (!this.balancesInitialized) return Infinity; // No balance info — don't restrict

    if (normalizedSide === 'buy') {
      if (!this.quoteBalance) return 0;
      return this.quoteBalance.total - (this.quoteBalance.transferHold || 0);
    } else if (normalizedSide === 'sell') {
      if (!this.baseBalance) return 0;
      return this.baseBalance.total - (this.baseBalance.transferHold || 0);
    }
    return 0;
  }

  /**
   * Check if we can quote on a given side.
   * Returns false if:
   *   - At position limit for the accumulating side
   *   - No available balance for the side (balance-aware check)
   */
  canQuote(side) {
    const normalizedSide = side.toLowerCase();
    const absPosition = Math.abs(this.netPosition);

    if (absPosition >= this.maxPositionBTC) {
      // At limit: block the accumulating side
      if (this.netPosition > 0 && normalizedSide === 'buy') return false;
      if (this.netPosition < 0 && normalizedSide === 'sell') return false;
    }

    // Balance-aware check: don't quote a side we can't back
    if (this.balancesInitialized) {
      const available = this.getAvailableForSide(normalizedSide);
      if (available <= 0) return false;
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
      hedgeNeeded: this.shouldHedge().shouldHedge,
      balancesInitialized: this.balancesInitialized,
      baseBalance: this.baseBalance,
      quoteBalance: this.quoteBalance,
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
