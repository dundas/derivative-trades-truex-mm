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
  qe.activeOrders = new Map();
  qe.config = {
    confidenceThreshold: 0.3,
    tickSize: 0.5,
  };
  qe.onPriceUpdate = jest.fn();
  qe.updateTruexEbbo = jest.fn();
  qe.updatePyusdUsd = jest.fn();
  qe.evaluateShadowTake = jest.fn(() => ({ logs: [], evaluation: null }));
  qe._isTruexEbboFresh = jest.fn(() => true);
  qe.onExecutionReport = jest.fn();
  qe.onOrderCancelReject = jest.fn();
  qe.cancelAllQuotes = jest.fn();
  qe.invalidateQueuedWork = jest.fn();
  qe.clearPendingReplacement = jest.fn();
  qe.suspendQuoting = jest.fn();
  qe.resumeQuoting = jest.fn();
  qe.drainQueue = jest.fn();
  qe.getQuoteStatus = jest.fn(() => ({
    bidLevels: 0,
    askLevels: 0,
    activeCount: 0,
    lastMid: 0,
    isQuoting: false,
    truexEbbo: null,
    pyusdUsd: null,
    pyusdUsdFresh: false,
    pyusdBasisSuppressed: true,
    shadowTakeMode: false,
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

function createMockKrakenRestClient() {
  return {
    getTicker: jest.fn(async () => ({
      exchange: 'kraken',
      symbol: 'PYUSD/USD',
      timestamp: Date.now(),
      bid: 1.0,
      ask: 1.0001,
      last: 1.00005,
      volume24h: 1000,
    })),
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
    krakenRestClient: createMockKrakenRestClient(),
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

    test('forwards targetInventoryBTC into InventoryManager and exposes it in runtime status', () => {
      const targetInventoryBTC = 0.4;
      const { orchestrator } = createOrchestrator({ inventoryManager: undefined, targetInventoryBTC });

      expect(orchestrator.inventoryManager.targetInventoryBTC).toBe(targetInventoryBTC);
      const inventory = orchestrator.getStatus().inventory;
      expect(inventory.targetInventoryBTC).toBe(targetInventoryBTC);
      expect(inventory.inventoryDeviationBTC).toBe(-targetInventoryBTC);
      expect(inventory.inventoryDeviationSide).toBe('below-target');
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

  describe('TrueX EBBO poller', () => {
    test('parses the live nested /market/quote payload shape', () => {
      const parsed = MarketMakerOrchestrator.parseMarketQuote([
        {
          id: '78873627520270354',
          symbol: 'BTC-PYUSD',
          info: {
            last_trade: {
              price: '63888.6',
              qty: '0.00008',
              timestamp: '1781794363428309171',
            },
            best_bid: {
              price: '63788.5',
              qty: '0.008',
              order_count: '1',
              last_update: '1781794727328321122',
            },
            best_ask: {
              price: '63933.4',
              qty: '0.00008',
              order_count: '2',
              last_update: '1781794942928366811',
            },
            last_update: '1781794942928366896',
          },
        },
      ], { instrumentId: '78873627520270354', symbol: 'BTC-PYUSD' });

      expect(parsed.bestBid).toBe(63788.5);
      expect(parsed.bestAsk).toBe(63933.4);
      expect(parsed.bestBidQty).toBe(0.008);
      expect(parsed.bestAskQty).toBe(0.00008);
      expect(parsed.bestBidOrderCount).toBe(1);
      expect(parsed.bestAskOrderCount).toBe(2);
      expect(parsed.lastTradePrice).toBe(63888.6);
      expect(parsed.lastTradeQty).toBe(0.00008);
      expect(parsed.lastTradeTs).toBeGreaterThan(0);
      expect(parsed.timestamp).toBeGreaterThanOrEqual(parsed.lastTradeTs);
    });

    test('throws a clear error when /market/quote returns an empty array', () => {
      expect(() => MarketMakerOrchestrator.parseMarketQuote([], {
        instrumentId: '78873627520270354',
        symbol: 'BTC-PYUSD',
      })).toThrow('TrueX EBBO poll returned empty array');
    });

    test('parses the legacy flat /market/quote payload shape when encountered', () => {
      const parsed = MarketMakerOrchestrator.parseMarketQuote({
        instrument_id: 'legacy-1',
        symbol: 'BTC-PYUSD',
        bid_price: '100.25',
        ask_price: '100.75',
        bid_qty: '0.03',
        ask_qty: '0.04',
        timestamp: '1781794942928366896',
      });

      expect(parsed).toEqual(expect.objectContaining({
        instrumentId: 'legacy-1',
        symbol: 'BTC-PYUSD',
        bestBid: 100.25,
        bestAsk: 100.75,
        bestBidQty: 0.03,
        bestAskQty: 0.04,
        bestBidOrderCount: null,
        bestAskOrderCount: null,
        lastTradePrice: null,
        lastTradeQty: null,
      }));
      expect(parsed.timestamp).toBeGreaterThan(0);
    });

    test('polls /market/quote into quoteEngine.updateTruexEbbo without touching maker paths', async () => {
      const alertManager = { sendAlert: jest.fn(async () => ({})), sendRecovery: jest.fn(async () => ({})) };
      const { orchestrator, mocks } = createOrchestrator({ alertManager, truexEbboPollIntervalMs: 1000, shadowTakeMode: true });
      orchestrator.restClient = {
        getInstrument: jest.fn(async () => ({ id: '78873627520270354' })),
        getMarketQuote: jest.fn(async () => ([
          {
            id: '78873627520270354',
            symbol: 'BTC-PYUSD',
            info: {
              best_bid: { price: '100', qty: '0.01', order_count: '1', last_update: '1781794727328321122' },
              best_ask: { price: '101', qty: '0.02', order_count: '2', last_update: '1781794942928366811' },
              last_trade: { price: '100.5', qty: '0.001', timestamp: '1781794363428309171' },
              last_update: '1781794942928366896',
            },
          },
        ])),
      };
      orchestrator.isRunning = true;
      orchestrator._scheduleNextTruexEbboPoll = jest.fn();

      await orchestrator._pollTruexEbbo();

      expect(orchestrator.restClient.getInstrument).toHaveBeenCalledWith('BTC-PYUSD');
      expect(orchestrator.restClient.getMarketQuote).toHaveBeenCalledWith(
        { instrument_id: '78873627520270354' },
        { timeoutMs: orchestrator.truexEbboPollTimeoutMs },
      );
      expect(mocks.quoteEngine.updateTruexEbbo).toHaveBeenCalledWith(expect.objectContaining({
        bestBid: 100,
        bestAsk: 101,
        bestBidQty: 0.01,
        bestAskQty: 0.02,
      }));
      expect(mocks.quoteEngine.onPriceUpdate).not.toHaveBeenCalled();
      expect(mocks.fixConnection.sendMessage).not.toHaveBeenCalled();
      expect(alertManager.sendAlert).not.toHaveBeenCalled();
    });

    test('backs off and alerts after sustained poll failures', async () => {
      const alertManager = { sendAlert: jest.fn(async () => ({})), sendRecovery: jest.fn(async () => ({})) };
      const { orchestrator } = createOrchestrator({
        alertManager,
        truexEbboPollIntervalMs: 1000,
        truexEbboFailureAlertThreshold: 2,
      });
      orchestrator.restClient = {
        getInstrument: jest.fn(async () => ({ id: '78873627520270354' })),
        getMarketQuote: jest.fn(async () => {
          const err = new Error('rate limited');
          err.status = 429;
          throw err;
        }),
      };
      orchestrator.isRunning = true;
      orchestrator._scheduleNextTruexEbboPoll = jest.fn();

      await orchestrator._pollTruexEbbo();
      await orchestrator._pollTruexEbbo();

      expect(orchestrator._truexEbboConsecutiveErrors).toBe(2);
      expect(orchestrator._truexEbboCurrentBackoffMs).toBeGreaterThan(1000);
      expect(alertManager.sendAlert).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'TrueX EBBO poll failing',
      }));
    });

    test('skips overlapping ticks while a poll is already in flight', async () => {
      const { orchestrator } = createOrchestrator({ truexEbboPollIntervalMs: 1000 });
      orchestrator.restClient = {
        getInstrument: jest.fn(async () => ({ id: '78873627520270354' })),
        getMarketQuote: jest.fn(async () => ([])),
      };
      orchestrator.isRunning = true;
      orchestrator._truexEbboPollInFlight = true;
      orchestrator._scheduleNextTruexEbboPoll = jest.fn();

      await orchestrator._pollTruexEbbo();

      expect(orchestrator.restClient.getInstrument).not.toHaveBeenCalled();
      expect(orchestrator._scheduleNextTruexEbboPoll).toHaveBeenCalled();
    });

    test('does not start the poller when explicitly disabled with interval 0', () => {
      const { orchestrator } = createOrchestrator({ truexEbboPollIntervalMs: 0 });
      orchestrator.restClient = {
        getInstrument: jest.fn(),
        getMarketQuote: jest.fn(),
      };
      orchestrator._scheduleNextTruexEbboPoll = jest.fn();

      orchestrator._startTruexEbboPoller();

      expect(orchestrator.truexEbboPollIntervalMs).toBe(0);
      expect(orchestrator._scheduleNextTruexEbboPoll).not.toHaveBeenCalled();
    });

    test('invokes the shadow evaluation path from the EBBO poll without touching FIX sends', async () => {
      const alertManager = { sendAlert: jest.fn(async () => ({})), sendRecovery: jest.fn(async () => ({})) };
      const { orchestrator, mocks } = createOrchestrator({ alertManager, truexEbboPollIntervalMs: 1000, shadowTakeMode: true });
      orchestrator.restClient = {
        getInstrument: jest.fn(async () => ({ id: '78873627520270354' })),
        getMarketQuote: jest.fn(async () => ([
          {
            id: '78873627520270354',
            symbol: 'BTC-PYUSD',
            info: {
              best_bid: { price: '100', qty: '0.01', order_count: '1', last_update: '1781794727328321122' },
              best_ask: { price: '101', qty: '0.02', order_count: '2', last_update: '1781794942928366811' },
              last_trade: { price: '100.5', qty: '0.001', timestamp: '1781794363428309171' },
              last_update: '1781794942928366896',
            },
          },
        ])),
        getMarketTrades: jest.fn(async () => ([
          { trade_price: '100.0', trade_qty: '0.1', timestamp: '1781794942928366896' },
        ])),
      };
      orchestrator.lastAggregatedPrice = {
        confidence: 0.95,
        sources: [{ exchange: 'coinbase', bid: 99.5, isStale: false }],
      };
      mocks.quoteEngine.evaluateShadowTake.mockReturnValue({
        logs: [{ type: 'would-take', dedupKey: '100.00:0.01000000', wouldTake: true }],
        evaluation: { wouldTake: true, suppressReason: null },
      });
      orchestrator.isRunning = true;
      orchestrator._scheduleNextTruexEbboPoll = jest.fn();

      await orchestrator._pollTruexEbbo();

      expect(mocks.quoteEngine.updateTruexEbbo).toHaveBeenCalledTimes(1);
      expect(mocks.quoteEngine.evaluateShadowTake).toHaveBeenCalledWith(expect.objectContaining({
        aggregatedPrice: orchestrator.lastAggregatedPrice,
        trigger: 'truex-ebbo-poll',
      }));
      expect(mocks.fixConnection.sendMessage).not.toHaveBeenCalled();
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

    test('exposes EBBO poll health fields', () => {
      const { orchestrator } = createOrchestrator();
      orchestrator._truexEbboLastSuccessAt = 1234567890;
      orchestrator._truexEbboConsecutiveErrors = 2;

      const status = orchestrator.getStatus();

      expect(status.truexEbboLastSuccessAt).toBe(1234567890);
      expect(status.truexEbboConsecutiveErrors).toBe(2);
    });

    test('exposes PYUSD/USD basis fields and freshness', () => {
      const { orchestrator } = createOrchestrator();
      orchestrator.pyusdUsd = {
        price: 1.00005,
        bid: 1.0,
        ask: 1.0001,
        timestamp: Date.now(),
        source: 'kraken-rest',
        pair: 'PYUSD/USD',
      };
      orchestrator._pyusdUsdLastSuccessAt = 1234567891;
      orchestrator._pyusdUsdConsecutiveErrors = 1;

      const status = orchestrator.getStatus();

      expect(status.pyusdUsd.price).toBe(1.00005);
      expect(status.pyusdUsdFresh).toBe(true);
      expect(status.pyusdUsdLastSuccessAt).toBe(1234567891);
      expect(status.pyusdUsdConsecutiveErrors).toBe(1);
    });
  });

  describe('PYUSD/USD basis poller', () => {
    test('polls Kraken ticker and stores PYUSD/USD reference separately from maker price updates', async () => {
      const { orchestrator, mocks } = createOrchestrator({ pyusdUsdPollIntervalMs: 0 });
      orchestrator.isRunning = true;

      await orchestrator._pollPyusdUsdReference();

      expect(mocks.krakenRestClient.getTicker).toHaveBeenCalledWith('PYUSD/USD', { timeoutMs: 1 });
      expect(orchestrator.pyusdUsd.price).toBe(1.00005);
      expect(mocks.quoteEngine.updatePyusdUsd).toHaveBeenCalledWith(expect.objectContaining({
        price: 1.00005,
        bid: 1.0,
        ask: 1.0001,
        source: 'kraken-rest',
      }));
      expect(mocks.quoteEngine.onPriceUpdate).not.toHaveBeenCalled();
      expect(mocks.fixConnection.sendMessage).not.toHaveBeenCalled();
    });

    test('falls back to the next source when the first source fails', async () => {
      const krakenRestClient = createMockKrakenRestClient();
      krakenRestClient.getTicker = jest.fn()
        .mockRejectedValueOnce(new Error('pair unavailable'))
        .mockResolvedValueOnce({
          exchange: 'kraken',
          symbol: 'PYUSDUSD',
          timestamp: Date.now(),
          bid: 1.0,
          ask: 1.0002,
          last: 1.0001,
          volume24h: 1000,
        });

      const { orchestrator } = createOrchestrator({
        krakenRestClient,
        pyusdUsdPollIntervalMs: 0,
        pyusdUsdReferenceSources: [
          { type: 'kraken-rest', pair: 'PYUSD/USD' },
          { type: 'kraken-rest', pair: 'PYUSDUSD' },
        ],
      });
      orchestrator.isRunning = true;

      await orchestrator._pollPyusdUsdReference();

      expect(krakenRestClient.getTicker).toHaveBeenNthCalledWith(1, 'PYUSD/USD', { timeoutMs: 1 });
      expect(krakenRestClient.getTicker).toHaveBeenNthCalledWith(2, 'PYUSDUSD', { timeoutMs: 1 });
      expect(orchestrator.pyusdUsd.pair).toBe('PYUSDUSD');
      expect(orchestrator.pyusdUsd.price).toBe(1.0001);
    });

    test('marks stale basis references as not fresh without affecting BTC-USD price path', async () => {
      const { orchestrator, mocks } = createOrchestrator({ pyusdUsdStaleThresholdMs: 1000, pyusdUsdPollIntervalMs: 0 });
      await orchestrator.start();

      orchestrator.pyusdUsd = {
        price: 0.9998,
        bid: 0.9997,
        ask: 0.9999,
        timestamp: Date.now() - 5000,
        source: 'kraken-rest',
        pair: 'PYUSD/USD',
      };

      const price = { weightedMidpoint: 100000, confidence: 0.95 };
      mocks.priceAggregator.emit('price', price);

      expect(orchestrator.getStatus().pyusdUsdFresh).toBe(false);
      expect(mocks.quoteEngine.onPriceUpdate).toHaveBeenCalledWith(price);
      expect(mocks.pnlTracker.markToMarket).toHaveBeenCalledWith(100000);
      await orchestrator.stop();
    });

    test('fails loudly when kraken-rest sources are configured without a krakenRestClient', async () => {
      const { orchestrator } = createOrchestrator({
        krakenRestClient: null,
        pyusdUsdPollIntervalMs: 1000,
        pyusdUsdReferenceSources: [{ type: 'kraken-rest', pair: 'PYUSD/USD' }],
      });

      await expect(orchestrator.start()).rejects.toThrow(
        'PYUSD/USD reference polling requires options.krakenRestClient for kraken-rest sources',
      );
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

    test('keeps mark-to-market updating while OE-only quoting is suspended', async () => {
      const { orchestrator, mocks } = createOrchestrator({ marketDataFeed: null });
      await orchestrator.start();
      mocks.fixConnection.isLoggedOn = false;

      const price = { weightedMidpoint: 100250, confidence: 0.95 };
      mocks.priceAggregator.emit('price', price);

      expect(orchestrator._lastMidPrice).toBe(100250);
      expect(mocks.pnlTracker.markToMarket).toHaveBeenCalledWith(100250);
      expect(mocks.quoteEngine.invalidateQueuedWork).toHaveBeenCalledWith(true);
      expect(mocks.quoteEngine.onPriceUpdate).not.toHaveBeenCalled();
      await orchestrator.stop();
    });

    test('suspends quoting and skips price updates when OE is not logged on in OE-only mode', async () => {
      const { orchestrator, mocks } = createOrchestrator({ marketDataFeed: null });
      await orchestrator.start();
      mocks.fixConnection.isLoggedOn = false;

      const price = { weightedMidpoint: 100000, confidence: 0.95 };
      mocks.priceAggregator.emit('price', price);

      expect(mocks.quoteEngine.suspendQuoting).toHaveBeenCalled();
      expect(mocks.quoteEngine.invalidateQueuedWork).toHaveBeenCalledWith(true);
      expect(mocks.quoteEngine.onPriceUpdate).not.toHaveBeenCalled();
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

    test('coalesces shadow reevaluations on meaningful Coinbase changes and rate limits them', async () => {
      const { orchestrator, mocks } = createOrchestrator({ truexEbboPollIntervalMs: 1000, shadowTakeMode: true });
      await orchestrator.start();
      const processSpy = jest.spyOn(orchestrator, '_processShadowEvaluation').mockResolvedValue();
      mocks.quoteEngine._isTruexEbboFresh.mockReturnValue(true);

      mocks.priceAggregator.emit('price', {
        weightedMidpoint: 100000,
        confidence: 0.95,
        sources: [{ exchange: 'coinbase', bid: 100, isStale: false }],
      });
      await Promise.resolve();

      mocks.priceAggregator.emit('price', {
        weightedMidpoint: 100000.1,
        confidence: 0.95,
        sources: [{ exchange: 'coinbase', bid: 100.1, isStale: false }],
      });
      await Promise.resolve();

      orchestrator._shadowLastReevalAt = Date.now() - 1500;
      mocks.priceAggregator.emit('price', {
        weightedMidpoint: 100001,
        confidence: 0.1,
        sources: [{ exchange: 'coinbase', bid: 101, isStale: false }],
      });
      await Promise.resolve();

      expect(processSpy).toHaveBeenCalledTimes(2);
      expect(processSpy).toHaveBeenNthCalledWith(1, 'coinbase-update', { refreshTape: false });
      expect(processSpy).toHaveBeenNthCalledWith(2, 'coinbase-update', { refreshTape: false });
      expect(mocks.fixConnection.sendMessage).not.toHaveBeenCalled();

      processSpy.mockRestore();
      await orchestrator.stop();
    });
  });

  describe('shadow tape cache', () => {
    test('reuses cached trade tape on Coinbase reevaluations instead of refetching every tick', async () => {
      const { orchestrator, mocks } = createOrchestrator({ truexTradeCacheTtlMs: 10_000, shadowTakeMode: true });
      orchestrator.isRunning = true;
      orchestrator.lastAggregatedPrice = {
        confidence: 0.95,
        sources: [{ exchange: 'coinbase', bid: 100, isStale: false }],
      };
      orchestrator._truexTradeTape = {
        latestTradePrice: 100.1,
        latestTradeQty: 0.1,
        latestTradeTs: Date.now(),
        fetchedAt: Date.now(),
        inFlight: false,
      };
      orchestrator.restClient = {
        getInstrument: jest.fn(async () => ({ id: '78873627520270354' })),
        getMarketTrades: jest.fn(async () => []),
      };
      mocks.quoteEngine.evaluateShadowTake.mockReturnValue({
        logs: [],
        evaluation: { wouldTake: false, suppressReason: 'edge-too-low' },
      });

      await orchestrator._processShadowEvaluation('coinbase-update', { refreshTape: false });
      await orchestrator._processShadowEvaluation('coinbase-update', { refreshTape: false });

      expect(orchestrator.restClient.getMarketTrades).not.toHaveBeenCalled();
      expect(mocks.quoteEngine.evaluateShadowTake).toHaveBeenCalledTimes(2);
      expect(mocks.fixConnection.sendMessage).not.toHaveBeenCalled();
    });

    test('alerts on sustained zero detections even before the first would-take event', async () => {
      const alertManager = { sendAlert: jest.fn(async () => ({})), sendRecovery: jest.fn(async () => ({})) };
      const { orchestrator } = createOrchestrator({
        alertManager,
        shadowZeroDetectionAlertThresholdMs: 1000,
        shadowTakeMode: true,
      });

      orchestrator._handleShadowEvaluationResult({
        logs: [],
        evaluation: { wouldTake: false, suppressReason: 'edge-too-low' },
      });
      orchestrator._updateShadowAlerts(orchestrator._shadowZeroDetectionWindowStartedAt + 1500);

      expect(alertManager.sendAlert).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'Shadow take zero detections while market active',
      }));
    });

    test('does not arm the zero-detection timer while shadow inputs are not evaluable', async () => {
      const alertManager = { sendAlert: jest.fn(async () => ({})), sendRecovery: jest.fn(async () => ({})) };
      const { orchestrator } = createOrchestrator({
        alertManager,
        shadowZeroDetectionAlertThresholdMs: 1000,
        shadowTakeMode: true,
      });

      orchestrator._handleShadowEvaluationResult({
        logs: [],
        evaluation: { wouldTake: false, suppressReason: 'coinbase-stale' },
      });
      orchestrator._updateShadowAlerts(Date.now() + 1500);

      expect(orchestrator._shadowZeroDetectionWindowStartedAt).toBe(0);
      expect(alertManager.sendAlert).not.toHaveBeenCalled();
    });

    test('clears an active zero-detection alert when the market becomes non-evaluable', async () => {
      const alertManager = { sendAlert: jest.fn(async () => ({})), sendRecovery: jest.fn(async () => ({})) };
      const { orchestrator } = createOrchestrator({
        alertManager,
        shadowZeroDetectionAlertThresholdMs: 1000,
        shadowTakeMode: true,
      });

      orchestrator._shadowNoDetectionAlertActive = true;
      orchestrator._shadowZeroDetectionWindowStartedAt = Date.now() - 1500;
      orchestrator._handleShadowEvaluationResult({
        logs: [],
        evaluation: { wouldTake: false, suppressReason: 'coinbase-stale' },
      });

      expect(orchestrator._shadowNoDetectionAlertActive).toBe(false);
      expect(orchestrator._shadowZeroDetectionWindowStartedAt).toBe(0);
      expect(alertManager.sendRecovery).toHaveBeenCalledWith({
        reason: 'Shadow take zero detections while market active',
      });
    });

    test('does not invoke shadow evaluation when shadowTakeMode is false', async () => {
      const { orchestrator, mocks } = createOrchestrator({ shadowTakeMode: false, truexEbboPollIntervalMs: 1000 });
      await orchestrator.start();
      const processSpy = jest.spyOn(orchestrator, '_processShadowEvaluation').mockResolvedValue();
      mocks.quoteEngine._isTruexEbboFresh.mockReturnValue(true);

      mocks.priceAggregator.emit('price', {
        weightedMidpoint: 100000,
        confidence: 0.95,
        sources: [{ exchange: 'coinbase', bid: 100, isStale: false }],
      });
      await Promise.resolve();

      expect(processSpy).not.toHaveBeenCalled();
      expect(orchestrator.shadowTakeMode).toBe(false);

      processSpy.mockRestore();
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

    test('routes OrderCancelReject (35=9) to QuoteEngine', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      const message = {
        fields: {
          '35': '9',       // OrderCancelReject
          '11': 'CX001',   // Cancel ClOrdID
          '41': 'ORIG001', // OrigClOrdID
          '58': 'Too late to cancel',
          '102': '0',
        },
      };
      mocks.fixConnection.emit('message', message);

      expect(mocks.quoteEngine.onOrderCancelReject).toHaveBeenCalledWith(message.fields);
      // Should NOT also route to onExecutionReport
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

  describe('event wiring: OE disconnects', () => {
    test('restores in-flight orders to active and clears stale replacement intent without dropping late-ack recovery state', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.quoteEngine.activeOrders.set('C1', { side: 'buy', status: 'cancelling' });
      mocks.quoteEngine.activeOrders.set('P1', { side: 'sell', status: 'pending' });
      mocks.quoteEngine.activeOrders.set('A1', { side: 'buy', status: 'active' });

      mocks.fixConnection.emit('disconnect');

      expect(mocks.quoteEngine.suspendQuoting).toHaveBeenCalled();
      expect(mocks.quoteEngine.invalidateQueuedWork).toHaveBeenCalledWith(true);
      expect(mocks.quoteEngine.clearPendingReplacement).toHaveBeenCalledWith('C1');
      expect(mocks.quoteEngine.clearPendingReplacement).toHaveBeenCalledWith('P1');
      expect(mocks.quoteEngine.activeOrders.get('C1').status).toBe('active');
      expect(mocks.quoteEngine.activeOrders.get('P1').status).toBe('active');
      expect(mocks.quoteEngine.activeOrders.has('A1')).toBe(true);
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

    test('routes intentional taker fills to PnLTracker as taker', async () => {
      const { orchestrator, mocks } = createOrchestrator();
      await orchestrator.start();

      mocks.quoteEngine.emit('fill', {
        side: 'buy',
        price: 99950,
        size: 0.1,
        clOrdID: 'QTAKER',
        execID: 'exec-taker',
        orderIntent: 'taker_opportunity',
        liquidityRoleExpected: 'taker',
        isMaker: false,
      });

      const pnlCall = mocks.pnlTracker.onFill.mock.calls[0][0];
      expect(pnlCall.isMaker).toBe(false);
      expect(pnlCall.venue).toBe('truex');

      const auditCall = mocks.auditLogger.logFillEvent.mock.calls[0][0];
      expect(auditCall.orderIntent).toBe('taker_opportunity');
      expect(auditCall.liquidityRoleExpected).toBe('taker');
      expect(auditCall.isMaker).toBe(false);
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

  describe('data pipeline integration', () => {
    function createMockDataPipeline() {
      return {
        start: jest.fn(async () => {}),
        stop: jest.fn(async () => {}),
        addFill: jest.fn(),
        addOrder: jest.fn(),
        logFIXMessage: jest.fn(),
        logError: jest.fn(),
        getStats: jest.fn(() => ({
          pipeline: { flushCycles: 0, migrationCycles: 0 },
          memory: { ordersInMemory: 0, fillsInMemory: 0 },
          isRunning: true,
          hasRedis: true,
          hasPostgres: true,
        })),
      };
    }

    test('calls dataPipeline.start() on start', async () => {
      const dataPipeline = createMockDataPipeline();
      const { orchestrator } = createOrchestrator({ dataPipeline });
      await orchestrator.start();
      expect(dataPipeline.start).toHaveBeenCalledTimes(1);
      await orchestrator.stop();
    });

    test('binds the initialized pipeline PostgreSQL manager as the telemetry writer', async () => {
      const pgManager = { recordQuoteLifecycleEvent: jest.fn(async () => {}) };
      const dataPipeline = createMockDataPipeline();
      dataPipeline.pgManager = pgManager;
      const { orchestrator } = createOrchestrator({ dataPipeline });

      expect(orchestrator.quoteTelemetry.writer).toBeNull();
      await orchestrator.start();
      expect(orchestrator.quoteTelemetry.writer).toBe(pgManager);
      await orchestrator.stop();
    });

    test('enriches lifecycle telemetry with available Coinbase book context', () => {
      const quoteTelemetry = { writer: null, record: jest.fn(() => Promise.resolve()) };
      const { orchestrator } = createOrchestrator({ quoteTelemetry });
      orchestrator.lastAggregatedPrice = {
        timestamp: 1000,
        weightedMidpoint: 100,
        sources: [{ exchange: 'coinbase', bid: 99.5, ask: 100.5 }],
      };

      orchestrator._onQuoteLifecycle({ eventType: 'create', quoteId: 'Q-telemetry', side: 'buy' });

      expect(quoteTelemetry.record).toHaveBeenCalledWith(expect.objectContaining({
        context: expect.objectContaining({
          coinbase: expect.objectContaining({ bestBid: 99.5, bestAsk: 100.5, timestamp: 1000 }),
        }),
      }));
    });

    test('calls dataPipeline.stop() on stop', async () => {
      const dataPipeline = createMockDataPipeline();
      const { orchestrator } = createOrchestrator({ dataPipeline });
      await orchestrator.start();
      await orchestrator.stop();
      expect(dataPipeline.stop).toHaveBeenCalledTimes(1);
    });

    test('handles dataPipeline.start() failure gracefully', async () => {
      const dataPipeline = createMockDataPipeline();
      dataPipeline.start = jest.fn(async () => { throw new Error('Redis down'); });
      const { orchestrator, mocks } = createOrchestrator({ dataPipeline });
      await orchestrator.start();
      expect(orchestrator.isRunning).toBe(true);
      expect(mocks.logger.warn).toHaveBeenCalled();
      await orchestrator.stop();
    });

    test('handles dataPipeline.stop() failure gracefully', async () => {
      const dataPipeline = createMockDataPipeline();
      dataPipeline.stop = jest.fn(async () => { throw new Error('Flush failed'); });
      const { orchestrator, mocks } = createOrchestrator({ dataPipeline });
      await orchestrator.start();
      await orchestrator.stop();
      expect(orchestrator.isRunning).toBe(false);
      expect(mocks.logger.error).toHaveBeenCalled();
    });

    test('routes quote fills to dataPipeline.addFill()', async () => {
      const dataPipeline = createMockDataPipeline();
      const { orchestrator, mocks } = createOrchestrator({ dataPipeline, auditLogger: null });
      await orchestrator.start();

      mocks.quoteEngine.emit('fill', {
        side: 'buy',
        price: 100000,
        size: 0.1,
        clOrdID: 'Q001',
        execID: 'exec-1',
      });

      expect(dataPipeline.addFill).toHaveBeenCalledTimes(1);
      const fill = dataPipeline.addFill.mock.calls[0][0];
      expect(fill.fillId).toBe('Q001-exec-1');
      expect(fill.side).toBe('buy');
      expect(fill.quantity).toBe(0.1);
      expect(fill.price).toBe(100000);
      await orchestrator.stop();
    });

    test('routes FIX execution report fills to dataPipeline.addFill()', async () => {
      const dataPipeline = createMockDataPipeline();
      const { orchestrator, mocks } = createOrchestrator({ dataPipeline, dataManager: null });
      await orchestrator.start();

      mocks.fixConnection.emit('message', {
        fields: {
          '35': '8',
          '11': 'Q001',
          '17': 'exec-1',
          '39': '2',
          '31': '100000',
          '32': '0.5',
          '54': '1',
        },
      });

      expect(dataPipeline.addFill).toHaveBeenCalledTimes(1);
      const fill = dataPipeline.addFill.mock.calls[0][0];
      expect(fill.orderId).toBe('Q001');
      expect(fill.side).toBe('buy');
      expect(fill.quantity).toBe(0.5);
      await orchestrator.stop();
    });

    test('dedupes dataPipeline fills when QuoteEngine also emits the execution-report fill', async () => {
      const dataPipeline = createMockDataPipeline();
      const quoteEngine = createMockQuoteEngine();
      quoteEngine.onExecutionReport = jest.fn((fields) => {
        quoteEngine.emit('fill', {
          side: fields['54'] === '1' ? 'buy' : 'sell',
          price: Number(fields['31']),
          size: Number(fields['32']),
          clOrdID: fields['11'],
          execID: fields['17'],
          orderIntent: 'taker_opportunity',
          liquidityRoleExpected: 'taker',
          isMaker: false,
        });
      });
      const { orchestrator, mocks } = createOrchestrator({ dataPipeline, dataManager: null, quoteEngine });
      await orchestrator.start();

      mocks.fixConnection.emit('message', {
        fields: {
          '35': '8',
          '11': 'Q001',
          '17': 'exec-1',
          '39': '2',
          '31': '100000',
          '32': '0.5',
          '54': '1',
        },
      });

      expect(dataPipeline.addFill).toHaveBeenCalledTimes(1);
      const fill = dataPipeline.addFill.mock.calls[0][0];
      expect(fill.fillId).toBe('Q001-exec-1');
      expect(fill.orderIntent).toBe('taker_opportunity');
      expect(fill.isMaker).toBe(false);
      await orchestrator.stop();
    });

    test('logs all FIX messages to dataPipeline.logFIXMessage()', async () => {
      const dataPipeline = createMockDataPipeline();
      const { orchestrator, mocks } = createOrchestrator({ dataPipeline });
      await orchestrator.start();

      // Send heartbeat (not an exec report)
      mocks.fixConnection.emit('message', {
        fields: { '35': '0', '34': '5' },
      });

      expect(dataPipeline.logFIXMessage).toHaveBeenCalledTimes(1);
      const args = dataPipeline.logFIXMessage.mock.calls[0];
      expect(args[1].direction).toBe('INBOUND');
      expect(args[1].msgType).toBe('0');
      await orchestrator.stop();
    });

    test('includes dataPipeline stats in getStatus()', async () => {
      const dataPipeline = createMockDataPipeline();
      const { orchestrator } = createOrchestrator({ dataPipeline });
      await orchestrator.start();

      const status = orchestrator.getStatus();
      expect(status.dataPipeline).not.toBeNull();
      expect(status.dataPipeline.hasRedis).toBe(true);
      expect(status.dataPipeline.hasPostgres).toBe(true);
      await orchestrator.stop();
    });

    test('returns null dataPipeline in getStatus() when not configured', () => {
      const { orchestrator } = createOrchestrator();
      const status = orchestrator.getStatus();
      expect(status.dataPipeline).toBeNull();
    });

    test('prefers dataPipeline over legacy auditLogger for quote fills', async () => {
      const dataPipeline = createMockDataPipeline();
      const auditLogger = createMockAuditLogger();
      const { orchestrator, mocks } = createOrchestrator({ dataPipeline, auditLogger });
      await orchestrator.start();

      mocks.quoteEngine.emit('fill', {
        side: 'buy',
        price: 100000,
        size: 0.1,
        clOrdID: 'Q001',
        execID: 'exec-1',
      });

      expect(dataPipeline.addFill).toHaveBeenCalledTimes(1);
      expect(auditLogger.logFillEvent).not.toHaveBeenCalled();
      await orchestrator.stop();
    });

    test('prefers dataPipeline over legacy dataManager for FIX fills', async () => {
      const dataPipeline = createMockDataPipeline();
      const dataManager = createMockDataManager();
      const { orchestrator, mocks } = createOrchestrator({ dataPipeline, dataManager });
      await orchestrator.start();

      mocks.fixConnection.emit('message', {
        fields: {
          '35': '8',
          '11': 'Q001',
          '17': 'exec-1',
          '39': '2',
          '31': '100000',
          '32': '0.1',
          '54': '2',
        },
      });

      expect(dataPipeline.addFill).toHaveBeenCalledTimes(1);
      expect(dataManager.addFill).not.toHaveBeenCalled();
      await orchestrator.stop();
    });

    test('backward compat: legacy dataManager still works without dataPipeline', async () => {
      const dataManager = createMockDataManager();
      const { orchestrator, mocks } = createOrchestrator({ dataPipeline: null, dataManager });
      await orchestrator.start();

      mocks.fixConnection.emit('message', {
        fields: {
          '35': '8',
          '11': 'Q001',
          '17': 'exec-1',
          '39': '2',
          '31': '100000',
          '32': '0.1',
          '54': '1',
        },
      });

      expect(dataManager.addFill).toHaveBeenCalledTimes(1);
      await orchestrator.stop();
    });

    test('backward compat: legacy auditLogger still works without dataPipeline', async () => {
      const auditLogger = createMockAuditLogger();
      const { orchestrator, mocks } = createOrchestrator({ dataPipeline: null, auditLogger });
      await orchestrator.start();

      mocks.quoteEngine.emit('fill', {
        side: 'buy',
        price: 100000,
        size: 0.1,
        clOrdID: 'Q001',
        execID: 'exec-1',
      });

      expect(auditLogger.logFillEvent).toHaveBeenCalledTimes(1);
      await orchestrator.stop();
    });
  });

  describe('drain queue timer', () => {
    test('calls drainQueue periodically', async () => {
      const { orchestrator, mocks } = createOrchestrator({ drainQueueIntervalMs: 50 });
      await orchestrator.start();

      const deadline = Date.now() + 500;
      while (mocks.quoteEngine.drainQueue.mock.calls.length < 2 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 10));
      }

      expect(mocks.quoteEngine.drainQueue.mock.calls.length).toBeGreaterThanOrEqual(2);
      await orchestrator.stop();
    });
  });
});

describe('MarketMakerOrchestrator._getTruexTapeContext — EBBO last_trade fallback', () => {
  test('returns null when neither the trade-tape poll nor the EBBO has a trade', () => {
    const { orchestrator } = createOrchestrator();
    expect(orchestrator._truexTradeTape.latestTradeTs).toBeNull();
    expect(orchestrator._getTruexTapeContext()).toBeNull();
  });

  test('falls back to the EBBO last_trade when the trade-tape poll is empty', () => {
    const { orchestrator, mocks } = createOrchestrator();
    // trade-tape poll stays empty (default after construction)
    const ts = Date.now() - 10_000;
    mocks.quoteEngine.truexEbbo = {
      lastTradePrice: 101.2,
      lastTradeQty: 0.25,
      lastTradeTs: ts,
    };
    const ctx = orchestrator._getTruexTapeContext();
    expect(ctx).not.toBeNull();
    expect(ctx.latestTradePrice).toBe(101.2);
    expect(ctx.latestTradeQty).toBe(0.25);
    expect(ctx.latestTradeTs).toBe(ts);
    expect(ctx.ageS).toBeGreaterThan(9);
  });

  test('prefers the dedicated trade-tape poll over the EBBO fallback', () => {
    const { orchestrator, mocks } = createOrchestrator();
    const tapeTs = Date.now() - 3_000;
    orchestrator._truexTradeTape = {
      latestTradePrice: 102.5,
      latestTradeQty: 0.1,
      latestTradeTs: tapeTs,
      fetchedAt: Date.now(),
      inFlight: false,
    };
    mocks.quoteEngine.truexEbbo = {
      lastTradePrice: 101.2,
      lastTradeQty: 0.25,
      lastTradeTs: Date.now() - 10_000,
    };
    const ctx = orchestrator._getTruexTapeContext();
    expect(ctx.latestTradePrice).toBe(102.5);
    expect(ctx.latestTradeTs).toBe(tapeTs);
  });
});
