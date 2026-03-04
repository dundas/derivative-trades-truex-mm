import { EventEmitter } from 'events';
import { FIXConnection } from '../fix-protocol/fix-connection.js';
import { TrueXDataManager } from '../data-pipeline/truex-data-manager.js';
import { AuditLogger } from '../data-pipeline/audit-logger.js';
import { InventoryManager } from './inventory-manager.js';
import { PnLTracker } from './pnl-tracker.js';
import { QuoteEngine } from './quote-engine.js';
import { HedgeExecutor } from './hedge-executor.js';
import { TrueXMarketDataFeed } from './truex-market-data.js';
import { TrueXRESTClient } from '../exchanges/truex/TrueXRESTClient.js';

/**
 * MarketMakerOrchestrator - Wires all components and manages lifecycle.
 *
 * Components:
 *   PriceAggregator → QuoteEngine → FIXConnection (OE) → TrueX
 *   FIXConnection (OE) exec reports → InventoryManager → HedgeExecutor
 *   InventoryManager + HedgeExecutor → PnLTracker
 *   TrueXMarketDataFeed (optional) → QuoteEngine
 *
 * Events: 'started', 'stopped', 'fill', 'hedge', 'error', 'emergency'
 */
export class MarketMakerOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();

    this.logger = options.logger || console;
    this.sessionId = options.sessionId || `mm-${Date.now()}`;
    this.symbol = options.symbol || 'BTC-PYUSD';

    // --- Core components (accept injected or create from config) ---

    this.fixOE = options.fixConnection || new FIXConnection({
      host: options.truexHost,
      port: options.truexPort,
      senderCompID: options.senderCompID || 'CLI_CLIENT',
      targetCompID: options.targetCompID || 'TRUEX_UAT_OE',
      apiKey: options.apiKey,
      apiSecret: options.apiSecret,
      heartbeatInterval: options.heartbeatInterval || 30,
      logger: this.logger,
    });

    this.inventoryManager = options.inventoryManager || new InventoryManager({
      maxPositionBTC: options.maxPositionBTC || 5.0,
      hedgeThresholdBTC: options.hedgeThresholdBTC || 2.0,
      maxSkewTicks: options.maxSkewTicks || 3,
      skewExponent: options.skewExponent || 1.5,
      emergencyLimitBTC: options.emergencyLimitBTC,
      tickSize: options.tickSize || 0.50,
      logger: this.logger,
    });

    this.pnlTracker = options.pnlTracker || new PnLTracker({
      truexMakerFeeBps: options.truexMakerFeeBps || 0,
      truexTakerFeeBps: options.truexTakerFeeBps || 10,
      hedgeMakerFeeBps: options.hedgeMakerFeeBps || 16,
      hedgeTakerFeeBps: options.hedgeTakerFeeBps || 26,
      logIntervalMs: options.pnlLogIntervalMs || 30000,
      significantPnlChange: options.significantPnlChange || 100,
      logger: this.logger,
    });

    this.quoteEngine = options.quoteEngine || new QuoteEngine({
      inventoryManager: this.inventoryManager,
      fixConnection: this.fixOE,
      levels: options.levels || 5,
      baseSpreadBps: options.baseSpreadBps || 50,
      levelSpacingTicks: options.levelSpacingTicks || 1,
      randomLevelSpacingBpsMin: options.randomLevelSpacingBpsMin || null,
      randomLevelSpacingBpsMax: options.randomLevelSpacingBpsMax || null,
      repriceThresholdTicks: options.repriceThresholdTicks || 1,
      baseSizeBTC: options.baseSizeBTC || 0.1,
      sizeDecayFactor: options.sizeDecayFactor || 0.8,
      sizeDecimalPlaces: options.sizeDecimalPlaces || 8,
      maxOrdersPerSecond: options.maxOrdersPerSecond || 8,
      minRepriceIntervalMs: options.minRepriceIntervalMs || 0,
      tickSize: options.tickSize || 0.50,
      minNotional: options.minNotional || 1.0,
      priceBandPct: options.priceBandPct || 2.5,
      confidenceThreshold: options.confidenceThreshold || 0.3,
      symbol: this.symbol,
      clientId: options.clientId || null,
      logger: this.logger,
    });

    this.hedgeExecutor = options.hedgeExecutor || new HedgeExecutor({
      krakenClient: options.krakenClient,
      priceAggregator: options.priceAggregator,
      hedgeSymbol: options.hedgeSymbol || 'XBTUSD',
      maxHedgeSizeBTC: options.maxHedgeSizeBTC || 1.0,
      minHedgeSizeBTC: options.minHedgeSizeBTC || 0.001,
      limitTimeoutMs: options.limitTimeoutMs || 5000,
      logger: this.logger,
    });

    // Optional: TrueX market data feed
    this.marketDataFeed = options.marketDataFeed || null;

    // Price aggregator (external, must be provided)
    this.priceAggregator = options.priceAggregator || null;

    // Data pipeline (optional)
    // Prefer unified DataPipelineManager; fall back to legacy dataManager/auditLogger
    this.dataPipeline = options.dataPipeline || null;
    this.dataManager = options.dataManager || null;
    this.auditLogger = options.auditLogger || null;

    // REST client for order reconciliation (optional)
    this.restClient = null;
    if (options.restUrl) {
      this.restClient = new TrueXRESTClient({
        baseURL: options.restUrl.replace(/\/$/, '') + '/api/v1',
        apiKey: options.apiKey,
        apiSecret: options.apiSecret,
        userId: options.clientId,
      });
    }
    this.reconcileIntervalMs = options.reconcileIntervalMs || 300000; // 5 min
    this.balanceRefreshIntervalMs = options.balanceRefreshIntervalMs || 60000; // 1 min

    // State
    this.isRunning = false;
    this.startedAt = null;

    // Timers
    this.drainQueueTimer = null;
    this.drainQueueIntervalMs = options.drainQueueIntervalMs || 200;
    this._reconcileTimer = null;
    this._balanceRefreshTimer = null;

    // Bind handlers to preserve context
    this._onPriceUpdate = this._onPriceUpdate.bind(this);
    this._onFIXMessage = this._onFIXMessage.bind(this);
    this._onQuoteFill = this._onQuoteFill.bind(this);
    this._onHedgeSignal = this._onHedgeSignal.bind(this);
    this._onHedgeFill = this._onHedgeFill.bind(this);
    this._onEmergency = this._onEmergency.bind(this);
  }

  /**
   * Start the market maker: connect, wire events, begin quoting.
   */
  async start() {
    this.logger.info(`[Orchestrator] Starting market maker session ${this.sessionId}`);

    // 1. Wire event handlers
    this._wireEvents();

    // 2. Fetch account balances via REST (before connecting FIX)
    //    This is MANDATORY when a REST client is configured — fail-open is too dangerous
    if (this.restClient) {
      await this._initializeBalances();
      if (!this.inventoryManager.balancesInitialized) {
        throw new Error('Balance initialization failed — cannot start quoting without balance data');
      }
    } else {
      this.logger.warn('[Orchestrator] No REST client — skipping balance initialization (quoting both sides)');
    }

    // 3. Connect FIX OE
    this.logger.info('[Orchestrator] Connecting FIX OE...');
    await this.fixOE.connect();
    this.logger.info('[Orchestrator] FIX OE connected');

    // 3. Connect market data feed (optional, non-blocking)
    if (this.marketDataFeed) {
      try {
        this.logger.info('[Orchestrator] Connecting TrueX market data feed...');
        await this.marketDataFeed.connect();
        await this.marketDataFeed.subscribe(this.symbol);
        this.logger.info('[Orchestrator] TrueX market data feed connected');
      } catch (err) {
        this.logger.warn(`[Orchestrator] Market data feed failed (non-fatal): ${err.message}`);
      }
    }

    // 4. Start data pipeline (optional, non-blocking)
    if (this.dataPipeline) {
      try {
        await this.dataPipeline.start();
        this.logger.info('[Orchestrator] Data pipeline started');
      } catch (err) {
        this.logger.warn(`[Orchestrator] Data pipeline start failed (non-fatal): ${err.message}`);
      }
    }

    // 5. Start PnL periodic logging
    this.pnlTracker.startPeriodicLogging();

    // 6. Start quote engine drain queue timer
    this.drainQueueTimer = setInterval(() => {
      this.quoteEngine.drainQueue();
    }, this.drainQueueIntervalMs);

    // 7. Start REST reconciliation timer (if REST client configured)
    if (this.restClient) {
      this._reconcileTimer = setInterval(() => this._restReconcile(), this.reconcileIntervalMs);
      this.logger.info(`[Orchestrator] REST reconciliation enabled (every ${this.reconcileIntervalMs / 1000}s)`);

      // 8. Start periodic balance refresh (re-syncs tracked balances with exchange)
      this._balanceRefreshTimer = setInterval(() => this._refreshBalances(), this.balanceRefreshIntervalMs);
      this.logger.info(`[Orchestrator] Balance refresh enabled (every ${this.balanceRefreshIntervalMs / 1000}s)`);
    }

    this.isRunning = true;
    this.startedAt = Date.now();

    this.logger.info('[Orchestrator] Market maker started — waiting for price updates to begin quoting');
    this.emit('started', { sessionId: this.sessionId, timestamp: this.startedAt });

    return true;
  }

  /**
   * Stop the market maker: cancel quotes, hedge, disconnect.
   */
  async stop() {
    if (!this.isRunning) return false;

    this.logger.info('[Orchestrator] Stopping market maker...');

    // 1. Cancel all active quotes
    this.quoteEngine.cancelAllQuotes('shutdown');
    this.logger.info('[Orchestrator] All quotes cancelled');

    // 2. Attempt to hedge remaining position
    const position = this.inventoryManager.getPositionSummary();
    if (Math.abs(position.netPosition) > this.hedgeExecutor.config.minHedgeSizeBTC) {
      this.logger.info(`[Orchestrator] Hedging remaining position: ${position.netPosition.toFixed(6)} BTC`);
      try {
        const hedgeSide = position.netPosition > 0 ? 'sell' : 'buy';
        await this.hedgeExecutor.executeHedge(hedgeSide, Math.abs(position.netPosition), 'urgent');
      } catch (err) {
        this.logger.error(`[Orchestrator] Final hedge failed: ${err.message}`);
      }
    }

    // 3. Stop timers
    if (this.drainQueueTimer) {
      clearInterval(this.drainQueueTimer);
      this.drainQueueTimer = null;
    }
    if (this._reconcileTimer) {
      clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    if (this._balanceRefreshTimer) {
      clearInterval(this._balanceRefreshTimer);
      this._balanceRefreshTimer = null;
    }
    this.pnlTracker.stopPeriodicLogging();

    // 4. Stop data pipeline (flush remaining data)
    if (this.dataPipeline) {
      try {
        await this.dataPipeline.stop();
        this.logger.info('[Orchestrator] Data pipeline stopped');
      } catch (err) {
        this.logger.error(`[Orchestrator] Data pipeline stop failed: ${err.message}`);
      }
    }

    // 5. Disconnect market data feed
    if (this.marketDataFeed) {
      try {
        await this.marketDataFeed.disconnect();
      } catch (_) { /* best effort */ }
    }

    // 6. Disconnect FIX OE
    try {
      await this.fixOE.disconnect();
    } catch (_) { /* best effort */ }

    // 7. Log final session report
    const report = this.pnlTracker.getSessionReport();
    this.logger.info(`[Orchestrator] Final PnL Report:\n${report}`);

    // 8. Unwire events
    this._unwireEvents();

    this.isRunning = false;

    const stopInfo = {
      sessionId: this.sessionId,
      timestamp: Date.now(),
      durationMs: Date.now() - this.startedAt,
      pnl: this.pnlTracker.getSummary(),
      inventory: this.inventoryManager.getPositionSummary(),
    };

    this.logger.info('[Orchestrator] Market maker stopped');
    this.emit('stopped', stopInfo);

    return true;
  }

  /**
   * Get comprehensive status of all components.
   */
  getStatus() {
    return {
      sessionId: this.sessionId,
      isRunning: this.isRunning,
      startedAt: this.startedAt,
      uptimeMs: this.isRunning ? Date.now() - this.startedAt : 0,
      quotes: this.quoteEngine.getQuoteStatus(),
      inventory: this.inventoryManager.getPositionSummary(),
      pnl: this.pnlTracker.getSummary(),
      hedge: this.hedgeExecutor.getHedgeStats(),
      fixOE: {
        isConnected: this.fixOE.isConnected,
        isLoggedOn: this.fixOE.isLoggedOn,
        msgSeqNum: this.fixOE.msgSeqNum,
      },
      marketData: this.marketDataFeed ? {
        isSubscribed: this.marketDataFeed.isSubscribed,
        spread: this.marketDataFeed.getSpread(),
      } : null,
      dataPipeline: this.dataPipeline ? this.dataPipeline.getStats() : null,
    };
  }

  // --- Event Wiring ---

  _wireEvents() {
    // Price → QuoteEngine
    if (this.priceAggregator) {
      this.priceAggregator.on('price', this._onPriceUpdate);
    }

    // FIX OE messages → execution report handling
    this.fixOE.on('message', this._onFIXMessage);

    // QuoteEngine fills → Inventory + PnL
    this.quoteEngine.on('fill', this._onQuoteFill);

    // Inventory hedge signal → HedgeExecutor
    this.inventoryManager.on('hedge-signal', this._onHedgeSignal);

    // Hedge fills → Inventory + PnL
    this.hedgeExecutor.on('hedge-filled', this._onHedgeFill);

    // Emergency → cancel all
    this.inventoryManager.on('emergency', this._onEmergency);
  }

  _unwireEvents() {
    if (this.priceAggregator) {
      this.priceAggregator.removeListener('price', this._onPriceUpdate);
    }
    this.fixOE.removeListener('message', this._onFIXMessage);
    this.quoteEngine.removeListener('fill', this._onQuoteFill);
    this.inventoryManager.removeListener('hedge-signal', this._onHedgeSignal);
    this.hedgeExecutor.removeListener('hedge-filled', this._onHedgeFill);
    this.inventoryManager.removeListener('emergency', this._onEmergency);
  }

  // --- Event Handlers ---

  _onPriceUpdate(aggregatedPrice) {
    if (!this.isRunning) return;

    // Feed price to QuoteEngine
    this.quoteEngine.onPriceUpdate(aggregatedPrice);

    // Update PnL mark-to-market
    if (aggregatedPrice.weightedMidpoint) {
      this.pnlTracker.markToMarket(aggregatedPrice.weightedMidpoint);
    }
  }

  _onFIXMessage(message) {
    if (!message || !message.fields) return;
    const msgType = message.fields['35'];

    // Log all FIX messages to data pipeline
    if (this.dataPipeline) {
      this.dataPipeline.logFIXMessage(message, {
        direction: 'INBOUND',
        msgType,
        sessionId: this.sessionId,
        msgSeqNum: message.fields['34'],
      });
    }

    // Route OrderCancelReject (35=9) to QuoteEngine
    if (msgType === '9') {
      this.quoteEngine.onOrderCancelReject(message.fields);
      return;
    }

    // Only handle execution reports (35=8) beyond this point
    if (msgType !== '8') return;

    // Route to QuoteEngine for order state management
    this.quoteEngine.onExecutionReport(message.fields);

    // Track order state and fills in data pipeline
    const pipeline = this.dataPipeline || this.dataManager;
    if (pipeline) {
      const orderId = message.fields['11'];
      const ordStatus = message.fields['39'];
      const execID = message.fields['17'];
      const lastQty = message.fields['32'] ? Number(message.fields['32']) : 0;
      const lastPx = message.fields['31'] ? Number(message.fields['31']) : 0;
      const orderQty = message.fields['38'] ? Number(message.fields['38']) : null;
      const orderPx = message.fields['44'] ? Number(message.fields['44']) : null;
      const side = message.fields['54'] === '1' ? 'buy' : 'sell';

      // Map FIX ordStatus to readable status
      const statusMap = { 'A': 'pending_new', '0': 'new', '1': 'partial_fill', '2': 'filled', '4': 'cancelled', '8': 'rejected' };

      // Track order state changes
      if (pipeline.addOrder && orderId) {
        pipeline.addOrder({
          orderId,
          sessionId: this.sessionId,
          symbol: this.symbol,
          side,
          status: statusMap[ordStatus] || ordStatus,
          size: orderQty,
          price: orderPx,
          timestamp: Date.now(),
        });
      }

      // Track fills
      if (execID && lastQty > 0) {
        const fill = {
          fillId: `${orderId}-${execID}`,
          execID,
          orderId,
          sessionId: this.sessionId,
          symbol: this.symbol,
          side,
          quantity: lastQty,
          price: lastPx,
          timestamp: Date.now(),
        };
        pipeline.addFill(fill);
      }
    }
  }

  _onQuoteFill({ side, price, size, clOrdID, execID }) {
    // Route fill to InventoryManager
    this.inventoryManager.onFill({
      side,
      quantity: size,
      price,
      venue: 'truex',
      execID,
    });

    // Route fill to PnLTracker
    this.pnlTracker.onFill({
      side,
      quantity: size,
      price,
      venue: 'truex',
      isMaker: true, // Our quotes are maker orders
      execID,
      timestamp: Date.now(),
    });

    // Route fill to data pipeline (unified or legacy audit logger)
    const fillRecord = {
      fillId: `${clOrdID}-${execID}`,
      execID,
      orderId: clOrdID,
      sessionId: this.sessionId,
      symbol: this.symbol,
      side,
      quantity: size,
      price,
      timestamp: Date.now(),
    };
    if (this.dataPipeline) {
      this.dataPipeline.addFill(fillRecord);
    } else if (this.auditLogger) {
      this.auditLogger.logFillEvent(fillRecord);
    }

    this.emit('fill', { side, price, size, clOrdID, execID, venue: 'truex' });
  }

  _onHedgeSignal({ shouldHedge, side, size }) {
    if (!shouldHedge || !this.isRunning) return;

    this.logger.info(`[Orchestrator] Hedge signal: ${side} ${size.toFixed(6)} BTC`);
    this.hedgeExecutor.executeHedge(side, size).catch(err => {
      this.logger.error(`[Orchestrator] Hedge execution failed: ${err.message}`);
    });
  }

  _onHedgeFill({ side, size, price, orderId, slippage }) {
    // Route hedge fill to InventoryManager (reduces position)
    this.inventoryManager.onFill({
      side,
      quantity: size,
      price,
      venue: 'kraken',
      execID: orderId,
    });

    // Route to PnL tracker
    this.pnlTracker.onFill({
      side,
      quantity: size,
      price,
      venue: 'kraken',
      isMaker: false, // Hedge orders are usually taker
      execID: orderId,
      timestamp: Date.now(),
    });

    this.emit('hedge', { side, size, price, orderId, slippage, venue: 'kraken' });
  }

  _onEmergency({ netPosition, reason }) {
    this.logger.error(`[Orchestrator] EMERGENCY: ${reason}`);

    // Cancel all quotes immediately
    this.quoteEngine.cancelAllQuotes(`emergency: ${reason}`);

    this.emit('emergency', { netPosition, reason });
  }

  // --- Balance Initialization ---

  /**
   * Fetch account balances from TrueX REST API and initialize inventory manager.
   * Called ONCE at startup. Throws on failure (startup is mandatory).
   */
  async _initializeBalances() {
    this.logger.info('[Orchestrator] Fetching account balances via REST...');
    const { baseBalance, quoteBalance } = await this._fetchBalances();

    // Initialize inventory manager (sets netPosition from base total)
    this.inventoryManager.initializeFromBalances({ baseBalance, quoteBalance });

    // Log which sides we'll quote
    const [, quoteAsset] = this.symbol.split('-');
    const [baseAsset] = this.symbol.split('-');
    const canBid = this.inventoryManager.canQuote('buy');
    const canAsk = this.inventoryManager.canQuote('sell');
    this.logger.info(`[Orchestrator] Quoting: bids=${canBid ? 'YES' : 'NO (no ' + quoteAsset + ')'}, asks=${canAsk ? 'YES' : 'NO (no ' + baseAsset + ')'}`);
  }

  /**
   * Periodic balance refresh — re-syncs tracked balances from exchange.
   * Uses refreshBalances() which does NOT reset netPosition/VWAP.
   * Safe to call during active trading.
   */
  async _refreshBalances() {
    if (!this.restClient || !this.isRunning) return;

    try {
      const { baseBalance, quoteBalance } = await this._fetchBalances();
      this.inventoryManager.refreshBalances({ baseBalance, quoteBalance });
    } catch (err) {
      this.logger.warn(`[Orchestrator] Balance refresh failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Shared helper: fetch and parse balances from REST API.
   */
  async _fetchBalances() {
    const summary = await this.restClient.getAccountSummary();

    if (!summary || !summary.balances) {
      throw new Error('No balance data returned from REST API');
    }

    const [baseAsset, quoteAsset] = this.symbol.split('-');
    let baseBalance = null;
    let quoteBalance = null;

    for (const bal of summary.balances) {
      const parsed = TrueXRESTClient.parseBalance(bal);
      const name = (parsed.assetName || '').toUpperCase();
      if (name === baseAsset) {
        baseBalance = { available: parsed.available, held: parsed.held, total: parsed.total };
      } else if (name === quoteAsset) {
        quoteBalance = { available: parsed.available, held: parsed.held, total: parsed.total };
      }
    }

    this.logger.info(
      `[Orchestrator] Balances: ${baseAsset}=${baseBalance ? baseBalance.available : 0} avail / ${baseBalance ? baseBalance.total : 0} total, ` +
      `${quoteAsset}=${quoteBalance ? quoteBalance.available : 0} avail / ${quoteBalance ? quoteBalance.total : 0} total`
    );

    return { baseBalance, quoteBalance };
  }

  // --- REST-based Order Reconciliation ---

  async _restReconcile() {
    if (!this.restClient || !this.isRunning) return;

    try {
      // 1. Fetch active orders from exchange via REST
      const exchangeOrders = await this.restClient.getActiveOrders();

      // 2. Build lookup of exchange orders by external_id (our clOrdID)
      const exchangeByClOrdID = new Map();
      for (const raw of exchangeOrders) {
        const parsed = TrueXRESTClient.parseOrder(raw);
        // Skip transitional states
        if (parsed.status === 'NEW_PENDING' || parsed.status === 'CANCEL_PENDING') continue;
        exchangeByClOrdID.set(parsed.externalId, { ...parsed, rawId: raw.id });
      }

      // 3. Build set of local clOrdIDs (skip in-flight orders)
      const localClOrdIDs = new Set();
      for (const [clOrdID, order] of this.quoteEngine.activeOrders) {
        if (order.status === 'pending' || order.status === 'cancelling') continue;
        localClOrdIDs.add(clOrdID);
      }

      // 4. Detect discrepancies
      let matched = 0;
      let orphansCancelled = 0;
      let ghostsRemoved = 0;

      // Orphans: on exchange but not in local state → cancel via REST
      for (const [extId, order] of exchangeByClOrdID) {
        if (localClOrdIDs.has(extId) || this.quoteEngine.activeOrders.has(extId)) {
          matched++;
        } else {
          this.logger.warn(`[Reconcile] Orphan on exchange: ${extId} ${order.side} ${order.qty} @ ${order.price} — cancelling`);
          try {
            await this.restClient.cancelOrder(order.rawId);
            orphansCancelled++;
          } catch (err) {
            this.logger.warn(`[Reconcile] Failed to cancel orphan ${extId}: ${err.message}`);
          }
        }
      }

      // Ghosts: in local state but not on exchange → remove from activeOrders
      for (const clOrdID of localClOrdIDs) {
        if (!exchangeByClOrdID.has(clOrdID)) {
          this.logger.warn(`[Reconcile] Ghost in local state: ${clOrdID} — removing`);
          this.quoteEngine.removeStaleOrder(clOrdID);
          ghostsRemoved++;
        }
      }

      const stats = {
        exchange: exchangeByClOrdID.size,
        local: localClOrdIDs.size,
        matched,
        orphansCancelled,
        ghostsRemoved,
      };

      this.logger.info(
        `[Reconcile] exchange=${stats.exchange} local=${stats.local} matched=${stats.matched} ` +
        `orphans=${stats.orphansCancelled} ghosts=${stats.ghostsRemoved}`
      );

      this.emit('reconcile', stats);
    } catch (err) {
      this.logger.error(`[Reconcile] REST reconciliation failed: ${err.message}`);
      this.emit('error', { phase: 'reconcile', error: err });
    }
  }
}
