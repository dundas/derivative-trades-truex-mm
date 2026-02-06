import { EventEmitter } from 'events';
import { FIXConnection } from '../fix-protocol/fix-connection.js';
import { TrueXDataManager } from '../data-pipeline/truex-data-manager.js';
import { AuditLogger } from '../data-pipeline/audit-logger.js';
import { InventoryManager } from './inventory-manager.js';
import { PnLTracker } from './pnl-tracker.js';
import { QuoteEngine } from './quote-engine.js';
import { HedgeExecutor } from './hedge-executor.js';
import { TrueXMarketDataFeed } from './truex-market-data.js';

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
      repriceThresholdTicks: options.repriceThresholdTicks || 1,
      baseSizeBTC: options.baseSizeBTC || 0.1,
      sizeDecayFactor: options.sizeDecayFactor || 0.8,
      maxOrdersPerSecond: options.maxOrdersPerSecond || 8,
      tickSize: options.tickSize || 0.50,
      minNotional: options.minNotional || 1.0,
      priceBandPct: options.priceBandPct || 2.5,
      confidenceThreshold: options.confidenceThreshold || 0.3,
      symbol: this.symbol,
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
    this.dataManager = options.dataManager || null;
    this.auditLogger = options.auditLogger || null;

    // State
    this.isRunning = false;
    this.startedAt = null;

    // Timers
    this.drainQueueTimer = null;
    this.drainQueueIntervalMs = options.drainQueueIntervalMs || 200;

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

    // 2. Connect FIX OE
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

    // 4. Start PnL periodic logging
    this.pnlTracker.startPeriodicLogging();

    // 5. Start quote engine drain queue timer
    this.drainQueueTimer = setInterval(() => {
      this.quoteEngine.drainQueue();
    }, this.drainQueueIntervalMs);

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
    this.pnlTracker.stopPeriodicLogging();

    // 4. Disconnect market data feed
    if (this.marketDataFeed) {
      try {
        await this.marketDataFeed.disconnect();
      } catch (_) { /* best effort */ }
    }

    // 5. Disconnect FIX OE
    try {
      await this.fixOE.disconnect();
    } catch (_) { /* best effort */ }

    // 6. Log final session report
    const report = this.pnlTracker.getSessionReport();
    this.logger.info(`[Orchestrator] Final PnL Report:\n${report}`);

    // 7. Unwire events
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

    // Only handle execution reports (35=8)
    if (msgType !== '8') return;

    // Route to QuoteEngine for order state management
    this.quoteEngine.onExecutionReport(message.fields);

    // Log to data pipeline if available
    if (this.dataManager) {
      const orderId = message.fields['11'];
      const execID = message.fields['17'];
      const ordStatus = message.fields['39'];
      const lastQty = message.fields['32'] ? Number(message.fields['32']) : 0;
      const lastPx = message.fields['31'] ? Number(message.fields['31']) : 0;
      const side = message.fields['54'] === '1' ? 'buy' : 'sell';

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
        this.dataManager.addFill(fill);
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

    // Audit log if available
    if (this.auditLogger) {
      this.auditLogger.logFillEvent({
        fillId: `${clOrdID}-${execID}`,
        execID,
        orderId: clOrdID,
        sessionId: this.sessionId,
        symbol: this.symbol,
        side,
        quantity: size,
        price,
        timestamp: Date.now(),
      });
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
}
