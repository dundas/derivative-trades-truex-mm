/**
 * AuditLogRecovery (7.3)
 *
 * Rebuilds in-memory session state (orders & fills) from AuditLogger JSONL.
 * Optionally backfills Redis for durability.
 */
export class AuditLogRecovery {
  constructor({ auditLogger, dataManager, redisManager, logger } = {}) {
    if (!auditLogger) throw new Error('auditLogger is required');
    if (!dataManager) throw new Error('dataManager is required');

    this.auditLogger = auditLogger;
    this.data = dataManager;
    this.redis = redisManager || null;
    this.logger = logger || console;
  }

  /**
   * Rebuild memory from audit log for a session, returning counts and lists.
   */
  async rebuildMemoryFromAudit(sessionId, { date = null } = {}) {
    const session = await this.auditLogger.recoverSessionData(sessionId, date);

    // 1) Reconstruct orders: use last event per orderId to derive terminal state
    const ordersAdded = [];
    if (Array.isArray(session?.orders)) {
      const byOrderId = new Map();
      for (const entry of session.orders) {
        const od = entry?.orderData || entry; // tolerate direct
        const orderId = od?.orderId;
        if (!orderId) continue;
        // keep last event as the final state
        byOrderId.set(orderId, {
          orderId: od.orderId,
          clientOrderId: od.clientOrderId,
          exchangeOrderId: od.exchangeOrderId,
          sessionId: od.sessionId || sessionId,
          symbol: od.symbol,
          side: od.side,
          type: od.type,
          size: od.size,
          price: od.price,
          status: od.status || entry?.event || 'UNKNOWN',
          createdAt: od.createdAt || entry?.timestamp,
          updatedAt: od.updatedAt || entry?.timestamp
        });
      }
      for (const order of byOrderId.values()) {
        try {
          this.data.addOrder(order);
          ordersAdded.push(order);
        } catch (e) {
          this.logger.warn(`[AuditLogRecovery] Failed to add order ${order.orderId}: ${e.message}`);
        }
      }
    }

    // 2) Reconstruct fills
    const fillsAdded = [];
    if (Array.isArray(session?.fills)) {
      for (const entry of session.fills) {
        const fd = entry?.fillData || entry; // tolerate direct
        const fill = this.normalizeFill(fd);
        if (!fill) continue;
        try {
          const added = this.data.addFill(fill);
          if (added) fillsAdded.push(fill);
        } catch (e) {
          this.logger.warn(`[AuditLogRecovery] Failed to add fill ${fill.fillId}: ${e.message}`);
        }
      }
    }

    return {
      ordersAddedCount: ordersAdded.length,
      fillsAddedCount: fillsAdded.length,
      ordersAdded,
      fillsAdded
    };
  }

  /**
   * Complete recovery: rebuild memory and optionally backfill Redis for durability.
   */
  async recoverFromAuditLog(sessionId, { date = null, flushToRedis = false } = {}) {
    const summary = await this.rebuildMemoryFromAudit(sessionId, { date });

    let flushed = { orders: null, fills: null };
    if (flushToRedis && this.redis) {
      try {
        if (summary.ordersAdded.length) {
          flushed.orders = await this.redis.flushOrders(summary.ordersAdded);
        } else {
          flushed.orders = { success: 0, failed: 0, skipped: 0, errors: [] };
        }
      } catch (e) {
        this.logger.error(`[AuditLogRecovery] Failed to flush orders to Redis: ${e.message}`);
        flushed.orders = { success: 0, failed: summary.ordersAdded.length, skipped: 0, errors: [e.message] };
      }
      try {
        if (summary.fillsAdded.length) {
          flushed.fills = await this.redis.flushFills(summary.fillsAdded);
        } else {
          flushed.fills = { success: 0, failed: 0, skipped: 0, errors: [] };
        }
      } catch (e) {
        this.logger.error(`[AuditLogRecovery] Failed to flush fills to Redis: ${e.message}`);
        flushed.fills = { success: 0, failed: summary.fillsAdded.length, skipped: 0, errors: [e.message] };
      }
    }

    return { ...summary, flushed };
  }

  normalizeFill(fd) {
    if (!fd) return null;
    const sessionId = fd.sessionId;
    const execID = fd.execID;
    const orderId = fd.orderId;
    if (!execID || !orderId) return null;
    const fillId = fd.fillId || `${orderId}-${execID}`;

    return {
      fillId,
      execID,
      orderId,
      exchangeOrderId: fd.exchangeOrderId,
      sessionId,
      symbol: fd.symbol,
      side: fd.side,
      quantity: fd.quantity,
      price: fd.price,
      fee: fd.fee,
      feeAsset: fd.feeAsset,
      total: fd.total,
      netTotal: fd.netTotal,
      timestamp: fd.timestamp || Date.now(),
      receivedAt: fd.receivedAt,
      execType: fd.execType,
      ordStatus: fd.ordStatus,
      source: fd.source || 'audit-recovery',
      data: {
        executionReport: fd.data?.executionReport,
        originalFIXMessage: fd.data?.originalFIXMessage
      },
      deduplicationKey: fd.deduplicationKey || (sessionId && execID ? `${sessionId}_${execID}` : undefined)
    };
  }
}
