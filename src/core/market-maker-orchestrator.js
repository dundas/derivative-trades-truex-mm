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
import { AlertManager, normalizeAlertReason } from '../alerts/alert-manager.js';

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

    // Redis client (optional) — used for sequence number persistence and other caching
    this.redis = options.redisClient || null;

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
      redisClient: this.redis,
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
      truexMakerFeeBps: options.truexMakerFeeBps ?? 0,
      truexTakerFeeBps: options.truexTakerFeeBps ?? 0,
      hedgeMakerFeeBps: options.hedgeMakerFeeBps ?? 0,
      hedgeTakerFeeBps: options.hedgeTakerFeeBps ?? 0,
      logIntervalMs: options.pnlLogIntervalMs || 30000,
      significantPnlChange: options.significantPnlChange || 100,
      logger: this.logger,
    });

    this.quoteEngine = options.quoteEngine || new QuoteEngine({
      inventoryManager: this.inventoryManager,
      fixConnection: this.fixOE,
      levels: options.levels || 5,
      baseSpreadBps: options.baseSpreadBps || 50,
      quoteAnchorMode: options.quoteAnchorMode || 'mid',
      coinbaseAnchorBufferTicks: options.coinbaseAnchorBufferTicks ?? 1,
      anchorExchange: options.anchorExchange || 'coinbase',
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
      truexBookStaleThresholdMs: options.truexBookStaleThresholdMs || 10000,
      marketablePostOnlyAction: options.marketablePostOnlyAction || 'skip',
      replaceMode: options.replaceMode || 'passive-safe',
      minActiveLevelsPerSide: options.minActiveLevelsPerSide ?? 1,
      maxReplacementsPerSidePerCycle: options.maxReplacementsPerSidePerCycle ?? 1,
      pendingReplacementTimeoutMs: options.pendingReplacementTimeoutMs || 5000,
      allowTakerOrders: options.allowTakerOrders || false,
      truexTakerFeeBps: options.truexTakerFeeBps ?? 0,
      minTakeEdgeBps: options.minTakeEdgeBps ?? 1,
      takeSlippageBufferBps: options.takeSlippageBufferBps ?? 0,
      takeHedgeBufferBps: options.takeHedgeBufferBps ?? 0,
      maxTakerOrdersPerMinute: options.maxTakerOrdersPerMinute ?? 0,
      maxTakerNotionalPerMinute: options.maxTakerNotionalPerMinute ?? 0,
      marketDataProvider: () => this.marketDataFeed?.getBestBidAsk?.(),
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

    // PostgreSQL manager (optional) — used for balance snapshots
    this.postgresManager = options.postgresManager || null;

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
    this.truexEbboPollIntervalMs = options.truexEbboPollIntervalMs ?? 1000;
    const configuredTruexEbboPollTimeoutMs =
      options.truexEbboPollTimeoutMs ?? Math.max(250, this.truexEbboPollIntervalMs - 100);
    this.truexEbboPollTimeoutMs = Math.min(
      configuredTruexEbboPollTimeoutMs,
      Math.max(1, this.truexEbboPollIntervalMs - 1),
    );
    this.truexEbboMaxBackoffMs = options.truexEbboMaxBackoffMs ?? 30000;
    this.truexEbboFailureAlertThreshold = options.truexEbboFailureAlertThreshold ?? 3;
    this.truexEbboInstrumentId = options.truexEbboInstrumentId ?? null;
    this.pyusdUsdPollIntervalMs = options.pyusdUsdPollIntervalMs ?? 5000;
    const configuredPyusdUsdPollTimeoutMs =
      options.pyusdUsdPollTimeoutMs ?? Math.max(250, this.pyusdUsdPollIntervalMs - 100);
    this.pyusdUsdPollTimeoutMs = Math.min(
      configuredPyusdUsdPollTimeoutMs,
      Math.max(1, this.pyusdUsdPollIntervalMs - 1),
    );
    this.pyusdUsdStaleThresholdMs = options.pyusdUsdStaleThresholdMs ?? 15000;
    this.pyusdUsdMaxBackoffMs = options.pyusdUsdMaxBackoffMs ?? 30000;
    this.pyusdUsdFailureAlertThreshold = options.pyusdUsdFailureAlertThreshold ?? 3;
    this.pyusdUsdReferenceSources = this._buildPyusdUsdReferenceSources(options.pyusdUsdReferenceSources);
    this.krakenRestClient =
      options.krakenRestClient ||
      (options.krakenClient && typeof options.krakenClient.getTicker === 'function' ? options.krakenClient : null);

    // State
    this.isRunning = false;
    this.startedAt = null;

    // Watchdog state
    this._lastMdUpdateTime = 0;
    this._lastRepriceTime = 0;
    this._watchdogTimer = null;
    this._recordedPipelineFillIds = new Set();

    // Balance snapshot state
    this._lastMidPrice = null;
    this._snapshotTimer = null;
    this._snapshotIntervalMs = parseInt(process.env.BALANCE_SNAPSHOT_INTERVAL_MS ?? '900000', 10);
    this._intentionalStop = false;
    this._mdStaleThresholdMs = parseInt(process.env.MD_STALE_THRESHOLD_MS || '10000', 10);
    this._quotingIdleThresholdMs = parseInt(process.env.QUOTING_IDLE_THRESHOLD_MS || '120000', 10);
    this._quotingGateEnabled = true; // false when MD stale or session down
    /** Normalized watchdog issue keys that were present on the last tick (for recovery diffing) */
    this._activeWatchdogIssues = new Set();
    this._truexEbboPollTimer = null;
    this._truexEbboPollInFlight = false;
    this._truexEbboConsecutiveErrors = 0;
    this._truexEbboCurrentBackoffMs = this.truexEbboPollIntervalMs;
    this._truexEbboLastSuccessAt = 0;
    this._truexEbboFailureAlertActive = false;
    this._pyusdUsdPollTimer = null;
    this._pyusdUsdPollInFlight = false;
    this._pyusdUsdConsecutiveErrors = 0;
    this._pyusdUsdCurrentBackoffMs = this.pyusdUsdPollIntervalMs;
    this._pyusdUsdLastSuccessAt = 0;
    this._pyusdUsdFailureAlertActive = false;
    this.pyusdUsd = null;

    // Alert manager (injectable for testing; defaults to env-driven config)
    this.alertManager = options.alertManager || new AlertManager({
      slackWebhookUrl: process.env.DEFAULT_SLACK_WEBHOOK_URL || null,
      alertEmail: process.env.ALERT_EMAIL || null,
      alertPhone: process.env.ALERT_PHONE || null,
      telnyxApiKey: process.env.TELNYX_API_KEY || null,
      telnyxFromNumber: process.env.TELNYX_FROM_NUMBER || null,
      logger: this.logger,
    });

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
    this._onOEDisconnect = this._onOEDisconnect.bind(this);
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

    // 4. Connect market data feed (optional, non-blocking) — TrueX MD FIX or e.g. Coinbase adapter
    if (this.marketDataFeed) {
      try {
        this.logger.info('[Orchestrator] Connecting market data feed...');
        await this.marketDataFeed.connect();
        await this.marketDataFeed.subscribe(this.symbol);
        this.logger.info('[Orchestrator] Market data feed connect/subscribe completed');
      } catch (err) {
        this.logger.warn(`[Orchestrator] Market data feed failed (non-fatal): ${err.message}`);
      }
    }

    // 5. Start data pipeline (optional, non-blocking)
    if (this.dataPipeline) {
      try {
        await this.dataPipeline.start();
        this.logger.info('[Orchestrator] Data pipeline started');
      } catch (err) {
        this.logger.warn(`[Orchestrator] Data pipeline start failed (non-fatal): ${err.message}`);
      }
    }

    // 6. Start PnL periodic logging
    this.pnlTracker.startPeriodicLogging();

    // 7. Start quote engine drain queue timer
    this.drainQueueTimer = setInterval(() => {
      this.quoteEngine.drainQueue();
    }, this.drainQueueIntervalMs);

    // 8. Start REST reconciliation timer (if REST client configured)
    if (this.restClient) {
      // Run immediately at startup to cancel any orphaned orders from previous session
      this._restReconcile().catch(err =>
        this.logger.warn(`[Orchestrator] Startup reconciliation failed (non-fatal): ${err.message}`)
      );

      this._reconcileTimer = setInterval(() => this._restReconcile(), this.reconcileIntervalMs);
      this.logger.info(`[Orchestrator] REST reconciliation enabled (every ${this.reconcileIntervalMs / 1000}s)`);

      // 9. Start periodic balance refresh (re-syncs tracked balances with exchange)
      this._balanceRefreshTimer = setInterval(() => this._refreshBalances(), this.balanceRefreshIntervalMs);
      this.logger.info(`[Orchestrator] Balance refresh enabled (every ${this.balanceRefreshIntervalMs / 1000}s)`);
    }

    // Start watchdog
    this._watchdogTimer = setInterval(() => this._runWatchdog(), 30000);
    this.logger.info('[Orchestrator] Watchdog started (30s interval)');

    // 10. Take immediate balance snapshot and start periodic timer (if postgres available)
    if (this.postgresManager) {
      await this._takeBalanceSnapshot();
      this._snapshotTimer = setInterval(() => this._takeBalanceSnapshot(), this._snapshotIntervalMs);
      this.logger.info(`[Orchestrator] Balance snapshot timer started (every ${this._snapshotIntervalMs / 1000}s)`);
    }

    this.isRunning = true;
    this.startedAt = Date.now();
    this._startTruexEbboPoller();
    this._startPyusdUsdPoller();

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
    if (this._truexEbboPollTimer) {
      clearTimeout(this._truexEbboPollTimer);
      this._truexEbboPollTimer = null;
    }
    if (this._pyusdUsdPollTimer) {
      clearTimeout(this._pyusdUsdPollTimer);
      this._pyusdUsdPollTimer = null;
    }
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }
    this._intentionalStop = true;
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

    // 5a. Take final balance snapshot (FR-2.4)
    if (this.postgresManager) {
      await this._takeBalanceSnapshot();
    }

    // 5b. Disconnect market data feed
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
      truexEbbo: this.quoteEngine.getQuoteStatus()?.truexEbbo || null,
      truexEbboLastSuccessAt: this._truexEbboLastSuccessAt || null,
      truexEbboConsecutiveErrors: this._truexEbboConsecutiveErrors,
      pyusdUsd: this.pyusdUsd ? { ...this.pyusdUsd } : null,
      pyusdUsdFresh: this._isPyusdUsdFresh(),
      pyusdUsdLastSuccessAt: this._pyusdUsdLastSuccessAt || null,
      pyusdUsdConsecutiveErrors: this._pyusdUsdConsecutiveErrors,
      dataPipeline: this.dataPipeline ? this.dataPipeline.getStats() : null,
    };
  }

  static parseMarketQuote(rawQuote, { instrumentId, symbol } = {}) {
    if (!rawQuote) {
      throw new Error('TrueX EBBO poll returned empty payload');
    }

    const toNumber = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const nanosToMillis = (value) => {
      if (!value) return null;
      try {
        return TrueXRESTClient.nanosToDate(String(value)).getTime();
      } catch (_) {
        return null;
      }
    };

    if (Array.isArray(rawQuote)) {
      if (rawQuote.length === 0) {
        throw new Error('TrueX EBBO poll returned empty array');
      }
      const entry = rawQuote.find((item) =>
        (instrumentId && item?.id === instrumentId) || (symbol && item?.symbol === symbol)
      ) || rawQuote[0];
      if (!entry?.info) {
        throw new Error('TrueX EBBO payload missing info block');
      }

      const bestBid = entry.info.best_bid || {};
      const bestAsk = entry.info.best_ask || {};
      const lastTrade = entry.info.last_trade || {};
      const timestamp =
        nanosToMillis(entry.info.last_update) ??
        nanosToMillis(bestBid.last_update) ??
        nanosToMillis(bestAsk.last_update) ??
        nanosToMillis(lastTrade.timestamp);

      return {
        instrumentId: entry.id || instrumentId || null,
        symbol: entry.symbol || symbol || null,
        bestBid: toNumber(bestBid.price),
        bestAsk: toNumber(bestAsk.price),
        bestBidQty: toNumber(bestBid.qty),
        bestAskQty: toNumber(bestAsk.qty),
        bestBidOrderCount: toNumber(bestBid.order_count),
        bestAskOrderCount: toNumber(bestAsk.order_count),
        lastTradePrice: toNumber(lastTrade.price),
        lastTradeQty: toNumber(lastTrade.qty),
        lastTradeTs: nanosToMillis(lastTrade.timestamp),
        timestamp,
      };
    }

    return {
      instrumentId: rawQuote.instrument_id || instrumentId || null,
      symbol: rawQuote.symbol || symbol || null,
      bestBid: toNumber(rawQuote.bid_price),
      bestAsk: toNumber(rawQuote.ask_price),
      bestBidQty: toNumber(rawQuote.bid_qty),
      bestAskQty: toNumber(rawQuote.ask_qty),
      bestBidOrderCount: null,
      bestAskOrderCount: null,
      lastTradePrice: null,
      lastTradeQty: null,
      lastTradeTs: null,
      timestamp: nanosToMillis(rawQuote.timestamp),
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

    // OE disconnect → flush inflight orders so QuoteEngine can resume on reconnect
    this.fixOE.on('disconnect', this._onOEDisconnect);
    this.fixOE.on('logout', this._onOEDisconnect);

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
    this.fixOE.removeListener('disconnect', this._onOEDisconnect);
    this.fixOE.removeListener('logout', this._onOEDisconnect);
    this.quoteEngine.removeListener('fill', this._onQuoteFill);
    this.inventoryManager.removeListener('hedge-signal', this._onHedgeSignal);
    this.hedgeExecutor.removeListener('hedge-filled', this._onHedgeFill);
    this.inventoryManager.removeListener('emergency', this._onEmergency);
  }

  // --- Event Handlers ---

  _onPriceUpdate(aggregatedPrice) {
    if (!this.isRunning) return;

    // Update MD freshness timestamp FIRST (so we know if data is arriving)
    this._lastMdUpdateTime = Date.now();

    // Continue operational mark-to-market even while quoting is gated.
    if (aggregatedPrice.weightedMidpoint) {
      this._lastMidPrice = aggregatedPrice.weightedMidpoint;
      this.pnlTracker.markToMarket(aggregatedPrice.weightedMidpoint);
    }

    if (!this.fixOE.isLoggedOn) {
      this.quoteEngine.suspendQuoting();
      this.quoteEngine.invalidateQueuedWork?.(true);
      this.logger.warn('[WATCHDOG] Quoting gate closed: OE not logged on');
      return;
    }

    // Check dual-session gate: both OE and MD must be logged on
    if (this.marketDataFeed) {
      if (this.marketDataFeed.isLoggedOn === false) {
        this.quoteEngine.suspendQuoting();
        this.quoteEngine.invalidateQueuedWork?.(true);
        this.logger.warn('[WATCHDOG] Quoting gate closed: MD not logged on');
        return;
      }
    }

    // Re-enable quoting gate if MD data is flowing again (was closed by staleness)
    if (!this._quotingGateEnabled) {
      this._quotingGateEnabled = true;
      this.quoteEngine.resumeQuoting();
      this.logger.info('[WATCHDOG] Quoting gate re-enabled: fresh MD update received');
    }

    // Feed price to QuoteEngine (gate passed)
    this.quoteEngine.resumeQuoting();
    if (this.marketDataFeed?.getBestBidAsk) {
      this.quoteEngine.updateTrueXBook(this.marketDataFeed.getBestBidAsk());
    }
    this.quoteEngine.onPriceUpdate(aggregatedPrice);
    this._lastRepriceTime = Date.now();
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
        this._addPipelineFillOnce(pipeline, fill);
      }
    }
  }

  _onQuoteFill({ side, price, size, clOrdID, execID, orderIntent, liquidityRoleExpected, isMaker = true }) {
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
      isMaker,
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
      orderIntent: orderIntent || (isMaker ? 'maker_quote' : 'taker_opportunity'),
      liquidityRoleExpected: liquidityRoleExpected || (isMaker ? 'maker' : 'taker'),
      isMaker,
      timestamp: Date.now(),
    };
    if (this.dataPipeline) {
      this._addPipelineFillOnce(this.dataPipeline, fillRecord);
    } else if (this.auditLogger) {
      this.auditLogger.logFillEvent(fillRecord);
    }

    this.emit('fill', { side, price, size, clOrdID, execID, venue: 'truex', orderIntent, liquidityRoleExpected, isMaker });
  }

  _addPipelineFillOnce(pipeline, fill) {
    if (!pipeline?.addFill) return;
    const fillId = fill.fillId || `${fill.orderId || fill.clOrdID || 'unknown'}-${fill.execID || 'unknown'}`;
    if (this._recordedPipelineFillIds.has(fillId)) return;
    this._recordedPipelineFillIds.add(fillId);
    pipeline.addFill({ ...fill, fillId });
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

  /**
   * Handle OE FIX disconnect or logout.
   *
   * In-flight local orders may still be live on the venue if the disconnect
   * raced with order entry or cancel processing. Restore both 'pending' and
   * 'cancelling' orders to active state, discard stale replacement intent, and
   * force a fresh reprice after reconnect while preserving late-ack recovery
   * state for venue-facing cancels.
   */
  _onOEDisconnect() {
    if (!this.isRunning) return;
    this.quoteEngine.suspendQuoting();
    this.quoteEngine.invalidateQueuedWork?.(true);
    let restoredPending = 0;
    let restoredCancelling = 0;
    for (const [clOrdID, order] of this.quoteEngine.activeOrders) {
      if (order.status === 'cancelling') {
        this.quoteEngine.clearPendingReplacement?.(clOrdID);
        order.status = 'active';
        restoredCancelling++;
        continue;
      }
      if (order.status === 'pending') {
        this.quoteEngine.clearPendingReplacement?.(clOrdID);
        order.status = 'active';
        restoredPending++;
      }
    }
    if (restoredPending > 0 || restoredCancelling > 0) {
      this.logger.warn(
        `[Orchestrator] OE disconnected — restored ${restoredPending} pending and ${restoredCancelling} cancelling order(s)`
      );
    }
  }

  _startTruexEbboPoller() {
    if (!this.restClient || this.truexEbboPollIntervalMs <= 0) return;
    this._scheduleNextTruexEbboPoll(0);
    this.logger.info(
      `[Orchestrator] TrueX EBBO poll enabled (every ${this.truexEbboPollIntervalMs}ms, timeout ${this.truexEbboPollTimeoutMs}ms)`
    );
  }

  _scheduleNextTruexEbboPoll(delayMs = this.truexEbboPollIntervalMs) {
    if (!this.isRunning) return;
    if (this._truexEbboPollTimer) {
      clearTimeout(this._truexEbboPollTimer);
    }
    this._truexEbboPollTimer = setTimeout(() => {
      this._pollTruexEbbo().catch((err) => {
        this.logger.warn(`[Orchestrator] TrueX EBBO poll loop error (non-fatal): ${err.message}`);
      });
    }, delayMs);
  }

  _buildPyusdUsdReferenceSources(configuredSources) {
    const fallbackSources = [
      { type: 'kraken-rest', pair: 'PYUSD/USD' },
      { type: 'kraken-rest', pair: 'PYUSDUSD' },
    ];

    if (!Array.isArray(configuredSources) || configuredSources.length === 0) {
      return fallbackSources;
    }

    return configuredSources
      .filter((source) => source && typeof source.type === 'string')
      .map((source) => ({
        type: source.type,
        pair: source.pair || null,
      }));
  }

  _startPyusdUsdPoller() {
    if (!this.krakenRestClient || this.pyusdUsdPollIntervalMs <= 0 || this.pyusdUsdReferenceSources.length === 0) return;
    this._scheduleNextPyusdUsdPoll(0);
    this.logger.info(
      `[Orchestrator] PYUSD/USD reference poll enabled (every ${this.pyusdUsdPollIntervalMs}ms, timeout ${this.pyusdUsdPollTimeoutMs}ms)`
    );
  }

  _scheduleNextPyusdUsdPoll(delayMs = this.pyusdUsdPollIntervalMs) {
    if (!this.isRunning) return;
    if (this._pyusdUsdPollTimer) {
      clearTimeout(this._pyusdUsdPollTimer);
    }
    this._pyusdUsdPollTimer = setTimeout(() => {
      this._pollPyusdUsdReference().catch((err) => {
        this.logger.warn(`[Orchestrator] PYUSD/USD poll loop error (non-fatal): ${err.message}`);
      });
    }, delayMs);
  }

  _isPyusdUsdFresh(reference = this.pyusdUsd) {
    if (!reference?.timestamp) return false;
    return Date.now() - reference.timestamp <= this.pyusdUsdStaleThresholdMs;
  }

  async _fetchPyusdUsdReferenceFromSource(source) {
    if (source?.type !== 'kraken-rest') {
      throw new Error(`Unsupported PYUSD/USD reference source: ${source?.type || 'unknown'}`);
    }
    if (!this.krakenRestClient) {
      throw new Error('Kraken REST client unavailable for PYUSD/USD reference poll');
    }

    const ticker = await this.krakenRestClient.getTicker(source.pair || 'PYUSD/USD', {
      timeoutMs: this.pyusdUsdPollTimeoutMs,
    });
    return {
      price: ticker.last,
      bid: ticker.bid,
      ask: ticker.ask,
      timestamp: ticker.timestamp,
      source: source.type,
      pair: source.pair || ticker.symbol,
    };
  }

  async _pollPyusdUsdReference() {
    if (!this.isRunning || !this.krakenRestClient) return;
    if (this._pyusdUsdPollInFlight) {
      this.logger.warn('[Orchestrator] PYUSD/USD poll still in flight — skipping overlapping tick');
      this._scheduleNextPyusdUsdPoll(this._pyusdUsdCurrentBackoffMs || this.pyusdUsdPollIntervalMs);
      return;
    }

    this._pyusdUsdPollInFlight = true;
    try {
      const candidates = this.pyusdUsdReferenceSources.length > 0
        ? this.pyusdUsdReferenceSources
        : this._buildPyusdUsdReferenceSources();
      let lastError = null;
      let reference = null;

      for (const source of candidates) {
        try {
          reference = await this._fetchPyusdUsdReferenceFromSource(source);
          break;
        } catch (err) {
          lastError = err;
        }
      }

      if (!reference) {
        throw lastError || new Error('PYUSD/USD reference poll returned no usable source');
      }

      this.pyusdUsd = reference;
      const hadFailureAlert = this._pyusdUsdFailureAlertActive;
      this._pyusdUsdConsecutiveErrors = 0;
      this._pyusdUsdCurrentBackoffMs = this.pyusdUsdPollIntervalMs;
      this._pyusdUsdLastSuccessAt = Date.now();
      this._pyusdUsdFailureAlertActive = false;

      if (hadFailureAlert) {
        this.alertManager.sendRecovery({ reason: 'PYUSD/USD reference poll failing' })
          .catch((err) => this.logger.error(`[Orchestrator] PYUSD/USD recovery alert failed: ${err.message}`));
      }
    } catch (err) {
      this._pyusdUsdConsecutiveErrors++;
      this._pyusdUsdCurrentBackoffMs = Math.min(
        this.pyusdUsdMaxBackoffMs,
        Math.max(
          this.pyusdUsdPollIntervalMs,
          Math.ceil(this._pyusdUsdCurrentBackoffMs * 1.5),
        ),
      );

      this.logger.warn(
        `[Orchestrator] PYUSD/USD poll failed (${this._pyusdUsdConsecutiveErrors} consecutive): ${err.message}`
      );

      if (
        this._pyusdUsdConsecutiveErrors >= this.pyusdUsdFailureAlertThreshold &&
        !this._pyusdUsdFailureAlertActive
      ) {
        this._pyusdUsdFailureAlertActive = true;
        this.alertManager.sendAlert({
          reason: 'PYUSD/USD reference poll failing',
          level: 'error',
          details: {
            consecutiveErrors: this._pyusdUsdConsecutiveErrors,
            backoffMs: this._pyusdUsdCurrentBackoffMs,
            symbol: this.symbol,
          },
        }).catch((alertErr) =>
          this.logger.error(`[Orchestrator] PYUSD/USD alert failed: ${alertErr.message}`)
        );
      }
    } finally {
      this._pyusdUsdPollInFlight = false;
      if (this.isRunning) {
        this._scheduleNextPyusdUsdPoll(this._pyusdUsdCurrentBackoffMs || this.pyusdUsdPollIntervalMs);
      }
    }
  }

  async _resolveTruexEbboInstrumentId() {
    if (this.truexEbboInstrumentId) return this.truexEbboInstrumentId;
    const instrument = await this.restClient.getInstrument(this.symbol);
    if (!instrument?.id) {
      throw new Error(`TrueX instrument lookup failed for ${this.symbol}`);
    }
    this.truexEbboInstrumentId = instrument.id;
    return this.truexEbboInstrumentId;
  }

  async _pollTruexEbbo() {
    if (!this.isRunning || !this.restClient) return;
    if (this._truexEbboPollInFlight) {
      this.logger.warn('[Orchestrator] TrueX EBBO poll still in flight — skipping overlapping tick');
      this._scheduleNextTruexEbboPoll(this._truexEbboCurrentBackoffMs || this.truexEbboPollIntervalMs);
      return;
    }

    this._truexEbboPollInFlight = true;
    try {
      const instrumentId = await this._resolveTruexEbboInstrumentId();
      const rawQuote = await this.restClient.getMarketQuote(
        { instrument_id: instrumentId },
        { timeoutMs: this.truexEbboPollTimeoutMs }
      );
      const parsed = MarketMakerOrchestrator.parseMarketQuote(rawQuote, {
        instrumentId,
        symbol: this.symbol,
      });
      this.quoteEngine.updateTruexEbbo(parsed);

      const hadFailureAlert = this._truexEbboFailureAlertActive;
      this._truexEbboConsecutiveErrors = 0;
      this._truexEbboCurrentBackoffMs = this.truexEbboPollIntervalMs;
      this._truexEbboLastSuccessAt = Date.now();
      this._truexEbboFailureAlertActive = false;

      if (hadFailureAlert) {
        this.alertManager.sendRecovery({ reason: 'TrueX EBBO poll failing' })
          .catch((err) => this.logger.error(`[Orchestrator] TrueX EBBO recovery alert failed: ${err.message}`));
      }
    } catch (err) {
      this._truexEbboConsecutiveErrors++;
      const status = err?.status || err?.cause?.status;
      const multiplier = status === 429 ? 2 : 1.5;
      this._truexEbboCurrentBackoffMs = Math.min(
        this.truexEbboMaxBackoffMs,
        Math.max(
          this.truexEbboPollIntervalMs,
          Math.ceil(this._truexEbboCurrentBackoffMs * multiplier),
        ),
      );

      this.logger.warn(
        `[Orchestrator] TrueX EBBO poll failed (${this._truexEbboConsecutiveErrors} consecutive): ${err.message}`
      );

      if (
        this._truexEbboConsecutiveErrors >= this.truexEbboFailureAlertThreshold &&
        !this._truexEbboFailureAlertActive
      ) {
        this._truexEbboFailureAlertActive = true;
        this.alertManager.sendAlert({
          reason: 'TrueX EBBO poll failing',
          level: 'error',
          details: {
            consecutiveErrors: this._truexEbboConsecutiveErrors,
            backoffMs: this._truexEbboCurrentBackoffMs,
            symbol: this.symbol,
          },
        }).catch((alertErr) =>
          this.logger.error(`[Orchestrator] TrueX EBBO alert failed: ${alertErr.message}`)
        );
      }
    } finally {
      this._truexEbboPollInFlight = false;
      if (this.isRunning) {
        this._scheduleNextTruexEbboPoll(this._truexEbboCurrentBackoffMs || this.truexEbboPollIntervalMs);
      }
    }
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
        baseBalance = { available: parsed.available, held: parsed.held, total: parsed.total, transferHold: parsed.transferHold || 0 };
      } else if (name === quoteAsset) {
        quoteBalance = { available: parsed.available, held: parsed.held, total: parsed.total, transferHold: parsed.transferHold || 0 };
      }
    }

    // Guard: if neither balance was matched, asset name resolution failed entirely
    if (!baseBalance && !quoteBalance) {
      throw new Error(
        `Balance name resolution failed — no balances matched for ${baseAsset} or ${quoteAsset}. ` +
        `Raw balances had ${summary.balances.length} entries. Check asset name mapping.`
      );
    }

    this.logger.info(
      `[Orchestrator] Balances: ${baseAsset}=${baseBalance ? baseBalance.available : 0} avail / ${baseBalance ? baseBalance.total : 0} total, ` +
      `${quoteAsset}=${quoteBalance ? quoteBalance.available : 0} avail / ${quoteBalance ? quoteBalance.total : 0} total`
    );

    return { baseBalance, quoteBalance };
  }

  // --- Balance Snapshots ---

  /**
   * Take a single balance snapshot and persist it to the balance_snapshots table.
   * Errors are caught and logged as warnings — this method NEVER throws.
   */
  async _takeBalanceSnapshot() {
    if (!this.postgresManager) return;

    try {
      const position = this.inventoryManager.getPositionSummary();
      const btcQty = position.baseBalance?.available ?? 0;
      const pyusdQty = position.quoteBalance?.available ?? 0;
      const midPrice = this._lastMidPrice;
      const portfolioValue = midPrice !== null ? btcQty * midPrice + pyusdQty : null;

      const sql = `
        INSERT INTO balance_snapshots (session_id, timestamp, btc_qty, pyusd_qty, btc_mid_price, portfolio_value_pyusd)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (session_id, timestamp) DO NOTHING
        RETURNING id
      `;
      const result = await this.postgresManager.db.query(sql, [
        this.sessionId,
        Date.now(),
        btcQty,
        pyusdQty,
        midPrice,
        portfolioValue,
      ]);
      if (result.rows.length === 0) {
        this.logger.warn('[Orchestrator] balance snapshot skipped (timestamp conflict — duplicate within same ms)');
      }
    } catch (err) {
      this.logger.warn(`[Orchestrator] balance snapshot failed: ${err.message}`);
    }
  }

  // --- Watchdog ---

  /**
   * Check whether the MD feed has gone stale.
   * Returns true and triggers order cancellation if stale; false otherwise.
   */
  _checkMdStaleness() {
    if (!this.marketDataFeed || this._lastMdUpdateTime === 0) return false;
    const age = Date.now() - this._lastMdUpdateTime;
    if (age > this._mdStaleThresholdMs) {
      this.logger.error(`[WATCHDOG] MD feed stale (${age}ms > ${this._mdStaleThresholdMs}ms) — cancelling all orders`);
      // Cancel via REST if available
      if (this.restClient) {
        this._cancelAllOrdersViaRest('md-stale').catch(err =>
          this.logger.error(`[WATCHDOG] REST cancel failed: ${err.message}`)
        );
      }
      // Cancel via QuoteEngine (FIX)
      this.quoteEngine.cancelAllQuotes('md-stale');
      // Close the quoting gate until fresh MD data arrives
      this._quotingGateEnabled = false;
      // Attempt MD reconnect
      if (this.marketDataFeed && (typeof this.marketDataFeed.restart === 'function' || typeof this.marketDataFeed.connect === 'function')) {
        this.logger.info('[WATCHDOG] Attempting MD feed reconnect...');
        const reconnect = typeof this.marketDataFeed.restart === 'function'
          ? this.marketDataFeed.restart.bind(this.marketDataFeed)
          : this.marketDataFeed.connect.bind(this.marketDataFeed);
        reconnect().catch(err =>
          this.logger.error(`[WATCHDOG] MD reconnect failed: ${err.message}`)
        );
      }
      return true;
    }
    return false;
  }

  /**
   * Cancel all active orders via REST client.
   * Calls cancelAllOrders() if available, otherwise iterates getActiveOrders().
   */
  async _cancelAllOrdersViaRest(reason) {
    this.logger.info(`[WATCHDOG] Cancelling all orders via REST (reason: ${reason})`);
    if (typeof this.restClient.cancelAllOrders === 'function') {
      await this.restClient.cancelAllOrders();
      return;
    }
    // Fallback: iterate and cancel individually
    const orders = await this.restClient.getActiveOrders();
    for (const raw of orders) {
      try {
        await this.restClient.cancelOrder(raw.id);
      } catch (err) {
        this.logger.warn(`[WATCHDOG] REST cancel of ${raw.id} failed: ${err.message}`);
      }
    }
  }

  /**
   * Periodic health check: runs every 30s while the market maker is active.
   * Emits 'watchdog-alert' with a list of issues if any are found.
   */
  _runWatchdog() {
    if (!this.isRunning || this._intentionalStop) return;
    const now = Date.now();
    const issues = [];

    // Check OE FIX
    if (!this.fixOE.isLoggedOn) {
      issues.push('OE FIX not logged on');
    }

    // Check market data readiness
    if (this.marketDataFeed && !this.marketDataFeed.isLoggedOn) {
      issues.push('MD feed not ready');
    }

    // Check MD staleness
    const mdStale = this._checkMdStaleness();
    if (mdStale) {
      issues.push('MD feed stale');
    }

    // Check quoting idle (only if we have non-zero balances expected)
    const repriceAge = this._lastRepriceTime > 0 ? now - this._lastRepriceTime : null;
    if (repriceAge !== null && repriceAge > this._quotingIdleThresholdMs) {
      const position = this.inventoryManager.getPositionSummary();
      const baseTotal = position.baseBalance?.total ?? 0;
      const quoteTotal = position.quoteBalance?.total ?? 0;
      const hasBalance = baseTotal > 0 || quoteTotal > 0;
      if (hasBalance) {
        issues.push(`Quoting idle for ${Math.round(repriceAge / 1000)}s`);
      }
    }

    const currentKeys = new Set(issues.map((i) => normalizeAlertReason(i)));
    for (const prev of this._activeWatchdogIssues) {
      if (!currentKeys.has(prev)) {
        this.alertManager.sendRecovery({ reason: prev })
          .catch(err => this.logger.error(`[WATCHDOG] Recovery alert failed: ${err.message}`));
      }
    }
    this._activeWatchdogIssues = currentKeys;

    if (issues.length > 0) {
      const msg = `[WATCHDOG] Health check failed: ${issues.join('; ')}`;
      this.logger.error(msg);
      this.emit('watchdog-alert', { issues, timestamp: now });

      // Fire alerts (deduplication handled by AlertManager)
      const position = this.inventoryManager.getPositionSummary();
      this.alertManager.sendAlert({
        reason: issues.join('; '),
        level: 'error',
        details: { position, issues },
      }).catch(err => this.logger.error(`[WATCHDOG] Alert send failed: ${err.message}`));

      // Cancel all orders via REST (safety net)
      if (this.restClient) {
        this._cancelAllOrdersViaRest('watchdog').catch(err =>
          this.logger.error(`[WATCHDOG] REST cancel on watchdog failed: ${err.message}`)
        );
      }

      // Force-reconnect failed sessions (FR-2.2 step 4)
      if (!this.fixOE.isLoggedOn) {
        this.logger.info('[WATCHDOG] Force-reconnecting OE FIX session...');
        this.fixOE.connect().catch(err =>
          this.logger.error(`[WATCHDOG] OE reconnect failed: ${err.message}`)
        );
      }
      if (this.marketDataFeed && !mdStale && !this.marketDataFeed.isLoggedOn &&
        (typeof this.marketDataFeed.restart === 'function' || typeof this.marketDataFeed.connect === 'function')) {
        this.logger.info('[WATCHDOG] Force-reconnecting market data feed...');
        const reconnect = typeof this.marketDataFeed.restart === 'function'
          ? this.marketDataFeed.restart.bind(this.marketDataFeed)
          : this.marketDataFeed.connect.bind(this.marketDataFeed);
        reconnect().catch(err =>
          this.logger.error(`[WATCHDOG] MD reconnect failed: ${err.message}`)
        );
      }
    } else {
      this.logger.debug('[WATCHDOG] Health check OK');
    }
  }

  /**
   * Return a structured health status snapshot for API consumers.
   */
  getHealthStatus() {
    const now = Date.now();
    const lastRepriceAge = this._lastRepriceTime > 0 ? now - this._lastRepriceTime : null;
    const lastMdAge = this._lastMdUpdateTime > 0 ? now - this._lastMdUpdateTime : null;
    const oeConnected = this.fixOE.isLoggedOn;
    const mdConnected = this.marketDataFeed ? (this.marketDataFeed.isLoggedOn === true) : null;
    const uptime = this.startedAt ? now - this.startedAt : 0;

    // Status logic
    const quotingIdle = lastRepriceAge !== null && lastRepriceAge > this._quotingIdleThresholdMs;
    const bothConnected = oeConnected && (mdConnected === null || mdConnected === true);
    const isHealthy = !quotingIdle && bothConnected && this.isRunning;
    const isUnhealthy = quotingIdle || !oeConnected || mdConnected === false;

    let status;
    if (isHealthy) {
      status = 'healthy';
    } else if (!isUnhealthy && this.isRunning) {
      status = 'degraded';
    } else {
      status = 'unhealthy';
    }

    const position = this.inventoryManager.getPositionSummary();
    return {
      status,
      quoting: this.isRunning && !quotingIdle,
      lastRepriceAge,
      oeConnected,
      mdConnected,
      lastMdAge,
      activeOrders: this.quoteEngine.activeOrders?.size ?? 0,
      position,
      balances: position.balancesInitialized
        ? { base: position.baseBalance, quote: position.quoteBalance }
        : null,
      lastFill: typeof this.pnlTracker.getLastFill === 'function'
        ? this.pnlTracker.getLastFill()
        : null,
      pnl: this.pnlTracker.getSummary(),
      uptime,
      sessionId: this.sessionId,
    };
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
