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
      randomLevelSpacingBpsMin: options.randomLevelSpacingBpsMin || null,
      randomLevelSpacingBpsMax: options.randomLevelSpacingBpsMax || null,
      repriceThresholdTicks: options.repriceThresholdTicks || 1,
      baseSizeBTC: options.baseSizeBTC || 0.1,
      sizeDecayFactor: options.sizeDecayFactor || 0.8,
      maxOrdersPerSecond: options.maxOrdersPerSecond || 8,
      dupGuardMs: options.dupGuardMs || 500,
      minRepriceIntervalMs: options.minRepriceIntervalMs || 0, // Min ms between reprices (0 = no debounce)
      sizeDecimalPlaces: options.sizeDecimalPlaces || 8, // Decimal places for quantity rounding
      tickSize: options.tickSize || 0.50,
      minNotional: options.minNotional || 1.0,
      priceBandPct: options.priceBandPct || 2.5,
      confidenceThreshold: options.confidenceThreshold || 0.3,
      symbol: options.symbol || 'BTC-PYUSD',
      senderCompID: options.senderCompID || 'CLI_CLIENT',
      targetCompID: options.targetCompID || 'TRUEX_UAT_OE',
      clientId: options.clientId || null, // TrueX PartyID (tag 448) — required for order entry
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

    // Rejection backoff: stop quoting after consecutive rejects
    this.consecutiveRejects = 0;
    this.rejectBackoffUntil = 0; // timestamp when backoff ends

    // Cancel tracking: newClOrdID → origClOrdID (for matching cancel acks back to activeOrders)
    this.cancelToOrigMap = new Map();

    // Optional randomized bps ladder (stable for this engine instance).
    this.levelSpacingBpsByLevel = this._buildLevelSpacingBpsLadder();
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

    const now = Date.now();

    // Rejection backoff: pause quoting after consecutive rejects
    if (this.rejectBackoffUntil > now) {
      return;
    }
    if (this.config.minRepriceIntervalMs > 0 &&
        this.lastRepriceAt &&
        (now - this.lastRepriceAt) < this.config.minRepriceIntervalMs) {
      return;
    }

    // Get inventory skew
    const skew = this.inventoryManager
      ? this.inventoryManager.getSkew()
      : { bidSkewTicks: 0, askSkewTicks: 0 };

    // Compute desired quotes
    const desired = this.computeDesiredQuotes(mid, skew);

    // Reconcile against active orders
    const actions = this.reconcileOrders(desired, this.activeOrders);

    // Log reconciliation summary
    if (actions.toPlace.length || actions.toCancel.length || actions.toReplace.length) {
      const statusCounts = {};
      for (const [, o] of this.activeOrders) {
        statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
      }
      this.logger.info(`[QuoteEngine] Reprice: mid=$${mid.toFixed(2)} active=${this.activeOrders.size} (${JSON.stringify(statusCounts)}) | place=${actions.toPlace.length} cancel=${actions.toCancel.length} replace=${actions.toReplace.length}`);
    }

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

    // Track cumulative committed balance: start from what's already committed in active orders
    // This prevents double-commitment when orders from previous reprice are still live
    let bidCommittedQuote = 0;
    let askCommittedBase = 0;
    for (const [, order] of this.activeOrders) {
      if (order.status === 'active' || order.status === 'pending') {
        if (order.side === 'buy') {
          bidCommittedQuote += order.size * order.price;
        } else if (order.side === 'sell') {
          askCommittedBase += order.size;
        }
      }
    }

    for (let level = 1; level <= levels; level++) {
      const levelOffset = this._getLevelOffset(mid, level, levelSpacingTicks, tickSize);
      const rawSize = baseSizeBTC * Math.pow(sizeDecayFactor, level - 1);
      const size = parseFloat(rawSize.toFixed(this.config.sizeDecimalPlaces));

      // Bid price
      const rawBid = mid - halfSpread - levelOffset - (skew.bidSkewTicks * tickSize);
      const bidPrice = this.snapToTick(rawBid);

      // Ask price
      const rawAsk = mid + halfSpread + levelOffset + (skew.askSkewTicks * tickSize);
      const askPrice = this.snapToTick(rawAsk);

      // Filter bids — cap size to remaining available quote balance
      if (
        this._canQuoteSide('buy') &&
        this.withinPriceBand(bidPrice, mid) &&
        bidPrice * size >= minNotional
      ) {
        const cappedBidSize = this._capSizeToBalance('buy', size, bidPrice, bidCommittedQuote);
        if (cappedBidSize > 0 && bidPrice * cappedBidSize >= minNotional) {
          bids.push({ side: 'buy', price: bidPrice, size: cappedBidSize, level });
          bidCommittedQuote += cappedBidSize * bidPrice;
        }
      }

      // Filter asks — cap size to remaining available base balance
      if (
        this._canQuoteSide('sell') &&
        this.withinPriceBand(askPrice, mid) &&
        askPrice * size >= minNotional
      ) {
        const cappedAskSize = this._capSizeToBalance('sell', size, askPrice, askCommittedBase);
        if (cappedAskSize > 0 && askPrice * cappedAskSize >= minNotional) {
          asks.push({ side: 'sell', price: askPrice, size: cappedAskSize, level });
          askCommittedBase += cappedAskSize;
        }
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
        // Check if there's a pending/cancelling order at this side+level (in flight)
        // If so, skip — wait for confirmation before placing replacement
        let hasInflightAtLevel = false;
        for (const [, order] of active) {
          if (order.side === dq.side && order.level === dq.level &&
              (order.status === 'cancelling' || order.status === 'pending')) {
            hasInflightAtLevel = true;
            break;
          }
        }
        if (!hasInflightAtLevel) {
          toPlace.push(dq);
        }
      } else {
        matched.add(match.clOrdID);

        // Skip orders that are pending or cancelling (wait for TrueX confirmation)
        if (match.order.status === 'cancelling' || match.order.status === 'pending') {
          continue;
        }

        const priceDiffTicks = Math.abs(match.order.price - dq.price) / this.config.tickSize;

        if (priceDiffTicks >= this.config.repriceThresholdTicks) {
          // Price moved enough: cancel old, place new
          toReplace.push({ cancel: match.clOrdID, cancelOrder: match.order, place: dq });
        }
        // Otherwise keep existing (no action)
      }
    }

    // Active orders with no corresponding desired quote: cancel (only confirmed orders)
    for (const [clOrdID, order] of active) {
      if (!matched.has(clOrdID) && order.status !== 'pending' && order.status !== 'cancelling') {
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
      '18': '6',  // ExecInst: Add Liquidity Only (maker-only)
      '55': this.config.symbol,
      '54': quote.side === 'buy' ? '1' : '2',
      '38': quote.size.toString(),
      '44': quote.price.toFixed(2),
      '40': '2',  // Limit
      '59': '1',  // GTC
    };

    // TrueX Party ID block — required for order entry
    if (this.config.clientId) {
      fields['453'] = '1';                  // NoPartyIDs
      fields['448'] = this.config.clientId; // PartyID (TrueX client ID)
      fields['452'] = '3';                  // PartyRole (3 = Client ID)
    }

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
    // TrueX cancel via 35=F (OrderCancelRequest). No tag 54 (Side).
    const fields = {
      '35': 'F',
      '11': newClOrdID,
      '41': origClOrdID,
    };

    // TrueX Party ID block — required for cancels too
    if (this.config.clientId) {
      fields['453'] = '1';
      fields['448'] = this.config.clientId;
      fields['452'] = '3';
    }

    // Mark order as 'cancelling' so reconcileOrders skips this level
    const activeOrder = this.activeOrders.get(origClOrdID);
    if (activeOrder) {
      activeOrder.status = 'cancelling';
    }

    // Track cancel ClOrdID → original ClOrdID for exec report matching
    this.cancelToOrigMap.set(newClOrdID, origClOrdID);

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
    const lastQty = fields['32'] ? parseFloat(fields['32']) : null;
    const side = fields['54'] === '1' ? 'buy' : 'sell';

    // Resolve cancel ClOrdID → original ClOrdID if this is a cancel ack
    const origClOrdID = this.cancelToOrigMap.get(clOrdID);
    const resolvedClOrdID = origClOrdID || clOrdID;

    switch (ordStatus) {
      case '0': // New - order accepted
        this.consecutiveRejects = 0; // Reset backoff on success
        if (this.activeOrders.has(resolvedClOrdID)) {
          this.activeOrders.get(resolvedClOrdID).status = 'active';
        }
        break;

      case '2': // Filled
        this.activeOrders.delete(resolvedClOrdID);
        this.cancelToOrigMap.delete(clOrdID);
        this.emit('fill', {
          side,
          price: lastPx,
          size: lastQty,
          clOrdID: resolvedClOrdID,
          execID,
        });
        break;

      case '4': // Cancelled
        this.activeOrders.delete(resolvedClOrdID);
        this.cancelToOrigMap.delete(clOrdID);
        break;

      case '8': // Rejected
        this.consecutiveRejects++;
        if (this.consecutiveRejects >= 3) {
          // Back off for 5 seconds after 3+ consecutive rejects
          this.rejectBackoffUntil = Date.now() + 5000;
          this.logger.warn(`[QuoteEngine] ${this.consecutiveRejects} consecutive rejects — backing off for 5s`);
        }
        if (origClOrdID) {
          // Cancel was rejected — original order still lives on TrueX
          // Restore to 'active' so reconciler knows the level is occupied
          const origOrder = this.activeOrders.get(origClOrdID);
          if (origOrder) {
            origOrder.status = 'active';
          }
          this.cancelToOrigMap.delete(clOrdID);
        } else {
          // New order was rejected — remove from tracking (never made it to exchange)
          this.activeOrders.delete(resolvedClOrdID);
        }
        this.logger.error(`[QuoteEngine] Order rejected: clOrdID=${clOrdID}, reason=${fields['58'] || 'unknown'}, code=${fields['103'] || 'n/a'}`);
        break;
    }
  }

  /**
   * Handle inbound OrderCancelReject (35=9) from FIX.
   * TrueX sends 35=9 when a cancel request fails. The original order is still live.
   * Key fields: tag 11 (ClOrdID of cancel), tag 41 (OrigClOrdID), tag 58 (Text), tag 102 (CxlRejReason)
   */
  onOrderCancelReject(fields) {
    if (!fields) return;

    const clOrdID = fields['11'];        // ClOrdID of the cancel request
    const origClOrdID = fields['41'];    // OrigClOrdID — the order we tried to cancel
    const reason = fields['58'] || 'unknown';
    const cxlRejReason = fields['102'];  // 0=Too late, 1=Unknown order, etc.

    this.logger.warn(`[QuoteEngine] OrderCancelReject: cancel=${clOrdID} orig=${origClOrdID} reason=${reason} cxlRejReason=${cxlRejReason}`);

    // Resolve via cancelToOrigMap if origClOrdID not in the message
    const resolvedOrigClOrdID = origClOrdID || this.cancelToOrigMap.get(clOrdID);

    if (resolvedOrigClOrdID) {
      if (cxlRejReason === '1') {
        // Unknown order — it's gone from the exchange, remove from tracking
        this.activeOrders.delete(resolvedOrigClOrdID);
      } else {
        // Cancel failed but original order still lives — restore to 'active'
        const origOrder = this.activeOrders.get(resolvedOrigClOrdID);
        if (origOrder) {
          origOrder.status = 'active';
        }
      }
    }

    // Clean up cancel tracking
    this.cancelToOrigMap.delete(clOrdID);

    // Count as a reject for backoff purposes
    this.consecutiveRejects++;
    if (this.consecutiveRejects >= 3) {
      this.rejectBackoffUntil = Date.now() + 5000;
      this.logger.warn(`[QuoteEngine] ${this.consecutiveRejects} consecutive rejects — backing off for 5s`);
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

    // Emergency: clear all active orders immediately (don't wait for cancel acks)
    this.activeOrders.clear();

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
   * Remove a stale order from local tracking (used by REST reconciliation).
   * Returns true if the order existed and was removed.
   */
  removeStaleOrder(clOrdID) {
    if (this.activeOrders.has(clOrdID)) {
      this.activeOrders.delete(clOrdID);
      return true;
    }
    return false;
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
   * Cap order size to available balance minus already-committed amounts.
   * For sells: cap to available BTC minus already committed BTC across prior levels.
   * For buys: cap to (available PYUSD - committed PYUSD) / price.
   * @param {string} side - 'buy' or 'sell'
   * @param {number} desiredSize - desired order size in BTC
   * @param {number} price - order price
   * @param {number} alreadyCommitted - amount already committed across prior levels
   *   For sells: BTC already committed. For buys: PYUSD already committed.
   * Returns capped size rounded to sizeDecimalPlaces.
   */
  _capSizeToBalance(side, desiredSize, price, alreadyCommitted = 0) {
    if (!this.inventoryManager || !this.inventoryManager.balancesInitialized) {
      return desiredSize; // No balance info — use full size
    }

    const available = this.inventoryManager.getAvailableForSide(side);
    if (available === Infinity) return desiredSize;

    let maxSize;
    if (side === 'sell') {
      // Selling BTC: cap to (available BTC - already committed BTC)
      const remaining = available - alreadyCommitted;
      maxSize = Math.max(0, remaining);
    } else {
      // Buying BTC: cap to (available PYUSD - already committed PYUSD) / price
      const remaining = available - alreadyCommitted;
      maxSize = price > 0 ? Math.max(0, remaining) / price : 0;
    }

    const cappedSize = Math.min(desiredSize, maxSize);
    const factor = Math.pow(10, this.config.sizeDecimalPlaces);
    return Math.floor(Math.max(0, cappedSize) * factor) / factor;
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

  _buildLevelSpacingBpsLadder() {
    const { levels, randomLevelSpacingBpsMin, randomLevelSpacingBpsMax } = this.config;
    if (!randomLevelSpacingBpsMin || !randomLevelSpacingBpsMax) return null;
    if (randomLevelSpacingBpsMin <= 0 || randomLevelSpacingBpsMax <= 0) return null;
    if (randomLevelSpacingBpsMax < randomLevelSpacingBpsMin) return null;

    const ladder = [];
    let cumulativeBps = 0;
    for (let level = 1; level <= levels; level++) {
      const stepBps = randomLevelSpacingBpsMin +
        Math.random() * (randomLevelSpacingBpsMax - randomLevelSpacingBpsMin);
      cumulativeBps += stepBps;
      ladder.push(cumulativeBps);
    }

    return ladder;
  }

  _getLevelOffset(mid, level, levelSpacingTicks, tickSize) {
    if (this.levelSpacingBpsByLevel) {
      const cumulativeBps = this.levelSpacingBpsByLevel[level - 1] || 0;
      return (cumulativeBps / 10000) * mid;
    }
    return level * levelSpacingTicks * tickSize;
  }
}
