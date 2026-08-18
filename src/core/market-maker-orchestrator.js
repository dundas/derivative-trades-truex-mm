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
import { QuoteLifecycleTelemetry } from '../data-pipeline/quote-lifecycle-telemetry.js';
import { ReferenceMarkoutCollector } from '../data-pipeline/reference-markout-collector.js';
import { CapitalReservationManager } from './capital-reservation-manager.js';
import { MakerPresenceController } from './maker-presence-controller.js';

function strictPositiveRestNumber(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function captureLocalReconciliationOrder(orderId, order, capitalManager) {
  const reservation = capitalManager?.getReservation?.(orderId) || null;
  return Object.freeze({
    ref: order,
    status: order?.status,
    acknowledgedLive: order?.acknowledgedLive,
    side: order?.side,
    size: order?.size,
    price: order?.price,
    level: order?.level,
    capitalState: reservation?.state,
    capitalAcknowledgedLive: reservation?.acknowledgedLive,
    capitalRemainingSize: reservation?.remainingSize,
    capitalMutationSequence: reservation?.lastMutationSequence,
  });
}

function localReconciliationOrderUnchanged(snapshot, current, orderId, capitalManager) {
  if (!snapshot || !current || current !== snapshot.ref) return false;
  const latest = captureLocalReconciliationOrder(orderId, current, capitalManager);
  return snapshot.status === latest.status &&
    snapshot.acknowledgedLive === latest.acknowledgedLive &&
    snapshot.side === latest.side && snapshot.size === latest.size &&
    snapshot.price === latest.price && snapshot.level === latest.level &&
    snapshot.capitalState === latest.capitalState &&
    snapshot.capitalAcknowledgedLive === latest.capitalAcknowledgedLive &&
    snapshot.capitalRemainingSize === latest.capitalRemainingSize &&
    snapshot.capitalMutationSequence === latest.capitalMutationSequence;
}

function isStableLocalOrder(order) {
  return order && order.status !== 'pending' && order.status !== 'cancelling';
}

function positiveIntegerOption(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

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
      // Default ON: after 3 consecutive logon timeouts, fall back to
      // ResetSeqNumFlag=Y so a counterparty FIX-gateway restart doesn't
      // wedge us in a multi-hour session-resume loop. FIXConnection is the
      // sole validator — unset / NaN / 0 / negative all coerce to defaults.
      logonResetFallbackEnabled: process.env.FIX_LOGON_RESET_FALLBACK !== 'false',
      logonResetThreshold: parseInt(process.env.FIX_LOGON_RESET_THRESHOLD, 10),
      maxConsecutiveResetFallbacks: parseInt(process.env.FIX_MAX_LOGON_RESET_FALLBACKS, 10),
    });

    this.inventoryManager = options.inventoryManager || new InventoryManager({
      maxPositionBTC: options.maxPositionBTC || 5.0,
      targetInventoryBTC: options.targetInventoryBTC,
      hedgeThresholdBTC: options.hedgeThresholdBTC || 2.0,
      maxSkewTicks: options.maxSkewTicks || 3,
      skewExponent: options.skewExponent || 1.5,
      emergencyLimitBTC: options.emergencyLimitBTC,
      tickSize: options.tickSize || 0.50,
      logger: this.logger,
    });

    this.capitalReservationManager = options.capitalReservationManager ||
      (options.continuityConfig ? new CapitalReservationManager(options.continuityConfig) : null);
    this.presenceController = options.presenceController ||
      (options.continuityConfig ? new MakerPresenceController(options.continuityConfig, { now: options.now || Date.now }) : null);

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
      capitalReservationManager: this.capitalReservationManager,
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
      momentumRepriceBps: options.momentumRepriceBps ?? 0, // fail-closed default; run-prod.js enables via MOMENTUM_REPRICE_BPS
      tickSize: options.tickSize || 0.50,
      minNotional: options.minNotional || 1.0,
      priceBandPct: options.priceBandPct || 2.5,
      confidenceThreshold: options.confidenceThreshold || 0.3,
      symbol: this.symbol,
      clientId: options.clientId || null,
      selfMatchPreventionInstruction: options.selfMatchPreventionInstruction ?? process.env.TRUEX_SELF_MATCH_PREVENTION_INSTRUCTION,
      truexBookStaleThresholdMs: options.truexBookStaleThresholdMs || 10000,
      pyusdUsdStaleThresholdMs: options.pyusdUsdStaleThresholdMs ?? 15000,
      marketablePostOnlyAction: options.marketablePostOnlyAction || 'skip',
      replaceMode: options.replaceMode || 'passive-safe',
      minActiveLevelsPerSide: options.continuityConfig?.minActiveLevelsPerSide ?? options.minActiveLevelsPerSide ?? 1,
      minimumFundedQuoteSize: options.continuityConfig?.minimumFundedQuoteSize ?? 0,
      degradedMaxLevels: options.continuityConfig?.degradedMaxLevels ?? 1,
      degradedSizeFactor: options.continuityConfig?.degradedSizeFactor ?? 1,
      defensiveSpreadFloorBps: options.continuityConfig?.defensiveSpreadFloorBps ?? 0,
      maxReplacementsPerSidePerCycle: options.maxReplacementsPerSidePerCycle ?? 1,
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
      truexTapeMaxAgeMs: options.truexTapeMaxAgeMs ?? 5000,
      shadowDetectionTapeMaxAgeMs: options.shadowDetectionTapeMaxAgeMs ?? 30000,
      truexTapeOutlierThresholdBps: options.truexTapeOutlierThresholdBps ?? 50,
      marketDataProvider: () => this.marketDataFeed?.getBestBidAsk?.(),
      logger: this.logger,
    });
    if (options.continuityConfig) {
      this.quoteEngine.setContinuityStateProvider?.(() => this._getContinuityStatus());
    }

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
    this.quoteTelemetry = options.quoteTelemetry || new QuoteLifecycleTelemetry({
      writer: this.postgresManager,
      logger: this.logger,
      policyId: options.policyId || 'default',
    });
    this.referenceMarkoutCollector = options.referenceMarkoutCollector ||
      (options.referenceMarkoutConfig ? new ReferenceMarkoutCollector({
        writer: this.postgresManager,
        logger: this.logger,
        config: options.referenceMarkoutConfig,
        marketProvider: () => this.lastAggregatedPrice,
        basisProvider: () => this.pyusdUsd,
      }) : null);
    this.policyVector = {
      targetInventoryBTC: Number(options.targetInventoryBTC ?? 0), maxSkewTicks: Number(options.maxSkewTicks ?? 3),
      anchorBufferTicks: Number(options.coinbaseAnchorBufferTicks ?? 1), baseSpreadBps: Number(options.baseSpreadBps ?? 50),
      levelSpacingTicks: Number(options.levelSpacingTicks ?? 1), baseSizeBTC: Number(options.baseSizeBTC ?? 0.1),
      sizeDecayFactor: Number(options.sizeDecayFactor ?? 0.8), repriceThresholdTicks: Number(options.repriceThresholdTicks ?? 1),
    };

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
    this.startupCancelVerifyTimeoutMs = positiveIntegerOption(
      options.startupCancelVerifyTimeoutMs ?? 30000,
      'startupCancelVerifyTimeoutMs',
    );
    this.startupCancelVerifyIntervalMs = positiveIntegerOption(
      options.startupCancelVerifyIntervalMs ?? 500,
      'startupCancelVerifyIntervalMs',
    );
    if (this.startupCancelVerifyIntervalMs > this.startupCancelVerifyTimeoutMs) {
      throw new Error('startupCancelVerifyIntervalMs must not exceed startupCancelVerifyTimeoutMs');
    }
    this._now = options.now || Date.now;
    this._sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    this.pyusdUsdPollIntervalMs = options.pyusdUsdPollIntervalMs ?? 0;
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
    this.truexTradePollSize = options.truexTradePollSize ?? 10;
    this.truexTradePollTimeoutMs = options.truexTradePollTimeoutMs ?? this.truexEbboPollTimeoutMs;
    this.truexTradeCacheTtlMs = options.truexTradeCacheTtlMs ?? Math.max(this.truexEbboPollIntervalMs, 1000);
    this.shadowZeroDetectionAlertThresholdMs = options.shadowZeroDetectionAlertThresholdMs ?? 300000;
    this.shadowSuppressionAlertThreshold = options.shadowSuppressionAlertThreshold ?? 5;
    this.shadowEdgeCeilingAlertThreshold = options.shadowEdgeCeilingAlertThreshold ?? 3;
    this.shadowTakeMode = options.shadowTakeMode ?? false;

    // State
    this.isRunning = false;
    this.startedAt = null;
    this._emergencyUnsafe = false;

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
    this.lastAggregatedPrice = null;
    this._shadowLastReevalAt = 0;
    this._shadowLastCoinbaseBid = null;
    this._shadowLastCoinbaseFresh = null;
    this._shadowLastConfidenceOk = null;
    this._shadowLastDetectionAt = 0;
    this._shadowZeroDetectionWindowStartedAt = 0;
    this._shadowNoDetectionAlertActive = false;
    this._shadowBasisSuppressionAlertActive = false;
    this._shadowEdgeCeilingAlertActive = false;
    this._shadowMetricsWindowStartedAt = 0;
    this._shadowMetrics = { evaluations: 0, detections: 0, basisSuppressions: 0, edgeCeilings: 0 };
    this._truexTradeTape = {
      latestTradePrice: null,
      latestTradeQty: null,
      latestTradeTs: null,
      fetchedAt: 0,
      inFlight: false,
    };

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
    this._onQuoteLifecycle = this._onQuoteLifecycle.bind(this);
    this._onHedgeSignal = this._onHedgeSignal.bind(this);
    this._onHedgeFill = this._onHedgeFill.bind(this);
    this._onEmergency = this._onEmergency.bind(this);
    this._onOEDisconnect = this._onOEDisconnect.bind(this);
    this._onCapitalResyncRequired = this._onCapitalResyncRequired.bind(this);
    this._capitalResyncInFlight = null;
    this._capitalResyncPending = false;
  }

  /**
   * Start the market maker: connect, wire events, begin quoting.
   */
  async start() {
    this.logger.info(`[Orchestrator] Starting market maker session ${this.sessionId}`);
    this._validatePyusdUsdPollingConfig();

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

    // 3. Strictly remove exchange orphans before FIX can connect or quoting can start.
    // This explicit option is the only pre-start reconciliation path; ordinary
    // periodic/manual calls remain gated on isRunning.
    if (this.restClient) {
      await this._restReconcile({ allowPreStart: true, strict: true });
    }

    // 4. Connect FIX OE
    this.logger.info('[Orchestrator] Connecting FIX OE...');
    await this.fixOE.connect();
    this.logger.info('[Orchestrator] FIX OE connected');

    // 5. Connect market data feed (optional, non-blocking) — TrueX MD FIX or e.g. Coinbase adapter
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

    // 6. Start data pipeline (optional, non-blocking)
    if (this.dataPipeline) {
      try {
        await this.dataPipeline.start();
        // The pipeline initializes its PostgreSQL manager lazily. Bind it only
        // after a successful start so telemetry degrades gracefully with no DB.
        if (!this.quoteTelemetry.writer && this.dataPipeline.pgManager) {
          this.quoteTelemetry.writer = this.dataPipeline.pgManager;
        }
        if (this.referenceMarkoutCollector && !this.referenceMarkoutCollector.writer && this.dataPipeline.pgManager) {
          this.referenceMarkoutCollector.setWriter(this.dataPipeline.pgManager);
        }
        this.logger.info('[Orchestrator] Data pipeline started');
      } catch (err) {
        this.logger.warn(`[Orchestrator] Data pipeline start failed (non-fatal): ${err.message}`);
      }
    }

    // 7. Start PnL periodic logging
    this.pnlTracker.startPeriodicLogging();

    // 8. Start quote engine drain queue timer
    this.drainQueueTimer = setInterval(() => {
      this.quoteEngine.drainQueue();
    }, this.drainQueueIntervalMs);

    // 9. Start REST reconciliation timer (if REST client configured)
    if (this.restClient) {
      this._reconcileTimer = setInterval(() => this._restReconcile(), this.reconcileIntervalMs);
      this.logger.info(`[Orchestrator] REST reconciliation enabled (every ${this.reconcileIntervalMs / 1000}s)`);

      // 10. Start periodic balance refresh (re-syncs tracked balances with exchange)
      this._balanceRefreshTimer = setInterval(
        () => this._periodicBalanceRefresh(),
        this.balanceRefreshIntervalMs,
      );
      this.logger.info(`[Orchestrator] Balance refresh enabled (every ${this.balanceRefreshIntervalMs / 1000}s)`);
    }

    // Start watchdog
    this._watchdogTimer = setInterval(() => this._runWatchdog(), 30000);
    this.logger.info('[Orchestrator] Watchdog started (30s interval)');

    // 11. Take immediate balance snapshot and start periodic timer (if postgres available)
    if (this.postgresManager) {
      await this._takeBalanceSnapshot();
      this._snapshotTimer = setInterval(() => this._takeBalanceSnapshot(), this._snapshotIntervalMs);
      this.logger.info(`[Orchestrator] Balance snapshot timer started (every ${this._snapshotIntervalMs / 1000}s)`);
    }

    this.isRunning = true;
    this.startedAt = Date.now();
    if (this.referenceMarkoutCollector?.writer) this.referenceMarkoutCollector.start();
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
    this.referenceMarkoutCollector?.stop();
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
      referenceMarkouts: this.referenceMarkoutCollector?.getStats?.() || null,
      capital: this.capitalReservationManager?.getStatus() || null,
      continuity: this._getContinuityStatus(),
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

    // OE logon-reset fallback fired (informational) — log + alert at info level
    // so ops can correlate with TrueX-side restarts.
    this.fixOE.on('logon-reset-fallback', (info) => {
      this.logger.warn(
        `[Orchestrator] FIX logon-reset fallback fired for ${info.targetCompID} ` +
        `(${info.fallbackAttempt}/${info.maxFallbacks}, after ${info.consecutiveTimeouts} timeouts)`
      );
      this.alertManager.sendAlert({
        reason: 'FIX logon-reset fallback fired',
        level: 'warn',
        details: {
          targetCompID: info.targetCompID,
          fallbackAttempt: info.fallbackAttempt,
          maxFallbacks: info.maxFallbacks,
          consecutiveTimeouts: info.consecutiveTimeouts,
        },
      });
    });

    // OE logon-reset fallback exhausted — loop guard tripped. Real cause is
    // elsewhere (creds, TrueX outage, network). Escalate hard.
    this.fixOE.on('logon-reset-fallback-exhausted', (info) => {
      this.logger.error(
        `[Orchestrator] FIX logon-reset fallback exhausted for ${info.targetCompID} ` +
        `after ${info.attempts} attempts — manual intervention likely required`
      );
      this.alertManager.sendAlert({
        reason: 'FIX logon-reset fallback exhausted',
        level: 'error',
        details: {
          targetCompID: info.targetCompID,
          attempts: info.attempts,
        },
      });
    });

    // QuoteEngine fills → Inventory + PnL
    this.quoteEngine.on('fill', this._onQuoteFill);
    this.quoteEngine.on('quote-lifecycle', this._onQuoteLifecycle);
    this.quoteEngine.on('capital-resync-required', this._onCapitalResyncRequired);

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
    this.quoteEngine.removeListener('quote-lifecycle', this._onQuoteLifecycle);
    this.quoteEngine.removeListener('capital-resync-required', this._onCapitalResyncRequired);
    this.inventoryManager.removeListener('hedge-signal', this._onHedgeSignal);
    this.hedgeExecutor.removeListener('hedge-filled', this._onHedgeFill);
    this.inventoryManager.removeListener('emergency', this._onEmergency);
  }

  // --- Event Handlers ---

  _onPriceUpdate(aggregatedPrice) {
    if (!this.isRunning) return;
    this.lastAggregatedPrice = aggregatedPrice || null;

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
    const continuity = this._getContinuityStatus();
    if (continuity) this.quoteEngine.setContinuityState(continuity);
    this.quoteEngine.onPriceUpdate(aggregatedPrice);
    this._lastRepriceTime = Date.now();

    if (this._shouldTriggerShadowReevaluation(aggregatedPrice)) {
      this._processShadowEvaluation('coinbase-update', { refreshTape: false }).catch((err) => {
        this.logger.warn(`[Orchestrator] Shadow coinbase reevaluation failed (non-fatal): ${err.message}`);
      });
    }
  }

  _onCapitalResyncRequired({ side, reason }) {
    if (this._capitalResyncInFlight) {
      this._capitalResyncPending = true;
      return this._capitalResyncInFlight;
    }
    this.logger.warn(`[Orchestrator] Capital resync required for ${side}: ${reason}`);
    this._capitalResyncInFlight = (async () => {
      do {
        this._capitalResyncPending = false;
        await this._refreshBalances({ requireLiveOrders: true, clearBlockedSides: true });
        // Re-derive from the reconciled balance snapshot; never replay the rejected size.
        this.quoteEngine.deferredRepriceNeeded = true;
        this.quoteEngine.drainQueue();
      } while (this._capitalResyncPending);
    })()
      .catch((error) => {
        this.logger.error(`[Orchestrator] Capital resync failed for ${side}: ${error.message}`);
      })
      .finally(() => {
        this._capitalResyncInFlight = null;
      });
    return this._capitalResyncInFlight;
  }

  _getContinuityStatus() {
    if (!this.presenceController || !this.capitalReservationManager) return null;
    const reservations = this.capitalReservationManager.getReservations();
    const capital = this.capitalReservationManager.getStatus();
    const mid = Number(this._lastMidPrice || this.quoteEngine.lastMid || 0);
    const status = this.presenceController.observe({
      orders: reservations,
      oeHealthy: this.fixOE.isLoggedOn === true,
      referenceHealthy: this._lastMdUpdateTime > 0 &&
        Date.now() - this._lastMdUpdateTime <= this._mdStaleThresholdMs,
      reconciliationState: capital.state === 'uninitialized' ? 'failed' : capital.state,
      fundedSizeBySide: {
        buy: mid > 0 ? this.capitalReservationManager.getQuoteCapacity('buy') / mid : 0,
        sell: this.capitalReservationManager.getQuoteCapacity('sell'),
      },
      blockedSides: capital.blockedSides,
      emergency: this._emergencyUnsafe === true,
    });
    for (const alert of status.alerts) {
      this.alertManager.sendAlert({
        reason: `Market-maker ${alert.side} side gap`,
        level: 'error',
        details: alert,
      }).catch((error) => this.logger.error(`[Orchestrator] Side-gap alert failed: ${error.message}`));
    }
    return status;
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

  _onQuoteFill({
    side, price, size, clOrdID, execID, orderIntent, liquidityRoleExpected,
    isMaker = true, estimated = false, evidenceGap = false,
  }) {
    // Route fill to InventoryManager
    this.inventoryManager.onFill({
      side,
      quantity: size,
      price,
      venue: 'truex',
      execID,
      ...(estimated ? { estimated: true } : {}),
      ...(evidenceGap ? { evidenceGap: true } : {}),
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
      ...(estimated ? { estimated: true } : {}),
      ...(evidenceGap ? { evidenceGap: true } : {}),
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
      ...(estimated ? { estimated: true } : {}),
      ...(evidenceGap ? { evidenceGap: true } : {}),
    };
    if (this.dataPipeline) {
      this._addPipelineFillOnce(this.dataPipeline, fillRecord);
    } else if (this.auditLogger) {
      this.auditLogger.logFillEvent(fillRecord);
    }

    this.emit('fill', {
      side, price, size, clOrdID, execID, venue: 'truex', orderIntent,
      liquidityRoleExpected, isMaker,
      ...(estimated ? { estimated: true } : {}),
      ...(evidenceGap ? { evidenceGap: true } : {}),
    });
  }

  _onQuoteLifecycle(event) {
    const summary = this.inventoryManager.getPositionSummary?.() || {};
    const activeOrders = this.quoteEngine.activeOrders || new Map();
    let committedExposureBTC = 0;
    for (const order of activeOrders.values()) {
      if (order.status === 'active' || order.status === 'pending') {
        committedExposureBTC += (order.side === 'buy' ? 1 : -1) * (Number(order.size) || 0);
      }
    }
    const quoteStatus = this.quoteEngine.getQuoteStatus?.() || {};
    const market = this.lastAggregatedPrice || {};
    const now = Date.now();
    const coinbase = Array.isArray(market.sources)
      ? market.sources.find(source => source?.exchange === 'coinbase') || null
      : null;
    const enrichedEvent = {
      ...event,
      decisionTimestamp: now,
      sessionId: this.sessionId,
      symbol: this.symbol,
      targetInventoryBTC: summary.targetInventoryBTC ?? this.inventoryManager.targetInventoryBTC,
      policyVector: this.policyVector,
      inventoryDeviationBTC: summary.inventoryDeviationBTC,
      committedExposureBTC,
      context: {
        coinbase: coinbase ? {
          bestBid: coinbase.bid, bestAsk: coinbase.ask,
          timestamp: coinbase.sourceTimestamp ?? null,
          receivedTimestamp: coinbase.receivedTimestamp ?? null,
        } : null,
        truexEbbo: quoteStatus.truexEbbo || null,
        fairValue: market.weightedMidpoint ?? quoteStatus.lastMid ?? null,
        feedAgeMs: market.timestamp ? Math.max(0, now - market.timestamp) : null,
        volatility: market.volatility ?? null,
        marketState: market.marketState ?? null,
      },
    };
    this.quoteTelemetry.record(enrichedEvent)
      .catch(err => this.logger.warn(`[Orchestrator] Quote telemetry failed: ${err.message}`));
    if (event.eventType === 'create' || event.eventType === 'replace') {
      this.referenceMarkoutCollector?.recordQuoteDecision(enrichedEvent);
    } else if ((event.eventType === 'partial_fill' || event.eventType === 'full_fill') && event.executionId) {
      this.referenceMarkoutCollector?.scheduleFill({
        fillId: `${event.quoteId}-${event.executionId}`,
        executionId: event.executionId,
        quoteId: event.quoteId,
        sessionId: this.sessionId,
        fillTimestamp: now,
        decisionTimestamp: null,
        side: event.side,
        level: event.level,
        policyId: this.quoteTelemetry.policyId,
        price: event.price,
        size: event.size,
      });
    }
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
    this._emergencyUnsafe = true;

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
    if (this.pyusdUsdPollIntervalMs <= 0 || this.pyusdUsdReferenceSources.length === 0 || !this.krakenRestClient) return;
    this._scheduleNextPyusdUsdPoll(0);
    this.logger.info(
      `[Orchestrator] PYUSD/USD reference poll enabled (every ${this.pyusdUsdPollIntervalMs}ms, timeout ${this.pyusdUsdPollTimeoutMs}ms)`
    );
  }

  _validatePyusdUsdPollingConfig() {
    if (this.pyusdUsdPollIntervalMs <= 0) return;
    if (!this.krakenRestClient && this.pyusdUsdReferenceSources.some((source) => source.type === 'kraken-rest')) {
      throw new Error('PYUSD/USD reference polling requires options.krakenRestClient for kraken-rest sources');
    }
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

  _extractCoinbaseSource(aggregatedPrice = this.lastAggregatedPrice) {
    if (!Array.isArray(aggregatedPrice?.sources)) return null;
    return aggregatedPrice.sources.find((source) => source?.exchange === 'coinbase') || null;
  }

  _shouldTriggerShadowReevaluation(aggregatedPrice) {
    if (!this.shadowTakeMode) return false;
    const coinbaseSource = this._extractCoinbaseSource(aggregatedPrice);
    if (!coinbaseSource?.bid) return false;
    if (!this.quoteEngine?._isTruexEbboFresh?.()) return false;

    const confidenceOk = aggregatedPrice.confidence >= (this.quoteEngine?.config?.confidenceThreshold ?? 0.3);
    const coinbaseFresh = !coinbaseSource.isStale;
    const bidMovedEnough = this._shadowLastCoinbaseBid === null ||
      Math.abs(Number(coinbaseSource.bid) - Number(this._shadowLastCoinbaseBid)) >= (this.quoteEngine?.config?.tickSize ?? 0.5);
    const freshnessFlipped = this._shadowLastCoinbaseFresh !== null && coinbaseFresh !== this._shadowLastCoinbaseFresh;
    const confidenceFlipped = this._shadowLastConfidenceOk !== null && confidenceOk !== this._shadowLastConfidenceOk;
    const shouldEvaluate = bidMovedEnough || freshnessFlipped || confidenceFlipped;

    this._shadowLastCoinbaseBid = Number(coinbaseSource.bid);
    this._shadowLastCoinbaseFresh = coinbaseFresh;
    this._shadowLastConfidenceOk = confidenceOk;

    if (!shouldEvaluate) return false;

    const now = Date.now();
    const minIntervalMs = Math.max(this.truexEbboPollIntervalMs, 1);
    if (this._shadowLastReevalAt && (now - this._shadowLastReevalAt) < minIntervalMs) {
      return false;
    }

    this._shadowLastReevalAt = now;
    return true;
  }

  _normalizeTruexTradeTapeResponse(trades) {
    if (!Array.isArray(trades) || trades.length === 0) return null;
    for (const trade of trades) {
      const latestTradePrice = Number(trade?.trade_price ?? trade?.price ?? 0);
      const latestTradeQty = Number(trade?.trade_qty ?? trade?.qty ?? 0);
      const latestTradeTs = trade?.timestamp ? TrueXRESTClient.nanosToDate(String(trade.timestamp)).getTime() : null;
      if (latestTradePrice > 0 && latestTradeTs) {
        return {
          latestTradePrice,
          latestTradeQty: latestTradeQty > 0 ? latestTradeQty : null,
          latestTradeTs,
        };
      }
    }
    return null;
  }

  async _refreshTruexTradeTapeIfNeeded() {
    if (!this.isRunning || !this.restClient) return;
    const now = Date.now();
    if (this._truexTradeTape.inFlight) return;
    if (this._truexTradeTape.fetchedAt && (now - this._truexTradeTape.fetchedAt) < this.truexTradeCacheTtlMs) {
      return;
    }

    this._truexTradeTape.inFlight = true;
    try {
      const instrumentId = await this._resolveTruexEbboInstrumentId();
      const trades = await this.restClient.getMarketTrades(
        { instrument_id: instrumentId, size: this.truexTradePollSize },
        { timeoutMs: this.truexTradePollTimeoutMs },
      );
      const normalized = this._normalizeTruexTradeTapeResponse(trades);
      if (normalized) {
        this._truexTradeTape = {
          ...this._truexTradeTape,
          ...normalized,
          fetchedAt: now,
        };
      } else {
        this._truexTradeTape = {
          ...this._truexTradeTape,
          latestTradePrice: null,
          latestTradeQty: null,
          latestTradeTs: null,
          fetchedAt: now,
        };
      }
    } catch (err) {
      this.logger.warn(`[Orchestrator] TrueX trade tape refresh failed (non-fatal): ${err.message}`);
    } finally {
      this._truexTradeTape.inFlight = false;
    }
  }

  _getTruexTapeContext() {
    // Prefer the dedicated trade-tape poll (getMarketTrades) — an independent
    // recent-trades source. Fall back to the EBBO's last_trade (always present on
    // a successful EBBO poll) when the trade-tape poll is empty, so detection
    // isn't blocked purely because no recent trades were returned on a quiet
    // book. The tape-outlier check and the shadowDetectionTapeMaxAgeMs gate in
    // evaluateShadowTake still filter stale/phantom tapes downstream.
    if (this._truexTradeTape.latestTradeTs && this._truexTradeTape.latestTradePrice) {
      return {
        latestTradePrice: this._truexTradeTape.latestTradePrice,
        latestTradeQty: this._truexTradeTape.latestTradeQty,
        latestTradeTs: this._truexTradeTape.latestTradeTs,
        ageS: (Date.now() - this._truexTradeTape.latestTradeTs) / 1000,
      };
    }
    const ebbo = this.quoteEngine?.truexEbbo;
    if (ebbo?.lastTradeTs && ebbo?.lastTradePrice) {
      return {
        latestTradePrice: ebbo.lastTradePrice,
        latestTradeQty: ebbo.lastTradeQty ?? null,
        latestTradeTs: ebbo.lastTradeTs,
        ageS: (Date.now() - ebbo.lastTradeTs) / 1000,
      };
    }
    return null;
  }

  _rollShadowMetricsWindow(now = Date.now()) {
    if (!this._shadowMetricsWindowStartedAt || (now - this._shadowMetricsWindowStartedAt) > this.shadowZeroDetectionAlertThresholdMs) {
      this._shadowMetricsWindowStartedAt = now;
      this._shadowMetrics = { evaluations: 0, detections: 0, basisSuppressions: 0, edgeCeilings: 0 };
    }
  }

  _updateShadowAlerts(now = Date.now()) {
    if (this._shadowZeroDetectionWindowStartedAt > 0) {
      const noDetectionForMs = now - this._shadowZeroDetectionWindowStartedAt;
      if (noDetectionForMs >= this.shadowZeroDetectionAlertThresholdMs && !this._shadowNoDetectionAlertActive) {
        this._shadowNoDetectionAlertActive = true;
        this.alertManager.sendAlert({
          reason: 'Shadow take zero detections while market active',
          level: 'warn',
          details: { noDetectionForMs, symbol: this.symbol },
        }).catch((err) => this.logger.error(`[Orchestrator] Shadow zero-detection alert failed: ${err.message}`));
      }
    }

    if (this._shadowMetrics.basisSuppressions >= this.shadowSuppressionAlertThreshold && !this._shadowBasisSuppressionAlertActive) {
      this._shadowBasisSuppressionAlertActive = true;
      this.alertManager.sendAlert({
        reason: 'Shadow take basis suppression spike',
        level: 'warn',
        details: { count: this._shadowMetrics.basisSuppressions, symbol: this.symbol },
      }).catch((err) => this.logger.error(`[Orchestrator] Shadow basis-suppression alert failed: ${err.message}`));
    }

    if (this._shadowMetrics.edgeCeilings >= this.shadowEdgeCeilingAlertThreshold && !this._shadowEdgeCeilingAlertActive) {
      this._shadowEdgeCeilingAlertActive = true;
      this.alertManager.sendAlert({
        reason: 'Shadow take edge ceiling trips',
        level: 'warn',
        details: { count: this._shadowMetrics.edgeCeilings, symbol: this.symbol },
      }).catch((err) => this.logger.error(`[Orchestrator] Shadow edge-ceiling alert failed: ${err.message}`));
    }
  }

  _handleShadowEvaluationResult(result) {
    if (!result?.evaluation) return;
    const now = Date.now();
    const suppressReason = result.evaluation.suppressReason;
    const basisSample = {
      type: 'shadow-basis-sample',
      timestamp: result.evaluation.timestamp ?? now,
      trigger: result.evaluation.trigger ?? 'unknown',
      pyusdUsd: suppressReason === 'basis-stale' ? null : (result.evaluation.pyusdUsd ?? null),
      suppressReason: suppressReason ?? null,
      coinbaseFresh: result.evaluation.coinbaseFresh ?? null,
      wouldTake: !!result.evaluation.wouldTake,
    };
    this._rollShadowMetricsWindow(now);
    const zeroDetectionEligibleSuppressReasons = new Set([
      'coinbase-stale',
      'coinbase-low-confidence',
      'truex-ebbo-stale',
      'truex-tape-stale',
      'truex-tape-missing',
      'basis-stale',
    ]);
    const zeroDetectionEligible = !zeroDetectionEligibleSuppressReasons.has(result.evaluation.suppressReason);
    if (zeroDetectionEligible && !this._shadowZeroDetectionWindowStartedAt) {
      this._shadowZeroDetectionWindowStartedAt = now;
    } else if (!zeroDetectionEligible) {
      this._shadowZeroDetectionWindowStartedAt = 0;
      if (this._shadowNoDetectionAlertActive) {
        this._shadowNoDetectionAlertActive = false;
        this.alertManager.sendRecovery({ reason: 'Shadow take zero detections while market active' })
          .catch((err) => this.logger.error(`[Orchestrator] Shadow zero-detection recovery failed: ${err.message}`));
      }
    }
    this._shadowMetrics.evaluations++;

    if (result.evaluation.wouldTake) {
      this._shadowMetrics.detections++;
      this._shadowLastDetectionAt = now;
      this._shadowZeroDetectionWindowStartedAt = now;
      if (this._shadowNoDetectionAlertActive) {
        this._shadowNoDetectionAlertActive = false;
        this.alertManager.sendRecovery({ reason: 'Shadow take zero detections while market active' })
          .catch((err) => this.logger.error(`[Orchestrator] Shadow zero-detection recovery failed: ${err.message}`));
      }
      if (this._shadowBasisSuppressionAlertActive) {
        this._shadowBasisSuppressionAlertActive = false;
        this.alertManager.sendRecovery({ reason: 'Shadow take basis suppression spike' })
          .catch((err) => this.logger.error(`[Orchestrator] Shadow basis-suppression recovery failed: ${err.message}`));
      }
      if (this._shadowEdgeCeilingAlertActive) {
        this._shadowEdgeCeilingAlertActive = false;
        this.alertManager.sendRecovery({ reason: 'Shadow take edge ceiling trips' })
          .catch((err) => this.logger.error(`[Orchestrator] Shadow edge-ceiling recovery failed: ${err.message}`));
      }
    }

    if (suppressReason === 'basis-stale' || suppressReason === 'basis-depeg') {
      this._shadowMetrics.basisSuppressions++;
    }
    if (suppressReason === 'edge-too-high') {
      this._shadowMetrics.edgeCeilings++;
    }

    this.logger.info(`[SHADOW] ${JSON.stringify(basisSample)}`);
    for (const log of result.logs || []) {
      this.logger.info(`[SHADOW] ${JSON.stringify(log)}`);
    }

    this._updateShadowAlerts(now);
  }

  async _processShadowEvaluation(trigger, { refreshTape = false } = {}) {
    if (!this.shadowTakeMode ||
        !this.isRunning ||
        !this.lastAggregatedPrice ||
        typeof this.quoteEngine?.evaluateShadowTake !== 'function') {
      return;
    }
    if (refreshTape) {
      await this._refreshTruexTradeTapeIfNeeded();
    }
    const result = this.quoteEngine.evaluateShadowTake({
      aggregatedPrice: this.lastAggregatedPrice,
      truexTape: this._getTruexTapeContext(),
      trigger,
      now: Date.now(),
    });
    if (!result) return;
    this._handleShadowEvaluationResult(result);
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
      this.quoteEngine.updatePyusdUsd?.(reference);
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
      await this._processShadowEvaluation('truex-ebbo-poll', { refreshTape: true });

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
    this.capitalReservationManager?.reconcile({ baseBalance, quoteBalance, liveOrders: [] });

    // Log which sides we'll quote
    const [, quoteAsset] = this.symbol.split('-');
    const [baseAsset] = this.symbol.split('-');
    const canBid = this.inventoryManager.canQuote('buy');
    const canAsk = this.inventoryManager.canQuote('sell');
    this.logger.info(`[Orchestrator] Quoting: bids=${canBid ? 'YES' : 'NO (no ' + quoteAsset + ')'}, asks=${canAsk ? 'YES' : 'NO (no ' + baseAsset + ')'}`);
  }

  /**
   * Periodic recovery is bounded by balanceRefreshIntervalMs. Healthy state
   * keeps the lightweight balance-only refresh; failed/blocked capital state
   * requires one coalesced, generation-safe balance + live-order snapshot.
   */
  _periodicBalanceRefresh() {
    if (!this.restClient || !this.isRunning) return Promise.resolve();
    const capital = this.capitalReservationManager?.getStatus();
    const needsCoherentRecovery = capital &&
      (capital.state === 'failed' || capital.blockedSides.length > 0);
    if (!needsCoherentRecovery) return this._refreshBalances();
    if (this._capitalResyncInFlight) return this._capitalResyncInFlight;
    const side = capital.blockedSides.length === 1 ? capital.blockedSides[0] : 'multiple';
    return this._onCapitalResyncRequired({
      side,
      reason: 'periodic-capital-recovery',
    });
  }

  /**
   * Periodic balance refresh — re-syncs tracked balances from exchange.
   * Uses refreshBalances() which does NOT reset netPosition/VWAP.
   * Safe to call during active trading.
   */
  async _refreshBalances({ requireLiveOrders = false, clearBlockedSides = false } = {}) {
    if (!this.restClient || !this.isRunning) return;

    const generation = this.capitalReservationManager?.beginReconciliation();
    try {
      const [{ baseBalance, quoteBalance }, liveOrders] = await Promise.all([
        this._fetchBalances(),
        this.capitalReservationManager || requireLiveOrders ? this._fetchCapitalLiveOrders() : Promise.resolve([]),
      ]);
      const reconciledLiveOrders = liveOrders.map((live) => {
        const local = this.quoteEngine.activeOrders.get(live?.orderId);
        const localOrderMatches = Boolean(local &&
          local.side === live?.side &&
          Number.isFinite(Number(live?.price)) && Math.abs(Number(live.price) - Number(local.price)) <= 1e-10 &&
          Number.isFinite(Number(live?.size)) && Math.abs(Number(live.size) - Number(local.size)) <= 1e-10);
        return { ...live, localOrderMatches };
      });
      const absentLocalOrderIds = [];
      if (this.capitalReservationManager && generation) {
        const liveIds = new Set(reconciledLiveOrders.map((order) => order?.orderId).filter(Boolean));
        for (const orderId of generation.knownOrders.keys()) {
          if (liveIds.has(orderId)) continue;
          const current = this.capitalReservationManager.getReservation(orderId);
          // The absence snapshot is stale for any order mutated after the
          // request began. Only remove an unchanged acknowledged-live order.
          if (!current?.acknowledgedLive || current.lastMutationSequence > generation.eventSequence) continue;
          const reconciled = typeof this.quoteEngine.reconcileRestAbsentOrder === 'function'
            ? this.quoteEngine.reconcileRestAbsentOrder(orderId)
            : (this.quoteEngine.activeOrders.has(orderId) && this.quoteEngine.removeStaleOrder(orderId));
          if (reconciled?.changed || reconciled === true) {
            absentLocalOrderIds.push(orderId);
          }
        }
      }
      this.inventoryManager.refreshBalances({ baseBalance, quoteBalance });
      const capitalResult = this.capitalReservationManager?.reconcile({
        baseBalance,
        quoteBalance,
        liveOrders: reconciledLiveOrders,
        clearBlockedSides,
        generation,
      });
      for (const orderId of capitalResult?.promotedOrderIds || []) {
        const local = this.quoteEngine.activeOrders.get(orderId);
        if (local) {
          local.status = 'active';
          local.acknowledgedLive = true;
        }
      }
      if (absentLocalOrderIds.length > 0) {
        // removeStaleOrder created a conservative delta after this request
        // began, so this snapshot cannot absorb/unblock it. Require one more
        // coalesced fresh generation, then re-derive quotes from that state.
        if (this._capitalResyncInFlight) {
          this._capitalResyncPending = true;
        } else {
          await this._onCapitalResyncRequired({
            side: 'multiple',
            reason: 'rest-order-absence-local-state-reconciled',
          });
        }
      }
    } catch (err) {
      this.logger.warn(`[Orchestrator] Balance refresh failed (non-fatal): ${err.message}`);
      this.capitalReservationManager?.reconciliationFailed();
      if (requireLiveOrders) throw err;
    }
  }

  async _fetchCapitalLiveOrders() {
    const rawOrders = await this.restClient.getActiveOrders();
    const liveOrders = [];
    for (const raw of rawOrders) {
      const parsed = TrueXRESTClient.parseOrder(raw);
      if (!parsed.externalId || !['ACTIVE', 'CANCEL_PENDING'].includes(parsed.status)) continue;
      // Promotion evidence is intentionally read from the raw fields. The
      // general REST parser uses parseFloat and is suitable for display, but
      // would accept partial garbage ("0.01junk"). A zero/malformed live row
      // must remain visible to reconciliation as a mismatch; never substitute
      // the original quantity for missing or invalid leaves.
      const price = strictPositiveRestNumber(raw?.order_info?.price);
      const size = strictPositiveRestNumber(raw?.leaves_qty);
      liveOrders.push({
        orderId: parsed.externalId,
        status: parsed.status,
        side: String(parsed.side).toLowerCase(),
        price,
        size,
        promotionEvidenceValid: price !== null && size !== null,
      });
    }
    return liveOrders;
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
    // Presence alerts are independently rate-limited and never feed the generic
    // watchdog cancel-all path: a missing side must preserve the funded live side.
    this._getContinuityStatus();

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

    const continuity = this._getContinuityStatus();

    // Status logic
    const quotingIdle = lastRepriceAge !== null && lastRepriceAge > this._quotingIdleThresholdMs;
    const bothConnected = oeConnected && (mdConnected === null || mdConnected === true);
    const isHealthy = !quotingIdle && bothConnected && this.isRunning;
    const isUnhealthy = quotingIdle || !oeConnected || mdConnected === false;

    let status;
    if (continuity?.executionState === 'unsafe') {
      status = 'unhealthy';
    } else if (continuity?.executionState === 'degraded') {
      status = 'degraded';
    } else if (isHealthy) {
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
      continuity,
      capital: this.capitalReservationManager?.getStatus() || null,
    };
  }

  // --- REST-based Order Reconciliation ---

  async _verifyStartupCancelPending(rawOrders) {
    let current = rawOrders;
    const startedAt = this._now();
    const maxPolls = Math.ceil(
      this.startupCancelVerifyTimeoutMs / this.startupCancelVerifyIntervalMs
    );
    let polls = 0;
    while (true) {
      const pending = current.filter((raw) => raw?.status === 'CANCEL_PENDING');
      if (pending.length === 0) return current;

      const venueIds = new Set();
      const externalIds = new Set();
      for (const raw of pending) {
        const venueId = typeof raw?.id === 'string' ? raw.id.trim() : '';
        const externalId = typeof raw?.external_id === 'string' ? raw.external_id.trim() : '';
        if (!venueId || !externalId || venueIds.has(venueId) || externalIds.has(externalId)) {
          throw new Error('invalid cancel-pending identity during strict startup reconciliation');
        }
        venueIds.add(venueId);
        externalIds.add(externalId);
      }

      const elapsed = this._now() - startedAt;
      if (!Number.isFinite(elapsed) || elapsed < 0 ||
          elapsed >= this.startupCancelVerifyTimeoutMs || polls >= maxPolls) {
        throw new Error('cancel-pending verification timed out during strict startup reconciliation');
      }
      const waitMs = Math.min(
        this.startupCancelVerifyIntervalMs,
        this.startupCancelVerifyTimeoutMs - elapsed,
      );
      await this._sleep(waitMs);
      polls++;
      current = await this.restClient.getActiveOrders();
      if (!Array.isArray(current)) {
        throw new Error('invalid active-order response during strict startup reconciliation');
      }
    }
  }

  async _restReconcile({ allowPreStart = false, strict = false, _generationFollowup = false } = {}) {
    if (!this.restClient || (!this.isRunning && !allowPreStart)) return;

    try {
      // The local side of the reconciliation must share the same request
      // boundary as the REST snapshot. Never interpret an order born or
      // mutated while the request is in flight through an older response.
      const localGeneration = new Map();
      for (const [orderId, order] of this.quoteEngine.activeOrders) {
        localGeneration.set(orderId,
          captureLocalReconciliationOrder(orderId, order, this.capitalReservationManager));
      }

      // 1. Fetch active orders from exchange via REST
      let rawExchangeOrders = await this.restClient.getActiveOrders();
      if (!Array.isArray(rawExchangeOrders)) {
        throw new Error('invalid active-order response during REST reconciliation');
      }
      if (strict) rawExchangeOrders = await this._verifyStartupCancelPending(rawExchangeOrders);

      // 2. Parse every non-transitional exchange order. Keep the array so even
      // duplicate/missing external IDs cannot collapse distinct orphan cancels.
      const exchangeOrders = [];
      const exchangeClOrdIDs = new Set();
      for (const raw of rawExchangeOrders) {
        const parsed = TrueXRESTClient.parseOrder(raw);
        if (['CANCELED', 'FILLED', 'REJECTED'].includes(parsed.status)) continue;
        // Skip transitional states
        if (parsed.status === 'NEW_PENDING' || parsed.status === 'CANCEL_PENDING') continue;
        exchangeOrders.push({ ...parsed, rawId: raw.id });
        if (parsed.externalId) exchangeClOrdIDs.add(parsed.externalId);
      }

      // 3. Build the immutable request-generation local set (skip in-flight
      // orders). Current local state is used only to prove the identity did not
      // change after the request began.
      const localClOrdIDs = new Set();
      for (const [clOrdID, snapshot] of localGeneration) {
        if (isStableLocalOrder(snapshot)) localClOrdIDs.add(clOrdID);
      }

      let generationChanged = false;
      const currentStableIds = new Set();
      for (const [orderId, order] of this.quoteEngine.activeOrders) {
        if (!isStableLocalOrder(order)) continue;
        currentStableIds.add(orderId);
        const snapshot = localGeneration.get(orderId);
        if (!snapshot || !isStableLocalOrder(snapshot) ||
            !localReconciliationOrderUnchanged(
              snapshot, order, orderId, this.capitalReservationManager)) {
          generationChanged = true;
        }
      }
      for (const orderId of localClOrdIDs) {
        if (!currentStableIds.has(orderId)) generationChanged = true;
      }

      // 4. Detect discrepancies
      let matched = 0;
      let orphansCancelled = 0;
      let ghostsRemoved = 0;
      const ghostSides = new Set();

      // Orphans: on exchange but not in local state → cancel via REST
      for (const order of exchangeOrders) {
        const extId = order.externalId;
        if (localClOrdIDs.has(extId) || this.quoteEngine.activeOrders.has(extId)) {
          matched++;
        } else {
          this.logger.warn(`[Reconcile] Orphan on exchange: ${extId} ${order.side} ${order.qty} @ ${order.price} — cancelling`);
          try {
            await this.restClient.cancelOrder(order.rawId);
            orphansCancelled++;
          } catch (err) {
            if (strict) throw err;
            this.logger.warn(`[Reconcile] Failed to cancel orphan ${extId}: ${err.message}`);
          }
        }
      }

      // Ghosts: in local state but not on exchange → remove from activeOrders
      for (const clOrdID of localClOrdIDs) {
        const snapshot = localGeneration.get(clOrdID);
        const current = this.quoteEngine.activeOrders.get(clOrdID);
        if (!localReconciliationOrderUnchanged(
          snapshot, current, clOrdID, this.capitalReservationManager
        )) continue;
        if (!exchangeClOrdIDs.has(clOrdID)) {
          this.logger.warn(`[Reconcile] Ghost in local state: ${clOrdID} — removing`);
          const ghostSide = this.quoteEngine.activeOrders.get(clOrdID)?.side;
          if (ghostSide === 'buy' || ghostSide === 'sell') ghostSides.add(ghostSide);
          this.quoteEngine.removeStaleOrder(clOrdID);
          ghostsRemoved++;
        }
      }

      // A manager-backed ghost has an unknown terminal outcome, not a proven
      // cancel. Await one coalesced fresh balance/live-order reconciliation for
      // the batch before any blocked capacity can become reusable.
      if (ghostsRemoved > 0 && this.capitalReservationManager) {
        const side = ghostSides.size === 1 ? [...ghostSides][0]
          : (ghostSides.size > 1 ? 'multiple' : 'unknown');
        await this._onCapitalResyncRequired({
          side,
          reason: 'rest-order-absence-unknown-outcome',
        });
      }

      const stats = {
        exchange: exchangeOrders.length,
        local: localClOrdIDs.size,
        matched,
        orphansCancelled,
        ghostsRemoved,
        generationChanged,
      };

      this.logger.info(
        `[Reconcile] exchange=${stats.exchange} local=${stats.local} matched=${stats.matched} ` +
        `orphans=${stats.orphansCancelled} ghosts=${stats.ghostsRemoved}`
      );

      this.emit('reconcile', stats);
      if (generationChanged && !_generationFollowup) {
        // Exactly one awaited follow-up gives changed/born orders a snapshot
        // whose request began after they became stable. Bounding this to one
        // prevents a busy venue from creating an unbounded reconcile loop;
        // the periodic job will cover any further concurrent mutation.
        stats.followup = await this._restReconcile({
          allowPreStart,
          strict,
          _generationFollowup: true,
        });
      }
      return stats;
    } catch (err) {
      if (strict) throw err;
      this.logger.error(`[Reconcile] REST reconciliation failed: ${err.message}`);
      // EventEmitter treats an unhandled `error` event as a throw. Periodic
      // reconciliation is intentionally nonfatal, while registered observers
      // still receive the existing event contract.
      if (this.listenerCount('error') > 0) {
        this.emit('error', { phase: 'reconcile', error: err });
      }
      return undefined;
    }
  }
}
