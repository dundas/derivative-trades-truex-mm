import { EventEmitter } from 'events';

/**
 * QuoteEngine - Dynamic quote management for TrueX market making.
 *
 * Receives aggregated price updates, computes desired bid/ask ladders
 * with inventory skew, reconciles against active orders, and sends
 * FIX messages through a rate-limited pipeline.
 *
 * Events emitted:
 *   'quote-update'  - quotes changed { bidLevels, askLevels }
 *   'fill'          - order filled { side, price, size, clOrdID, execID }
 *   'cancel-all'    - emergency pullback triggered { reason }
 *   'rate-limited'  - action deferred { action, queueDepth }
 */
export class QuoteEngine extends EventEmitter {
  constructor(options = {}) {
    super();

    // Dependencies (injected)
    this.inventoryManager = options.inventoryManager;
    this.fixConnection = options.fixConnection;
    this.logger = options.logger || console;

    // Config
    this.config = {
      levels: options.levels || 5,
      baseSpreadBps: options.baseSpreadBps || 50,
      levelSpacingTicks: options.levelSpacingTicks || 1,
      repriceThresholdTicks: options.repriceThresholdTicks || 1,
      baseSizeBTC: options.baseSizeBTC || 0.1,
      sizeDecayFactor: options.sizeDecayFactor || 0.8,
      maxOrdersPerSecond: options.maxOrdersPerSecond || 8,
      dupGuardMs: options.dupGuardMs || 500,
      tickSize: options.tickSize || 0.50,
      minNotional: options.minNotional || 1.0,
      priceBandPct: options.priceBandPct || 2.5,
      confidenceThreshold: options.confidenceThreshold || 0.3,
      symbol: options.symbol || 'BTC-PYUSD',
      senderCompID: options.senderCompID || 'CLI_CLIENT',
      targetCompID: options.targetCompID || 'TRUEX_UAT_OE',
    };

    // State
    this.activeOrders = new Map(); // clOrdID -> { side, price, size, level, status, placedAt }
    this.lastMid = 0;
    this.lastRepriceAt = 0;
    this.isQuoting = false;
    this.orderSequence = 0;

    // Rate limiting
    this.actionQueue = [];
    this.actionsThisSecond = 0;
    this.lastActionReset = Date.now();
    this.lastActionByClOrdID = new Map(); // clOrdID -> lastActionTime
  }

  /**
   * Main entry point: called on every PriceAggregator 'price' event.
   */
  onPriceUpdate(aggregatedPrice) {
    if (!aggregatedPrice) return;

    // Gate on confidence
    if (aggregatedPrice.confidence < this.config.confidenceThreshold) {
      this.cancelAllQuotes('Low confidence: ' + aggregatedPrice.confidence.toFixed(2));
      return;
    }

    const mid = aggregatedPrice.weightedMidpoint;
    if (!mid || mid <= 0) return;

    this.lastMid = mid;

    // Get inventory skew
    const skew = this.inventoryManager
      ? this.inventoryManager.getSkew()
      : { bidSkewTicks: 0, askSkewTicks: 0 };

    // Compute desired quotes
    const desired = this.computeDesiredQuotes(mid, skew);

    // Reconcile against active orders
    const actions = this.reconcileOrders(desired, this.activeOrders);

    // Execute rate-limited
    this.executeActions(actions);

    this.isQuoting = true;
    this.lastRepriceAt = Date.now();
    this.emit('quote-update', {
      bidLevels: desired.filter(q => q.side === 'buy').length,
      askLevels: desired.filter(q => q.side === 'sell').length,
    });
  }

  /**
   * Compute desired bid/ask quotes based on mid price and inventory skew.
   */
  computeDesiredQuotes(mid, skew) {
    const {
      levels,
      baseSpreadBps,
      levelSpacingTicks,
      tickSize,
      baseSizeBTC,
      sizeDecayFactor,
      priceBandPct,
      minNotional,
    } = this.config;

    const halfSpread = (baseSpreadBps / 10000) * mid / 2;
    const bids = [];
    const asks = [];

    for (let level = 1; level <= levels; level++) {
      const levelOffset = level * levelSpacingTicks * tickSize;
      const size = baseSizeBTC * Math.pow(sizeDecayFactor, level - 1);

      // Bid price
      const rawBid = mid - halfSpread - levelOffset - (skew.bidSkewTicks * tickSize);
      const bidPrice = this.snapToTick(rawBid);

      // Ask price
      const rawAsk = mid + halfSpread + levelOffset + (skew.askSkewTicks * tickSize);
      const askPrice = this.snapToTick(rawAsk);

      // Filter bids
      if (
        this._canQuoteSide('buy') &&
        this.withinPriceBand(bidPrice, mid) &&
        bidPrice * size >= minNotional
      ) {
        bids.push({ side: 'buy', price: bidPrice, size, level });
      }

      // Filter asks
      if (
        this._canQuoteSide('sell') &&
        this.withinPriceBand(askPrice, mid) &&
        askPrice * size >= minNotional
      ) {
        asks.push({ side: 'sell', price: askPrice, size, level });
      }
    }

    return [...bids, ...asks];
  }

  /**
   * Snap a price to the nearest tick.
   */
  snapToTick(price) {
    return Math.round(price / this.config.tickSize) * this.config.tickSize;
  }

  /**
   * Check if a price is within the allowed price band around mid.
   */
  withinPriceBand(price, mid) {
    if (mid <= 0) return false;
    const deviation = Math.abs(price - mid) / mid * 100;
    return deviation <= this.config.priceBandPct;
  }

  /**
   * Reconcile desired quotes vs active orders.
   * Returns { toPlace, toCancel, toReplace }.
   */
  reconcileOrders(desired, active) {
    const toPlace = [];
    const toCancel = [];
    const toReplace = [];
    const matched = new Set(); // clOrdIDs that match a desired quote

    for (const dq of desired) {
      // Find matching active order at same side + level
      let match = null;
      for (const [clOrdID, order] of active) {
        if (order.side === dq.side && order.level === dq.level && !matched.has(clOrdID)) {
          match = { clOrdID, order };
          break;
        }
      }

      if (!match) {
        // No match: place new
        toPlace.push(dq);
      } else {
        matched.add(match.clOrdID);
        const priceDiffTicks = Math.abs(match.order.price - dq.price) / this.config.tickSize;

        if (priceDiffTicks >= this.config.repriceThresholdTicks) {
          // Price moved enough: cancel old, place new
          toReplace.push({ cancel: match.clOrdID, cancelOrder: match.order, place: dq });
        }
        // Otherwise keep existing (no action)
      }
    }

    // Active orders with no corresponding desired quote: cancel
    for (const [clOrdID, order] of active) {
      if (!matched.has(clOrdID)) {
        toCancel.push({ clOrdID, order });
      }
    }

    return { toPlace, toCancel, toReplace };
  }

  /**
   * Execute actions through rate limiter.
   * Priority: cancels first, then replacements, then new orders.
   */
  executeActions(actions) {
    // Reset rate counter if a second has passed
    const now = Date.now();
    if (now - this.lastActionReset >= 1000) {
      this.actionsThisSecond = 0;
      this.lastActionReset = now;
    }

    // Build ordered action list: cancels first, then replaces, then places
    const orderedActions = [];

    for (const c of actions.toCancel) {
      orderedActions.push({ type: 'cancel', clOrdID: c.clOrdID, order: c.order });
    }

    for (const r of actions.toReplace) {
      orderedActions.push({ type: 'cancel', clOrdID: r.cancel, order: r.cancelOrder });
      orderedActions.push({ type: 'place', quote: r.place });
    }

    for (const p of actions.toPlace) {
      orderedActions.push({ type: 'place', quote: p });
    }

    for (const action of orderedActions) {
      if (this.actionsThisSecond >= this.config.maxOrdersPerSecond) {
        // Defer to queue
        this.actionQueue.push(action);
        this.emit('rate-limited', { action: action.type, queueDepth: this.actionQueue.length });
        continue;
      }

      // Dup guard check
      const guardKey = action.type === 'cancel' ? action.clOrdID : null;
      if (guardKey && this._isDupGuarded(guardKey)) {
        continue;
      }

      this._dispatchAction(action);
      this.actionsThisSecond++;
    }
  }

  /**
   * Dispatch a single action to FIX connection.
   */
  _dispatchAction(action) {
    if (action.type === 'cancel') {
      this._sendCancel(action.clOrdID, action.order);
    } else if (action.type === 'place') {
      this._sendNewOrder(action.quote);
    }
  }

  /**
   * Send a FIX New Order Single (35=D).
   */
  _sendNewOrder(quote) {
    const clOrdID = this.generateClOrdID();
    const fields = {
      '35': 'D',
      '11': clOrdID,
      '55': this.config.symbol,
      '54': quote.side === 'buy' ? '1' : '2',
      '38': quote.size.toString(),
      '44': quote.price.toFixed(2),
      '40': '2',  // Limit
      '59': '1',  // GTC
    };

    this.activeOrders.set(clOrdID, {
      side: quote.side,
      price: quote.price,
      size: quote.size,
      level: quote.level,
      status: 'pending',
      placedAt: Date.now(),
    });

    this.lastActionByClOrdID.set(clOrdID, Date.now());

    if (this.fixConnection) {
      this.fixConnection.sendMessage(fields);
    }
  }

  /**
   * Send a FIX Order Cancel Request (35=F).
   */
  _sendCancel(origClOrdID, order) {
    const newClOrdID = this.generateClOrdID();
    const fields = {
      '35': 'F',
      '11': newClOrdID,
      '41': origClOrdID,
      '55': this.config.symbol,
      '54': order.side === 'buy' ? '1' : '2',
    };

    this.lastActionByClOrdID.set(origClOrdID, Date.now());

    if (this.fixConnection) {
      this.fixConnection.sendMessage(fields);
    }
  }

  /**
   * Handle inbound execution reports from FIX.
   */
  onExecutionReport(fields) {
    if (!fields) return;

    const clOrdID = fields['11'];
    const ordStatus = fields['39'];
    const execID = fields['17'];
    const lastPx = parseFloat(fields['31'] || fields['44'] || '0');
    const lastQty = parseFloat(fields['32'] || fields['38'] || '0');
    const side = fields['54'] === '1' ? 'buy' : 'sell';

    switch (ordStatus) {
      case '0': // New - order accepted
        if (this.activeOrders.has(clOrdID)) {
          this.activeOrders.get(clOrdID).status = 'active';
        }
        break;

      case '2': // Filled
        this.activeOrders.delete(clOrdID);
        this.emit('fill', {
          side,
          price: lastPx,
          size: lastQty,
          clOrdID,
          execID,
        });
        break;

      case '4': // Cancelled
        this.activeOrders.delete(clOrdID);
        break;

      case '8': // Rejected
        this.activeOrders.delete(clOrdID);
        this.logger.error(`[QuoteEngine] Order rejected: clOrdID=${clOrdID}, reason=${fields['58'] || 'unknown'}`);
        break;
    }
  }

  /**
   * Emergency: cancel all active orders. Bypasses rate limiter for cancels.
   */
  cancelAllQuotes(reason) {
    const orderCount = this.activeOrders.size;
    if (orderCount === 0) return;

    this.logger.warn(`[QuoteEngine] Cancelling all ${orderCount} quotes: ${reason || 'emergency'}`);

    for (const [clOrdID, order] of this.activeOrders) {
      this._sendCancel(clOrdID, order);
    }

    this.isQuoting = false;
    this.emit('cancel-all', { reason: reason || 'emergency', orderCount });
  }

  /**
   * Generate a unique ClOrdID that fits within 18 characters.
   */
  generateClOrdID() {
    const ts = Date.now().toString(36);
    const seq = (++this.orderSequence % 999).toString().padStart(3, '0');
    return `Q${ts}${seq}`;
  }

  /**
   * Return a summary of current quoting status.
   */
  getQuoteStatus() {
    let bidLevels = 0;
    let askLevels = 0;

    for (const order of this.activeOrders.values()) {
      if (order.side === 'buy') bidLevels++;
      else askLevels++;
    }

    return {
      bidLevels,
      askLevels,
      activeCount: this.activeOrders.size,
      lastMid: this.lastMid,
      lastRepriceAt: this.lastRepriceAt,
      isQuoting: this.isQuoting,
    };
  }

  /**
   * Check if a canQuote call allows quoting on a side.
   */
  _canQuoteSide(side) {
    if (!this.inventoryManager) return true;
    return this.inventoryManager.canQuote(side);
  }

  /**
   * Check dup guard: returns true if action was sent too recently for this clOrdID.
   */
  _isDupGuarded(clOrdID) {
    const lastTime = this.lastActionByClOrdID.get(clOrdID);
    if (!lastTime) return false;
    return (Date.now() - lastTime) < this.config.dupGuardMs;
  }

  /**
   * Drain queued actions (call periodically from orchestrator or timer).
   */
  drainQueue() {
    const now = Date.now();
    if (now - this.lastActionReset >= 1000) {
      this.actionsThisSecond = 0;
      this.lastActionReset = now;
    }

    while (this.actionQueue.length > 0 && this.actionsThisSecond < this.config.maxOrdersPerSecond) {
      const action = this.actionQueue.shift();
      this._dispatchAction(action);
      this.actionsThisSecond++;
    }
  }
}
