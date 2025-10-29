import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuditLogRecovery } from './audit-log-recovery.js';

class MockDataManager {
  constructor() {
    this.addOrder = jest.fn();
    this.addFill = jest.fn().mockImplementation((fill) => fill);
  }
}

describe('AuditLogRecovery (7.3)', () => {
  let auditLogger;
  let dataManager;
  let redisManager;
  let logger;
  let rec;

  beforeEach(() => {
    logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    auditLogger = { recoverSessionData: jest.fn() };
    dataManager = new MockDataManager();
    redisManager = {
      flushOrders: jest.fn().mockResolvedValue({ success: 1, failed: 0, skipped: 0, errors: [] }),
      flushFills: jest.fn().mockResolvedValue({ success: 2, failed: 0, skipped: 0, errors: [] })
    };
    rec = new AuditLogRecovery({ auditLogger, dataManager, redisManager, logger });
  });

  it('rebuilds memory from audit: uses last order event as final state', async () => {
    auditLogger.recoverSessionData.mockResolvedValue({
      orders: [
        { timestamp: 1, type: 'ORDER_EVENT', event: 'CREATED', orderData: { orderId: 'OID-1', sessionId: 'S', symbol: 'BTC/USD', status: 'CREATED' } },
        { timestamp: 2, type: 'ORDER_EVENT', event: 'FILLED',  orderData: { orderId: 'OID-1', sessionId: 'S', symbol: 'BTC/USD', status: 'FILLED' } },
        { timestamp: 3, type: 'ORDER_EVENT', event: 'SENT',    orderData: { orderId: 'OID-2', sessionId: 'S', symbol: 'BTC/USD', status: 'SENT' } }
      ],
      fills: [
        { fillData: { sessionId: 'S', orderId: 'OID-1', execID: 'E1', symbol: 'BTC/USD', quantity: 1, price: 100 } },
        { fillData: { sessionId: 'S', orderId: 'OID-1', execID: 'E2', symbol: 'BTC/USD', quantity: 1, price: 101 } }
      ]
    });

    const summary = await rec.rebuildMemoryFromAudit('S');
    expect(dataManager.addOrder).toHaveBeenCalledTimes(2);
    // The stored OID-1 should reflect the last event's status
    const addedOID1 = dataManager.addOrder.mock.calls.map(c => c[0]).find(o => o.orderId === 'OID-1');
    expect(addedOID1.status).toBe('FILLED');

    expect(dataManager.addFill).toHaveBeenCalledTimes(2);
    expect(summary.ordersAddedCount).toBe(2);
    expect(summary.fillsAddedCount).toBe(2);
  });

  it('recoverFromAuditLog optionally flushes to Redis', async () => {
    auditLogger.recoverSessionData.mockResolvedValue({
      orders: [ { timestamp: 2, type: 'ORDER_EVENT', event: 'FILLED', orderData: { orderId: 'OID-1', sessionId: 'S', symbol: 'BTC/USD', status: 'FILLED' } } ],
      fills: [ { fillData: { sessionId: 'S', orderId: 'OID-1', execID: 'E1', symbol: 'BTC/USD', quantity: 1, price: 100 } } ]
    });

    const res = await rec.recoverFromAuditLog('S', { flushToRedis: true });

    expect(redisManager.flushOrders).toHaveBeenCalledTimes(1);
    expect(redisManager.flushFills).toHaveBeenCalledTimes(1);
    expect(res.flushed.orders.success).toBe(1);
    expect(res.flushed.fills.success).toBe(2); // mocked to 2
  });

  it('normalizeFill sets deduplicationKey', () => {
    const fd = { sessionId: 'S', orderId: 'OID-1', execID: 'E1', symbol: 'BTC/USD' };
    const f = rec.normalizeFill(fd);
    expect(f.deduplicationKey).toBe('S_E1');
  });
});
