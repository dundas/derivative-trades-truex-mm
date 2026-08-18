import { EventEmitter } from 'events';
import { randomBytes } from 'node:crypto';

// Intentionally duplicated from the CJS FIX builder across the CJS/ESM boundary.
// Numeric 0 means send 2964=0; boolean/string false disables the tag here via null.
function normalizeSelfMatchPreventionInstruction(value) {
  if (value === undefined || value === null) return '0';
  const normalized = String(value).trim();
  if (!normalized || ['none', 'off', 'false'].includes(normalized.toLowerCase())) {
    return null;
  }
  return normalized;
}

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
    this.capitalReservationManager = options.capitalReservationManager || null;
    this.continuityStateProvider = options.continuityStateProvider || null;
    this.maxExecutionDedupeOrders = options.maxExecutionDedupeOrders ?? 10000;
    if (!Number.isInteger(this.maxExecutionDedupeOrders) || this.maxExecutionDedupeOrders < 1) {
      throw new Error('maxExecutionDedupeOrders must be a positive integer');
    }
    this.maxExecutionIdsPerOrder = options.maxExecutionIdsPerOrder ?? 256;
    if (!Number.isInteger(this.maxExecutionIdsPerOrder) || this.maxExecutionIdsPerOrder < 1) {
      throw new Error('maxExecutionIdsPerOrder must be a positive integer');
    }
    this.executionDedupeByOrder = new Map();
    this.unknownStatusDedupeByOrder = new Map();
    this.terminalExecutionOrders = new Set();
    this.executionEvidenceGap = null;
    this.logger = options.logger || console;
    this.now = typeof options.now === 'function' ? options.now : Date.now;

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
      // Momentum reprice (task 0010): bypass the minRepriceInterval debounce when
      // the mid has moved >= this many bps since the last dispatched reprice.
      // 0 disables. Withdrawal itself reuses reconcile + passive-safe machinery.
      // Deliberately fail-closed: default 0 (off) at the engine/orchestrator level;
      // only run-prod.js enables it (MOMENTUM_REPRICE_BPS, default 10).
      momentumRepriceBps: options.momentumRepriceBps ?? 0,
      sizeDecimalPlaces: options.sizeDecimalPlaces || 8, // Decimal places for quantity rounding
      tickSize: options.tickSize || 0.50,
      minNotional: options.minNotional || 1.0,
      priceBandPct: options.priceBandPct || 2.5,
      confidenceThreshold: options.confidenceThreshold || 0.3,
      symbol: options.symbol || 'BTC-PYUSD',
      senderCompID: options.senderCompID || 'CLI_CLIENT',
      targetCompID: options.targetCompID || 'TRUEX_UAT_OE',
      clientId: options.clientId || null, // TrueX PartyID (tag 448) — required for order entry
      selfMatchPreventionInstruction: normalizeSelfMatchPreventionInstruction(options.selfMatchPreventionInstruction),
      truexBookStaleThresholdMs: options.truexBookStaleThresholdMs || 10000,
      strictTruexMakerSafety: options.strictTruexMakerSafety ?? false,
      truexMakerEbboMaxAgeMs: options.truexMakerEbboMaxAgeMs ?? 10000,
      truexAloRetryCooldownMs: options.truexAloRetryCooldownMs ?? 5000,
      truexAloRetryMaxEntries: options.truexAloRetryMaxEntries ?? 256,
      pyusdUsdStaleThresholdMs: options.pyusdUsdStaleThresholdMs || 15000,
      marketablePostOnlyAction: options.marketablePostOnlyAction || 'skip',
      replaceMode: options.replaceMode || 'passive-safe',
      minActiveLevelsPerSide: options.minActiveLevelsPerSide ?? 0,
      minimumFundedQuoteSize: options.minimumFundedQuoteSize ?? 0,
      degradedMaxLevels: options.degradedMaxLevels ?? 1,
      degradedSizeFactor: options.degradedSizeFactor ?? 1,
      defensiveSpreadFloorBps: options.defensiveSpreadFloorBps ?? 0,
      maxReplacementsPerSidePerCycle: options.maxReplacementsPerSidePerCycle ?? Number.POSITIVE_INFINITY,
      pendingReplacementTimeoutMs: options.pendingReplacementTimeoutMs || 5000,
      pendingSelfCrossGuardMs: options.pendingSelfCrossGuardMs ?? 5000,
      cancellingSelfCrossGuardMs: options.cancellingSelfCrossGuardMs ?? 5000,
      allowTakerOrders: options.allowTakerOrders || false,
      truexTakerFeeBps: options.truexTakerFeeBps ?? 0,
      minTakeEdgeBps: options.minTakeEdgeBps ?? 1,
      takeSlippageBufferBps: options.takeSlippageBufferBps ?? 0,
      takeHedgeBufferBps: options.takeHedgeBufferBps ?? 0,
      maxTakerOrdersPerMinute: options.maxTakerOrdersPerMinute ?? 0,
      maxTakerNotionalPerMinute: options.maxTakerNotionalPerMinute ?? 0,
      shadowTakeMode: options.shadowTakeMode ?? false,
      shadowPersistenceRequiredPolls: options.shadowPersistenceRequiredPolls ?? 3,
      maxEdgeCeilingBps: options.maxEdgeCeilingBps ?? 250,
      pyusdDepegThresholdBps: options.pyusdDepegThresholdBps ?? 100,
      minTakeSizeBTC: options.minTakeSizeBTC ?? 0.0001,
      maxTakeNotionalPerOrder: options.maxTakeNotionalPerOrder ?? 1000,
      shadowTakeQtyDecayTolerancePct: options.shadowTakeQtyDecayTolerancePct ?? 0.1,
      shadowAttributionMaxAgeMs: options.shadowAttributionMaxAgeMs ?? 5000,
      // Tape-freshness gates — split detection vs send.
      //   truexTapeMaxAgeMs: strict gate reserved for the taker send-path re-check
      //     (enforced when allowTakerOrders is enabled, before a take is dispatched).
      //   shadowDetectionTapeMaxAgeMs: looser gate used by evaluateShadowTake so it logs
      //     edge-quality data on illiquid books where trades print less often than every 5s
      //     (e.g. BTC-PYUSD). Keeps the Phase-2 analyzer from starving on `truex-tape-stale`.
      truexTapeMaxAgeMs: options.truexTapeMaxAgeMs ?? 5000,
      shadowDetectionTapeMaxAgeMs: options.shadowDetectionTapeMaxAgeMs ?? 30000,
      truexTapeOutlierThresholdBps: options.truexTapeOutlierThresholdBps ?? 50,
      marketDataProvider: options.marketDataProvider || null,
    };
    if (!Number.isInteger(this.config.degradedMaxLevels) || this.config.degradedMaxLevels < 1) {
      throw new Error('degradedMaxLevels must be a positive integer');
    }
    if (!Number.isFinite(this.config.degradedSizeFactor) ||
        this.config.degradedSizeFactor <= 0 || this.config.degradedSizeFactor > 1) {
      throw new Error('degradedSizeFactor must be in (0, 1]');
    }
    if (!Number.isFinite(this.config.defensiveSpreadFloorBps) || this.config.defensiveSpreadFloorBps < 0) {
      throw new Error('defensiveSpreadFloorBps must be a finite non-negative number');
    }
    if (typeof this.config.strictTruexMakerSafety !== 'boolean') {
      throw new Error('strictTruexMakerSafety must be boolean');
    }
    if (this.config.strictTruexMakerSafety) {
      if (!['skip', 'slide'].includes(this.config.marketablePostOnlyAction)) {
        throw new Error('marketablePostOnlyAction must be skip or slide');
      }
      if (!Number.isFinite(this.config.truexMakerEbboMaxAgeMs) || this.config.truexMakerEbboMaxAgeMs <= 0) {
        throw new Error('truexMakerEbboMaxAgeMs must be a finite positive number');
      }
      if (!Number.isFinite(this.config.truexAloRetryCooldownMs) || this.config.truexAloRetryCooldownMs <= 0) {
        throw new Error('truexAloRetryCooldownMs must be a finite positive number');
      }
      if (!Number.isInteger(this.config.truexAloRetryMaxEntries) || this.config.truexAloRetryMaxEntries < 1) {
        throw new Error('truexAloRetryMaxEntries must be a positive integer');
      }
    }

    // State
    this.activeOrders = new Map(); // clOrdID -> { side, price, size, level, status, placedAt }
    this.lastMid = 0;
    this.lastAnchorBook = null; // { bestBid, bestAsk } from the anchor venue's feed (for coinbase-mirror)
    this.lastRepriceAt = 0;
    this.isQuoting = false;
    this.quotingSuspended = false;
    this.orderSequence = 0;
    this.orderIdNamespace = options.orderIdNamespace || randomBytes(5).toString('base64url').slice(0, 6);
    this.orderIdBootId = options.orderIdBootId || randomBytes(4).toString('base64url').slice(0, 5);
    this.continuityState = Object.freeze({ executionState: 'normal', reasons: [] });
    if (!/^[A-Za-z0-9_-]{4,6}$/.test(this.orderIdNamespace)) {
      throw new Error('orderIdNamespace must contain 4-6 URL-safe characters');
    }
    if (!/^[A-Za-z0-9_-]{5}$/.test(this.orderIdBootId)) {
      throw new Error('orderIdBootId must contain exactly 5 URL-safe characters');
    }

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
    this.resolvedCancelIds = new Set();
    this.pendingReplacements = new Map(); // origClOrdID -> { quote, createdAt }
    this.suppressedLevels = new Map(); // side:level -> { reason, timestamp, quote }
    this.recentRejectsByReason = new Map();
    this.lastReplacementSide = null;
    this.lastReplacementLevelBySide = new Map();
    this.deferredRepriceNeeded = false;
    this.lastMarketableAloSkip = null;
    // Balance-safety gate: pure placements skipped while same-side cancels in flight
    this.placementsDeferredForCancels = 0;
    // Momentum reprice (task 0010): mid at the last dispatched reprice — reference
    // for the debounce-bypass trigger; count of momentum-triggered bypasses.
    this.lastRepricedMid = 0;
    this.momentumReprices = 0;
    // True while a gated placement awaits its cancel confirm. Completion
    // retries go through _runDeferredReprice, where the flag exempts that one
    // path from the minRepriceInterval debounce; the ordinary onPriceUpdate
    // path stays debounced (no global bypass, no extra churn while the cancel
    // ack is slow).
    this.heldPlacementsPending = false;
    this.truexBook = null;
    this.truexEbbo = null;
    this.truexEbboGeneration = { buy: 0, sell: 0 };
    this.lastValidTruexEbboTouch = null;
    this.aloRetryInhibitions = new Map();
    this.pyusdUsd = null;
    this.takerWindowStartedAt = Date.now();
    this.takerOrdersThisWindow = 0;
    this.takerNotionalThisWindow = 0;
    this.shadowState = {
      activeCandidate: null,
      lastLoggedCandidate: null,
      pendingAttribution: null,
    };

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

  updateTruexEbbo(book) {
    if (!book) return;
    const prior = this.truexEbbo;
    const receivedAt = this.now();
    const observationNumber = (value) =>
      value === null || value === undefined || String(value).trim() === '' ? null : Number(value);
    const bestBid = observationNumber(book.bestBid);
    const bestAsk = observationNumber(book.bestAsk);
    const candidate = {
      bestBid,
      bestAsk,
      bestBidQty: book.bestBidQty ?? null,
      bestAskQty: book.bestAskQty ?? null,
      bestBidOrderCount: book.bestBidOrderCount ?? null,
      bestAskOrderCount: book.bestAskOrderCount ?? null,
      lastTradePrice: book.lastTradePrice ?? null,
      lastTradeQty: book.lastTradeQty ?? null,
      lastTradeTs: book.lastTradeTs ?? null,
      // Venue/source time is retained for provenance. Receipt/observation time is always
      // stamped here; a caller-supplied receivedAt is intentionally ignored.
      timestamp: book.timestamp,
      sourceTimestamp: book.timestamp,
      receivedAt,
      observationTimestamp: receivedAt,
    };
    const validObservation = this._validateStrictEbboObservation(candidate);
    const bidChanged = validObservation &&
      (!this.lastValidTruexEbboTouch || this.lastValidTruexEbboTouch.bestBid !== bestBid);
    const askChanged = validObservation &&
      (!this.lastValidTruexEbboTouch || this.lastValidTruexEbboTouch.bestAsk !== bestAsk);
    if (askChanged) this.truexEbboGeneration.buy++;
    if (bidChanged) this.truexEbboGeneration.sell++;
    if (validObservation) this.lastValidTruexEbboTouch = { bestBid, bestAsk };
    this.truexEbbo = candidate;
    if (this.config.strictTruexMakerSafety &&
        (bidChanged || askChanged || (!this._strictEbboState(prior).usable && validObservation))) {
      this.deferredRepriceNeeded = true;
    }
  }

  updatePyusdUsd(reference) {
    if (!reference) return;
    this.pyusdUsd = {
      price: reference.price ?? null,
      bid: reference.bid ?? null,
      ask: reference.ask ?? null,
      timestamp: reference.timestamp ?? null,
      source: reference.source ?? null,
      pair: reference.pair ?? null,
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
    this.heldPlacementsPending = false;
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
    this._refreshContinuityState();
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
    let momentumBypass = false;
    let momentumMoveBps = 0;

    // Rejection backoff: pause quoting after consecutive rejects
    if (this.rejectBackoffUntil > now) {
      return;
    }
    if (this.config.minRepriceIntervalMs > 0 &&
        this.lastRepriceAt &&
        (now - this.lastRepriceAt) < this.config.minRepriceIntervalMs) {
      // Inside the debounce window. Momentum bypass: if the mid has moved
      // >= momentumRepriceBps since the last dispatched reprice, stale quotes
      // are exposed to lead-lag pick-off — reprice now instead of waiting out
      // the interval. Each dispatched reprice re-baselines lastRepricedMid, so
      // this fires per N bps of movement, not per tick.
      // heldPlacementsPending deliberately does NOT bypass here: completion
      // retries flow through drainQueue → _runDeferredReprice (which carries
      // the hold exemption). A global bypass would churn unrelated
      // cancels/replaces on every tick during the hold window.
      const moveBps = this.lastRepricedMid > 0
        ? Math.abs(mid - this.lastRepricedMid) / this.lastRepricedMid * 1e4
        : 0;
      momentumBypass = this.config.momentumRepriceBps > 0 &&
        this.lastRepricedMid > 0 &&
        moveBps >= this.config.momentumRepriceBps;
      if (!momentumBypass) {
        return;
      }
      // Count/log only after a successful dispatch (below): a bypassed cycle
      // that dispatches nothing must not inflate the counter or re-log on
      // every tick while the reference stays unchanged.
      momentumMoveBps = moveBps;
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
    // Stamp on any cycle that dispatched, regardless of held placements. Gating
    // the stamp on heldPlacementsPending would leave lastRepriceAt stale during
    // intra-cycle holds (a same-side replacement-cancel marks its order
    // 'cancelling' before later same-side placements are evaluated), which
    // implicitly disables this debounce for every tick until a hold clears.
    // The completion-retry exemption lives solely in _runDeferredReprice's
    // heldPlacementsPending check.
    if (dispatched) {
      this.lastRepriceAt = Date.now();
      this.lastRepricedMid = mid;
      if (momentumBypass) {
        this.momentumReprices++;
        this.logger.info(
          `[QuoteEngine] Momentum reprice: move ${momentumMoveBps.toFixed(1)}bps >= ${this.config.momentumRepriceBps}bps since last reprice (lifetime=${this.momentumReprices})`
        );
      }
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

    const degraded = this.continuityState.executionState === 'degraded';
    const effectiveLevels = degraded ? Math.min(levels, this.config.degradedMaxLevels) : levels;
    const effectiveSpreadBps = degraded
      ? Math.max(baseSpreadBps, this.config.defensiveSpreadFloorBps)
      : baseSpreadBps;
    const effectiveSizeFactor = degraded ? this.config.degradedSizeFactor : 1;
    const halfSpread = (effectiveSpreadBps / 10000) * mid / 2;

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
    const recordDegradedOmission = (side, level, cause) => {
      if (!degraded) return;
      this._recordSuppression(
        { side, level, cause, transition: 'degraded-quote-omitted' },
        `degraded-${cause}`,
      );
    };

    // Track cumulative committed balance: start from what's already committed in active orders
    // This prevents double-commitment when orders from previous reprice are still live
    let bidCommittedQuote = 0;
    let askCommittedBase = 0;
    if (!this.capitalReservationManager) {
      for (const [, order] of this.activeOrders) {
        if (order.status === 'active' || order.status === 'pending') {
          if (order.side === 'buy') {
            bidCommittedQuote += order.size * order.price;
          } else if (order.side === 'sell') {
            askCommittedBase += order.size;
          }
        }
      }
    }

    for (let level = 1; level <= effectiveLevels; level++) {
      const levelOffset = this._getLevelOffset(mid, level, levelSpacingTicks, tickSize);
      const rawSize = baseSizeBTC * effectiveSizeFactor * Math.pow(sizeDecayFactor, level - 1);
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
      if (degraded) {
        rawBid = Math.min(rawBid, mid - halfSpread - levelOffset);
        rawAsk = Math.max(rawAsk, mid + halfSpread + levelOffset);
      }
      const bidPrice = this.snapToTick(rawBid);
      const askPrice = this.snapToTick(rawAsk);

      // Filter bids — cap size to remaining available quote balance
      if (!this._canQuoteSide('buy')) {
        recordDegradedOmission('buy', level, 'can-quote-disabled');
      } else if (!this.withinPriceBand(bidPrice, mid)) {
        recordDegradedOmission('buy', level, 'price-band');
      } else if (bidPrice * size < minNotional) {
        recordDegradedOmission('buy', level, 'minimum-notional');
      } else {
        const cappedBidSize = this._capSizeToBalance('buy', size, bidPrice, bidCommittedQuote, level);
        if (cappedBidSize >= this.config.minimumFundedQuoteSize && bidPrice * cappedBidSize >= minNotional) {
          bids.push({ side: 'buy', price: bidPrice, size: cappedBidSize, level });
          bidCommittedQuote += cappedBidSize * bidPrice;
        } else if (cappedBidSize < this.config.minimumFundedQuoteSize) {
          recordDegradedOmission(
            'buy', level,
            cappedBidSize + 1e-12 < size ? 'balance-cap-below-minimum-size' : 'minimum-funded-size',
          );
        } else {
          recordDegradedOmission('buy', level, 'minimum-notional-after-cap');
        }
      }

      // Filter asks — cap size to remaining available base balance
      if (!this._canQuoteSide('sell')) {
        recordDegradedOmission('sell', level, 'can-quote-disabled');
      } else if (!this.withinPriceBand(askPrice, mid)) {
        recordDegradedOmission('sell', level, 'price-band');
      } else if (askPrice * size < minNotional) {
        recordDegradedOmission('sell', level, 'minimum-notional');
      } else {
        const cappedAskSize = this._capSizeToBalance('sell', size, askPrice, askCommittedBase, level);
        if (cappedAskSize >= this.config.minimumFundedQuoteSize && askPrice * cappedAskSize >= minNotional) {
          asks.push({ side: 'sell', price: askPrice, size: cappedAskSize, level });
          askCommittedBase += cappedAskSize;
        } else if (cappedAskSize < this.config.minimumFundedQuoteSize) {
          recordDegradedOmission(
            'sell', level,
            cappedAskSize + 1e-12 < size ? 'balance-cap-below-minimum-size' : 'minimum-funded-size',
          );
        } else {
          recordDegradedOmission('sell', level, 'minimum-notional-after-cap');
        }
      }
    }

    if (degraded) {
      for (let omittedLevel = effectiveLevels + 1; omittedLevel <= levels; omittedLevel++) {
        for (const side of ['buy', 'sell']) {
          this._recordSuppression(
            { side, level: omittedLevel, cause: 'maximum-depth', transition: 'degraded-quote-omitted' },
            'degraded-max-levels',
          );
        }
      }
    }
    const desired = [...bids, ...asks];
    return degraded
      ? desired.map((quote) => ({
          ...quote,
          executionState: 'degraded',
          controlReasons: ['degraded-size-factor', 'defensive-spread-floor'],
        }))
      : desired;
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
    this._refreshContinuityState();
    // Reset rate counter if a second has passed
    const now = Date.now();
    if (now - this.lastActionReset >= 1000) {
      this.actionsThisSecond = 0;
      this.lastActionReset = now;
    }

    const hasAuthoritativePresence = Boolean(this.capitalReservationManager);
    const authoritativePresence = this.capitalReservationManager?.getPresence() || { buy: 0, sell: 0 };
    const absentSides = new Set(
      ['buy', 'sell'].filter((side) =>
        hasAuthoritativePresence && this.config.minActiveLevelsPerSide > 0 &&
          authoritativePresence[side] < this.config.minActiveLevelsPerSide)
    );

    // Build ordered action list. TrueX default is passive-safe because ALO
    // replacements that cross the book are cancelled/rejected by the venue.
    const orderedActions = [];
    const enforcePresenceFloor = this.continuityState.executionState !== 'unsafe';

    const projectedSafeLevels = { buy: new Set(), sell: new Set() };
    for (const reservation of this.capitalReservationManager?.getReservations?.() || []) {
      if (reservation.acknowledgedLive && Number.isInteger(reservation.level) && reservation.level > 0) {
        projectedSafeLevels[reservation.side]?.add(reservation.level);
      }
    }
    for (const c of actions.toCancel) {
      const side = c.order?.side;
      const level = c.order?.level;
      const safeSide = absentSides.size > 0 && side && !absentSides.has(side);
      const removesUniqueLevel = Boolean(side && projectedSafeLevels[side]?.has(level));
      const preserveSafeL1 = enforcePresenceFloor && (
        (hasAuthoritativePresence && removesUniqueLevel &&
          projectedSafeLevels[side].size <= this.config.minActiveLevelsPerSide) ||
        (absentSides.size > 0 && level === 1)
      );
      if (preserveSafeL1) {
        this._recordSuppression(
          c.order,
          absentSides.size > 0 ? 'degraded-preserve-safe-l1' : 'presence-floor-preserved',
        );
        this.deferredRepriceNeeded = true;
        continue;
      }
      if (removesUniqueLevel) projectedSafeLevels[side].delete(level);
      orderedActions.push({ type: 'cancel', clOrdID: c.clOrdID, order: c.order });
    }

    if (this.config.replaceMode === 'place-before-cancel' && !hasAuthoritativePresence &&
        !this.config.strictTruexMakerSafety) {
      for (const r of actions.toReplace) {
        orderedActions.push({ type: 'place', quote: { ...r.place, replacesQuoteId: r.cancel } });
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
        const level = r.cancelOrder?.level || r.place?.level;
        const liveOnSide = liveCountsBySide.get(side) || 0;
        const initialLiveOnSide = initialLiveCountsBySide.get(side) || 0;
        const inflightOnSide = inflightCountsBySide.get(side) || 0;
        const replacementsOnSide = replacementCountsBySide.get(side) || 0;
        const safeSide = absentSides.size > 0 && side && !absentSides.has(side);
        const removesSafeLevel = Boolean(side && projectedSafeLevels[side]?.has(level));
        if ((enforcePresenceFloor && hasAuthoritativePresence && removesSafeLevel &&
              projectedSafeLevels[side].size <= this.config.minActiveLevelsPerSide) ||
            (absentSides.size > 0 && level === 1)) {
          this._recordSuppression(
            r.cancelOrder || r.place,
            level === 1 ? 'degraded-preserve-funded-l1' : 'degraded-preserve-safe-level',
          );
          this.deferredRepriceNeeded = true;
          continue;
        }
        const singleQuoteException = !hasAuthoritativePresence && absentSides.size === 0 &&
          this.config.minActiveLevelsPerSide === 1 &&
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
        if (removesSafeLevel) projectedSafeLevels[side].delete(level);
        liveCountsBySide.set(side, liveOnSide - 1);
        replacementCountsBySide.set(side, replacementsOnSide + 1);
      }
    }

    const placements = [...actions.toPlace].sort((left, right) => {
      const leftAbsentL1 = absentSides.has(left.side) && left.level === 1 ? 0 : 1;
      const rightAbsentL1 = absentSides.has(right.side) && right.level === 1 ? 0 : 1;
      return leftAbsentL1 - rightAbsentL1 || left.level - right.level;
    });
    for (const p of placements) {
      if (absentSides.has(p.side) && p.level > this.config.degradedMaxLevels) {
        this._recordSuppression(p, 'degraded-missing-side-depth-suppressed');
        this.deferredRepriceNeeded = true;
        continue;
      }
      orderedActions.push({ type: 'place', quote: p });
    }

    let dispatched = false;
    let deferredThisCycle = 0;
    for (const action of orderedActions) {
      if (action.type === 'replacement-cancel' && this.config.strictTruexMakerSafety) {
        const ebboState = this._strictEbboState();
        if (!ebboState.usable) {
          this._recordSuppression(action.quote || action.order, ebboState.reason);
          this.deferredRepriceNeeded = true;
          continue;
        }
      }
      if (this.continuityState.executionState === 'unsafe' && action.type !== 'cancel') {
        this._recordSuppression(action.quote || action.order, 'unsafe-execution-gate');
        this.deferredRepriceNeeded = false;
        continue;
      }
      // Balance-safety gate: a pure placement must not go out while a same-side
      // cancel is still in flight — the venue holds those funds until the cancel
      // is processed, so the new order could exceed available balance and be
      // rejected (Insufficient balance). Skipped placements are re-derived by the
      // next reprice with fresh prices. Replacement placements are unaffected
      // (they flush only after cancel confirm via pendingReplacements).
      if (this._shouldHoldPlacement(action)) {
        this.placementsDeferredForCancels++;
        deferredThisCycle++;
        this.deferredRepriceNeeded = true;
        continue;
      }

      if (this.actionsThisSecond >= this.config.maxOrdersPerSecond) {
        if (action.type === 'replacement-cancel') {
          this.deferredRepriceNeeded = true;
          this.emit('rate-limited', { action: action.type, queueDepth: this.actionQueue.length });
          continue;
        }
        if (this.capitalReservationManager && action.type === 'cancel') {
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

      if (this._dispatchAction(action) === false) continue;
      this.actionsThisSecond++;
      dispatched = true;
    }
    if (deferredThisCycle > 0) {
      this.heldPlacementsPending = true;
      this.logger.info(
        `[QuoteEngine] Deferred ${deferredThisCycle} placement(s) pending same-side cancel confirms (lifetime=${this.placementsDeferredForCancels})`
      );
    } else {
      // Nothing held this cycle — any previously pending hold is resolved
      this.heldPlacementsPending = false;
    }
    return dispatched;
  }

  /**
   * Dispatch a single action to FIX connection.
   */
  _dispatchAction(action) {
    this._refreshContinuityState();
    if (action.type === 'replacement-cancel' &&
        this.activeOrders.get(action.clOrdID)?.dispatchOutcomeUnknown) return false;
    if (this.continuityState.executionState === 'unsafe' && action.type !== 'cancel') {
      this._recordSuppression(action.quote || action.order, 'unsafe-execution-gate');
      return false;
    }
    if (action.type === 'cancel') {
      return this._sendCancel(action.clOrdID, action.order) !== false;
    } else if (action.type === 'replacement-cancel') {
      if (this.config.strictTruexMakerSafety && !this._prepareStrictMakerQuote(action.quote)) {
        this.deferredRepriceNeeded = true;
        return false;
      }
      const hadPending = this.pendingReplacements.has(action.clOrdID);
      const priorPending = this.pendingReplacements.get(action.clOrdID);
      const priorReplacementSide = this.lastReplacementSide;
      const replacementSide = action.order?.side;
      const hadReplacementLevel = this.lastReplacementLevelBySide.has(replacementSide);
      const priorReplacementLevel = this.lastReplacementLevelBySide.get(replacementSide);
      const restoreReplacementIntent = () => {
        if (hadPending) this.pendingReplacements.set(action.clOrdID, priorPending);
        else this.pendingReplacements.delete(action.clOrdID);
        this.lastReplacementSide = priorReplacementSide;
        if (hadReplacementLevel) this.lastReplacementLevelBySide.set(replacementSide, priorReplacementLevel);
        else this.lastReplacementLevelBySide.delete(replacementSide);
        this.deferredRepriceNeeded = true;
      };
      this.pendingReplacements.set(action.clOrdID, {
        quote: { ...action.quote, replacesQuoteId: action.clOrdID }, createdAt: Date.now(),
      });
      this.lastReplacementSide = replacementSide || null;
      this.lastReplacementLevelBySide.set(replacementSide, action.order?.level || 0);
      try {
        if (this._sendCancel(action.clOrdID, action.order) === false) {
          restoreReplacementIntent();
          return false;
        }
      } catch (error) {
        restoreReplacementIntent();
        throw error;
      }
      return true;
    } else if (action.type === 'place') {
      return Boolean(this._sendNewOrder(action.quote));
    }
    return false;
  }

  /**
   * Balance-safety gate: true when a pure placement must wait because a
   * same-side cancel is still in flight ('cancelling' in activeOrders).
   * Derived from order state on purpose — no separate counters to leak when
   * acks are lost; existing cancel-timeout/orphan recovery heals the state.
   * Bypassed in place-before-cancel mode (that mode intentionally places first).
   */
  _shouldHoldPlacement(action) {
    if (action.type !== 'place') return false;
    if (this.config.replaceMode === 'place-before-cancel') return false;
    const side = action.quote?.side;
    if (!side) return false;
    return this._hasInflightCancels(side);
  }

  _hasInflightCancels(side) {
    for (const [, order] of this.activeOrders) {
      if (order.side === side && order.status === 'cancelling') return true;
    }
    return false;
  }

  /**
   * Send a FIX New Order Single (35=D).
   */
  _sendNewOrder(quote) {
    this._refreshContinuityState();
    if (this.continuityState.executionState === 'unsafe') {
      this._recordSuppression(quote, 'unsafe-execution-gate');
      return null;
    }
    const prepared = this._prepareQuoteForSend(quote);
    if (!prepared) return null;

    const clOrdID = this.generateClOrdID();
    if (this.capitalReservationManager) {
      const reservation = this.capitalReservationManager.reserve({
        orderId: clOrdID,
        side: prepared.side,
        price: prepared.price,
        size: prepared.size,
        level: prepared.level,
        replacesOrderId: prepared.replacesQuoteId || null,
      });
      if (!reservation.accepted) {
        this._recordSuppression(prepared, reservation.reason);
        return null;
      }
    }
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
    if (this.config.selfMatchPreventionInstruction !== null &&
        this.config.selfMatchPreventionInstruction !== undefined) {
      fields['2964'] = String(this.config.selfMatchPreventionInstruction);
    }

    // TrueX Party ID block — required for order entry
    if (this.config.clientId) {
      fields['453'] = '1';                  // NoPartyIDs
      fields['448'] = this.config.clientId; // PartyID (TrueX client ID)
      fields['452'] = '3';                  // PartyRole (3 = Client ID)
    }

    const placedAt = Date.now();
    this.activeOrders.set(clOrdID, {
      side: quote.side,
      price: prepared.price,
      size: prepared.size,
      level: prepared.level,
      status: 'pending',
      acknowledgedLive: false,
      placedAt,
      decisionTimestamp: placedAt,
      orderIntent: prepared.orderIntent || (prepared.postOnly === false ? 'taker_opportunity' : 'maker_quote'),
      liquidityRoleExpected: prepared.postOnly === false ? 'taker' : 'maker',
    });
    // Everything above may invoke injected synchronous code (notably capital reserve). Recheck
    // the exact prepared price immediately at the transport boundary; never re-slide here because
    // fields and capital were built for this price.
    if (!this._isPreparedQuoteSendableNow(prepared)) {
      this._rollbackUnsentNewOrder(clOrdID);
      this.deferredRepriceNeeded = true;
      return null;
    }

    if (this.fixConnection) {
      let dispatchAccepted;
      try {
        dispatchAccepted = this.fixConnection.sendMessage(fields);
      } catch (error) {
        this._rollbackUnsentNewOrder(clOrdID);
        throw error;
      }
      if (dispatchAccepted === false) {
        this._rollbackUnsentNewOrder(clOrdID);
        this.deferredRepriceNeeded = true;
        return null;
      }
      if (this.config.strictTruexMakerSafety && dispatchAccepted?.then) {
        // Strict production adapters must implement the synchronous FIX enqueue
        // contract. Contain a legacy Promise rejection and retain the reservation
        // conservatively because dispatch outcome is unknowable at this boundary.
        void Promise.resolve(dispatchAccepted).catch((error) => {
          try { this.logger.error(`[QuoteEngine] Async FIX dispatch contract violation: ${error.message}`); } catch (_) {}
        });
        const reason = 'async-new-dispatch-outcome-unknown';
        const transitioned = this.capitalReservationManager?.dispatchOutcomeUnknown
          ? this.capitalReservationManager.dispatchOutcomeUnknown(clOrdID, reason)
          : (this.capitalReservationManager?.failClosedForEvidenceGap?.(clOrdID, reason) || false);
        this._failClosedExecutionEvidence(clOrdID, reason, {
          authoritative: Boolean(this.capitalReservationManager),
        });
        if (!transitioned || !this._emitCapitalEvidenceGap(clOrdID)) {
          this._emitCapitalResyncRequired({ side: prepared.side, reason, orderId: clOrdID });
        }
        this.deferredRepriceNeeded = true;
        return null;
      }
    }
    this.lastActionByClOrdID.set(clOrdID, Date.now());
    this.emit('quote-lifecycle', {
      eventType: prepared.replacesQuoteId ? 'replace' : 'create', quoteId: clOrdID,
      replacesQuoteId: prepared.replacesQuoteId || null, side: prepared.side, price: prepared.price,
      size: prepared.size, level: prepared.level, action: prepared.replacesQuoteId ? 'replace' : 'place',
      decisionTimestamp: placedAt,
    });
    if (prepared.postOnly === false) {
      this._recordTakerOrder(prepared.size * prepared.price);
    }
    return clOrdID;
  }

  _rollbackUnsentNewOrder(clOrdID) {
    this.activeOrders.delete(clOrdID);
    this.lastActionByClOrdID.delete(clOrdID);
    this._clearExecutionIdentity(clOrdID);
    if (this.capitalReservationManager?.newDispatchAborted) {
      this.capitalReservationManager.newDispatchAborted(clOrdID);
    } else {
      this.capitalReservationManager?.rejected(clOrdID);
    }
  }

  _isPreparedQuoteSendableNow(prepared) {
    this._refreshContinuityState();
    if (this.continuityState.executionState === 'unsafe') {
      this._recordSuppression(prepared, 'unsafe-execution-gate');
      return false;
    }
    if (!this.config.strictTruexMakerSafety) return true;
    const state = this._strictEbboState();
    if (!state.usable) {
      this._recordSuppression(prepared, state.reason);
      return false;
    }
    if (prepared.postOnly === false) return true;
    if (this._isAloRetryInhibited(prepared)) {
      this._recordSuppression(prepared, 'alo-retry-inhibited');
      return false;
    }
    const marketable = prepared.side === 'buy'
      ? prepared.price >= state.book.bestAsk
      : prepared.price <= state.book.bestBid;
    if (marketable) {
      this._recordSuppression(prepared, 'marketable-post-only');
      return false;
    }
    if (this._wouldSelfCrossTrackedOrder(prepared)) {
      this._recordSuppression(prepared, 'self-cross-tracked-order');
      return false;
    }
    return true;
  }

  /**
   * Send a FIX Order Cancel Request (35=F).
   */
  _sendCancel(origClOrdID, order) {
    const alreadyUnknown = this.activeOrders.get(origClOrdID)?.dispatchOutcomeUnknown;
    if (alreadyUnknown) return false;
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
    const priorLocal = activeOrder ? {
      hadStatus: Object.prototype.hasOwnProperty.call(activeOrder, 'status'),
      status: activeOrder.status,
      hadCancellingAt: Object.prototype.hasOwnProperty.call(activeOrder, 'cancellingAt'),
      cancellingAt: activeOrder.cancellingAt,
    } : null;
    const priorCapital = this.capitalReservationManager?.getReservation(origClOrdID) || null;
    if (activeOrder) {
      activeOrder.status = 'cancelling';
      // A cancel request does not make an acknowledged order disappear from the venue.
      // Presence clears only on a terminal report or fresh REST absence.
      activeOrder.cancellingAt = Date.now();
    }
    const capitalTransitioned = this.capitalReservationManager?.cancelRequested(origClOrdID) || false;

    // Track cancel ClOrdID → original ClOrdID for exec report matching
    const hadCancelMapping = this.cancelToOrigMap.has(newClOrdID);
    const priorCancelMapping = this.cancelToOrigMap.get(newClOrdID);
    this.cancelToOrigMap.set(newClOrdID, origClOrdID);

    const rollbackDispatch = () => {
      if (activeOrder && this.activeOrders.get(origClOrdID) === activeOrder) {
        if (priorLocal.hadStatus) activeOrder.status = priorLocal.status;
        else delete activeOrder.status;
        if (priorLocal.hadCancellingAt) activeOrder.cancellingAt = priorLocal.cancellingAt;
        else delete activeOrder.cancellingAt;
      }
      if (capitalTransitioned) {
        this.capitalReservationManager.cancelDispatchFailed(origClOrdID, priorCapital?.state);
      }
      if (hadCancelMapping) this.cancelToOrigMap.set(newClOrdID, priorCancelMapping);
      else this.cancelToOrigMap.delete(newClOrdID);
    };
    if (this.fixConnection) {
      let dispatchAccepted;
      try {
        dispatchAccepted = this.fixConnection.sendMessage(fields);
      } catch (error) {
        rollbackDispatch();
        throw error;
      }
      if (dispatchAccepted === false) {
        rollbackDispatch();
        return false;
      }
      if (this.config.strictTruexMakerSafety && dispatchAccepted?.then) {
        void Promise.resolve(dispatchAccepted).catch((error) => {
          try {
            this.logger.error(`[QuoteEngine] Async FIX cancel outcome unknown: ${error.message}`);
          } catch (_) {}
        });
        if (activeOrder) activeOrder.dispatchOutcomeUnknown = true;
        const reason = 'async-cancel-dispatch-outcome-unknown';
        const transitioned = this.capitalReservationManager?.failClosedForEvidenceGap?.(
          origClOrdID, reason,
        ) || false;
        this._failClosedExecutionEvidence(origClOrdID, reason, {
          authoritative: Boolean(this.capitalReservationManager),
        });
        if (!transitioned || !this._emitCapitalEvidenceGap(origClOrdID)) {
          this._emitCapitalResyncRequired({ side: order?.side, reason, orderId: origClOrdID });
        }
        this.deferredRepriceNeeded = true;
        return true;
      }
    }

    this.lastActionByClOrdID.set(origClOrdID, Date.now());
    this.emit('quote-lifecycle', {
      eventType: 'cancel', quoteId: origClOrdID, orderId: newClOrdID,
      side: order?.side, price: order?.price, size: order?.size, level: order?.level,
      action: 'cancel', reason: 'reprice_or_cancel',
    });
    return true;
  }

  /**
   * Handle inbound execution reports from FIX.
   */
  _emitFillEvent(resolvedClOrdID, side, price, size, execID, metadata = {}) {
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
      ...metadata,
    });
    return tracked;
  }

  _emitCapitalEvidenceGap(orderId) {
    const gap = this.capitalReservationManager?.takeEvidenceGap?.();
    if (!gap) return false;
    return this._emitCapitalResyncRequired({ ...gap, orderId });
  }

  _emitCapitalResyncRequired(event) {
    try {
      this.emit('capital-resync-required', event);
      return true;
    } catch (error) {
      try { this.logger.error(`[QuoteEngine] Capital resync observer failed: ${error.message}`); } catch (_) {}
      return false;
    }
  }

  setContinuityState(status = {}) {
    const executionState = ['normal', 'degraded', 'unsafe'].includes(status.executionState)
      ? status.executionState
      : 'unsafe';
    this.continuityState = Object.freeze({
      executionState,
      reasons: Object.freeze(Array.isArray(status.reasons) ? [...status.reasons] : ['invalid-continuity-state']),
      activeLevels: status.activeLevels ? Object.freeze({ ...status.activeLevels }) : undefined,
    });
  }

  setContinuityStateProvider(provider) {
    this.continuityStateProvider = typeof provider === 'function' ? provider : null;
  }

  _refreshContinuityState() {
    if (this.executionEvidenceGap) {
      this.setContinuityState({
        executionState: 'unsafe',
        reasons: ['execution-evidence-gap', this.executionEvidenceGap.reason],
      });
      return this.continuityState;
    }
    if (!this.continuityStateProvider) return this.continuityState;
    try {
      const status = this.continuityStateProvider();
      if (!status || typeof status.then === 'function') throw new Error('continuity provider must be synchronous');
      this.setContinuityState(status);
    } catch (error) {
      this.setContinuityState({ executionState: 'unsafe', reasons: ['continuity-state-provider-failed'] });
      this.logger.error(`[QuoteEngine] Continuity provider failed closed: ${error.message}`);
    }
    return this.continuityState;
  }

  getContinuityState() {
    return this.continuityState;
  }

  onExecutionReport(fields) {
    if (!fields) return;

    const clOrdID = fields['11'];
    const ordStatus = fields['39'];
    const execID = fields['17'];
    const lastPx = parseFloat(fields['31'] || fields['44'] || '0');
    const lastQty = fields['32'] ? parseFloat(fields['32']) : null;
    // Resolve cancel ClOrdID → original ClOrdID if this is a cancel ack
    const origClOrdID = this.cancelToOrigMap.get(clOrdID);
    const reportedOrigClOrdID = typeof fields['41'] === 'string' && fields['41'] ? fields['41'] : null;
    if (origClOrdID && reportedOrigClOrdID && reportedOrigClOrdID !== origClOrdID) {
      this.capitalReservationManager?.failClosedForEvidenceGap?.(
        origClOrdID, 'cancel-ack-identity-mismatch',
      );
      this._failClosedExecutionEvidence(origClOrdID, 'cancel-ack-identity-mismatch', {
        authoritative: Boolean(this.capitalReservationManager),
      });
      this._emitCapitalResyncRequired({
        orderId: origClOrdID,
        side: this.activeOrders.get(origClOrdID)?.side,
        reason: 'cancel-ack-identity-mismatch',
      });
      return;
    }
    const resolvedClOrdID = origClOrdID || clOrdID;
    const side = this.activeOrders.get(resolvedClOrdID)?.side || (fields['54'] === '1' ? 'buy' : 'sell');
    if (!this.capitalReservationManager && (ordStatus === '1' || ordStatus === '2')) {
      if (this.executionEvidenceGap) return;
      if (this.terminalExecutionOrders.has(resolvedClOrdID)) return;
      if (!this.activeOrders.has(resolvedClOrdID)) return;
      if (!execID) {
        this._failClosedExecutionEvidence(resolvedClOrdID, 'execution-id-required');
        return;
      }
      const identity = this.executionDedupeByOrder.get(resolvedClOrdID);
      if (identity?.terminal || (execID && identity?.execIDs.has(execID))) return;
      if (identity && identity.execIDs.size >= this.maxExecutionIdsPerOrder) {
        this._failClosedExecutionEvidence(resolvedClOrdID, 'execution-id-capacity-exceeded');
        return;
      }
      if (!identity && this.executionDedupeByOrder.size >= this.maxExecutionDedupeOrders) {
        this._failClosedExecutionEvidence(resolvedClOrdID, 'execution-order-capacity-exceeded');
        return;
      }
      if (ordStatus === '2') {
        const previousRemaining = Number(this.activeOrders.get(resolvedClOrdID)?.size);
        const rawLeaves = fields['151'];
        const leavesSupplied = rawLeaves !== undefined;
        const parsedLeaves = leavesSupplied && String(rawLeaves).trim() !== '' ? Number(rawLeaves) : NaN;
        if (!Number.isFinite(previousRemaining) || previousRemaining <= 0) {
          this._failClosedExecutionEvidence(resolvedClOrdID, 'invalid-terminal-remaining-quantity');
          return;
        }
        if (leavesSupplied && (!Number.isFinite(parsedLeaves) || parsedLeaves !== 0)) {
          this._failClosedExecutionEvidence(resolvedClOrdID, 'invalid-terminal-leaves-quantity');
          return;
        }
        const quantityProvesTerminal = Number.isFinite(lastQty) && lastQty > 0 &&
          Math.abs(lastQty - previousRemaining) <= 1e-10;
        const leavesProveTerminal = leavesSupplied && parsedLeaves === 0;
        if (!quantityProvesTerminal && !leavesProveTerminal) {
          this._failClosedExecutionEvidence(resolvedClOrdID, 'unproven-terminal-fill');
          return;
        }
      }
    }

    switch (ordStatus) {
      case '0': // New - order accepted
        this.consecutiveRejects = 0; // Reset backoff on success
        if (this.activeOrders.has(resolvedClOrdID)) {
          const tracked = this.activeOrders.get(resolvedClOrdID);
          if (tracked.status !== 'cancelling') tracked.status = 'active';
          tracked.acknowledgedLive = true;
        }
        this.capitalReservationManager?.accept(resolvedClOrdID);
        break;

      case '1': // Partially Filled — record the partial, keep the order live (reduced)
        this.consecutiveRejects = 0; // a fill means the order pipeline is healthy
        {
          const rawLeaves = fields['151'];
          const trackedBeforeFill = this.activeOrders.get(resolvedClOrdID);
          let parsedLeaves =
            rawLeaves !== undefined && String(rawLeaves).trim() !== '' ? Number(rawLeaves) : NaN;
          if (!this.capitalReservationManager) {
            const previousRemaining = Number(trackedBeforeFill?.size);
            if (!Number.isFinite(lastQty) || lastQty <= 0 || !Number.isFinite(previousRemaining) ||
                lastQty > previousRemaining + 1e-10) {
              this._failClosedExecutionEvidence(resolvedClOrdID, 'invalid-partial-last-quantity');
              break;
            }
            const expectedLeaves = Math.max(0, previousRemaining - lastQty);
            if (rawLeaves === undefined) {
              parsedLeaves = expectedLeaves;
            } else if (!Number.isFinite(parsedLeaves) || parsedLeaves < 0 ||
                parsedLeaves > previousRemaining + 1e-10 ||
                Math.abs(parsedLeaves - expectedLeaves) > 1e-10) {
              this._failClosedExecutionEvidence(resolvedClOrdID, 'inconsistent-partial-quantity');
              break;
            }
          }
          let effectiveLastQty = lastQty;
          let derivedQuantity = false;
          if ((!Number.isFinite(effectiveLastQty) || effectiveLastQty <= 0) && Number.isFinite(parsedLeaves)) {
            const remaining = this.capitalReservationManager?.getReservation(resolvedClOrdID)?.remainingSize ??
              trackedBeforeFill?.size;
            const derived = Number(remaining) - parsedLeaves;
            if (Number.isFinite(derived) && derived > 0) {
              effectiveLastQty = derived;
              derivedQuantity = true;
            }
          }
          if (!Number.isFinite(effectiveLastQty) || effectiveLastQty <= 0 ||
              !Number.isFinite(parsedLeaves) || parsedLeaves < 0) {
            if (!this.capitalReservationManager && Number.isFinite(lastQty) && lastQty > 0 && trackedBeforeFill) {
              const fallbackLeaves = Math.max(0, Number(trackedBeforeFill.size) - lastQty);
              const priceEstimated = !Number.isFinite(lastPx) || lastPx <= 0;
              const effectivePrice = priceEstimated ? Number(trackedBeforeFill.price) : lastPx;
              if (!Number.isFinite(effectivePrice) || effectivePrice <= 0) {
                this._failClosedExecutionEvidence(resolvedClOrdID, 'fill-price-evidence-gap');
                break;
              }
              const tracked = this._emitFillEvent(
                resolvedClOrdID, side, effectivePrice, lastQty, execID,
                priceEstimated ? { estimated: true, evidenceGap: true } : {},
              );
              this.emit('quote-lifecycle', {
                eventType: 'partial_fill', quoteId: resolvedClOrdID, executionId: execID, side,
                price: effectivePrice, size: lastQty, level: tracked?.level, action: 'partial_fill',
                decisionTimestamp: tracked?.decisionTimestamp ?? tracked?.placedAt ?? null,
                ...(priceEstimated ? { estimated: true, evidenceGap: true } : {}),
              });
              if (tracked) {
                tracked.size = fallbackLeaves;
                tracked.status = tracked.status === 'cancelling' ? 'cancelling' : 'active';
                tracked.acknowledgedLive = true;
              }
              this._recordExecutionIdentity(resolvedClOrdID, execID);
              break;
            }
            this.capitalReservationManager?.failClosedForEvidenceGap(resolvedClOrdID, 'partial-fill-evidence-gap');
            this._emitCapitalEvidenceGap(resolvedClOrdID);
            break;
          }
          const leavesQty = parsedLeaves;
          if (this.capitalReservationManager && !this.capitalReservationManager.fill({
            orderId: resolvedClOrdID,
            executionId: execID,
            quantity: effectiveLastQty,
            leavesQuantity: leavesQty,
          })) {
            this._emitCapitalEvidenceGap(resolvedClOrdID);
            break;
          }
          // The generic fill event is rewritten below so consumers receive an explicit lifecycle type.
          const fallbackPrice = Number(trackedBeforeFill?.price) ||
            Number(this.capitalReservationManager?.getReservation(resolvedClOrdID)?.price);
          const priceEstimated = !Number.isFinite(lastPx) || lastPx <= 0;
          const effectivePrice = priceEstimated ? fallbackPrice : lastPx;
          const estimatedEvidence = derivedQuantity || priceEstimated;
          if (!Number.isFinite(effectivePrice) || effectivePrice <= 0) {
            if (this.capitalReservationManager) {
              this.capitalReservationManager.failClosedForEvidenceGap(resolvedClOrdID, 'fill-price-evidence-gap');
              this._emitCapitalEvidenceGap(resolvedClOrdID);
            } else {
              this._failClosedExecutionEvidence(resolvedClOrdID, 'fill-price-evidence-gap');
            }
            break;
          }
          const tracked = this._emitFillEvent(
            resolvedClOrdID, side, effectivePrice, effectiveLastQty, execID,
            estimatedEvidence ? { estimated: true, evidenceGap: true } : {},
          );
          this.emit('quote-lifecycle', {
            eventType: 'partial_fill', quoteId: resolvedClOrdID, executionId: execID, side,
            price: effectivePrice, size: effectiveLastQty, level: tracked?.level, action: 'partial_fill',
            decisionTimestamp: tracked?.decisionTimestamp ?? tracked?.placedAt ?? null,
            ...(estimatedEvidence ? { estimated: true, evidenceGap: true } : {}),
          });
          if (tracked) {
            // Remaining size = LeavesQty (tag 151) when it is a strictly-numeric value, else
            // subtract LastQty. Strict Number() (not parseFloat) rejects partial garbage like
            // '0.007foo'; the trim guard rejects absent/empty/whitespace (Number('') === 0).
            tracked.size = Math.max(0, leavesQty);
            // A fill proves the order is live, so promote 'pending' → 'active'. But preserve
            // 'cancelling' so reconcileOrders doesn't double-act on an in-flight cancel.
            tracked.status = tracked.status === 'cancelling' ? 'cancelling' : 'active';
            tracked.acknowledgedLive = true;
          }
          if (!this.capitalReservationManager) this._recordExecutionIdentity(resolvedClOrdID, execID);
        }
        break;

      case '2': // Filled — record the fill and remove the order
        this.consecutiveRejects = 0;
        if (this.capitalReservationManager) {
          const reservation = this.capitalReservationManager.getReservation(resolvedClOrdID);
          const preTerminalRemaining = reservation?.remainingSize;
          const fallbackPrice = Number(this.activeOrders.get(resolvedClOrdID)?.price) || Number(reservation?.price);
          const priceEstimated = !Number.isFinite(lastPx) || lastPx <= 0;
          const effectivePrice = priceEstimated ? fallbackPrice : lastPx;
          const rawTerminalLeaves = fields['151'];
          const terminalLeavesSupplied = rawTerminalLeaves !== undefined;
          const parsedTerminalLeaves = terminalLeavesSupplied && String(rawTerminalLeaves).trim() !== ''
            ? Number(rawTerminalLeaves)
            : NaN;
          const invalidSuppliedLeaves = terminalLeavesSupplied &&
            (!Number.isFinite(parsedTerminalLeaves) || parsedTerminalLeaves !== 0);
          const leavesProveTerminal = terminalLeavesSupplied && parsedTerminalLeaves === 0;
          const quantityProvesTerminal = lastQty && reservation &&
            Math.abs(lastQty - reservation.remainingSize) <= 1e-10;
          let applied = false;
          const quantityEvidenceGap = !Number.isFinite(lastQty) || lastQty <= 0 ||
            Math.abs(lastQty - preTerminalRemaining) > 1e-10;
          let terminalEvidenceGap = false;
          if (invalidSuppliedLeaves) {
            terminalEvidenceGap = true;
            applied = this.capitalReservationManager.terminalEvidenceGap(
              resolvedClOrdID, 'invalid-terminal-leaves-quantity',
            );
          } else if (!execID) {
            terminalEvidenceGap = true;
            applied = this.capitalReservationManager.terminalEvidenceGap(
              resolvedClOrdID, 'terminal-fill-execution-id-required',
            );
          } else if (leavesProveTerminal || quantityProvesTerminal) {
            applied = this.capitalReservationManager.fullFill(resolvedClOrdID, execID, {
              lastQuantity: lastQty,
              leavesQuantity: 0,
            });
          } else {
            terminalEvidenceGap = true;
            this.logger.warn(`[QuoteEngine] Ignoring unproven full fill without LastQty or LeavesQty=0: clOrdID=${resolvedClOrdID}`);
            applied = this.capitalReservationManager.terminalEvidenceGap(
              resolvedClOrdID, 'unproven-terminal-fill',
            );
          }
          this._emitCapitalEvidenceGap(resolvedClOrdID);
          if (!applied) break;
          if (preTerminalRemaining > 0 && effectivePrice > 0) {
            const estimatedEvidence = terminalEvidenceGap || !execID || quantityEvidenceGap || priceEstimated;
            const tracked = this._emitFillEvent(
              resolvedClOrdID, side, effectivePrice, preTerminalRemaining,
              execID || `estimated-terminal:${resolvedClOrdID}`,
              estimatedEvidence ? { estimated: true, evidenceGap: true } : {},
            );
            this.emit('quote-lifecycle', {
              eventType: 'full_fill', quoteId: resolvedClOrdID,
              executionId: execID || `estimated-terminal:${resolvedClOrdID}`,
              side, price: effectivePrice, size: preTerminalRemaining,
              level: tracked?.level, action: 'full_fill',
              decisionTimestamp: tracked?.decisionTimestamp ?? tracked?.placedAt ?? null,
              ...(estimatedEvidence ? { estimated: true, evidenceGap: true } : {}),
            });
          }
          this.activeOrders.delete(resolvedClOrdID);
          this.unknownStatusDedupeByOrder.delete(resolvedClOrdID);
          this._retireCancelId(clOrdID);
          this._retireCancelMappings(resolvedClOrdID);
          break;
        }
        if (execID) {
          const trackedBeforeFill = this.activeOrders.get(resolvedClOrdID);
          const preTerminalRemaining = Number(trackedBeforeFill?.size);
          const quantityProvesTerminal = Number.isFinite(lastQty) && lastQty > 0 &&
            Math.abs(lastQty - preTerminalRemaining) <= 1e-10;
          const priceEstimated = !Number.isFinite(lastPx) || lastPx <= 0;
          const effectivePrice = priceEstimated ? Number(trackedBeforeFill?.price) : lastPx;
          if (!Number.isFinite(effectivePrice) || effectivePrice <= 0) {
            this._failClosedExecutionEvidence(resolvedClOrdID, 'fill-price-evidence-gap');
            break;
          }
          const estimatedEvidence = !quantityProvesTerminal || priceEstimated;
          const tracked = this._emitFillEvent(
            resolvedClOrdID, side, effectivePrice, preTerminalRemaining, execID,
            estimatedEvidence ? { estimated: true, evidenceGap: true } : {},
          );
          this.emit('quote-lifecycle', {
            eventType: 'full_fill', quoteId: resolvedClOrdID, executionId: execID, side,
            price: effectivePrice, size: preTerminalRemaining, level: tracked?.level, action: 'full_fill',
            decisionTimestamp: tracked?.decisionTimestamp ?? tracked?.placedAt ?? null,
            ...(estimatedEvidence ? { estimated: true, evidenceGap: true } : {}),
          });
          this._recordExecutionIdentity(resolvedClOrdID, execID, { terminal: true });
        }
        this.activeOrders.delete(resolvedClOrdID);
        this._retireCancelId(clOrdID);
        this._retireCancelMappings(resolvedClOrdID);
        break;

      case '4': // Cancelled
        // Distinguish a cancel WE initiated (cancel ack: resolved via cancelToOrigMap, or the
        // order was marked 'cancelling') from an UNSOLICITED venue cancel (the venue dropped a
        // resting order we never asked to cancel — e.g. a post-only/ALO order it deemed
        // marketable). Surface the latter so it stops vanishing silently.
        const cancelled = this.activeOrders.get(resolvedClOrdID);
        {
          const selfInitiated = !!origClOrdID || cancelled?.status === 'cancelling';
          if (cancelled && !selfInitiated) {
            const reason = fields['58'] || 'unsolicited';
            // Venue text is diagnostic only. Any unsolicited cancellation of a
            // maker attempt can indicate post-only marketability and must inhibit
            // an identical retry storm. The helper deliberately excludes takers.
            this._recordAloRetryInhibition(cancelled);
            this.logger.warn(
              `[QuoteEngine] Venue-cancelled ${cancelled.side} L${cancelled.level} @ ${cancelled.price} size=${cancelled.size}: ${reason}`
            );
            this.recentRejectsByReason.set(
              `venue-cancel:${reason}`,
              (this.recentRejectsByReason.get(`venue-cancel:${reason}`) || 0) + 1
            );
          }
        }
        this.activeOrders.delete(resolvedClOrdID);
        this.emit('quote-lifecycle', {
          eventType: 'cancel', quoteId: resolvedClOrdID, side: cancelled?.side,
          price: cancelled?.price, size: cancelled?.size, level: cancelled?.level,
          action: 'cancelled', reason: fields['58'] || null,
        });
        this._retireCancelId(clOrdID);
        this._retireCancelMappings(resolvedClOrdID);
        this.capitalReservationManager?.cancelled(resolvedClOrdID);
        this._clearExecutionIdentity(resolvedClOrdID);
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
            origOrder.acknowledgedLive = true;
          }
          this.capitalReservationManager?.cancelRejected(origClOrdID);
          this._retireCancelId(clOrdID);
        } else {
          // New order was rejected — remove from tracking (never made it to exchange)
          this.activeOrders.delete(resolvedClOrdID);
          this._clearExecutionIdentity(resolvedClOrdID);
        }
        {
          const reason = fields['58'] || 'unknown';
          const newlyRejected = origClOrdID ? false : (this.capitalReservationManager?.rejected(resolvedClOrdID) ?? true);
          if (newlyRejected && /insufficient\s+(?:balance|funds)/i.test(reason)) {
            this.capitalReservationManager?.insufficientFunds(side);
            this.emit('capital-resync-required', { side, reason });
          }
          this.recentRejectsByReason.set(reason, (this.recentRejectsByReason.get(reason) || 0) + 1);
          this.logger.error(`[QuoteEngine] Order rejected: clOrdID=${clOrdID}, reason=${reason}, code=${fields['103'] || 'n/a'}`);
          this.emit('quote-lifecycle', {
            eventType: 'reject', quoteId: resolvedClOrdID, orderId: clOrdID, side,
            action: 'reject', reason, executionId: execID,
          });
        }
        break;

      case 'C': // Expired
        if (!this.capitalReservationManager) {
          this.logger.warn(`[QuoteEngine] Unhandled execution report ordStatus=${ordStatus} clOrdID=${clOrdID} execID=${execID}`);
          break;
        }
        if (this.capitalReservationManager.expired(resolvedClOrdID)) {
          const expired = this.activeOrders.get(resolvedClOrdID);
          this.activeOrders.delete(resolvedClOrdID);
          this.unknownStatusDedupeByOrder.delete(resolvedClOrdID);
          this.emit('quote-lifecycle', {
            eventType: 'cancel', quoteId: resolvedClOrdID, executionId: execID,
            side: expired?.side || side, price: expired?.price, size: expired?.size,
            level: expired?.level, action: 'expired', reason: fields['58'] || 'expired',
          });
        }
        break;

      case 'A': // PendingNew
      case '6': // PendingCancel
      case 'E': // PendingReplace
        // Benign in-flight transition states (TrueX sends PendingNew before New on every
        // order). Expected and frequent — no action, and must NOT hit the default warn.
        break;

      default: // Surface anything we don't explicitly handle instead of silently dropping it
        if (this.capitalReservationManager?.isActionableReservation(resolvedClOrdID)) {
          const status = ordStatus === undefined || ordStatus === null || ordStatus === ''
            ? 'missing'
            : String(ordStatus);
          const reason = `unmapped-ord-status:${status}`;
          const identity = this._recordUnknownStatusIdentity(resolvedClOrdID, execID);
          if (identity === 'capacity' && !this.executionEvidenceGap) {
            const transitioned = this.capitalReservationManager.failClosedForEvidenceGap(
              resolvedClOrdID, 'unknown-status-dedupe-capacity-exceeded',
            );
            if (transitioned) {
              this._failClosedExecutionEvidence(
                resolvedClOrdID, 'unknown-status-dedupe-capacity-exceeded',
              );
              this._emitCapitalEvidenceGap(resolvedClOrdID);
            }
          } else if (identity === 'new' && !this.executionEvidenceGap) {
            const newlyFailed = this.capitalReservationManager.failClosedForEvidenceGap(
              resolvedClOrdID, reason,
            );
            if (newlyFailed) {
              this._failClosedExecutionEvidence(resolvedClOrdID, reason, { authoritative: true });
              this._emitCapitalEvidenceGap(resolvedClOrdID);
            }
          }
        }
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

    if (typeof clOrdID === 'string' && clOrdID && this.resolvedCancelIds.has(clOrdID)) return;

    this.logger.warn(`[QuoteEngine] OrderCancelReject: cancel=${clOrdID} orig=${origClOrdID} reason=${reason} cxlRejReason=${cxlRejReason}`);

    // Resolve via cancelToOrigMap if origClOrdID not in the message
    const mappedOrigClOrdID = typeof clOrdID === 'string' && clOrdID
      ? this.cancelToOrigMap.get(clOrdID)
      : null;
    const explicitOrigClOrdID = typeof origClOrdID === 'string' && origClOrdID ? origClOrdID : null;
    const unknownCandidate = [explicitOrigClOrdID, mappedOrigClOrdID].find((orderId) =>
      this.activeOrders.get(orderId)?.dispatchOutcomeUnknown);
    if (unknownCandidate && (!clOrdID || mappedOrigClOrdID !== unknownCandidate ||
        (explicitOrigClOrdID && explicitOrigClOrdID !== unknownCandidate))) {
      this.capitalReservationManager?.failClosedForEvidenceGap?.(
        unknownCandidate, 'async-cancel-dispatch-outcome-unknown',
      );
      this._failClosedExecutionEvidence(
        unknownCandidate, 'async-cancel-dispatch-outcome-unknown',
        { authoritative: Boolean(this.capitalReservationManager) },
      );
      this._emitCapitalResyncRequired({
        orderId: unknownCandidate,
        side: this.activeOrders.get(unknownCandidate)?.side,
        reason: 'uncorrelated-cancel-reject',
      });
      return;
    }
    const resolvedOrigClOrdID = explicitOrigClOrdID || mappedOrigClOrdID;

    if (resolvedOrigClOrdID) {
      if (cxlRejReason === '1') {
        // Unknown order proves only absence, not cancellation: it may have
        // filled before the cancel arrived. Consume the remaining commitment
        // conservatively and require a fresh balance/live-order reconcile.
        this.activeOrders.delete(resolvedOrigClOrdID);
        if (this.capitalReservationManager) {
          const evidence = this.capitalReservationManager.cancelRejectUnknown(resolvedOrigClOrdID);
          if (evidence) {
            const event = { ...evidence, orderId: resolvedOrigClOrdID, executionState: 'degraded' };
            this.emit('cancel-unknown-outcome', event);
            this.emit('capital-resync-required', event);
          }
        }
        this.pendingReplacements.delete(resolvedOrigClOrdID);
        this._clearExecutionIdentity(resolvedOrigClOrdID);
        this._retireCancelMappings(resolvedOrigClOrdID);
      } else {
        // Cancel failed but original order still lives — restore to 'active'
        this.resolveUnknownCancelAsActive(resolvedOrigClOrdID, {
          replacement: 'drop', evidenceAuthority: true, evidenceSource: 'fix-cancel-reject',
        });
      }
    }

    // Clean up cancel tracking
    this._retireCancelId(clOrdID);

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
    const maxSequence = 36 ** 6 - 1;
    if (this.orderSequence >= maxSequence) {
      throw new Error('ClOrdID sequence exhausted for this engine boot');
    }
    const seq = (++this.orderSequence).toString(36).padStart(6, '0');
    return `Q${this.orderIdNamespace}${this.orderIdBootId}${seq}`;
  }

  /**
   * Remove a stale order from local tracking (used by REST reconciliation).
   * Returns true if the order existed and was removed.
   */
  removeStaleOrder(clOrdID) {
    const tracked = this.activeOrders.get(clOrdID);
    if (!tracked) return false;
    this.reconcileRestAbsentOrder(clOrdID);
    return true;
  }

  /**
   * Reconcile a manager-known acknowledged order absent from REST. Unlike the
   * legacy stale-order helper, this also works after emergency cancel-all has
   * already cleared activeOrders.
   */
  reconcileRestAbsentOrder(clOrdID) {
    const tracked = this.activeOrders.get(clOrdID);
    if (tracked) this.activeOrders.delete(clOrdID);
    const evidence = this.capitalReservationManager?.restOrderAbsent(clOrdID) || null;
    if (evidence) {
      this.emit('rest-order-absence', {
        ...evidence,
        level: tracked?.level,
        executionState: 'degraded',
      });
    }
    this.pendingReplacements.delete(clOrdID);
    this._retireCancelMappings(clOrdID);
    this.deferredRepriceNeeded = true;
    this._clearExecutionIdentity(clOrdID);
    return { changed: Boolean(tracked || evidence), removedLocal: Boolean(tracked), evidence };
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
      continuity: this.getContinuityState(),
      lastMarketableAloSkip: this.lastMarketableAloSkip,
      recentRejectsByReason: Object.fromEntries(this.recentRejectsByReason),
      truexEbbo: this.truexEbbo ? { ...this.truexEbbo } : null,
      truexEbboFresh: this._isTruexEbboFresh(),
      strictTruexMakerSafety: this.config.strictTruexMakerSafety,
      truexMakerEbboFresh: this.config.strictTruexMakerSafety ? this._strictEbboState().usable : null,
      aloRetryInhibitions: Array.from(this.aloRetryInhibitions.values()).map((entry) => ({ ...entry })),
      pyusdUsd: this.pyusdUsd ? { ...this.pyusdUsd } : null,
      pyusdUsdFresh: this._isPyusdBasisFresh(),
      pyusdBasisSuppressed: this.shouldSuppressBasisDependentDetection(),
      shadowTakeMode: this.config.shadowTakeMode,
      shadowState: {
        activeCandidate: this.shadowState.activeCandidate ? { ...this.shadowState.activeCandidate } : null,
        lastLoggedCandidate: this.shadowState.lastLoggedCandidate ? { ...this.shadowState.lastLoggedCandidate } : null,
        pendingAttribution: this.shadowState.pendingAttribution ? { ...this.shadowState.pendingAttribution } : null,
      },
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
  _capSizeToBalance(side, desiredSize, price, alreadyCommitted = 0, level = 1) {
    if (this.capitalReservationManager) {
      const available = this.capitalReservationManager.getQuoteCapacityForLevel(
        side, level, alreadyCommitted,
      );
      const remaining = Math.max(0, available - alreadyCommitted);
      const maxSize = side === 'sell' ? remaining : (price > 0 ? remaining / price : 0);
      const factor = Math.pow(10, this.config.sizeDecimalPlaces);
      return Math.floor(Math.max(0, Math.min(desiredSize, maxSize)) * factor) / factor;
    }
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
    this._refreshContinuityState();
    this._expirePendingReplacements();
    if (this.quotingSuspended) {
      return;
    }
    const now = Date.now();
    if (now - this.lastActionReset >= 1000) {
      this.actionsThisSecond = 0;
      this.lastActionReset = now;
    }

    let droppedStalePlacements = 0;
    while (this.actionQueue.length > 0 && this.actionsThisSecond < this.config.maxOrdersPerSecond) {
      const action = this.actionQueue.shift();
      if (this.capitalReservationManager &&
          (action.type === 'replacement-cancel' ||
            (action.type === 'cancel' && this.continuityState.executionState !== 'unsafe'))) {
        this._recordSuppression(action.quote || action.order, 'queued-cancel-rederive-required');
        this.deferredRepriceNeeded = true;
        continue;
      }
      // Same balance-safety gate as the dispatch loop: gated placements are
      // DROPPED, not held — they were built in an earlier cycle and would be
      // stale by the time the cancel clears. deferredRepriceNeeded re-derives
      // fresh quotes on the next cycle, same guarantee as the dispatch skip.
      if (this._shouldHoldPlacement(action)) {
        this.placementsDeferredForCancels++;
        droppedStalePlacements++;
        this.heldPlacementsPending = true;
        continue;
      }
      if (this._dispatchAction(action) === false) continue;
      this.actionsThisSecond++;
    }
    if (droppedStalePlacements > 0) {
      this.deferredRepriceNeeded = true;
      this.logger.info(
        `[QuoteEngine] Dropped ${droppedStalePlacements} stale queued placement(s) pending same-side cancel confirms (re-deriving next cycle)`
      );
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

  _strictEbboState(book = this.truexEbbo) {
    if (!book) return { usable: false, reason: 'truex-ebbo-missing' };
    if (!this._validateStrictEbboObservation(book)) {
      return { usable: false, reason: 'truex-ebbo-invalid' };
    }
    if (this.now() - Number(book.receivedAt) > this.config.truexMakerEbboMaxAgeMs) {
      return { usable: false, reason: 'truex-ebbo-stale' };
    }
    return { usable: true, book };
  }

  _validateStrictEbboObservation(book) {
    if (!book) return false;
    const bid = Number(book.bestBid);
    const ask = Number(book.bestAsk);
    const rawSourceTimestamp = book.sourceTimestamp ?? book.timestamp;
    if (rawSourceTimestamp === null || rawSourceTimestamp === undefined ||
        String(rawSourceTimestamp).trim() === '') return false;
    if (typeof rawSourceTimestamp !== 'number') return false;
    const sourceTimestamp = rawSourceTimestamp;
    const receivedAt = Number(book.receivedAt);
    return Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0 && bid <= ask &&
      Number.isSafeInteger(sourceTimestamp) && sourceTimestamp > 0 &&
      Number.isSafeInteger(receivedAt) && receivedAt >= 0 &&
      sourceTimestamp <= receivedAt && receivedAt <= this.now() &&
      Number(book.observationTimestamp ?? receivedAt) === receivedAt;
  }

  _makerSafetyBookState() {
    if (this.config.strictTruexMakerSafety) return this._strictEbboState();
    const book = this._getTrueXBook();
    return this._isBookFresh(book)
      ? { usable: true, book }
      : { usable: false, reason: 'legacy-book-unavailable' };
  }

  _isBookFresh(book = this._getTrueXBook()) {
    return !!(book && book.timestamp && (Date.now() - book.timestamp) <= this.config.truexBookStaleThresholdMs);
  }

  _isTruexEbboFresh(book = this.truexEbbo) {
    return !!(book && book.timestamp && (Date.now() - book.timestamp) <= this.config.truexBookStaleThresholdMs);
  }

  _isPyusdBasisFresh(reference = this.pyusdUsd) {
    return !!(
      reference &&
      reference.timestamp &&
      (Date.now() - reference.timestamp) <= this.config.pyusdUsdStaleThresholdMs
    );
  }

  shouldSuppressBasisDependentDetection(reference = this.pyusdUsd) {
    return !this._isPyusdBasisFresh(reference);
  }

  _extractCoinbaseSource(aggregatedPrice) {
    if (!Array.isArray(aggregatedPrice?.sources)) return null;
    return aggregatedPrice.sources.find((source) => source?.exchange === 'coinbase') || null;
  }

  _getInventoryNetPosition() {
    if (typeof this.inventoryManager?.getPositionSummary === 'function') {
      return Number(this.inventoryManager.getPositionSummary()?.netPosition ?? 0);
    }
    return Number(this.inventoryManager?.netPosition ?? 0);
  }

  _getCommittedSellInventoryBtc() {
    let committed = 0;
    for (const [, order] of this.activeOrders) {
      if ((order.status === 'active' || order.status === 'pending') && order.side === 'sell') {
        committed += Number(order.size) || 0;
      }
    }
    return committed;
  }

  _getSellableInventoryBtc() {
    const available = Number(this.inventoryManager?.getAvailableForSide?.('sell') ?? Infinity);
    const committed = this._getCommittedSellInventoryBtc();
    const netPosition = Math.max(0, this._getInventoryNetPosition() - committed);
    const uncommittedAvailable = Math.max(0, available - committed);
    return Math.max(0, Math.min(uncommittedAvailable, netPosition));
  }

  _getShadowCandidateKey(price, qty) {
    return `${Number(price).toFixed(2)}:${Number(qty).toFixed(8)}`;
  }

  _isSameShadowOrder(a, b) {
    if (!a || !b) return false;
    if (Number(a.price) !== Number(b.price)) return false;
    const baseQty = Math.max(Number(a.qty) || 0, Number(b.qty) || 0);
    if (baseQty <= 0) return false;
    const delta = Math.abs(Number(a.qty) - Number(b.qty));
    return (delta / baseQty) <= this.config.shadowTakeQtyDecayTolerancePct;
  }

  _buildShadowEvaluation({
    now,
    trigger,
    coinbaseBid,
    coinbaseFresh,
    rawEdgeBps,
    basisAdjEdgeBps,
    size,
    truexTapeAgeS,
    dedupKey,
    suppressReason = null,
    wouldTake = false,
  }) {
    return {
      timestamp: now,
      trigger,
      side: 'sell',
      size,
      truexPrice: this.truexEbbo?.bestBid ?? null,
      rawEdgeBps,
      basisAdjEdgeBps,
      pyusdUsd: this.pyusdUsd?.price ?? null,
      coinbaseBid,
      coinbaseFresh,
      truexTapeAgeS,
      dedupKey,
      suppressReason,
      wouldTake,
    };
  }

  _resolvePendingShadowAttribution({ now, currentCandidate }) {
    const pending = this.shadowState.pendingAttribution;
    if (!pending) return [];

    const ageMs = now - pending.loggedAt;
    if (ageMs < this.config.shadowAttributionMaxAgeMs && this._isSameShadowOrder(pending, currentCandidate)) {
      return [];
    }

    const outcome = this._isSameShadowOrder(pending, currentCandidate) ? 'persisted' : 'disappeared';
    const attribution = {
      type: 'shadow-take-attribution',
      timestamp: now,
      dedupKey: pending.dedupKey,
      outcome,
      ageMs,
      truexPrice: pending.price,
      truexQty: pending.qty,
    };
    this.shadowState.pendingAttribution = null;
    return [attribution];
  }

  _resetShadowCandidate() {
    this.shadowState.activeCandidate = null;
  }

  evaluateShadowTake({ aggregatedPrice, truexTape = null, now = Date.now(), trigger = 'unknown' }) {
    if (!this.config.shadowTakeMode) {
      return null;
    }

    const coinbaseSource = this._extractCoinbaseSource(aggregatedPrice);
    const coinbaseBid = Number(coinbaseSource?.bid ?? 0);
    const coinbaseFresh = !!coinbaseSource && !coinbaseSource.isStale;
    const logs = this._resolvePendingShadowAttribution({
      now,
      currentCandidate: this.truexEbbo
        ? { price: this.truexEbbo.bestBid, qty: this.truexEbbo.bestBidQty }
        : null,
    });

    if (!coinbaseFresh || !coinbaseBid || aggregatedPrice?.confidence < this.config.confidenceThreshold) {
      this._resetShadowCandidate();
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid: coinbaseBid || null,
          coinbaseFresh,
          rawEdgeBps: null,
          basisAdjEdgeBps: null,
          size: null,
          truexTapeAgeS: truexTape?.ageS ?? null,
          dedupKey: null,
          suppressReason: !coinbaseFresh ? 'coinbase-stale' : 'coinbase-low-confidence',
        }),
      };
    }

    if (!this._isTruexEbboFresh() || !this.truexEbbo?.bestBid || !this.truexEbbo?.bestBidQty) {
      this._resetShadowCandidate();
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid,
          coinbaseFresh,
          rawEdgeBps: null,
          basisAdjEdgeBps: null,
          size: null,
          truexTapeAgeS: truexTape?.ageS ?? null,
          dedupKey: null,
          suppressReason: 'truex-ebbo-stale',
        }),
      };
    }

    if (this.shouldSuppressBasisDependentDetection()) {
      this._resetShadowCandidate();
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid,
          coinbaseFresh,
          rawEdgeBps: null,
          basisAdjEdgeBps: null,
          size: null,
          truexTapeAgeS: truexTape?.ageS ?? null,
          dedupKey: null,
          suppressReason: 'basis-stale',
        }),
      };
    }

    const pyusdUsd = Number(this.pyusdUsd?.price ?? 0);
    const depegBps = Math.abs(pyusdUsd - 1) * 10000;
    if (depegBps > this.config.pyusdDepegThresholdBps) {
      this._resetShadowCandidate();
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid,
          coinbaseFresh,
          rawEdgeBps: null,
          basisAdjEdgeBps: null,
          size: null,
          truexTapeAgeS: truexTape?.ageS ?? null,
          dedupKey: null,
          suppressReason: 'basis-depeg',
        }),
      };
    }

    const rawEdgeBps = this.computeTakeEdgeBps({
      side: 'sell',
      fairValue: coinbaseBid,
      executionPrice: this.truexEbbo.bestBid,
    });
    const basisAdjEdgeBps = this.computeTakeEdgeBps({
      side: 'sell',
      fairValue: coinbaseBid,
      executionPrice: this.truexEbbo.bestBid / pyusdUsd,
    });
    const truexTapeAgeS = truexTape?.ageS ?? null;
    const dedupKey = this._getShadowCandidateKey(this.truexEbbo.bestBid, this.truexEbbo.bestBidQty);

    if (!truexTape?.latestTradePrice || !truexTape?.latestTradeTs || truexTapeAgeS === null) {
      this._resetShadowCandidate();
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid,
          coinbaseFresh,
          rawEdgeBps,
          basisAdjEdgeBps,
          size: null,
          truexTapeAgeS,
          dedupKey,
          suppressReason: 'truex-tape-missing',
        }),
      };
    }

    if ((now - truexTape.latestTradeTs) > this.config.shadowDetectionTapeMaxAgeMs) {
      this._resetShadowCandidate();
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid,
          coinbaseFresh,
          rawEdgeBps,
          basisAdjEdgeBps,
          size: null,
          truexTapeAgeS,
          dedupKey,
          suppressReason: 'truex-tape-stale',
        }),
      };
    }

    const tapeDistanceBps = Math.abs((Number(truexTape.latestTradePrice) - this.truexEbbo.bestBid) / this.truexEbbo.bestBid) * 10000;
    if (tapeDistanceBps > this.config.truexTapeOutlierThresholdBps) {
      this._resetShadowCandidate();
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid,
          coinbaseFresh,
          rawEdgeBps,
          basisAdjEdgeBps,
          size: null,
          truexTapeAgeS,
          dedupKey,
          suppressReason: 'truex-tape-outlier',
        }),
      };
    }

    if (basisAdjEdgeBps > this.config.maxEdgeCeilingBps) {
      this._resetShadowCandidate();
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid,
          coinbaseFresh,
          rawEdgeBps,
          basisAdjEdgeBps,
          size: null,
          truexTapeAgeS,
          dedupKey,
          suppressReason: 'edge-too-high',
        }),
      };
    }

    if (basisAdjEdgeBps < this.config.minTakeEdgeBps) {
      this._resetShadowCandidate();
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid,
          coinbaseFresh,
          rawEdgeBps,
          basisAdjEdgeBps,
          size: null,
          truexTapeAgeS,
          dedupKey,
          suppressReason: 'edge-too-low',
        }),
      };
    }

    const maxSizeByNotional = this.config.maxTakeNotionalPerOrder > 0
      ? this.config.maxTakeNotionalPerOrder / this.truexEbbo.bestBid
      : Infinity;
    const size = Math.min(
      Number(this.truexEbbo.bestBidQty),
      this._getSellableInventoryBtc(),
      maxSizeByNotional,
    );

    if (!Number.isFinite(size) || size < this.config.minTakeSizeBTC) {
      this._resetShadowCandidate();
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid,
          coinbaseFresh,
          rawEdgeBps,
          basisAdjEdgeBps,
          size,
          truexTapeAgeS,
          dedupKey,
          suppressReason: 'take-size-too-small',
        }),
      };
    }

    const candidate = {
      price: this.truexEbbo.bestBid,
      qty: Number(this.truexEbbo.bestBidQty),
      dedupKey,
      persistenceCount: 1,
    };
    if (this._isSameShadowOrder(this.shadowState.activeCandidate, candidate)) {
      candidate.persistenceCount = this.shadowState.activeCandidate.persistenceCount + 1;
    }
    this.shadowState.activeCandidate = candidate;

    if (candidate.persistenceCount < this.config.shadowPersistenceRequiredPolls) {
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid,
          coinbaseFresh,
          rawEdgeBps,
          basisAdjEdgeBps,
          size,
          truexTapeAgeS,
          dedupKey,
          suppressReason: 'persistence-pending',
        }),
      };
    }

    if (this._isSameShadowOrder(this.shadowState.lastLoggedCandidate, candidate)) {
      return {
        logs,
        evaluation: this._buildShadowEvaluation({
          now,
          trigger,
          coinbaseBid,
          coinbaseFresh,
          rawEdgeBps,
          basisAdjEdgeBps,
          size,
          truexTapeAgeS,
          dedupKey,
          suppressReason: 'deduped',
        }),
      };
    }

    const log = {
      type: 'would-take',
      ...this._buildShadowEvaluation({
        now,
        trigger,
        coinbaseBid,
        coinbaseFresh,
        rawEdgeBps,
        basisAdjEdgeBps,
        size,
        truexTapeAgeS,
        dedupKey,
        wouldTake: true,
      }),
      persistenceCount: candidate.persistenceCount,
    };

    this.shadowState.lastLoggedCandidate = candidate;
    this.shadowState.pendingAttribution = {
      price: candidate.price,
      qty: candidate.qty,
      dedupKey,
      loggedAt: now,
    };

    logs.push(log);
    return { logs, evaluation: log };
  }

  _isMarketablePostOnly(quote) {
    const { usable, book } = this._makerSafetyBookState();
    if (!usable) return false;
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
    const value = {
      reason,
      cause: quote?.cause || reason,
      transition: quote?.transition || `${this.continuityState.executionState}-state-retained`,
      executionState: this.continuityState.executionState,
      timestamp: Date.now(),
      quote: { ...quote },
    };
    this.suppressedLevels.set(key, value);
    if (reason === 'marketable-post-only') {
      this.lastMarketableAloSkip = value;
    }
    if (reason === 'self-cross-tracked-order') {
      this.deferredRepriceNeeded = true;
    }
    this.logger.warn(`[QuoteEngine] Suppressed ${quote.side} L${quote.level}: ${reason}`);
  }

  _recordExecutionIdentity(orderId, execID, { terminal = false } = {}) {
    if (!orderId) return;
    if (terminal) {
      this.executionDedupeByOrder.delete(orderId);
      this.terminalExecutionOrders.add(orderId);
      while (this.terminalExecutionOrders.size > this.maxExecutionDedupeOrders) {
        this.terminalExecutionOrders.delete(this.terminalExecutionOrders.values().next().value);
      }
      return;
    }
    const current = this.executionDedupeByOrder.get(orderId) || { execIDs: new Set(), terminal: false };
    if (execID) current.execIDs.add(execID);
    this.executionDedupeByOrder.delete(orderId);
    this.executionDedupeByOrder.set(orderId, current);
  }

  _clearExecutionIdentity(orderId) {
    if (!orderId) return;
    this.executionDedupeByOrder.delete(orderId);
    this.terminalExecutionOrders.delete(orderId);
    this.unknownStatusDedupeByOrder.delete(orderId);
  }

  _recordUnknownStatusIdentity(orderId, execID) {
    let identity = this.unknownStatusDedupeByOrder.get(orderId);
    if (!identity) {
      if (this.unknownStatusDedupeByOrder.size >= this.maxExecutionDedupeOrders) return 'capacity';
      identity = { execIDs: new Set(), missingExecIDSeen: false };
      this.unknownStatusDedupeByOrder.set(orderId, identity);
    }
    if (!execID) {
      if (identity.missingExecIDSeen) return 'duplicate';
      identity.missingExecIDSeen = true;
      return 'new';
    }
    if (identity.execIDs.has(execID)) return 'duplicate';
    if (identity.execIDs.size >= this.maxExecutionIdsPerOrder) return 'capacity';
    identity.execIDs.add(execID);
    return 'new';
  }

  _failClosedExecutionEvidence(orderId, reason, { authoritative = false } = {}) {
    if (this.executionEvidenceGap) return false;
    this.executionEvidenceGap = { orderId, reason, executionState: 'unsafe', authoritative };
    this.setContinuityState({ executionState: 'unsafe', reasons: ['execution-evidence-gap', reason] });
    this.suspendQuoting();
    try { this.emit('execution-evidence-gap', { ...this.executionEvidenceGap }); } catch (_) {}
    try { this.logger.error(`[QuoteEngine] Execution evidence failed closed: orderId=${orderId} reason=${reason}`); } catch (_) {}
    return false;
  }

  resolveAuthoritativeExecutionEvidenceGap() {
    if (!this.executionEvidenceGap?.authoritative) return false;
    this.executionEvidenceGap = null;
    this.setContinuityState({ executionState: 'normal', reasons: [] });
    return true;
  }

  _prepareQuoteForSend(quote) {
    const prepared = { ...quote };
    let strictEbboState = null;
    if (this.config.strictTruexMakerSafety) {
      strictEbboState = this._strictEbboState();
      if (!strictEbboState.usable) {
        this._recordSuppression(prepared, strictEbboState.reason);
        return null;
      }
    }
    const isPostOnly = prepared.postOnly !== false;
    if (!isPostOnly) {
      const takerQuote = this._prepareTakerQuote(prepared);
      if (!takerQuote) {
        return null;
      }
      return takerQuote;
    }

    if (strictEbboState) return this._prepareStrictMakerQuote(prepared, strictEbboState);

    if (!this._isMarketablePostOnly(prepared)) {
      if (!this._wouldSelfCrossTrackedOrder(prepared)) {
        return prepared;
      }
      this._recordSuppression(prepared, 'self-cross-tracked-order');
      return null;
    }

    if (this.config.marketablePostOnlyAction === 'slide') {
      const book = this._makerSafetyBookState().book;
      if (prepared.side === 'buy' && book?.bestAsk !== null && book?.bestAsk !== undefined) {
        prepared.price = this.snapToTick(book.bestAsk - this.config.tickSize);
        if (this.config.strictTruexMakerSafety && this._isAloRetryInhibited(prepared)) {
          this._recordSuppression(prepared, 'alo-retry-inhibited');
          return null;
        }
        if (this._wouldSelfCrossTrackedOrder(prepared)) {
          this._recordSuppression(prepared, 'self-cross-tracked-order');
          return null;
        }
        return prepared;
      }
      if (prepared.side === 'sell' && book?.bestBid !== null && book?.bestBid !== undefined) {
        prepared.price = this.snapToTick(book.bestBid + this.config.tickSize);
        if (this.config.strictTruexMakerSafety && this._isAloRetryInhibited(prepared)) {
          this._recordSuppression(prepared, 'alo-retry-inhibited');
          return null;
        }
        if (this._wouldSelfCrossTrackedOrder(prepared)) {
          this._recordSuppression(prepared, 'self-cross-tracked-order');
          return null;
        }
        return prepared;
      }
    }

    this._recordSuppression(prepared, 'marketable-post-only');
    return null;
  }

  _prepareStrictMakerQuote(quote, capturedState = this._strictEbboState()) {
    const prepared = { ...quote };
    if (!capturedState.usable) {
      this._recordSuppression(prepared, capturedState.reason);
      return null;
    }
    if (this._isAloRetryInhibited(prepared)) {
      this._recordSuppression(prepared, 'alo-retry-inhibited');
      return null;
    }
    const book = capturedState.book;
    const marketable = prepared.side === 'buy'
      ? prepared.price >= book.bestAsk
      : prepared.price <= book.bestBid;
    if (!marketable) {
      if (!this._wouldSelfCrossTrackedOrder(prepared)) return prepared;
      this._recordSuppression(prepared, 'self-cross-tracked-order');
      return null;
    }
    if (this.config.marketablePostOnlyAction === 'slide') {
      prepared.price = prepared.side === 'buy'
        ? this.snapToTick(book.bestAsk - this.config.tickSize)
        : this.snapToTick(book.bestBid + this.config.tickSize);
      if (!Number.isFinite(prepared.price) || prepared.price <= 0) {
        this._recordSuppression(prepared, 'marketable-slide-invalid');
        return null;
      }
      if (this._isAloRetryInhibited(prepared)) {
        this._recordSuppression(prepared, 'alo-retry-inhibited');
        return null;
      }
      if (this._wouldSelfCrossTrackedOrder(prepared)) {
        this._recordSuppression(prepared, 'self-cross-tracked-order');
        return null;
      }
      return prepared;
    }
    this._recordSuppression(prepared, 'marketable-post-only');
    return null;
  }

  _aloRetryKey(side, price) {
    return `${side}:${Number(price).toFixed(8)}`;
  }

  _isAloRetryInhibited(quote) {
    if (quote?.postOnly === false) return false;
    const key = this._aloRetryKey(quote.side, quote.price);
    const inhibition = this.aloRetryInhibitions.get(key);
    if (!inhibition) return false;
    const generation = this.truexEbboGeneration[quote.side] || 0;
    if (generation !== inhibition.generation ||
        this.now() - inhibition.createdAt >= this.config.truexAloRetryCooldownMs) {
      this.aloRetryInhibitions.delete(key);
      return false;
    }
    return true;
  }

  _recordAloRetryInhibition(order) {
    if (!this.config.strictTruexMakerSafety || order?.postOnly === false ||
        order?.liquidityRoleExpected === 'taker' || !order?.side || !Number.isFinite(Number(order.price))) return;
    const key = this._aloRetryKey(order.side, order.price);
    this.aloRetryInhibitions.delete(key);
    this.aloRetryInhibitions.set(key, {
      side: order.side,
      price: Number(order.price),
      generation: this.truexEbboGeneration[order.side] || 0,
      createdAt: this.now(),
    });
    while (this.aloRetryInhibitions.size > this.config.truexAloRetryMaxEntries) {
      this.aloRetryInhibitions.delete(this.aloRetryInhibitions.keys().next().value);
    }
  }

  _wouldSelfCrossTrackedOrder(quote) {
    // Taker quotes are covered by exchange-level 2964; this local guard is for maker-only quotes.
    if (!quote || quote.postOnly === false) return false;
    const now = Date.now();
    for (const order of this.activeOrders.values()) {
      if (!order || order.side === quote.side) continue;
      const isFreshPending = order.status === 'pending' &&
        order.placedAt &&
        (now - order.placedAt) <= this.config.pendingSelfCrossGuardMs;
      const cancellingStartedAt = order.cancellingAt ?? order.placedAt;
      const isFreshCancelling = order.status === 'cancelling' &&
        cancellingStartedAt &&
        (now - cancellingStartedAt) <= this.config.cancellingSelfCrossGuardMs;
      if (order.status !== 'active' && !isFreshPending && !isFreshCancelling) continue;
      if (quote.side === 'buy' && quote.price >= order.price) return true;
      if (quote.side === 'sell' && quote.price <= order.price) return true;
    }
    return false;
  }

  _prepareTakerQuote(quote) {
    const prepared = { ...quote };
    if (this.config.shadowTakeMode) {
      this._recordSuppression(prepared, 'shadow-mode-observe-only');
      return null;
    }

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
    this._refreshContinuityState();
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
    if (this.continuityState.executionState === 'unsafe') {
      this._recordSuppression(pending.quote, 'unsafe-execution-gate');
      return;
    }
    this._dispatchAction({ type: 'place', quote: pending.quote });
  }

  resolveUnknownCancelAsActive(origClOrdID, {
    replacement = 'drop', evidenceAuthority = false, evidenceSource = 'local-timeout',
  } = {}) {
    const original = this.activeOrders.get(origClOrdID);
    if (!original || (original.status !== 'cancelling' && !original.dispatchOutcomeUnknown)) return false;
    const wasUnknown = Boolean(original.dispatchOutcomeUnknown);
    original.status = 'active';
    original.acknowledgedLive = true;
    delete original.dispatchOutcomeUnknown;
    delete original.cancellingAt;
    if (wasUnknown && evidenceAuthority && this.capitalReservationManager?.resolveUnknownCancelAsActive) {
      this.capitalReservationManager.resolveUnknownCancelAsActive(origClOrdID);
    } else if (!wasUnknown) {
      this.capitalReservationManager?.cancelRejected(origClOrdID);
    }
    this._retireCancelMappings(origClOrdID);
    if (replacement === 'preserve') {
      const pending = this.pendingReplacements.get(origClOrdID);
      if (pending) pending.createdAt = Date.now();
    } else {
      this.pendingReplacements.delete(origClOrdID);
    }
    if (evidenceAuthority && this.executionEvidenceGap?.orderId === origClOrdID &&
        this.executionEvidenceGap.reason === 'async-cancel-dispatch-outcome-unknown') {
      this.executionEvidenceGap = null;
      this.setContinuityState({ executionState: 'normal', reasons: [] });
    }
    this.deferredRepriceNeeded = true;
    if (!evidenceAuthority) {
      try {
        this.logger.warn(`[QuoteEngine] Unknown cancel locally reset without authoritative evidence: ${evidenceSource}`);
      } catch (_) {}
    }
    return true;
  }

  _retireCancelMappings(origClOrdID) {
    for (const [cancelId, orderId] of this.cancelToOrigMap) {
      if (orderId !== origClOrdID) continue;
      this._retireCancelId(cancelId);
    }
  }

  _retireCancelId(cancelId) {
    if (!this.cancelToOrigMap.has(cancelId)) return false;
    this.cancelToOrigMap.delete(cancelId);
    this.resolvedCancelIds.add(cancelId);
    while (this.resolvedCancelIds.size > this.maxExecutionDedupeOrders) {
      this.resolvedCancelIds.delete(this.resolvedCancelIds.values().next().value);
    }
    return true;
  }

  _expirePendingReplacements() {
    const now = Date.now();
    for (const [origClOrdID, pending] of this.pendingReplacements.entries()) {
      if (now - pending.createdAt <= this.config.pendingReplacementTimeoutMs) continue;
      this.pendingReplacements.delete(origClOrdID);
      const original = this.activeOrders.get(origClOrdID);
      if (original?.status === 'cancelling') {
        this.resolveUnknownCancelAsActive(origClOrdID, { replacement: 'drop' });
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
    this._refreshContinuityState();
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
        (now - this.lastRepriceAt) < this.config.minRepriceIntervalMs &&
        !this.heldPlacementsPending) {
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
        // Stamp on ANY dispatched cycle (matches onPriceUpdate semantics):
        // - lastRepricedMid must track every dispatched reprice, else the
        //   momentum trigger retriggers too early during hold windows.
        // - lastRepriceAt debounces ordinary ticks after real work went out;
        //   completion retries are exempt via heldPlacementsPending in the
        //   staleness check above, so gating the stamp is unnecessary.
        this.lastRepriceAt = Date.now();
        this.lastRepricedMid = this.lastMid;
      }
      return !this.deferredRepriceNeeded;
    }
    this.deferredRepriceNeeded = false;
    // Nothing left to place — any pending hold is resolved (e.g. the cancel
    // was rejected and the restored order already matches, or quoting became
    // impossible). Clear so later deferred reprices respect the debounce.
    this.heldPlacementsPending = false;
    return true;
  }
}
