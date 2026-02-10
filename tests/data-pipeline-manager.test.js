import { describe, it, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { EventEmitter } from 'events';
import { DataPipelineManager } from '../src/data-pipeline/data-pipeline-manager.js';

// --- Mock factories ---

function createMockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
}

function createMockDataManager() {
  return {
    addFill: mock((fill) => fill),
    addOrder: mock((order) => order),
    updateOrder: mock((id, updates) => ({ ...updates, orderId: id })),
    getPendingOrders: mock(() => []),
    getPendingFills: mock(() => []),
    getPendingOHLC: mock(() => []),
    cleanup: mock(() => 0),
    getStats: mock(() => ({
      ordersInMemory: 0,
      fillsInMemory: 0,
      ohlcInMemory: 0,
      pendingOrders: 0,
      pendingFills: 0,
      pendingOHLC: 0,
      totalOrdersProcessed: 0,
      totalFillsProcessed: 0,
      duplicateFillsSkipped: 0,
    })),
    reset: mock(() => {}),
  };
}

function createMockRedisManager() {
  return {
    flushOrders: mock(async () => ({ success: 0, failed: 0, skipped: 0, errors: [] })),
    flushFills: mock(async () => ({ success: 0, failed: 0, skipped: 0, errors: [] })),
    flushOHLC: mock(async () => ({ success: 0, failed: 0, skipped: 0, errors: [] })),
    stats: {
      ordersFlushed: 0,
      fillsFlushed: 0,
      ohlcFlushed: 0,
      flushErrors: 0,
      lastFlushTime: 0,
      fillsDedupSkipped: 0,
    },
  };
}

function createMockPgManager() {
  return {
    initialize: mock(async () => {}),
    migrateFromRedis: mock(async () => ({
      sessions: { success: 1, failed: 0 },
      orders: { success: 5, failed: 0 },
      fills: { success: 3, failed: 0 },
      ohlc: { success: 2, failed: 0 },
    })),
    close: mock(async () => {}),
  };
}

function createMockAuditLogger() {
  return {
    logFillEvent: mock(() => true),
    logFIXMessage: mock(() => true),
    logOrderEvent: mock(() => true),
    logError: mock(() => true),
    stats: {
      fixMessagesLogged: 0,
      orderEventsLogged: 0,
      fillEventsLogged: 0,
      errorsLogged: 0,
      writeFailures: 0,
      lastWriteTime: 0,
    },
  };
}

// --- Tests ---

describe('DataPipelineManager', () => {
  let manager;
  let logger;
  let dataManager;
  let redisManager;
  let pgManager;
  let auditLogger;

  beforeEach(() => {
    logger = createMockLogger();
    dataManager = createMockDataManager();
    redisManager = createMockRedisManager();
    pgManager = createMockPgManager();
    auditLogger = createMockAuditLogger();

    manager = new DataPipelineManager({
      sessionId: 'test-session-1',
      symbol: 'BTC-PYUSD',
      logger,
      dataManager,
      redisManager,
      pgManager,
      auditLogger,
      redisFlushIntervalMs: 50,      // Fast for tests
      pgMigrationIntervalMs: 200,
      cleanupIntervalMs: 300,
    });
  });

  afterEach(async () => {
    if (manager.isRunning) {
      await manager.stop();
    }
  });

  // --- Constructor ---

  describe('constructor', () => {
    it('stores sessionId and symbol', () => {
      expect(manager.sessionId).toBe('test-session-1');
      expect(manager.symbol).toBe('BTC-PYUSD');
    });

    it('defaults symbol to BTC-PYUSD', () => {
      const m = new DataPipelineManager({ sessionId: 'x', logger });
      expect(m.symbol).toBe('BTC-PYUSD');
    });

    it('accepts injected components', () => {
      expect(manager.dataManager).toBe(dataManager);
      expect(manager.redisManager).toBe(redisManager);
      expect(manager.pgManager).toBe(pgManager);
      expect(manager.auditLogger).toBe(auditLogger);
    });

    it('defaults to not running', () => {
      expect(manager.isRunning).toBe(false);
    });

    it('is an EventEmitter', () => {
      expect(manager).toBeInstanceOf(EventEmitter);
    });
  });

  // --- Start/Stop Lifecycle ---

  describe('start()', () => {
    it('sets isRunning to true', async () => {
      await manager.start();
      expect(manager.isRunning).toBe(true);
    });

    it('starts flush timer when Redis manager is present', async () => {
      await manager.start();
      expect(manager._flushTimer).not.toBeNull();
    });

    it('starts migration timer when both Redis and PG are present', async () => {
      await manager.start();
      expect(manager._migrationTimer).not.toBeNull();
    });

    it('starts cleanup timer always', async () => {
      await manager.start();
      expect(manager._cleanupTimer).not.toBeNull();
    });

    it('skips flush timer when no Redis manager', async () => {
      manager.redisManager = null;
      await manager.start();
      expect(manager._flushTimer).toBeNull();
    });

    it('skips migration timer when no PG manager', async () => {
      manager.pgManager = null;
      await manager.start();
      expect(manager._migrationTimer).toBeNull();
    });

    it('skips migration timer when no Redis manager (PG needs Redis data)', async () => {
      manager.redisManager = null;
      await manager.start();
      expect(manager._migrationTimer).toBeNull();
    });

    it('is idempotent (calling start twice does nothing)', async () => {
      await manager.start();
      const timer1 = manager._flushTimer;
      await manager.start();
      expect(manager._flushTimer).toBe(timer1);
    });
  });

  describe('stop()', () => {
    it('sets isRunning to false', async () => {
      await manager.start();
      await manager.stop();
      expect(manager.isRunning).toBe(false);
    });

    it('clears all timers', async () => {
      await manager.start();
      expect(manager._flushTimer).not.toBeNull();
      await manager.stop();
      expect(manager._flushTimer).toBeNull();
      expect(manager._migrationTimer).toBeNull();
      expect(manager._cleanupTimer).toBeNull();
    });

    it('performs final Redis flush', async () => {
      dataManager.getPendingFills.mockReturnValueOnce([
        { fillId: 'f1', execID: 'e1', orderId: 'o1', sessionId: 's1', symbol: 'BTC-PYUSD' },
      ]);
      await manager.start();
      await manager.stop();
      expect(redisManager.flushFills).toHaveBeenCalled();
    });

    it('performs final PG migration', async () => {
      await manager.start();
      await manager.stop();
      expect(pgManager.migrateFromRedis).toHaveBeenCalled();
    });

    it('handles Redis flush error gracefully', async () => {
      redisManager.flushOrders.mockRejectedValueOnce(new Error('Redis down'));
      dataManager.getPendingOrders.mockReturnValueOnce([{ orderId: 'o1' }]);
      await manager.start();
      await manager.stop();
      expect(logger.error).toHaveBeenCalled();
      expect(manager.isRunning).toBe(false);
    });

    it('handles PG migration error gracefully', async () => {
      pgManager.migrateFromRedis.mockRejectedValueOnce(new Error('PG down'));
      await manager.start();
      await manager.stop();
      expect(logger.error).toHaveBeenCalled();
      expect(manager.isRunning).toBe(false);
    });

    it('is safe to call when not running', async () => {
      await manager.stop(); // Should not throw
      expect(manager.isRunning).toBe(false);
    });
  });

  // --- addFill ---

  describe('addFill()', () => {
    const fill = {
      fillId: 'ord1-exec1',
      execID: 'exec1',
      orderId: 'ord1',
      sessionId: 'test-session-1',
      symbol: 'BTC-PYUSD',
      side: 'buy',
      quantity: 0.5,
      price: 100000,
      timestamp: Date.now(),
    };

    it('routes fill to audit logger', () => {
      manager.addFill(fill);
      expect(auditLogger.logFillEvent).toHaveBeenCalledWith(fill);
    });

    it('routes fill to data manager', () => {
      manager.addFill(fill);
      expect(dataManager.addFill).toHaveBeenCalledWith(fill);
    });

    it('handles data manager rejection (duplicate fill) gracefully', () => {
      dataManager.addFill.mockImplementationOnce(() => { throw new Error('Duplicate fill'); });
      expect(() => manager.addFill(fill)).not.toThrow();
      expect(logger.debug).toHaveBeenCalled();
    });

    it('works without audit logger', () => {
      manager.auditLogger = null;
      expect(() => manager.addFill(fill)).not.toThrow();
      expect(dataManager.addFill).toHaveBeenCalledWith(fill);
    });
  });

  // --- addOrder ---

  describe('addOrder()', () => {
    it('routes order to data manager', () => {
      const order = { orderId: 'ord1', symbol: 'BTC-PYUSD', side: 'buy', price: 100000, size: 0.1 };
      manager.addOrder(order);
      expect(dataManager.addOrder).toHaveBeenCalledWith(order);
    });
  });

  // --- updateOrder ---

  describe('updateOrder()', () => {
    it('routes update to data manager', () => {
      manager.updateOrder('ord1', { status: 'FILLED' });
      expect(dataManager.updateOrder).toHaveBeenCalledWith('ord1', { status: 'FILLED' });
    });
  });

  // --- logFIXMessage ---

  describe('logFIXMessage()', () => {
    it('routes FIX message to audit logger', () => {
      const msg = { raw: '8=FIX.5.0SP2...' };
      const meta = { direction: 'INBOUND', msgType: '8', sessionId: 's1' };
      manager.logFIXMessage(msg, meta);
      expect(auditLogger.logFIXMessage).toHaveBeenCalledWith(msg, meta);
    });

    it('works without audit logger', () => {
      manager.auditLogger = null;
      expect(() => manager.logFIXMessage({}, {})).not.toThrow();
    });
  });

  // --- logError ---

  describe('logError()', () => {
    it('routes error to audit logger', () => {
      const err = new Error('test');
      manager.logError(err, { context: 'test' });
      expect(auditLogger.logError).toHaveBeenCalledWith(err, { context: 'test' });
    });
  });

  // --- Redis Flush Timer ---

  describe('Redis flush cycle', () => {
    it('pulls pending writes from data manager and flushes to Redis', async () => {
      const orders = [{ orderId: 'o1', symbol: 'BTC-PYUSD', sessionId: 's1' }];
      const fills = [{ fillId: 'f1', execID: 'e1', orderId: 'o1', sessionId: 's1' }];
      const ohlc = [{ symbol: 'BTC-PYUSD', interval: '1m', timestamp: 1000 }];

      dataManager.getPendingOrders.mockReturnValueOnce(orders);
      dataManager.getPendingFills.mockReturnValueOnce(fills);
      dataManager.getPendingOHLC.mockReturnValueOnce(ohlc);

      await manager.start();

      // Wait for one flush cycle
      await new Promise(r => setTimeout(r, 80));

      expect(redisManager.flushOrders).toHaveBeenCalledWith(orders);
      expect(redisManager.flushFills).toHaveBeenCalledWith(fills);
      expect(redisManager.flushOHLC).toHaveBeenCalledWith(ohlc);
      expect(manager.stats.flushCycles).toBeGreaterThanOrEqual(1);
    });

    it('emits flush-complete event when data was flushed', async () => {
      dataManager.getPendingOrders.mockReturnValueOnce([{ orderId: 'o1' }]);
      dataManager.getPendingFills.mockReturnValue([]);
      dataManager.getPendingOHLC.mockReturnValue([]);

      const events = [];
      manager.on('flush-complete', (data) => events.push(data));

      await manager.start();
      await new Promise(r => setTimeout(r, 80));

      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].orders).toBe(1);
    });

    it('does not emit flush-complete when no data to flush', async () => {
      const events = [];
      manager.on('flush-complete', (data) => events.push(data));

      await manager.start();
      await new Promise(r => setTimeout(r, 80));

      expect(events.length).toBe(0);
    });

    it('handles Redis flush error gracefully and emits error event', async () => {
      redisManager.flushOrders.mockRejectedValueOnce(new Error('Redis timeout'));
      dataManager.getPendingOrders.mockReturnValueOnce([{ orderId: 'o1' }]);

      const errors = [];
      manager.on('error', (e) => errors.push(e));

      await manager.start();
      await new Promise(r => setTimeout(r, 80));

      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0].phase).toBe('flush');
      expect(manager.stats.flushErrors).toBeGreaterThanOrEqual(1);
    });
  });

  // --- PG Migration Timer ---

  describe('PG migration cycle', () => {
    it('calls migrateFromRedis on PG manager', async () => {
      // Use very short migration interval for test
      manager.pgMigrationIntervalMs = 50;
      manager._migrationTimer = null; // Reset

      await manager.start();

      // Need to re-set timer with new interval since start() already ran
      clearInterval(manager._migrationTimer);
      manager._migrationTimer = setInterval(() => manager._migrateToPostgres(), 50);

      await new Promise(r => setTimeout(r, 80));

      expect(pgManager.migrateFromRedis).toHaveBeenCalledWith(redisManager, 'test-session-1');
      expect(manager.stats.migrationCycles).toBeGreaterThanOrEqual(1);
    });

    it('emits migration-complete event', async () => {
      const events = [];
      manager.on('migration-complete', (data) => events.push(data));

      // Call directly to avoid timer timing issues
      await manager._migrateToPostgres();

      expect(events.length).toBe(1);
      expect(events[0].fills.success).toBe(3);
    });

    it('handles PG migration error gracefully', async () => {
      pgManager.migrateFromRedis.mockRejectedValueOnce(new Error('PG error'));

      const errors = [];
      manager.on('error', (e) => errors.push(e));

      await manager._migrateToPostgres();

      expect(errors.length).toBe(1);
      expect(errors[0].phase).toBe('migration');
      expect(manager.stats.migrationErrors).toBe(1);
    });
  });

  // --- Memory Cleanup Timer ---

  describe('memory cleanup cycle', () => {
    it('calls cleanup on data manager', async () => {
      manager._cleanupMemory();
      expect(dataManager.cleanup).toHaveBeenCalled();
      expect(manager.stats.cleanupCycles).toBe(1);
    });

    it('logs when orders are evicted', () => {
      dataManager.cleanup.mockReturnValueOnce(5);
      manager._cleanupMemory();
      expect(logger.info).toHaveBeenCalled();
    });
  });

  // --- getStats ---

  describe('getStats()', () => {
    it('returns combined stats from all layers', () => {
      const stats = manager.getStats();

      expect(stats.pipeline).toBeDefined();
      expect(stats.memory).toBeDefined();
      expect(stats.redis).toBeDefined();
      expect(stats.audit).toBeDefined();
      expect(stats.isRunning).toBe(false);
      expect(stats.hasRedis).toBe(true);
      expect(stats.hasPostgres).toBe(true);
    });

    it('returns null for redis/audit when not configured', () => {
      manager.redisManager = null;
      manager.pgManager = null;
      manager.auditLogger = null;

      const stats = manager.getStats();
      expect(stats.redis).toBeNull();
      expect(stats.audit).toBeNull();
      expect(stats.hasRedis).toBe(false);
      expect(stats.hasPostgres).toBe(false);
    });
  });

  // --- Graceful degradation ---

  describe('graceful degradation', () => {
    it('works without Redis (memory-only mode)', async () => {
      manager.redisManager = null;
      manager.redisUrl = null;

      await manager.start();
      expect(manager.isRunning).toBe(true);
      expect(manager._flushTimer).toBeNull();

      const fill = { fillId: 'f1', execID: 'e1', orderId: 'o1' };
      manager.addFill(fill);
      expect(dataManager.addFill).toHaveBeenCalledWith(fill);

      await manager.stop();
    });

    it('works without PostgreSQL', async () => {
      manager.pgManager = null;

      await manager.start();
      expect(manager.isRunning).toBe(true);
      expect(manager._migrationTimer).toBeNull();

      await manager.stop();
    });

    it('works without audit logger', async () => {
      manager.auditLogger = null;

      await manager.start();
      expect(() => manager.addFill({ fillId: 'f1', execID: 'e1' })).not.toThrow();
      expect(() => manager.logFIXMessage({}, {})).not.toThrow();

      await manager.stop();
    });

    it('works in fully degraded mode (memory + audit only)', async () => {
      manager.redisManager = null;
      manager.redisUrl = null;
      manager.pgManager = null;

      await manager.start();
      expect(manager.isRunning).toBe(true);

      manager.addFill({ fillId: 'f1', execID: 'e1' });
      expect(dataManager.addFill).toHaveBeenCalled();
      expect(auditLogger.logFillEvent).toHaveBeenCalled();

      await manager.stop();
    });
  });
});
