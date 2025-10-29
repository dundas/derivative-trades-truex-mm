import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ExecutionReportRecovery } from './execution-report-recovery.js';

describe('ExecutionReportRecovery (7.1)', () => {
  let auditLogger;
  let redisManager;
  let dataManager;
  let logger;
  let rec;

  beforeEach(() => {
    logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    auditLogger = {
      recoverSessionData: jest.fn()
    };
    redisManager = {
      getAllFills: jest.fn().mockResolvedValue([]),
      flushFills: jest.fn().mockResolvedValue({ success: 0, failed: 0, skipped: 0, errors: [] })
    };
    dataManager = {
      addFill: jest.fn()
    };
    rec = new ExecutionReportRecovery({ auditLogger, redisManager, dataManager, logger });
  });

  it('detects missing executions by comparing audit vs redis', async () => {
    // Audit has two fills; Redis has one of them
    auditLogger.recoverSessionData.mockResolvedValue({
      fills: [
        { fillData: { sessionId: 'S', orderId: 'OID-1', execID: 'E1', symbol: 'BTC/USD', quantity: 1, price: 100 } },
        { fillData: { sessionId: 'S', orderId: 'OID-2', execID: 'E2', symbol: 'BTC/USD', quantity: 2, price: 101 } }
      ]
    });
    redisManager.getAllFills.mockResolvedValue([
      { execID: 'E1', orderId: 'OID-1' }
    ]);

    const res = await rec.detectMissingExecutions('S');
    expect(res.auditExecsCount).toBe(2);
    expect(res.redisExecsCount).toBe(1);
    expect(res.missingCount).toBe(1);
    expect(res.missing[0].execID).toBe('E2');
  });

  it('replays missing executions into Redis and primes memory', async () => {
    auditLogger.recoverSessionData.mockResolvedValue({
      fills: [
        { fillData: { sessionId: 'S', orderId: 'OID-1', execID: 'E1', symbol: 'BTC/USD', quantity: 1, price: 100 } }
      ]
    });
    redisManager.getAllFills.mockResolvedValue([]);
    redisManager.flushFills.mockResolvedValue({ success: 1, failed: 0, skipped: 0, errors: [] });

    const res = await rec.recoverMissingExecutions('S');
    expect(dataManager.addFill).toHaveBeenCalledTimes(1);
    expect(redisManager.flushFills).toHaveBeenCalledTimes(1);
    expect(res.flushed.success).toBe(1);
  });

  it('is no-op when nothing is missing', async () => {
    auditLogger.recoverSessionData.mockResolvedValue({ fills: [] });
    redisManager.getAllFills.mockResolvedValue([]);

    const res = await rec.recoverMissingExecutions('S');
    expect(res.missingCount).toBe(0);
    expect(redisManager.flushFills).not.toHaveBeenCalled();
  });
});
