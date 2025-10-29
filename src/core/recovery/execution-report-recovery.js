/**
 * ExecutionReportRecovery (7.1)
 *
 * Detects missing executions/fills by comparing the AuditLogger JSONL
 * against Redis state, and can replay missing fills into Redis safely.
 */
export class ExecutionReportRecovery {
  constructor({ auditLogger, redisManager, dataManager, logger } = {}) {
    if (!auditLogger) throw new Error('auditLogger is required');
    if (!redisManager) throw new Error('redisManager is required');

    this.auditLogger = auditLogger;
    this.redis = redisManager;
    this.data = dataManager; // optional, used for in-memory dedup if present
    this.logger = logger || console;
  }

  /**
   * Detect fills present in the audit log but missing from Redis by execID.
   */
  async detectMissingExecutions(sessionId, { date = null } = {}) {
    const session = await this.auditLogger.recoverSessionData(sessionId, date);
    const auditFills = Array.isArray(session?.fills) ? session.fills : [];

    // Build set of execIDs from audit log
    const auditExecs = new Map();
    for (const entry of auditFills) {
      const fd = entry?.fillData || entry; // tolerate direct-format entries
      const execID = fd?.execID;
      if (!execID) continue;
      // prefer last occurrence for most complete payload
      auditExecs.set(execID, fd);
    }

    // Fetch existing Redis fills and build set of execIDs
    const redisFills = await this.redis.getAllFills();
    const redisExecSet = new Set((redisFills || []).map(f => f.execID).filter(Boolean));

    // Compute differences
    const missing = [];
    for (const [execID, fill] of auditExecs.entries()) {
      if (!redisExecSet.has(execID)) {
        missing.push(this.normalizeFillFromAudit(fill));
      }
    }

    return {
      auditExecsCount: auditExecs.size,
      redisExecsCount: redisExecSet.size,
      missingCount: missing.length,
      missing
    };
  }

  /**
   * Attempt to replay missing executions into Redis.
   * Returns a summary including results from redis.flushFills().
   */
  async recoverMissingExecutions(sessionId, { date = null } = {}) {
    const detection = await this.detectMissingExecutions(sessionId, { date });
    if (!detection.missingCount) {
      this.logger.info('[ExecutionReportRecovery] No missing executions detected');
      return { ...detection, flushed: { success: 0, failed: 0, skipped: 0, errors: [] } };
    }

    // Optionally prime in-memory layer to avoid immediate dup writes elsewhere
    if (this.data && typeof this.data.addFill === 'function') {
      for (const f of detection.missing) {
        try { this.data.addFill(f); } catch { /* ignore */ }
      }
    }

    const flushed = await this.redis.flushFills(detection.missing);
    this.logger.info(`[ExecutionReportRecovery] Replayed ${flushed.success}/${detection.missingCount} missing fills (failed=${flushed.failed}, skipped=${flushed.skipped})`);
    return { ...detection, flushed };
  }

  /**
   * Normalize a fill object recovered from audit into Redis manager shape.
   */
  normalizeFillFromAudit(fillData) {
    if (!fillData) return null;
    const sessionId = fillData.sessionId;
    const execID = fillData.execID;
    const orderId = fillData.orderId;
    const fillId = fillData.fillId || (orderId && execID ? `${orderId}-${execID}` : execID);

    return {
      fillId,
      execID,
      orderId,
      exchangeOrderId: fillData.exchangeOrderId,
      sessionId,
      symbol: fillData.symbol,
      side: fillData.side,
      quantity: fillData.quantity,
      price: fillData.price,
      fee: fillData.fee,
      feeAsset: fillData.feeAsset,
      total: fillData.total,
      netTotal: fillData.netTotal,
      timestamp: fillData.timestamp || Date.now(),
      receivedAt: fillData.receivedAt,
      execType: fillData.execType,
      ordStatus: fillData.ordStatus,
      source: fillData.source || 'audit-recovery',
      data: {
        executionReport: fillData.data?.executionReport,
        originalFIXMessage: fillData.data?.originalFIXMessage
      },
      deduplicationKey: fillData.deduplicationKey || (sessionId && execID ? `${sessionId}_${execID}` : undefined)
    };
  }
}
