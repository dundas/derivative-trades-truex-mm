import { describe, test, expect, beforeEach, jest } from 'bun:test';
import { EventEmitter } from 'events';
import { MarketMakerOrchestrator } from '../src/core/market-maker-orchestrator.js';

// --- Mock Factories ---

function createMockFIXConnection() {
  const fix = new EventEmitter();
  fix.isConnected = false;
  fix.isLoggedOn = false;
  fix.msgSeqNum = 1;
  fix.connect = jest.fn(async () => {
    fix.isConnected = true;
    fix.isLoggedOn = true;
  });
  fix.disconnect = jest.fn(async () => {
    fix.isConnected = false;
    fix.isLoggedOn = false;
  });
  fix.sendMessage = jest.fn();
  return fix;
}

function createMockInventoryManager() {
  const inv = new EventEmitter();
  inv.onFill = jest.fn();
  inv.getSkew = jest.fn(() => ({ bidSkewTicks: 0, askSkewTicks: 0 }));
  inv.canQuote = jest.fn(() => true);
  inv.shouldHedge = jest.fn(() => ({ shouldHedge: false }));
  inv.getPositionSummary = jest.fn(() => ({
    netPosition: 0,
    totalBought: 0,
    totalSold: 0,
    avgEntryPrice: 0,
    positionUtilization: 0,
  }));
  inv.reset = jest.fn();
  return inv;
}

function createMockPnLTracker() {
  const pnl = new EventEmitter();
  pnl.onFill = jest.fn();
  pnl.markToMarket = jest.fn();
  pnl.startPeriodicLogging = jest.fn();
  pnl.stopPeriodicLogging = jest.fn();
  pnl.getSummary = jest.fn(() => ({
    realizedPnL: 0,
    unrealizedPnL: 0,
    totalPnL: 0,
    totalFees: 0,
    numTrades: 0,
  }));
  pnl.getSessionReport = jest.fn(() => '=== PnL Session Report ===\nNet PnL: $0.00\n===========================');
  return pnl;
}

function createMockQuoteEngine() {
  const qe = new EventEmitter();
  qe.onPriceUpdate = jest.fn();
  qe.onExecutionReport = jest.fn();
  qe.cancelAllQuotes = jest.fn();
  qe.drainQueue = jest.fn();
  qe.getQuoteStatus = jest.fn(() => ({
    bidLevels: 0,
    askLevels: 0,
    activeCount: 0,
    lastMid: 0,
    isQuoting: false,
  }));
  return qe;
}

function createMockHedgeExecutor() {
  const he = new EventEmitter();
  he.executeHedge = jest.fn(async () => ({
    orderId: 'hedge-001',
    side: 'sell',
    size: 0.5,
    price: 100000,
    slippage: 0,
    type: 'limit',
  }));
  he.config = {
    minHedgeSizeBTC: 0.001,
    maxHedgeSizeBTC: 1.0,
  };
  he.getHedgeStats = jest.fn(() => ({
    totalHedges: 0,
    totalHedgedBTC: 0,
    avgSlippage: 0,
    limitFillRate: 0,
    failedHedges: 0,
  }));
  return he;
}

function createMockMarketDataFeed() {
  const md = new EventEmitter();
  md.isSubscribed = false;
  md.connect = jest.fn(async () => { md.isSubscribed = true; });
  md.disconnect = jest.fn(async () => { md.isSubscribed = false; });
  md.subscribe = jest.fn(async (symbol) => { md.isSubscribed = true; });
  md.getSpread = jest.fn(() => ({ bid: 99950, ask: 100050, spread: 100 }));
  return md;
}

function createMockPriceAggregator() {
  const pa = new EventEmitter();
  pa.getAggregatedPrice = jest.fn(() => ({
    weightedMidpoint: 100000,
    bestBid: 99950,
    bestAsk: 100050,
    confidence: 0.95,
  }));
  return pa;
}

function createMockDataManager() {
  return {
    addFill: jest.fn(),
  };
}

function createMockAuditLogger() {
  return {
    logFillEvent: jest.fn(),
  };
}

function createMockLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function createOrchestrator(overrides = {}) {
  const mocks = {
    fixConnection: createMockFIXConnection(),
    inventoryManager: createMockInventoryManager(),
    pnlTracker: createMockPnLTracker(),
    quoteEngine: createMockQuoteEngine(),
    hedgeExecutor: createMockHedgeExecutor(),
    marketDataFeed: createMockMarketDataFeed(),
    priceAggregator: createMockPriceAggregator(),
    dataManager: createMockDataManager(),
    auditLogger: createMockAuditLogger(),
    logger: createMockLogger(),
    ...overrides,
  };

  const orchestrator = new MarketMakerOrchestrator(mocks);
  return { orchestrator, mocks };
}

// --- Tests ---

describe('MarketMakerOrchestrator', () => {

  describe('constructor', () => {
    test('stores injected components', () => {
      const { orchestrator, mocks } = createOrchestrator();
      expect(orchestrator.fixOE).toBe(mocks.fixConnection);
      expect(orchestrator.inventoryManager).toBe(mocks.inventoryManager);
      expect(orchestrator.pnlTracker).toBe(mocks.pnlTracker);
      expect(orchestrator.quoteEngine).toBe(mocks.quoteEngine);
      expect(orchestrator.hedgeExecutor).toBe(mocks.hedgeExecutor);
      expect(orchestrator.marketDataFeed).toBe(mocks.marketDataFeed);
      expect(orchestrator.priceAggregator).toBe(mocks.priceAggregator);
      expect(orchestrator.dataManager).toBe(mocks.dataManager);
      expect(orchestrator.auditLogger).toBe(mocks.auditLogger);
    });

    test('sets default values', () => {
      const { orchestrator } = createOrchestrator();
      expect(orchestrator.symbol).toBe('BTC-PYUSD');
      expect(orchestrator.isRunning).toBe(false);
      expect(orchestrator.startedAt).toBeNull();
    });

    test('accepts custom symbol', () => {
      const { orchestrator } = createOrchestrator({ symbol: 'ETH-PYUSD' });
      expect(orchestrator.symbol).toBe('ETH-PYUSD');
    });

    test('accepts custom sessionId', () => {
      const { orchestrator } = createOrchestrator({ sessionId: 'test-session-1' });
      expect(orchestrator.sessionId).toBe('test-session-1');
    });

    test('generates sessionId if not provided', () => {
      const { orchestrator } = createOrchestrator();
      expect(orchestrator.sessionId).toMatch(/^mm-\d+$/);
    });

    test('uses console as default logger', () => {
      const fix = createMockFIXConnection();
      const inv = createMockInventoryManager();
      const pnl = createMockPnLTracker();
      const qe = createMockQuoteEngine();
      const he = createMockHedgeExecutor();
      const orch = new MarketMakerOrchestrator({
        fixConnection: fix,
        inventoryManager: inv,
        pnlTracker: pnl,
        quoteEngine: qe,
        hedgeExecutor: he,
      });
      expect(orch.logger).toBe(console);
    });
  });

  describe('start()', () => {
    test('connects FIX OE', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();
      expect(mocks.fixConnection.connect).toHaveBeenCalledTimes(1);
    });

    test('connects market data feed when provided', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();
      expect(mocks.marketDataFeed.connect).toHaveBeenCalledTimes(1);
      expect(mocks.marketDataFeed.subscribe).toHaveBeenCalledWith('BTC-PYUSD');
    });

    test('skips market data feed when not provided', async () => {
      const { orchestrator } = createOrchestrator({ marketDataFeed: null });
      await orchestrator.start();
      // No error should occur
      expect(orchestrator.isRunning).toBe(true);
    });

    test('handles market data feed connection failure gracefully', async () => {
      const md = createMockMarketDataFeed();
      md.connect = jest.fn(async () => { throw new Error('Connection refused'); });
      const { orchestrator, mocks } = createOrchestrator({ marketDataFeed: md });
      await orchestrator.start();
      // Should still be running despite MD failure
      expect(orchestrator.isRunning).toBe(true);
      expect(mocks.logger.warn).toHaveBeenCalled();
    });

    test('starts PnL periodic logging', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();
      expect(mocks.pnlTracker.startPeriodicLogging).toHaveBeenCalledTimes(1);
    });

    test('sets isRunning to true', async () => {
      const { orchestrator } = createOrchestrator();
      expect(orchestrator.isRunning).toBe(false);
      await orchestrator.start();
      expect(orchestrator.isRunning).toBe(true);
    });

    test('records startedAt timestamp', async () => {
      const { orchestrator } = createOrchestrator();
      const before = Date.now();
      await orchestrator.start();
      const after = Date.now();
      expect(orchestrator.startedAt).toBeGreaterThanOrEqual(before);
      expect(orchestrator.startedAt).toBeLessThanOrEqual(after);
    });

    test('emits started event', async () => {
      const { orchestrator } = createOrchestrator();
      let emitted = null;
      orchestrator.on('started', (info) => { emitted = info; });
      await orchestrator.start();
      expect(emitted).not.toBeNull();
      expect(emitted.sessionId).toBe(orchestrator.sessionId);
      expect(emitted.timestamp).toBe(orchestrator.startedAt);
    });

    test('returns true', async () => {
      const { orchestrator } = createOrchestrator();
      const result = await orchestrator.start();
      expect(result).toBe(true);
    });

    test('starts drain queue timer', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();
      expect(orchestrator.drainQueueTimer).not.toBeNull();
      // Clean up timer
      clearInterval(orchestrator.drainQueueTimer);
    });
  });

  describe('stop()', () => {
    test('returns false if not running', async () => {
      const { orchestrator } = createOrchestrator();
      const result = await orchestrator.stop();
      expect(result).toBe(false);
    });

    test('cancels all active quotes', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();
      await orchestrator.stop();
      expect(mocks.quoteEngine.cancelAllQuotes).toHaveBeenCalledWith('shutdown');
    });

    test('hedges remaining position when above minimum', async () => {
      const inv = createMockInventoryManager();
      inv.getPositionSummary = jest.fn(() => ({ netPosition: 0.5 }));
      const { orchestrator, mocks } = createOrchestrator({ inventoryManager: inv });
      await orchestrator.start();
      await orchestrator.stop();
      expect(mocks.hedgeExecutor.executeHedge).toHaveBeenCalledWith('sell', 0.5, 'urgent');
    });

    test('hedges short position correctly', async () => {
      const inv = createMockInventoryManager();
      inv.getPositionSummary = jest.fn(() => ({ netPosition: -0.3 }));
      const { orchestrator, mocks } = createOrchestrator({ inventoryManager: inv });
      await orchestrator.start();
      await orchestrator.stop();
      expect(mocks.hedgeExecutor.executeHedge).toHaveBeenCalledWith('buy', 0.3, 'urgent');
    });

    test('skips final hedge when position below minimum', async () => {
      const inv = createMockInventoryManager();
      inv.getPositionSummary = jest.fn(() => ({ netPosition: 0.0001 }));
      const { orchestrator, mocks } = createOrchestrator({ inventoryManager: inv });
      await orchestrator.start();
      await orchestrator.stop();
      expect(mocks.hedgeExecutor.executeHedge).not.toHaveBeenCalled();
    });

    test('handles final hedge failure gracefully', async () => {
      const inv = createMockInventoryManager();
      inv.getPositionSummary = jest.fn(() => ({ netPosition: 1.0 }));
      const he = createMockHedgeExecutor();
      he.executeHedge = jest.fn(async () => { throw new Error('Hedge failed'); });
      const { orchestrator, mocks } = createOrchestrator({ inventoryManager: inv, hedgeExecutor: he });
      await orchestrator.start();
      await orchestrator.stop();
      // Should still stop cleanly
      expect(orchestrator.isRunning).toBe(false);
      expect(mocks.logger.error).toHaveBeenCalled();
    });

    test('stops PnL periodic logging', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();
      await orchestrator.stop();
      expect(mocks.pnlTracker.stopPeriodicLogging).toHaveBeenCalledTimes(1);
    });

    test('clears drain queue timer', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();
      expect(orchestrator.drainQueueTimer).not.toBeNull();
      await orchestrator.stop();
      expect(orchestrator.drainQueueTimer).toBeNull();
    });

    test('disconnects market data feed', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();
      await orchestrator.stop();
      expect(mocks.marketDataFeed.disconnect).toHaveBeenCalledTimes(1);
    });

    test('disconnects FIX OE', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();
      await orchestrator.stop();
      expect(mocks.fixConnection.disconnect).toHaveBeenCalledTimes(1);
    });

    test('logs final session report', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();
      await orchestrator.stop();
      expect(mocks.pnlTracker.getSessionReport).toHaveBeenCalledTimes(1);
    });

    test('sets isRunning to false', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();
      await orchestrator.stop();
      expect(orchestrator.isRunning).toBe(false);
    });

    test('emits stopped event with summary', async () => {
      const { orchestrator } = createOrchestrator();
      let emitted = null;
      orchestrator.on('stopped', (info) => { emitted = info; });
      await orchestrator.start();
      await orchestrator.stop();
      expect(emitted).not.toBeNull();
      expect(emitted.sessionId).toBe(orchestrator.sessionId);
      expect(emitted.durationMs).toBeGreaterThanOrEqual(0);
      expect(emitted.pnl).toBeDefined();
      expect(emitted.inventory).toBeDefined();
    });

    test('returns true when successfully stopped', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();
      const result = await orchestrator.stop();
      expect(result).toBe(true);
    });

    test('handles market data disconnect failure gracefully', async () => {
      const md = createMockMarketDataFeed();
      md.disconnect = jest.fn(async () => { throw new Error('Disconnect failed'); });
      const { orchestrator } = createOrchestrator({ marketDataFeed: md });
      await orchestrator.start();
      await orchestrator.stop();
      expect(orchestrator.isRunning).toBe(false);
    });

    test('handles FIX disconnect failure gracefully', async () => {
      const fix = createMockFIXConnection();
      fix.disconnect = jest.fn(async () => { throw new Error('Disconnect failed'); });
      const { orchestrator } = createOrchestrator({ fixConnection: fix });
      await orchestrator.start();
      await orchestrator.stop();
      expect(orchestrator.isRunning).toBe(false);
    });
  });

  describe('getStatus()', () => {
    test('returns comprehensive status when running', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();
      const status = orchestrator.getStatus();

      expect(status.sessionId).toBe(orchestrator.sessionId);
      expect(status.isRunning).toBe(true);
      expect(status.startedAt).toBe(orchestrator.startedAt);
      expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
      expect(status.quotes).toBeDefined();
      expect(status.inventory).toBeDefined();
      expect(status.pnl).toBeDefined();
      expect(status.hedge).toBeDefined();
      expect(status.fixOE).toBeDefined();
      expect(status.marketData).toBeDefined();

      // Clean up
      await orchestrator.stop();
    });

    test('returns zero uptime when not running', () => {
      const { orchestrator } = createOrchestrator();
      const status = orchestrator.getStatus();
      expect(status.isRunning).toBe(false);
      expect(status.uptimeMs).toBe(0);
    });

    test('returns FIX connection state', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();
      const status = orchestrator.getStatus();
      expect(status.fixOE.isConnected).toBe(true);
      expect(status.fixOE.isLoggedOn).toBe(true);
      await orchestrator.stop();
    });

    test('returns null marketData when no feed configured', () => {
      const { orchestrator } = createOrchestrator({ marketDataFeed: null });
      const status = orchestrator.getStatus();
      expect(status.marketData).toBeNull();
    });

    test('returns market data spread when feed configured', async () => {
      const { orchestrator } = createOrchestrator();
      await orchestrator.start();
      const status = orchestrator.getStatus();
      expect(status.marketData).not.toBeNull();
      expect(status.marketData.spread).toBeDefined();
      await orchestrator.stop();
    });
  });

  describe('event wiring: price updates', () => {
    test('forwards price updates to QuoteEngine', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      const price = { weightedMidpoint: 100000, confidence: 0.95 };
      mocks.priceAggregator.emit('price', price);

      expect(mocks.quoteEngine.onPriceUpdate).toHaveBeenCalledWith(price);
      await orchestrator.stop();
    });

    test('updates PnL mark-to-market on price updates', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      const price = { weightedMidpoint: 100500, confidence: 0.95 };
      mocks.priceAggregator.emit('price', price);

      expect(mocks.pnlTracker.markToMarket).toHaveBeenCalledWith(100500);
      await orchestrator.stop();
    });

    test('ignores price updates when not running', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();
      await orchestrator.stop();

      mocks.priceAggregator.emit('price', { weightedMidpoint: 100000, confidence: 0.95 });
      // onPriceUpdate should not be called after stop
      // The handler checks isRunning
      expect(mocks.quoteEngine.onPriceUpdate).not.toHaveBeenCalled();
    });

    test('skips mark-to-market when no weightedMidpoint', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      const price = { confidence: 0.95 };
      mocks.priceAggregator.emit('price', price);

      expect(mocks.quoteEngine.onPriceUpdate).toHaveBeenCalled();
      expect(mocks.pnlTracker.markToMarket).not.toHaveBeenCalled();
      await orchestrator.stop();
    });

    test('works without priceAggregator', async () => {
      const { orchestrator } = createOrchestrator({ priceAggregator: null });
      await orchestrator.start();
      // Should not throw
      expect(orchestrator.isRunning).toBe(true);
      await orchestrator.stop();
    });
  });

  describe('event wiring: FIX execution reports', () => {
    test('routes execution reports to QuoteEngine', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      const message = {
        fields: {
          '35': '8',   // Execution Report
          '11': 'Q001',
          '39': '0',   // New
          '17': 'exec-1',
        },
      };
      mocks.fixConnection.emit('message', message);

      expect(mocks.quoteEngine.onExecutionReport).toHaveBeenCalledWith(message.fields);
      await orchestrator.stop();
    });

    test('ignores non-execution-report messages', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      const message = {
        fields: {
          '35': '0',  // Heartbeat, not execution report
        },
      };
      mocks.fixConnection.emit('message', message);

      expect(mocks.quoteEngine.onExecutionReport).not.toHaveBeenCalled();
      await orchestrator.stop();
    });

    test('ignores messages with no fields', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.fixConnection.emit('message', null);
      mocks.fixConnection.emit('message', {});

      expect(mocks.quoteEngine.onExecutionReport).not.toHaveBeenCalled();
      await orchestrator.stop();
    });

    test('logs fills to data manager when available', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      const message = {
        fields: {
          '35': '8',
          '11': 'Q001',
          '17': 'exec-1',
          '39': '2',    // Filled
          '31': '100000',
          '32': '0.1',
          '54': '1',    // Buy
        },
      };
      mocks.fixConnection.emit('message', message);

      expect(mocks.dataManager.addFill).toHaveBeenCalledTimes(1);
      const fill = mocks.dataManager.addFill.mock.calls[0][0];
      expect(fill.orderId).toBe('Q001');
      expect(fill.execID).toBe('exec-1');
      expect(fill.side).toBe('buy');
      expect(fill.quantity).toBe(0.1);
      expect(fill.price).toBe(100000);
      expect(fill.symbol).toBe('BTC-PYUSD');
      await orchestrator.stop();
    });

    test('skips data manager logging when no execID or lastQty', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      const message = {
        fields: {
          '35': '8',
          '11': 'Q001',
          '39': '0',    // New (no fill)
        },
      };
      mocks.fixConnection.emit('message', message);

      expect(mocks.dataManager.addFill).not.toHaveBeenCalled();
      await orchestrator.stop();
    });

    test('skips data manager when not available', async () => {
      const { orchestrator, mocks } = createOrchestrator({ dataManager: null });
      await orchestrator.start();

      const message = {
        fields: {
          '35': '8',
          '11': 'Q001',
          '17': 'exec-1',
          '39': '2',
          '31': '100000',
          '32': '0.1',
          '54': '2',  // Sell
        },
      };
      // Should not throw
      mocks.fixConnection.emit('message', message);
      await orchestrator.stop();
    });
  });

  describe('event wiring: quote fills', () => {
    test('routes fills to InventoryManager', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.quoteEngine.emit('fill', {
        side: 'buy',
        price: 100000,
        size: 0.1,
        clOrdID: 'Q001',
        execID: 'exec-1',
      });

      expect(mocks.inventoryManager.onFill).toHaveBeenCalledWith({
        side: 'buy',
        quantity: 0.1,
        price: 100000,
        venue: 'truex',
        execID: 'exec-1',
      });
      await orchestrator.stop();
    });

    test('routes fills to PnLTracker as maker', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.quoteEngine.emit('fill', {
        side: 'sell',
        price: 100050,
        size: 0.2,
        clOrdID: 'Q002',
        execID: 'exec-2',
      });

      expect(mocks.pnlTracker.onFill).toHaveBeenCalledTimes(1);
      const pnlCall = mocks.pnlTracker.onFill.mock.calls[0][0];
      expect(pnlCall.side).toBe('sell');
      expect(pnlCall.quantity).toBe(0.2);
      expect(pnlCall.price).toBe(100050);
      expect(pnlCall.venue).toBe('truex');
      expect(pnlCall.isMaker).toBe(true);
      await orchestrator.stop();
    });

    test('logs to audit logger when available', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.quoteEngine.emit('fill', {
        side: 'buy',
        price: 100000,
        size: 0.1,
        clOrdID: 'Q001',
        execID: 'exec-1',
      });

      expect(mocks.auditLogger.logFillEvent).toHaveBeenCalledTimes(1);
      const auditCall = mocks.auditLogger.logFillEvent.mock.calls[0][0];
      expect(auditCall.fillId).toBe('Q001-exec-1');
      expect(auditCall.symbol).toBe('BTC-PYUSD');
      await orchestrator.stop();
    });

    test('skips audit logger when not available', async () => {
      const { orchestrator, mocks } = createOrchestrator({ auditLogger: null });
      await orchestrator.start();

      // Should not throw
      mocks.quoteEngine.emit('fill', {
        side: 'buy',
        price: 100000,
        size: 0.1,
        clOrdID: 'Q001',
        execID: 'exec-1',
      });
      await orchestrator.stop();
    });

    test('emits fill event on orchestrator', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      let emitted = null;
      orchestrator.on('fill', (info) => { emitted = info; });
      await orchestrator.start();

      mocks.quoteEngine.emit('fill', {
        side: 'buy',
        price: 100000,
        size: 0.1,
        clOrdID: 'Q001',
        execID: 'exec-1',
      });

      expect(emitted).not.toBeNull();
      expect(emitted.side).toBe('buy');
      expect(emitted.price).toBe(100000);
      expect(emitted.size).toBe(0.1);
      expect(emitted.venue).toBe('truex');
      await orchestrator.stop();
    });
  });

  describe('event wiring: hedge signals', () => {
    test('triggers hedge on shouldHedge signal', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.inventoryManager.emit('hedge-signal', {
        shouldHedge: true,
        side: 'sell',
        size: 0.5,
      });

      // Allow async to complete
      await new Promise(r => setTimeout(r, 10));

      expect(mocks.hedgeExecutor.executeHedge).toHaveBeenCalledWith('sell', 0.5);
      await orchestrator.stop();
    });

    test('ignores hedge signal when shouldHedge is false', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.inventoryManager.emit('hedge-signal', {
        shouldHedge: false,
        side: 'sell',
        size: 0.5,
      });

      expect(mocks.hedgeExecutor.executeHedge).not.toHaveBeenCalled();
      await orchestrator.stop();
    });

    test('ignores hedge signal when not running', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();
      await orchestrator.stop();

      mocks.inventoryManager.emit('hedge-signal', {
        shouldHedge: true,
        side: 'sell',
        size: 0.5,
      });

      // executeHedge may have been called during stop() for final hedge
      // Reset and check no new calls
      const callsAfterStop = mocks.hedgeExecutor.executeHedge.mock.calls.length;
      mocks.inventoryManager.emit('hedge-signal', {
        shouldHedge: true,
        side: 'buy',
        size: 0.3,
      });
      expect(mocks.hedgeExecutor.executeHedge.mock.calls.length).toBe(callsAfterStop);
    });

    test('handles hedge execution failure gracefully', async () => {
      const he = createMockHedgeExecutor();
      he.executeHedge = jest.fn(async () => { throw new Error('Kraken unavailable'); });
      const { orchestrator, mocks } = createOrchestrator({ hedgeExecutor: he });
      await orchestrator.start();

      mocks.inventoryManager.emit('hedge-signal', {
        shouldHedge: true,
        side: 'sell',
        size: 0.5,
      });

      // Allow async to complete
      await new Promise(r => setTimeout(r, 20));

      expect(mocks.logger.error).toHaveBeenCalled();
      // Should still be running
      expect(orchestrator.isRunning).toBe(true);
      await orchestrator.stop();
    });
  });

  describe('event wiring: hedge fills', () => {
    test('routes hedge fills to InventoryManager', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.hedgeExecutor.emit('hedge-filled', {
        side: 'sell',
        size: 0.5,
        price: 99900,
        orderId: 'hedge-001',
        slippage: -10,
      });

      expect(mocks.inventoryManager.onFill).toHaveBeenCalledWith({
        side: 'sell',
        quantity: 0.5,
        price: 99900,
        venue: 'kraken',
        execID: 'hedge-001',
      });
      await orchestrator.stop();
    });

    test('routes hedge fills to PnLTracker as taker', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.hedgeExecutor.emit('hedge-filled', {
        side: 'sell',
        size: 0.5,
        price: 99900,
        orderId: 'hedge-001',
        slippage: -10,
      });

      const pnlCall = mocks.pnlTracker.onFill.mock.calls[0][0];
      expect(pnlCall.venue).toBe('kraken');
      expect(pnlCall.isMaker).toBe(false);
      expect(pnlCall.quantity).toBe(0.5);
      await orchestrator.stop();
    });

    test('emits hedge event on orchestrator', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      let emitted = null;
      orchestrator.on('hedge', (info) => { emitted = info; });
      await orchestrator.start();

      mocks.hedgeExecutor.emit('hedge-filled', {
        side: 'sell',
        size: 0.5,
        price: 99900,
        orderId: 'hedge-001',
        slippage: -10,
      });

      expect(emitted).not.toBeNull();
      expect(emitted.side).toBe('sell');
      expect(emitted.venue).toBe('kraken');
      expect(emitted.slippage).toBe(-10);
      await orchestrator.stop();
    });
  });

  describe('event wiring: emergency', () => {
    test('cancels all quotes on emergency', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.inventoryManager.emit('emergency', {
        netPosition: 6.0,
        reason: 'Position limit exceeded',
      });

      expect(mocks.quoteEngine.cancelAllQuotes).toHaveBeenCalledWith('emergency: Position limit exceeded');
      await orchestrator.stop();
    });

    test('emits emergency event on orchestrator', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      let emitted = null;
      orchestrator.on('emergency', (info) => { emitted = info; });
      await orchestrator.start();

      mocks.inventoryManager.emit('emergency', {
        netPosition: 6.0,
        reason: 'Position limit exceeded',
      });

      expect(emitted).not.toBeNull();
      expect(emitted.reason).toBe('Position limit exceeded');
      expect(emitted.netPosition).toBe(6.0);
      await orchestrator.stop();
    });

    test('logs emergency to error level', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.inventoryManager.emit('emergency', {
        netPosition: 6.0,
        reason: 'Position limit exceeded',
      });

      expect(mocks.logger.error).toHaveBeenCalled();
      await orchestrator.stop();
    });
  });

  describe('event unwiring on stop', () => {
    test('removes all event listeners on stop', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      // Check listeners are wired
      expect(mocks.priceAggregator.listenerCount('price')).toBe(1);
      expect(mocks.fixConnection.listenerCount('message')).toBe(1);
      expect(mocks.quoteEngine.listenerCount('fill')).toBe(1);
      expect(mocks.inventoryManager.listenerCount('hedge-signal')).toBe(1);
      expect(mocks.hedgeExecutor.listenerCount('hedge-filled')).toBe(1);
      expect(mocks.inventoryManager.listenerCount('emergency')).toBe(1);

      await orchestrator.stop();

      // All listeners should be removed
      expect(mocks.priceAggregator.listenerCount('price')).toBe(0);
      expect(mocks.fixConnection.listenerCount('message')).toBe(0);
      expect(mocks.quoteEngine.listenerCount('fill')).toBe(0);
      expect(mocks.inventoryManager.listenerCount('hedge-signal')).toBe(0);
      expect(mocks.hedgeExecutor.listenerCount('hedge-filled')).toBe(0);
      expect(mocks.inventoryManager.listenerCount('emergency')).toBe(0);
    });
  });

  describe('full flow: price → quote → fill → hedge', () => {
    test('complete fill-to-hedge lifecycle', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      // 1. Price update arrives
      const price = { weightedMidpoint: 100000, confidence: 0.95 };
      mocks.priceAggregator.emit('price', price);
      expect(mocks.quoteEngine.onPriceUpdate).toHaveBeenCalledWith(price);
      expect(mocks.pnlTracker.markToMarket).toHaveBeenCalledWith(100000);

      // 2. Quote gets filled on TrueX
      mocks.quoteEngine.emit('fill', {
        side: 'buy',
        price: 99950,
        size: 0.5,
        clOrdID: 'Q001',
        execID: 'exec-1',
      });

      // Verify fill routed to inventory and PnL
      expect(mocks.inventoryManager.onFill).toHaveBeenCalledTimes(1);
      expect(mocks.pnlTracker.onFill).toHaveBeenCalledTimes(1);

      // 3. Inventory emits hedge signal
      mocks.inventoryManager.emit('hedge-signal', {
        shouldHedge: true,
        side: 'sell',
        size: 0.5,
      });

      await new Promise(r => setTimeout(r, 10));
      expect(mocks.hedgeExecutor.executeHedge).toHaveBeenCalledWith('sell', 0.5);

      // 4. Hedge fills back on Kraken
      mocks.hedgeExecutor.emit('hedge-filled', {
        side: 'sell',
        size: 0.5,
        price: 99900,
        orderId: 'hedge-001',
        slippage: -50,
      });

      // Verify hedge fill routed to inventory and PnL
      expect(mocks.inventoryManager.onFill).toHaveBeenCalledTimes(2);
      expect(mocks.pnlTracker.onFill).toHaveBeenCalledTimes(2);

      await orchestrator.stop();
    });

    test('full flow with FIX execution report', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      // FIX exec report for a fill
      const message = {
        fields: {
          '35': '8',
          '11': 'Q001',
          '17': 'exec-1',
          '39': '2',     // Filled
          '31': '100000',
          '32': '0.1',
          '54': '2',     // Sell
        },
      };
      mocks.fixConnection.emit('message', message);

      // QuoteEngine gets the exec report
      expect(mocks.quoteEngine.onExecutionReport).toHaveBeenCalledWith(message.fields);

      // DataManager gets the fill
      expect(mocks.dataManager.addFill).toHaveBeenCalledTimes(1);
      const fill = mocks.dataManager.addFill.mock.calls[0][0];
      expect(fill.side).toBe('sell');
      expect(fill.quantity).toBe(0.1);

      await orchestrator.stop();
    });
  });

  describe('drain queue timer', () => {
    test('calls drainQueue periodically', async () => {
      const { orchestrator, mocks } = createOrchestrator({ drainQueueIntervalMs: 50 });
      await orchestrator.start();

      // Wait for at least 2 intervals
      await new Promise(r => setTimeout(r, 130));

      expect(mocks.quoteEngine.drainQueue.mock.calls.length).toBeGreaterThanOrEqual(2);
      await orchestrator.stop();
    });
  });
});
