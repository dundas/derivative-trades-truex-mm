import { FIXConnection } from '../fix-protocol/fix-connection.js';
import { TrueXDataManager } from '../data-pipeline/truex-data-manager.js';
import { TrueXRedisManager } from '../data-pipeline/truex-redis-manager.js';
import { TrueXPostgreSQLManager } from '../data-pipeline/truex-postgresql-manager.js';
import { AuditLogger } from '../data-pipeline/audit-logger.js';
import { TrueXOhlcBuilder } from '../data-pipeline/ohlc-builder.js';
import { ExecutionReportRecovery } from './recovery/execution-report-recovery.js';

/**
 * TrueXMarketMaker Orchestrator
 * Wires FIX → Memory → Redis → PostgreSQL with Audit Logging and intervals.
 */
export class TrueXMarketMaker {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `truex-session-${Date.now()}`;
    this.symbol = options.symbol || 'BTC/USD';
    this.logger = options.logger || console;

    // Components
    this.auditLogger = options.auditLogger || new AuditLogger({ logger: this.logger });

    this.fix = options.fixConnection || new FIXConnection({
      host: options.fix?.host,
      port: options.fix?.port,
      senderCompID: options.fix?.senderCompID || 'CLI_CLIENT',
      targetCompID: options.fix?.targetCompID,
      apiKey: options.fix?.apiKey,
      apiSecret: options.fix?.apiSecret,
      heartbeatInterval: options.fix?.heartbeatInterval || 30,
      logger: this.logger,
      auditLogger: this.auditLogger
    });

    this.data = options.dataManager || new TrueXDataManager({ logger: this.logger });

    if (!options.redisClient) {
      throw new Error('redisClient is required');
    }
    this.redis = options.redisManager || new TrueXRedisManager({
      sessionId: this.sessionId,
      symbol: this.symbol,
      redisClient: options.redisClient,
      logger: this.logger
    });

    this.pg = options.pgManager || new TrueXPostgreSQLManager({ logger: this.logger });
    this.ohlc = options.ohlcBuilder || new TrueXOhlcBuilder({ symbol: this.symbol, logger: this.logger });

    // Recovery options
    this.enableRecoveryOnStart = options.enableRecoveryOnStart || false;
    this.executionRecovery = options.executionRecovery || null;

    // Intervals
    this.redisFlushIntervalMs = options.redisFlushIntervalMs || 1000; // 1s
    this.pgMigrateIntervalMs = options.pgMigrateIntervalMs || 5 * 60 * 1000; // 5m
    this.cleanupIntervalMs = options.cleanupIntervalMs || 30 * 60 * 1000; // 30m
    this.timers = { redis: null, pg: null, cleanup: null };

    // Bind
    this.handleFIXMessage = this.handleFIXMessage.bind(this);
  }

  async start() {
    this.logger.info('[TrueXMarketMaker] Starting orchestrator');
    await this.pg.initialize();

    // Wire FIX message handler
    this.fix.on('message', this.handleFIXMessage);

    await this.fix.connect();

    // Optional one-shot recovery before intervals
    if (this.enableRecoveryOnStart) {
      try {
        await this.runRecoveryOnce({ recover: true });
      } catch (e) {
        this.logger.error('[TrueXMarketMaker] Recovery run failed', e);
      }
    }

    // Start intervals
    this.timers.redis = setInterval(() => this.flushToRedis().catch((e) => this.logger.error(e)), this.redisFlushIntervalMs);
    this.timers.pg = setInterval(() => this.migrateToPostgres().catch((e) => this.logger.error(e)), this.pgMigrateIntervalMs);
    this.timers.cleanup = setInterval(() => this.data.cleanup(), this.cleanupIntervalMs);

    return true;
  }

  async stop() {
    this.logger.info('[TrueXMarketMaker] Stopping orchestrator');
    // Stop intervals
    for (const key of Object.keys(this.timers)) {
      if (this.timers[key]) clearInterval(this.timers[key]);
      this.timers[key] = null;
    }

    // Disconnect FIX
    try { await this.fix.disconnect(); } catch { /* noop */ }

    // Close pg
    try { await this.pg.close(); } catch { /* noop */ }

    // Close audit logger
    try { this.auditLogger.close(); } catch { /* noop */ }

    return true;
  }

  async flushToRedis() {
    // Enqueue any completed candles from builder
    const completed = this.ohlc.flushCompleteCandles(Date.now());
    for (const c of completed) this.data.addOHLC(c);
    const orders = this.data.getPendingOrders(100);
    const fills = this.data.getPendingFills(100);
    const ohlc = this.data.getPendingOHLC(100);
    if (orders.length) await this.redis.flushOrders(orders);
    if (fills.length) await this.redis.flushFills(fills);
    if (ohlc.length) await this.redis.flushOHLC(ohlc);
  }

  async migrateToPostgres() {
    await this.pg.migrateFromRedis(this.redis, this.sessionId);
  }

  // Run one-shot execution report recovery
  async runRecoveryOnce({ recover = true, date = null } = {}) {
    if (!this.executionRecovery) {
      this.executionRecovery = new ExecutionReportRecovery({
        auditLogger: this.auditLogger,
        redisManager: this.redis,
        dataManager: this.data,
        logger: this.logger
      });
    }
    if (recover) {
      return this.executionRecovery.recoverMissingExecutions(this.sessionId, { date });
    }
    return this.executionRecovery.detectMissingExecutions(this.sessionId, { date });
  }

  // Basic order placement - builds a New Order Single and logs order events
  async placeOrder({ clientOrderId, side, type = '2', size, price }) {
    const order = {
      orderId: clientOrderId || `OID-${Date.now()}`,
      clientOrderId: clientOrderId,
      sessionId: this.sessionId,
      symbol: this.symbol,
      side,
      type,
      size,
      price,
      status: 'CREATED',
      createdAt: Date.now()
    };

    // Log CREATE
    this.auditLogger.logOrderEvent('CREATED', order);
    this.data.addOrder(order);

    // Build FIX New Order Single (35=D)
    const fields = {
      '35': 'D',
      '49': this.fix.senderCompID,
      '56': this.fix.targetCompID,
      '34': this.fix.msgSeqNum.toString(),
      '52': this.fix.getUTCTimestamp(),
      '11': order.orderId, // ClOrdID
      '55': this.symbol,
      '54': side === 'buy' ? '1' : '2',
      '38': String(size),
      ...(price ? { '44': String(price) } : {}),
      '40': type // OrdType
    };

    await this.fix.sendMessage(fields);

    // Log SENT
    order.status = 'SENT';
    order.sentAt = Date.now();
    this.auditLogger.logOrderEvent('SENT', order);
    this.data.updateOrder(order.orderId, { status: 'SENT', sentAt: order.sentAt });

    return order.orderId;
  }

  // Handle inbound FIX message
  async handleFIXMessage(message) {
    const fields = message.fields || {};
    const msgType = fields['35'];
    if (msgType === '0') {
      // Heartbeat
      this.logger.debug('[TrueXMarketMaker] Heartbeat received');
      return;
    }
    if (msgType === '3') {
      // Business Message Reject
      this.handleReject(fields);
      return;
    }
    if (msgType === 'W') {
      // Market Data Snapshot Full Refresh (simplified handling if snapshot fields present)
      this.handleMarketDataSnapshot(fields);
      return;
    }
    if (msgType !== '8') return; // Execution Report only for now

    const ordStatus = fields['39'];
    const execType = fields['150'];
    const orderId = fields['11'];
    const exchangeOrderId = fields['37'];
    const execID = fields['17'];
    const symbol = fields['55'] || this.symbol;
    const lastQty = fields['32'] ? Number(fields['32']) : 0;
    const lastPx = fields['31'] ? Number(fields['31']) : undefined;

    // Update order
    const updates = { status: this.mapOrdStatus(ordStatus), exchangeOrderId, updatedAt: Date.now() };
    this.data.updateOrder(orderId, updates);

    // Audit ACK / CANCELLED / REJECTED / FILLED transitions
    const event = this.mapOrderEvent(execType, ordStatus);
    if (event) {
      const order = this.data.getOrder(orderId) || { orderId, sessionId: this.sessionId, symbol };
      const payload = { ...order, status: updates.status };
      this.auditLogger.logOrderEvent(event, payload);
    }

    // Add fill if present
    if (execID && lastQty > 0) {
      const fill = {
        fillId: `${orderId}-${execID}`,
        execID,
        orderId,
        exchangeOrderId,
        sessionId: this.sessionId,
        symbol,
        side: fields['54'] === '1' ? 'buy' : 'sell',
        quantity: lastQty,
        price: lastPx,
        timestamp: Date.now()
      };
      const added = this.data.addFill(fill);
      if (added) this.auditLogger.logFillEvent(fill);
      // Update OHLC builder from trade
      if (lastPx) {
        this.ohlc.updateWithTrade({ timestamp: Date.now(), price: lastPx, volume: lastQty, symbol });
      }
    }
  }

  handleMarketDataSnapshot(fields) {
    // If we have OHLC-like fields, update snapshot directly
    const now = Date.now();
    const symbol = fields['55'] || this.symbol;
    // First try: proper FIX MD Snapshot repeating group (268 NoMDEntries, 269 MDEntryType, 270 MDEntryPx)
    const noEntries = fields['268'] ? Number(fields['268']) : 0;
    let o, h, l, c, v;
    if (noEntries > 0) {
      for (let i = 1; i <= noEntries; i++) {
        // Support either dot or underscore separators used by our tests
        const type = fields[`269.${i}`] ?? fields[`269_${i}`];
        const pxStr = fields[`270.${i}`] ?? fields[`270_${i}`];
        const szStr = fields[`271.${i}`] ?? fields[`271_${i}`];
        const px = pxStr != null ? Number(pxStr) : undefined;
        const sz = szStr != null ? Number(szStr) : undefined;
        if (type === '4' && typeof px === 'number') o = px;      // Open
        if (type === '8' && typeof px === 'number') h = px;      // High
        if (type === '9' && typeof px === 'number') l = px;      // Low
        if (type === '7' && typeof px === 'number') c = px;      // Close
        if (type === 'B' || type === 'C' || type === '2') {
          // Optional: accumulate volume if provided (B: Trade Volume in some feeds, C: Open Interest, 2: Trade)
          if (typeof sz === 'number') v = (v || 0) + sz;
        }
      }
    }
    // Fallback mapping if custom fields present
    if (o == null && fields['O'] != null) o = Number(fields['O']);
    if (h == null && fields['H'] != null) h = Number(fields['H']);
    if (l == null && fields['L'] != null) l = Number(fields['L']);
    if (c == null && fields['C'] != null) c = Number(fields['C']);
    if (v == null && fields['V'] != null) v = Number(fields['V']);

    if ([o, h, l, c].every(vv => typeof vv === 'number')) {
      this.ohlc.updateWithSnapshot({ timestamp: now, open: o, high: h, low: l, close: c, volume: v, symbol });
    }
  }

  handleReject(fields) {
    const refMsgType = fields['372'];
    const refTagID = fields['371'];
    const reason = fields['58'];
    const orderId = fields['11'];
    this.logger.error(`[TrueXMarketMaker] Business Message Reject: refMsgType=${refMsgType} refTagID=${refTagID} reason=${reason || 'N/A'} orderId=${orderId || 'N/A'}`);
    if (orderId) {
      // Update order state and audit if we can associate with an order
      this.data.updateOrder(orderId, { status: 'REJECTED', updatedAt: Date.now() });
      const order = this.data.getOrder(orderId) || { orderId, sessionId: this.sessionId, symbol: this.symbol };
      this.auditLogger.logOrderEvent('REJECTED', { ...order, reason, refMsgType, refTagID });
    }
  }

  mapOrdStatus(ordStatus) {
    switch (ordStatus) {
      case '0': return 'OPEN'; // New
      case '1': return 'PARTIALLY_FILLED';
      case '2': return 'FILLED';
      case '4': return 'CANCELLED';
      case '8': return 'REJECTED';
      default: return 'UNKNOWN';
    }
  }

  mapOrderEvent(execType, ordStatus) {
    // Prefer execType if present
    switch (execType) {
      case '0': return 'ACKNOWLEDGED'; // New
      case '4': return 'CANCELLED';
      case '8': return 'REJECTED';
      case 'F': return 'FILLED';
      default:
        break;
    }
    // Fallback to ordStatus
    switch (ordStatus) {
      case '0': return 'ACKNOWLEDGED';
      case '2': return 'FILLED';
      case '4': return 'CANCELLED';
      case '8': return 'REJECTED';
      default: return null;
    }
  }
}
