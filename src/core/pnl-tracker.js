import { EventEmitter } from 'events';

/**
 * PnLTracker - FIFO-based Market Making P&L Tracker
 *
 * realizedPnL   = FIFO-matched spread (profit from completed round-trips)
 * unrealizedPnL = cost-basis MTM of open net position
 * sellProceeds  = total quote received from all sells (cash-flow, useful for sell-heavy accounts)
 * buyCost       = total quote spent on all buys
 * netCashFlow   = sellProceeds - buyCost (net PYUSD generated from trading)
 *
 * For a sell-heavy account (e.g. liquidating BTC inventory), realizedPnL will be
 * near $0 (no matched round-trips), but netCashFlow shows total PYUSD received.
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

    // FIFO queues for spread capture matching
    this.buyFills = [];   // { quantity, price, remainingQty, timestamp, venue }
    this.sellFills = [];  // { quantity, price, remainingQty, timestamp, venue }

    // FIFO PnL state
    this.realizedPnL = 0;
    this.unrealizedPnL = 0;
    this.totalMatchedQuantity = 0;
    this.lastMid = null;

    // Cash-flow tracking (accurate for sell-heavy / inventory-liquidation accounts)
    this.sellProceeds = 0;  // total quote received from all sells
    this.buyCost = 0;       // total quote spent on all buys

    // Fee tracking
    this.totalFees = 0;
    this.feesByVenue = {};
    this.makerFees = 0;
    this.takerFees = 0;

    // Trade stats
    this.numTrades = 0;
    this.buyCount = 0;
    this.sellCount = 0;
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

    // Cash-flow tracking
    if (side === 'buy') {
      this.buyCost += quantity * price;
      this.buyCount++;
    } else {
      this.sellProceeds += quantity * price;
      this.sellCount++;
    }

    // FIFO matching for realized spread PnL
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

    this._checkSignificantChange();
  }

  /**
   * FIFO matching: match opposite queue against the newest fill.
   * Realized PnL = spread captured on matched round-trips.
   */
  _matchFIFO(oppositeQueue, newQueue, oppositeSide) {
    const newEntry = newQueue[newQueue.length - 1];
    if (!newEntry || newEntry.remainingQty <= 0) return;

    let i = 0;
    while (i < oppositeQueue.length && newEntry.remainingQty > 0) {
      const oppEntry = oppositeQueue[i];
      if (oppEntry.remainingQty <= 0) { i++; continue; }

      const matchQty = Math.min(newEntry.remainingQty, oppEntry.remainingQty);

      let buyPrice, sellPrice;
      if (oppositeSide === 'buy') {
        buyPrice = oppEntry.price; sellPrice = newEntry.price;
      } else {
        buyPrice = newEntry.price; sellPrice = oppEntry.price;
      }

      this.realizedPnL += matchQty * (sellPrice - buyPrice);
      this.totalMatchedQuantity += matchQty;

      newEntry.remainingQty -= matchQty;
      oppEntry.remainingQty -= matchQty;
      if (oppEntry.remainingQty <= 0) i++;
    }

    while (oppositeQueue.length > 0 && oppositeQueue[0].remainingQty <= 0) {
      oppositeQueue.shift();
    }
    if (newEntry.remainingQty <= 0) newQueue.pop();
  }

  /**
   * Recompute unrealized PnL based on current mid price.
   * Uses cost-basis: unrealized = net position * (mid - avg cost).
   */
  markToMarket(currentMid) {
    this.lastMid = currentMid;

    const longQty = this.buyFills.reduce((sum, f) => sum + f.remainingQty, 0);
    const shortQty = this.sellFills.reduce((sum, f) => sum + f.remainingQty, 0);
    const netPosition = longQty - shortQty;

    if (netPosition > 0) {
      const avgCost = this._weightedAvg(this.buyFills);
      this.unrealizedPnL = netPosition * (currentMid - avgCost);
    } else if (netPosition < 0) {
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
    let totalQty = 0, totalValue = 0;
    for (const f of fills) {
      if (f.remainingQty > 0) {
        totalQty += f.remainingQty;
        totalValue += f.remainingQty * f.price;
      }
    }
    return totalQty > 0 ? totalValue / totalQty : 0;
  }

  _getFeeBps(venue, isMaker) {
    if (venue === 'truex') {
      return isMaker ? this.truexMakerFeeBps : this.truexTakerFeeBps;
    }
    return isMaker ? this.hedgeMakerFeeBps : this.hedgeTakerFeeBps;
  }

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
   * realizedPnL = FIFO spread on matched round-trips.
   * netCashFlow = sellProceeds - buyCost (use for sell-heavy accounts).
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
      // FIFO spread PnL (accurate for round-trip market making)
      realizedPnL: this.realizedPnL,
      unrealizedPnL: this.unrealizedPnL,
      totalPnL,
      totalFees: this.totalFees,
      // Cash-flow (accurate for sell-heavy / inventory liquidation)
      sellProceeds: this.sellProceeds,
      buyCost: this.buyCost,
      netCashFlow: this.sellProceeds - this.buyCost,
      // Position
      netPosition,
      // Trade stats
      numTrades: this.numTrades,
      buyCount: this.buyCount,
      sellCount: this.sellCount,
      // Efficiency
      avgSpreadCapture,
      totalMatchedQuantity: this.totalMatchedQuantity,
      // Fees
      feesByVenue: { ...this.feesByVenue },
      makerFees: this.makerFees,
      takerFees: this.takerFees,
    };
  }

  /** Generate a detailed session report string for logging. */
  getSessionReport() {
    const s = this.getSummary();
    const elapsedMin = ((Date.now() - this.sessionStartTime) / 60000).toFixed(1);
    const lines = [
      '=== PnL Session Report ===',
      `Session Duration: ${elapsedMin} min`,
      `Trades: ${s.numTrades} (${s.buyCount} buys, ${s.sellCount} sells)`,
      `Net Position: ${s.netPosition.toFixed(8)}`,
      `Realized PnL:   $${s.realizedPnL.toFixed(2)} (spread on matched round-trips)`,
      `Unrealized PnL: $${s.unrealizedPnL.toFixed(2)}`,
      `Total Fees:     $${s.totalFees.toFixed(2)}`,
      `Net PnL:        $${s.totalPnL.toFixed(2)}`,
      `Avg Spread Capture: $${s.avgSpreadCapture.toFixed(4)}/unit`,
      `Matched Quantity:   ${s.totalMatchedQuantity.toFixed(8)}`,
      `--- Cash Flow ---`,
      `Sell Proceeds: $${s.sellProceeds.toFixed(2)}`,
      `Buy Cost:      $${s.buyCost.toFixed(2)}`,
      `Net Cash Flow: $${s.netCashFlow.toFixed(2)}`,
      `Maker Fees: $${s.makerFees.toFixed(2)} | Taker Fees: $${s.takerFees.toFixed(2)}`,
    ];
    const venues = Object.keys(s.feesByVenue);
    if (venues.length > 0) {
      lines.push('Fees by Venue:');
      for (const v of venues) {
        lines.push(`  ${v}: $${s.feesByVenue[v].toFixed(2)}`);
      }
    }
    lines.push('===========================');
    return lines.join('\n');
  }

  /** Start periodic PnL summary logging. */
  startPeriodicLogging() {
    if (this._logTimer) return;
    this._logTimer = setInterval(() => {
      const s = this.getSummary();
      this.logger.info(`[PnLTracker] realized=$${s.realizedPnL.toFixed(2)} unrealized=$${s.unrealizedPnL.toFixed(2)} fees=$${s.totalFees.toFixed(2)} net=$${s.totalPnL.toFixed(2)} cashFlow=$${s.netCashFlow.toFixed(2)} trades=${s.numTrades}(${s.buyCount}B/${s.sellCount}S)`);
      this.emit('summary', s);
    }, this.logIntervalMs);
  }

  /** Stop periodic logging. */
  stopPeriodicLogging() {
    if (this._logTimer) {
      clearInterval(this._logTimer);
      this._logTimer = null;
    }
  }

  /** Reset all PnL state. */
  reset() {
    this.buyFills = [];
    this.sellFills = [];
    this.realizedPnL = 0;
    this.unrealizedPnL = 0;
    this.totalMatchedQuantity = 0;
    this.lastMid = null;
    this.sellProceeds = 0;
    this.buyCost = 0;
    this.totalFees = 0;
    this.feesByVenue = {};
    this.makerFees = 0;
    this.takerFees = 0;
    this.numTrades = 0;
    this.buyCount = 0;
    this.sellCount = 0;
    this._lastReportedPnL = 0;
    this.sessionStartTime = Date.now();
    this.stopPeriodicLogging();
  }
}
