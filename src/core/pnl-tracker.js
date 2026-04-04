import { EventEmitter } from 'events';

/**
 * PnLTracker - FIFO-based Profit & Loss Tracker
 *
 * Tracks realized PnL from matched fills using FIFO queuing,
 * unrealized PnL via mark-to-market, and per-venue fee accounting.
 *
 * Events emitted:
 * - 'significantChange' { totalPnL, previousPnL, delta }
 * - 'summary' { ...getSummary() }
 */
export class PnLTracker extends EventEmitter {
  constructor(options = {}) {
    super();

    // Fee configuration (basis points)
    this.truexMakerFeeBps = options.truexMakerFeeBps ?? 0;
    this.truexTakerFeeBps = options.truexTakerFeeBps ?? 0;
    this.hedgeMakerFeeBps = options.hedgeMakerFeeBps ?? 0;
    this.hedgeTakerFeeBps = options.hedgeTakerFeeBps ?? 0;

    // Logging configuration
    this.logIntervalMs = options.logIntervalMs ?? 30000;
    this.significantPnlChange = options.significantPnlChange ?? 100;

    // Logger
    this.logger = options.logger || console;

    // FIFO queues for matching
    this.buyFills = [];   // { quantity, price, remainingQty, timestamp, venue }
    this.sellFills = [];  // { quantity, price, remainingQty, timestamp, venue }

    // PnL state
    this.realizedPnL = 0;
    this.unrealizedPnL = 0;
    this.totalMatchedQuantity = 0;
    this.lastMid = null;

    // Fee tracking
    this.totalFees = 0;
    this.feesByVenue = {};
    this.makerFees = 0;
    this.takerFees = 0;

    // Trade stats
    this.numTrades = 0;
    this.sessionStartTime = Date.now();

    // For significant change detection
    this._lastReportedPnL = 0;

    // Periodic logging timer
    this._logTimer = null;
  }

  /**
   * Process a fill event from the trading engine.
   */
  onFill({ side, quantity, price, venue = 'truex', isMaker = false, execID, timestamp }) {
    if (!quantity || quantity <= 0) return;

    this.numTrades++;

    // Calculate and track fee
    const feeBps = this._getFeeBps(venue, isMaker);
    const feeAmount = quantity * price * (feeBps / 10000);
    this.totalFees += feeAmount;
    this.feesByVenue[venue] = (this.feesByVenue[venue] || 0) + feeAmount;
    if (isMaker) {
      this.makerFees += feeAmount;
    } else {
      this.takerFees += feeAmount;
    }

    // Add to FIFO queue
    const entry = {
      quantity,
      price,
      remainingQty: quantity,
      timestamp: timestamp || Date.now(),
      venue
    };

    if (side === 'buy') {
      this.buyFills.push(entry);
      this._matchFIFO(this.sellFills, this.buyFills, 'sell');
    } else {
      this.sellFills.push(entry);
      this._matchFIFO(this.buyFills, this.sellFills, 'buy');
    }

    // Re-mark to market if we have a price
    if (this.lastMid !== null) {
      this.markToMarket(this.lastMid);
    }

    // Check for significant PnL change
    this._checkSignificantChange();
  }

  /**
   * FIFO matching: try to match the opposite queue against newest fills.
   * oppositeQueue is the queue we match from (oldest first).
   * newQueue is where we just added (the new fill is at the end).
   */
  _matchFIFO(oppositeQueue, newQueue, oppositeSide) {
    // The new fill is the last entry in newQueue
    // We match it against entries in oppositeQueue (oldest first)
    const newEntry = newQueue[newQueue.length - 1];
    if (!newEntry || newEntry.remainingQty <= 0) return;

    let i = 0;
    while (i < oppositeQueue.length && newEntry.remainingQty > 0) {
      const oppEntry = oppositeQueue[i];
      if (oppEntry.remainingQty <= 0) {
        i++;
        continue;
      }

      const matchQty = Math.min(newEntry.remainingQty, oppEntry.remainingQty);

      // Determine buy/sell prices
      let buyPrice, sellPrice;
      if (oppositeSide === 'buy') {
        // oppositeQueue = buyFills, newQueue = sellFills
        buyPrice = oppEntry.price;
        sellPrice = newEntry.price;
      } else {
        // oppositeQueue = sellFills, newQueue = buyFills
        buyPrice = newEntry.price;
        sellPrice = oppEntry.price;
      }

      this.realizedPnL += matchQty * (sellPrice - buyPrice);
      this.totalMatchedQuantity += matchQty;

      newEntry.remainingQty -= matchQty;
      oppEntry.remainingQty -= matchQty;

      if (oppEntry.remainingQty <= 0) {
        i++;
      }
    }

    // Remove exhausted entries from the opposite queue
    while (oppositeQueue.length > 0 && oppositeQueue[0].remainingQty <= 0) {
      oppositeQueue.shift();
    }

    // Remove exhausted entry from new queue if fully matched
    if (newEntry.remainingQty <= 0) {
      newQueue.pop();
    }
  }

  /**
   * Recompute unrealized PnL based on current mid price.
   */
  markToMarket(currentMid) {
    this.lastMid = currentMid;

    const longQty = this.buyFills.reduce((sum, f) => sum + f.remainingQty, 0);
    const shortQty = this.sellFills.reduce((sum, f) => sum + f.remainingQty, 0);
    const netPosition = longQty - shortQty;

    if (netPosition > 0) {
      // Net long: unrealized = netPosition * (mid - avgCost)
      const avgCost = this._weightedAvg(this.buyFills);
      this.unrealizedPnL = netPosition * (currentMid - avgCost);
    } else if (netPosition < 0) {
      // Net short: unrealized = |netPosition| * (avgCost - mid)
      const avgCost = this._weightedAvg(this.sellFills);
      this.unrealizedPnL = Math.abs(netPosition) * (avgCost - currentMid);
    } else {
      this.unrealizedPnL = 0;
    }
  }

  /**
   * Weighted average price of remaining fills in a queue.
   */
  _weightedAvg(fills) {
    let totalQty = 0;
    let totalValue = 0;
    for (const f of fills) {
      if (f.remainingQty > 0) {
        totalQty += f.remainingQty;
        totalValue += f.remainingQty * f.price;
      }
    }
    return totalQty > 0 ? totalValue / totalQty : 0;
  }

  /**
   * Look up fee rate in bps for venue/maker combination.
   */
  _getFeeBps(venue, isMaker) {
    if (venue === 'truex') {
      return isMaker ? this.truexMakerFeeBps : this.truexTakerFeeBps;
    }
    // All non-truex venues use hedge fee schedule (kraken, etc.)
    return isMaker ? this.hedgeMakerFeeBps : this.hedgeTakerFeeBps;
  }

  /**
   * Check if PnL has moved significantly since last report.
   */
  _checkSignificantChange() {
    const currentTotal = this.realizedPnL + this.unrealizedPnL - this.totalFees;
    const delta = Math.abs(currentTotal - this._lastReportedPnL);
    if (delta >= this.significantPnlChange) {
      const previousPnL = this._lastReportedPnL;
      this._lastReportedPnL = currentTotal;
      this.emit('significantChange', {
        totalPnL: currentTotal,
        previousPnL,
        delta: currentTotal - previousPnL
      });
    }
  }

  /**
   * Get current PnL summary.
   */
  getSummary() {
    const totalPnL = this.realizedPnL + this.unrealizedPnL - this.totalFees;
    const avgSpreadCapture = this.totalMatchedQuantity > 0
      ? this.realizedPnL / this.totalMatchedQuantity
      : 0;

    const longQty = this.buyFills.reduce((sum, f) => sum + f.remainingQty, 0);
    const shortQty = this.sellFills.reduce((sum, f) => sum + f.remainingQty, 0);
    const netPosition = longQty - shortQty;

    return {
      realizedPnL: this.realizedPnL,
      unrealizedPnL: this.unrealizedPnL,
      totalPnL,
      totalFees: this.totalFees,
      numTrades: this.numTrades,
      avgSpreadCapture,
      netPosition,
      totalMatchedQuantity: this.totalMatchedQuantity,
      feesByVenue: { ...this.feesByVenue },
      makerFees: this.makerFees,
      takerFees: this.takerFees
    };
  }

  /**
   * Generate a detailed session report string for logging.
   */
  getSessionReport() {
    const summary = this.getSummary();
    const elapsed = Date.now() - this.sessionStartTime;
    const elapsedMin = (elapsed / 60000).toFixed(1);

    const lines = [
      '=== PnL Session Report ===',
      `Session Duration: ${elapsedMin} min`,
      `Trades: ${summary.numTrades}`,
      `Net Position: ${summary.netPosition.toFixed(8)}`,
      `Realized PnL: $${summary.realizedPnL.toFixed(2)}`,
      `Unrealized PnL: $${summary.unrealizedPnL.toFixed(2)}`,
      `Total Fees: $${summary.totalFees.toFixed(2)}`,
      `Net PnL: $${summary.totalPnL.toFixed(2)}`,
      `Avg Spread Capture: $${summary.avgSpreadCapture.toFixed(4)}/unit`,
      `Matched Quantity: ${summary.totalMatchedQuantity.toFixed(8)}`,
      `Maker Fees: $${summary.makerFees.toFixed(2)}`,
      `Taker Fees: $${summary.takerFees.toFixed(2)}`,
    ];

    const venues = Object.keys(summary.feesByVenue);
    if (venues.length > 0) {
      lines.push('Fees by Venue:');
      for (const v of venues) {
        lines.push(`  ${v}: $${summary.feesByVenue[v].toFixed(2)}`);
      }
    }

    lines.push('===========================');
    return lines.join('\n');
  }

  /**
   * Start periodic PnL summary logging.
   */
  startPeriodicLogging() {
    if (this._logTimer) return;
    this._logTimer = setInterval(() => {
      const summary = this.getSummary();
      this.logger.info(`[PnLTracker] PnL: realized=$${summary.realizedPnL.toFixed(2)} unrealized=$${summary.unrealizedPnL.toFixed(2)} fees=$${summary.totalFees.toFixed(2)} net=$${summary.totalPnL.toFixed(2)} trades=${summary.numTrades}`);
      this.emit('summary', summary);
    }, this.logIntervalMs);
  }

  /**
   * Stop periodic logging.
   */
  stopPeriodicLogging() {
    if (this._logTimer) {
      clearInterval(this._logTimer);
      this._logTimer = null;
    }
  }

  /**
   * Reset all PnL state.
   */
  reset() {
    this.buyFills = [];
    this.sellFills = [];
    this.realizedPnL = 0;
    this.unrealizedPnL = 0;
    this.totalMatchedQuantity = 0;
    this.lastMid = null;
    this.totalFees = 0;
    this.feesByVenue = {};
    this.makerFees = 0;
    this.takerFees = 0;
    this.numTrades = 0;
    this._lastReportedPnL = 0;
    this.sessionStartTime = Date.now();
    this.stopPeriodicLogging();
  }
}
