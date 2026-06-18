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
      // Quote anchoring: 'mid' = hang quotes off weighted mid by baseSpreadBps (default).
      // 'coinbase-mirror' = anchor to the anchor venue's best bid/ask ± coinbaseAnchorBufferTicks
      // so our spread tracks that venue's width. Falls back to 'mid' if the book is absent.
      quoteAnchorMode: options.quoteAnchorMode || 'mid',
      coinbaseAnchorBufferTicks: options.coinbaseAnchorBufferTicks ?? 1,
      // Which venue's book to mirror. Anchor is sourced from this exchange's feed
      // specifically (via aggregatedPrice.sources), NOT the cross-venue best bid/ask.
      anchorExchange: options.anchorExchange || 'coinbase',
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
      truexBookStaleThresholdMs: options.truexBookStaleThresholdMs || 10000,
      marketablePostOnlyAction: options.marketablePostOnlyAction || 'skip',
      replaceMode: options.replaceMode || 'passive-safe',
      minActiveLevelsPerSide: options.minActiveLevelsPerSide ?? 0,
      maxReplacementsPerSidePerCycle: options.maxReplacementsPerSidePerCycle ?? Number.POSITIVE_INFINITY,
      pendingReplacementTimeoutMs: options.pendingReplacementTimeoutMs || 5000,
      allowTakerOrders: options.allowTakerOrders || false,
      truexTakerFeeBps: options.truexTakerFeeBps ?? 0,
      minTakeEdgeBps: options.minTakeEdgeBps ?? 1,
      takeSlippageBufferBps: options.takeSlippageBufferBps ?? 0,
      takeHedgeBufferBps: options.takeHedgeBufferBps ?? 0,
      maxTakerOrdersPerMinute: options.maxTakerOrdersPerMinute ?? 0,
      maxTakerNotionalPerMinute: options.maxTakerNotionalPerMinute ?? 0,
      marketDataProvider: options.marketDataProvider || null,
    };

    // State
    this.activeOrders = new Map(); // clOrdID -> { side, price, size, level, status, placedAt }
    this.lastMid = 0;
    this.lastAnchorBook = null; // { bestBid, bestAsk } from the anchor venue's feed (for coinbase-mirror)
    this.lastRepriceAt = 0;
    this.isQuoting = false;
    this.quotingSuspended = false;
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
    this.pendingReplacements = new Map(); // origClOrdID -> { quote, createdAt }
    this.suppressedLevels = new Map(); // side:level -> { reason, timestamp, quote }
    this.recentRejectsByReason = new Map();
    this.lastReplacementSide = null;
    this.lastReplacementLevelBySide = new Map();
    this.deferredRepriceNeeded = false;
    this.lastMarketableAloSkip = null;
    this.truexBook = null;
    this.takerWindowStartedAt = Date.now();
    this.takerOrdersThisWindow = 0;
    this.takerNotionalThisWindow = 0;

    // Optional randomized bps ladder (stable for this engine instance).
    this.levelSpacingBpsByLevel = this._buildLevelSpacingBpsLadder();
  }

  updateTrueXBook(book) {
    if (!book) return;
    const bestBid = book.bestBid ?? null;
    const bestAsk = book.bestAsk ?? null;
    this.truexBook = {
      bestBid,
      bestAsk,
      bestBidSize: book.bestBidSize ?? null,
      bestAskSize: book.bestAskSize ?? null,
      timestamp: book.timestamp ?? null,
    };
  }

  suspendQuoting() {
    this.quotingSuspended = true;
    this.isQuoting = false;
  }

  resumeQuoting() {
    this.quotingSuspended = false;
  }

  invalidateQueuedWork(reprice = false) {
    this.actionQueue = [];
    this.deferredRepriceNeeded = reprice;
  }

  clearPendingReplacement(origClOrdID) {
    this.pendingReplacements.delete(origClOrdID);
  }

  /**
   * Extract the anchor venue's own best bid/ask from an aggregated price's per-venue sources.
   * Returns { bestBid, bestAsk } for a fresh, valid book, or null (→ caller falls back to mid).
   */
  _extractAnchorBook(aggregatedPrice) {
    const sources = aggregatedPrice?.sources;
    if (!Array.isArray(sources)) return null;
    const src = sources.find(
      (s) => s && s.exchange === this.config.anchorExchange && !s.isStale && s.bid > 0 && s.ask > s.bid
    );
    return src ? { bestBid: src.bid, bestAsk: src.ask } : null;
  }

  /**
   * Main entry point: called on every PriceAggregator 'price' event.
   */
  onPriceUpdate(aggregatedPrice) {
    if (!aggregatedPrice) return;
    this._expirePendingReplacements();

    // Gate on confidence
    if (aggregatedPrice.confidence < this.config.confidenceThreshold) {
      this.cancelAllQuotes('Low confidence: ' + aggregatedPrice.confidence.toFixed(2));
      return;
    }

    const mid = aggregatedPrice.weightedMidpoint;
    if (!mid || mid <= 0) return;

    this.lastMid = mid;
    if (this.quotingSuspended) {
      return;
    }

    // Capture the anchor venue's own best bid/ask for coinbase-mirror anchoring. Sourced from
    // that venue's feed specifically — NOT aggregatedPrice.bestBid/bestAsk, which is the best
    // across all venues and would mirror a synthetic cross-venue spread.
    this.lastAnchorBook = this._extractAnchorBook(aggregatedPrice);

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
    const desired = this.computeDesiredQuotes(mid, skew, this.lastAnchorBook);

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
    const dispatched = this.executeActions(actions);

    this.isQuoting = true;
    if (dispatched) {
      this.lastRepriceAt = Date.now();
    }
    this.emit('quote-update', {
      bidLevels: desired.filter(q => q.side === 'buy').length,
      askLevels: desired.filter(q => q.side === 'sell').length,
    });
  }

  /**
   * Compute desired bid/ask quotes based on mid price and inventory skew.
   */
  computeDesiredQuotes(mid, skew, anchorBook = null) {
    const {
      levels,
      baseSpreadBps,
      levelSpacingTicks,
      tickSize,
      baseSizeBTC,
      sizeDecayFactor,
      priceBandPct,
      minNotional,
      quoteAnchorMode,
      coinbaseAnchorBufferTicks,
    } = this.config;

    const halfSpread = (baseSpreadBps / 10000) * mid / 2;

    // coinbase-mirror: anchor L1 to the anchor venue's best bid/ask offset out by a small buffer
    // so our spread mirrors that venue's width while staying maker-safe. Deeper levels step out
    // by the same ladder used in 'mid' mode. Requires a valid anchor book; otherwise we fall back
    // to mid-anchored quoting so we never stop quoting on a missing reference.
    const useMirror =
      quoteAnchorMode === 'coinbase-mirror' &&
      anchorBook &&
      anchorBook.bestBid > 0 &&
      anchorBook.bestAsk > anchorBook.bestBid;
    const mirrorBuffer = coinbaseAnchorBufferTicks * tickSize;
    const l1LadderOffset = useMirror
      ? this._getLevelOffset(mid, 1, levelSpacingTicks, tickSize)
      : 0;

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

      let rawBid;
      let rawAsk;
      if (useMirror) {
        // L1 sits at the anchor venue's touch ± buffer; deeper levels add the ladder beyond L1.
        const ladder = levelOffset - l1LadderOffset;
        rawBid = anchorBook.bestBid - mirrorBuffer - ladder - (skew.bidSkewTicks * tickSize);
        rawAsk = anchorBook.bestAsk + mirrorBuffer + ladder + (skew.askSkewTicks * tickSize);
      } else {
        rawBid = mid - halfSpread - levelOffset - (skew.bidSkewTicks * tickSize);
        rawAsk = mid + halfSpread + levelOffset + (skew.askSkewTicks * tickSize);
      }
      const bidPrice = this.snapToTick(rawBid);
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
        const sizeShortfall = dq.size - match.order.size;

        if (priceDiffTicks >= this.config.repriceThresholdTicks) {
          // Price moved enough: cancel old, place new
          toReplace.push({ cancel: match.clOrdID, cancelOrder: match.order, place: dq });
        } else if (sizeShortfall > 0 && dq.price * sizeShortfall >= this.config.minNotional) {
          // Order is under-quoted vs desired (e.g. left smaller by a partial fill) and the
          // shortfall is economically meaningful — replace to replenish back to target size.
          // The minNotional guard prevents churn on tiny rounding differences.
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
   * Priority: pure cancels first, then replacements, then new places.
   */
  executeActions(actions) {
    // Reset rate counter if a second has passed
    const now = Date.now();
    if (now - this.lastActionReset >= 1000) {
      this.actionsThisSecond = 0;
      this.lastActionReset = now;
    }

    // Build ordered action list. TrueX default is passive-safe because ALO
    // replacements that cross the book are cancelled/rejected by the venue.
    const orderedActions = [];

    for (const c of actions.toCancel) {
      orderedActions.push({ type: 'cancel', clOrdID: c.clOrdID, order: c.order });
    }

    if (this.config.replaceMode === 'place-before-cancel') {
      for (const r of actions.toReplace) {
        orderedActions.push({ type: 'place', quote: r.place });
        orderedActions.push({ type: 'cancel', clOrdID: r.cancel, order: r.cancelOrder });
      }
    } else {
      const replacementCountsBySide = new Map();
      const initialLiveCountsBySide = new Map();
      const liveCountsBySide = new Map();
      const inflightCountsBySide = new Map();
      const pureCancelsBySide = new Map();

      for (const [, order] of this.activeOrders) {
        if (order.status === 'active') {
          initialLiveCountsBySide.set(order.side, (initialLiveCountsBySide.get(order.side) || 0) + 1);
          liveCountsBySide.set(order.side, (liveCountsBySide.get(order.side) || 0) + 1);
          continue;
        }
        if (order.status === 'cancelling' || order.status === 'pending') {
          inflightCountsBySide.set(order.side, (inflightCountsBySide.get(order.side) || 0) + 1);
        }
      }

      for (const cancel of actions.toCancel) {
        const side = cancel.order?.side;
        if (!side) continue;
        pureCancelsBySide.set(side, (pureCancelsBySide.get(side) || 0) + 1);
      }

      for (const [side, count] of pureCancelsBySide.entries()) {
        liveCountsBySide.set(side, Math.max(0, (liveCountsBySide.get(side) || 0) - count));
      }

      const replacements = this._orderPassiveSafeReplacements(actions.toReplace);

      for (const r of replacements) {
        const side = r.cancelOrder?.side || r.place?.side;
        const liveOnSide = liveCountsBySide.get(side) || 0;
        const initialLiveOnSide = initialLiveCountsBySide.get(side) || 0;
        const inflightOnSide = inflightCountsBySide.get(side) || 0;
        const replacementsOnSide = replacementCountsBySide.get(side) || 0;
        const singleQuoteException = this.config.minActiveLevelsPerSide === 1 &&
          initialLiveOnSide === 1 &&
          inflightOnSide === 0;

        if ((!singleQuoteException && liveOnSide <= this.config.minActiveLevelsPerSide) ||
            replacementsOnSide >= this.config.maxReplacementsPerSidePerCycle) {
          this.deferredRepriceNeeded = true;
          continue;
        }

        orderedActions.push({
          type: 'replacement-cancel',
          clOrdID: r.cancel,
          order: r.cancelOrder,
          quote: r.place,
        });
        liveCountsBySide.set(side, liveOnSide - 1);
        replacementCountsBySide.set(side, replacementsOnSide + 1);
      }
    }

    for (const p of actions.toPlace) {
      orderedActions.push({ type: 'place', quote: p });
    }

    let dispatched = false;
    for (const action of orderedActions) {
      if (this.actionsThisSecond >= this.config.maxOrdersPerSecond) {
        if (action.type === 'replacement-cancel') {
          this.deferredRepriceNeeded = true;
          this.emit('rate-limited', { action: action.type, queueDepth: this.actionQueue.length });
          continue;
        }
        // Defer to queue
        this.actionQueue.push(action);
        this.emit('rate-limited', { action: action.type, queueDepth: this.actionQueue.length });
        continue;
      }

      // Dup guard check
      const guardKey = action.type === 'cancel' || action.type === 'replacement-cancel'
        ? action.clOrdID
        : null;
      if (guardKey && this._isDupGuarded(guardKey)) {
        continue;
      }

      this._dispatchAction(action);
      this.actionsThisSecond++;
      dispatched = true;
    }
    return dispatched;
  }

  /**
   * Dispatch a single action to FIX connection.
   */
  _dispatchAction(action) {
    if (action.type === 'cancel') {
      this._sendCancel(action.clOrdID, action.order);
    } else if (action.type === 'replacement-cancel') {
      this.pendingReplacements.set(action.clOrdID, { quote: action.quote, createdAt: Date.now() });
      this.lastReplacementSide = action.order?.side || null;
      this.lastReplacementLevelBySide.set(action.order?.side, action.order?.level || 0);
      this._sendCancel(action.clOrdID, action.order);
    } else if (action.type === 'place') {
      this._sendNewOrder(action.quote);
    }
  }

  /**
   * Send a FIX New Order Single (35=D).
   */
  _sendNewOrder(quote) {
    const prepared = this._prepareQuoteForSend(quote);
    if (!prepared) return null;

    const clOrdID = this.generateClOrdID();
    const fields = {
      '35': 'D',
      '11': clOrdID,
      '55': this.config.symbol,
      '54': prepared.side === 'buy' ? '1' : '2',
      '38': prepared.size.toString(),
      '44': prepared.price.toFixed(2),
      '40': '2',  // Limit
      '59': '1',  // GTC
    };
    if (prepared.postOnly !== false) {
      fields['18'] = '6';  // ExecInst: Add Liquidity Only (maker-only)
    }

    // TrueX Party ID block — required for order entry
    if (this.config.clientId) {
      fields['453'] = '1';                  // NoPartyIDs
      fields['448'] = this.config.clientId; // PartyID (TrueX client ID)
      fields['452'] = '3';                  // PartyRole (3 = Client ID)
    }

    this.activeOrders.set(clOrdID, {
      side: quote.side,
      price: prepared.price,
      size: prepared.size,
      level: prepared.level,
      status: 'pending',
      placedAt: Date.now(),
      orderIntent: prepared.orderIntent || (prepared.postOnly === false ? 'taker_opportunity' : 'maker_quote'),
      liquidityRoleExpected: prepared.postOnly === false ? 'taker' : 'maker',
    });

    this.lastActionByClOrdID.set(clOrdID, Date.now());

    if (this.fixConnection) {
      this.fixConnection.sendMessage(fields);
    }
    if (prepared.postOnly === false) {
      this._recordTakerOrder(prepared.size * prepared.price);
    }
    return clOrdID;
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
  _emitFillEvent(resolvedClOrdID, side, price, size, execID) {
    const tracked = this.activeOrders.get(resolvedClOrdID);
    this.emit('fill', {
      side,
      price,
      size,
      clOrdID: resolvedClOrdID,
      execID,
      orderIntent: tracked?.orderIntent || 'maker_quote',
      liquidityRoleExpected: tracked?.liquidityRoleExpected || 'maker',
      isMaker: (tracked?.liquidityRoleExpected || 'maker') === 'maker',
    });
    return tracked;
  }

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

      case '1': // Partially Filled — record the partial, keep the order live (reduced)
        this.consecutiveRejects = 0; // a fill means the order pipeline is healthy
        if (lastQty && lastQty > 0) {
          const tracked = this._emitFillEvent(resolvedClOrdID, side, lastPx, lastQty, execID);
          if (tracked) {
            // Remaining size = LeavesQty (tag 151) if provided, else subtract LastQty.
            const leavesQty = fields['151'] !== undefined
              ? parseFloat(fields['151'])
              : (tracked.size - lastQty);
            tracked.size = Math.max(0, leavesQty);
            // A fill proves the order is live, so promote 'pending' → 'active'. But preserve
            // 'cancelling' so reconcileOrders doesn't double-act on an in-flight cancel.
            tracked.status = tracked.status === 'cancelling' ? 'cancelling' : 'active';
          }
        }
        break;

      case '2': // Filled — record the fill and remove the order
        this.consecutiveRejects = 0;
        this._emitFillEvent(resolvedClOrdID, side, lastPx, lastQty, execID);
        this.activeOrders.delete(resolvedClOrdID);
        this.cancelToOrigMap.delete(clOrdID);
        break;

      case '4': // Cancelled
        this.activeOrders.delete(resolvedClOrdID);
        this.cancelToOrigMap.delete(clOrdID);
        this._releasePendingReplacement(resolvedClOrdID);
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
        {
          const reason = fields['58'] || 'unknown';
          this.recentRejectsByReason.set(reason, (this.recentRejectsByReason.get(reason) || 0) + 1);
          this.logger.error(`[QuoteEngine] Order rejected: clOrdID=${clOrdID}, reason=${reason}, code=${fields['103'] || 'n/a'}`);
        }
        break;

      case 'A': // PendingNew
      case '6': // PendingCancel
      case 'E': // PendingReplace
        // Benign in-flight transition states (TrueX sends PendingNew before New on every
        // order). Expected and frequent — no action, and must NOT hit the default warn.
        break;

      default: // Surface anything we don't explicitly handle instead of silently dropping it
        this.logger.warn(`[QuoteEngine] Unhandled execution report ordStatus=${ordStatus} clOrdID=${clOrdID} execID=${execID}`);
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
        this.pendingReplacements.delete(resolvedOrigClOrdID);
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
    this.suspendQuoting();
    this.deferredRepriceNeeded = false;
    this.actionQueue = [];
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
    this._expirePendingReplacements();
    let bidLevels = 0;
    let askLevels = 0;

    for (const order of this.activeOrders.values()) {
      if (order.side === 'buy') bidLevels++;
      else askLevels++;
    }
    const suppressed = Array.from(this.suppressedLevels.entries()).map(([key, value]) => ({
      key,
      ...value,
    }));

    return {
      bidLevels,
      askLevels,
      activeCount: this.activeOrders.size,
      lastMid: this.lastMid,
      lastRepriceAt: this.lastRepriceAt,
      isQuoting: this.isQuoting,
      suppressed,
      lastMarketableAloSkip: this.lastMarketableAloSkip,
      recentRejectsByReason: Object.fromEntries(this.recentRejectsByReason),
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
    this._expirePendingReplacements();
    if (this.quotingSuspended) {
      return;
    }
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

    if (this.deferredRepriceNeeded && this.actionsThisSecond < this.config.maxOrdersPerSecond) {
      this._runDeferredReprice();
    }
  }

  _getTrueXBook() {
    if (this.config.marketDataProvider) {
      const provided = this.config.marketDataProvider();
      if (provided) this.updateTrueXBook(provided);
    }
    return this.truexBook;
  }

  _isBookFresh(book = this._getTrueXBook()) {
    return !!(book && book.timestamp && (Date.now() - book.timestamp) <= this.config.truexBookStaleThresholdMs);
  }

  _isMarketablePostOnly(quote) {
    const book = this._getTrueXBook();
    if (!this._isBookFresh(book)) return false;
    if (quote.side === 'buy' && book.bestAsk !== null && book.bestAsk !== undefined) {
      return quote.price >= book.bestAsk;
    }
    if (quote.side === 'sell' && book.bestBid !== null && book.bestBid !== undefined) {
      return quote.price <= book.bestBid;
    }
    return false;
  }

  _recordSuppression(quote, reason) {
    const key = `${quote.side}:${quote.level}`;
    const value = { reason, timestamp: Date.now(), quote: { ...quote } };
    this.suppressedLevels.set(key, value);
    if (reason === 'marketable-post-only') {
      this.lastMarketableAloSkip = value;
    }
    this.logger.warn(`[QuoteEngine] Suppressed ${quote.side} L${quote.level}: ${reason}`);
  }

  _prepareQuoteForSend(quote) {
    const prepared = { ...quote };
    const isPostOnly = prepared.postOnly !== false;
    if (!isPostOnly) {
      const takerQuote = this._prepareTakerQuote(prepared);
      if (!takerQuote) {
        return null;
      }
      return takerQuote;
    }

    if (!this._isMarketablePostOnly(prepared)) {
      return prepared;
    }

    if (this.config.marketablePostOnlyAction === 'slide') {
      const book = this._getTrueXBook();
      if (prepared.side === 'buy' && book?.bestAsk !== null && book?.bestAsk !== undefined) {
        prepared.price = this.snapToTick(book.bestAsk - this.config.tickSize);
        return prepared;
      }
      if (prepared.side === 'sell' && book?.bestBid !== null && book?.bestBid !== undefined) {
        prepared.price = this.snapToTick(book.bestBid + this.config.tickSize);
        return prepared;
      }
    }

    this._recordSuppression(prepared, 'marketable-post-only');
    return null;
  }

  _prepareTakerQuote(quote) {
    const prepared = { ...quote };
    if (!this.config.allowTakerOrders) {
      this._recordSuppression(prepared, 'taker-disabled');
      return null;
    }

    const fairValue = Number(prepared.fairValue);
    const executionPrice = Number(prepared.executionPrice ?? prepared.price);
    if (!fairValue || !executionPrice || fairValue <= 0 || executionPrice <= 0) {
      this._recordSuppression(prepared, 'taker-missing-edge-inputs');
      return null;
    }

    const edgeBps = this.computeTakeEdgeBps({ side: prepared.side, fairValue, executionPrice });
    if (edgeBps < this.config.minTakeEdgeBps) {
      this._recordSuppression({ ...prepared, edgeBps }, 'taker-edge-too-low');
      return null;
    }

    const notional = prepared.size * prepared.price;
    if (!this._hasTakerBudget(notional)) {
      this._recordSuppression({ ...prepared, edgeBps }, 'taker-budget-exhausted');
      return null;
    }

    prepared.edgeBps = edgeBps;
    return prepared;
  }

  computeTakeEdgeBps({ side, fairValue, executionPrice }) {
    const gross = side === 'buy'
      ? ((fairValue - executionPrice) / fairValue) * 10000
      : ((executionPrice - fairValue) / fairValue) * 10000;
    return gross
      - this.config.truexTakerFeeBps
      - this.config.takeSlippageBufferBps
      - this.config.takeHedgeBufferBps;
  }

  _resetTakerWindowIfNeeded() {
    const now = Date.now();
    if (now - this.takerWindowStartedAt >= 60000) {
      this.takerWindowStartedAt = now;
      this.takerOrdersThisWindow = 0;
      this.takerNotionalThisWindow = 0;
    }
  }

  _hasTakerBudget(notional) {
    this._resetTakerWindowIfNeeded();
    if (this.config.maxTakerOrdersPerMinute > 0 &&
        this.takerOrdersThisWindow >= this.config.maxTakerOrdersPerMinute) {
      return false;
    }
    if (this.config.maxTakerNotionalPerMinute > 0 &&
        this.takerNotionalThisWindow + notional > this.config.maxTakerNotionalPerMinute) {
      return false;
    }
    return true;
  }

  _recordTakerOrder(notional) {
    this._resetTakerWindowIfNeeded();
    this.takerOrdersThisWindow++;
    this.takerNotionalThisWindow += notional;
  }

  _releasePendingReplacement(origClOrdID) {
    const pending = this.pendingReplacements.get(origClOrdID);
    if (!pending) return;
    this.pendingReplacements.delete(origClOrdID);
    if (Date.now() - pending.createdAt > this.config.pendingReplacementTimeoutMs) {
      this._recordSuppression(pending.quote, 'pending-replacement-expired');
      return;
    }
    if (this.quotingSuspended || this.rejectBackoffUntil > Date.now()) {
      this.deferredRepriceNeeded = true;
      return;
    }
    this._dispatchAction({ type: 'place', quote: pending.quote });
  }

  _expirePendingReplacements() {
    const now = Date.now();
    for (const [origClOrdID, pending] of this.pendingReplacements.entries()) {
      if (now - pending.createdAt <= this.config.pendingReplacementTimeoutMs) continue;
      this.pendingReplacements.delete(origClOrdID);
      const original = this.activeOrders.get(origClOrdID);
      if (original?.status === 'cancelling') {
        original.status = 'active';
      }
      this._recordSuppression(pending.quote, 'pending-replacement-expired');
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

  _orderPassiveSafeReplacements(replacements) {
    const grouped = new Map();

    for (const replacement of replacements) {
      const side = replacement.cancelOrder?.side || replacement.place?.side || 'unknown';
      if (!grouped.has(side)) grouped.set(side, []);
      grouped.get(side).push(replacement);
    }

    const ordered = [];
    const sides = [...grouped.keys()].sort();
    if (this.lastReplacementSide && sides.includes(this.lastReplacementSide)) {
      const startIndex = (sides.indexOf(this.lastReplacementSide) + 1) % sides.length;
      sides.push(...sides.splice(0, startIndex));
    }
    for (const side of sides) {
      const sideReplacements = grouped.get(side).sort((a, b) =>
        (a.cancelOrder?.level || 0) - (b.cancelOrder?.level || 0)
      );
      const lastLevel = this.lastReplacementLevelBySide.get(side);
      let startIndex = 0;
      if (lastLevel !== undefined) {
        const nextIndex = sideReplacements.findIndex((r) => (r.cancelOrder?.level || 0) > lastLevel);
        startIndex = nextIndex >= 0 ? nextIndex : 0;
      }
      ordered.push(
        ...sideReplacements.slice(startIndex),
        ...sideReplacements.slice(0, startIndex),
      );
    }

    return ordered;
  }

  _runDeferredReprice() {
    if (this.quotingSuspended) {
      this.deferredRepriceNeeded = true;
      return false;
    }
    if (!this.lastMid || this.lastMid <= 0) return false;
    const now = Date.now();
    if (this.rejectBackoffUntil > now) {
      this.deferredRepriceNeeded = true;
      return false;
    }
    if (this.config.minRepriceIntervalMs > 0 &&
        this.lastRepriceAt &&
        (now - this.lastRepriceAt) < this.config.minRepriceIntervalMs) {
      this.deferredRepriceNeeded = true;
      return false;
    }
    const skew = this.inventoryManager
      ? this.inventoryManager.getSkew()
      : { bidSkewTicks: 0, askSkewTicks: 0 };
    // Pass the last anchor book so deferred reprices honour coinbase-mirror mode too —
    // otherwise they silently fall back to mid-anchored (baseSpreadBps) quotes.
    const desired = this.computeDesiredQuotes(this.lastMid, skew, this.lastAnchorBook);
    const actions = this.reconcileOrders(desired, this.activeOrders);
    if (actions.toPlace.length || actions.toCancel.length || actions.toReplace.length) {
      this.deferredRepriceNeeded = false;
      const dispatched = this.executeActions(actions);
      if (dispatched) {
        this.lastRepriceAt = Date.now();
      }
      return !this.deferredRepriceNeeded;
    }
    this.deferredRepriceNeeded = false;
    return true;
  }
}
