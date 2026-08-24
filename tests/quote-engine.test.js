import { describe, it, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { QuoteEngine } from '../src/core/quote-engine.js';
import { InventoryManager } from '../src/core/inventory-manager.js';

// --- Test helpers ---

function createMockInventory(overrides = {}) {
  return {
    getSkew: mock(() => overrides.skew || { bidSkewTicks: 0, askSkewTicks: 0 }),
    canQuote: mock(() => overrides.canQuote !== undefined ? overrides.canQuote : true),
  };
}

function createMockFix() {
  return {
    sendMessage: mock(() => Promise.resolve({})),
    senderCompID: 'CLI_CLIENT',
    targetCompID: 'TRUEX_UAT_OE',
    msgSeqNum: 1,
    getUTCTimestamp: () => '20260206-12:00:00.000',
  };
}

function createMockLogger() {
  return {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  };
}

function createEngine(overrides = {}) {
  const inventoryManager = overrides.inventoryManager || createMockInventory(overrides);
  const fixConnection = overrides.fixConnection || createMockFix();
  const logger = overrides.logger || createMockLogger();

  return new QuoteEngine({
    inventoryManager,
    fixConnection,
    logger,
    levels: overrides.levels || 3,
    baseSpreadBps: overrides.baseSpreadBps || 50,
    levelSpacingTicks: overrides.levelSpacingTicks || 1,
    repriceThresholdTicks: overrides.repriceThresholdTicks || 1,
    baseSizeBTC: overrides.baseSizeBTC || 0.1,
    sizeDecayFactor: overrides.sizeDecayFactor || 0.8,
    maxOrdersPerSecond: overrides.maxOrdersPerSecond || 8,
    dupGuardMs: overrides.dupGuardMs || 500,
    tickSize: overrides.tickSize || 0.50,
    minNotional: overrides.minNotional || 1.0,
    priceBandPct: overrides.priceBandPct || 2.5,
    confidenceThreshold: overrides.confidenceThreshold || 0.3,
    symbol: overrides.symbol || 'BTC-PYUSD',
    ...overrides,
  });
}

function makePrice(mid, confidence = 1.0) {
  return {
    midpoint: mid,
    bestBid: mid - 5,
    bestAsk: mid + 5,
    weightedMidpoint: mid,
    confidence,
    timestamp: Date.now(),
    symbol: 'BTC-PYUSD',
    spread: 10,
    spreadBps: 10,
    sources: [],
  };
}

// =====================
// Tests
// =====================

describe('QuoteEngine', () => {

  describe('minimal live canary', () => {
    const canaryConfig = {
      enabled: true, runId: 'canary-run-0001', durationMs: 900_000, maxCumulativeFilledBTC: 0.001,
      oneMinuteMarkoutDeadlineMs: 96_000,
      levels: 1, baseSizeBTC: 0.0005, minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
    };

    const strictCanaryEngine = (overrides = {}) => createEngine({
      levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true,
      quoteDispatchMode: 'live', minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
      contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
      authoritativeOrderStateProvider: () => ({ available: true, timestamp: Date.now(), orders: [] }),
      ...overrides,
    });

    it('keeps the normal L1 placement when the touch canary is disabled', () => {
      const engine = createEngine({
        levels: 1, baseSizeBTC: 0.0005, baseSpreadBps: 60, tickSize: 0.5,
        strictTruexMakerSafety: true, quoteDispatchMode: 'live',
        minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000,
      });
      engine.updateTruexEbbo({ bestBid: 10000, bestAsk: 10050, timestamp: Date.now() });

      const quotes = engine.computeDesiredQuotes(10025, { bidSkewTicks: 0, askSkewTicks: 0 });
      expect(quotes).toEqual(expect.arrayContaining([
        expect.objectContaining({ side: 'buy', level: 1, price: 9994.5 }),
        expect.objectContaining({ side: 'sell', level: 1, price: 10055.5 }),
      ]));
    });

    it('joins the fresh TrueX touch on both L1 sides within the canary envelope', () => {
      const engine = strictCanaryEngine({ baseSpreadBps: 60, tickSize: 0.5 });
      engine.updateTruexEbbo({ bestBid: 10000, bestAsk: 10050, timestamp: Date.now() });

      const quotes = engine.computeDesiredQuotes(10025, { bidSkewTicks: 0, askSkewTicks: 0 });
      expect(quotes).toEqual(expect.arrayContaining([
        expect.objectContaining({ side: 'buy', level: 1, price: 10000, contractOppositePrice: 10050 }),
        expect.objectContaining({ side: 'sell', level: 1, price: 10050, contractOppositePrice: 10000 }),
      ]));
    });

    it('joins a decimal tick-aligned TrueX touch despite floating-point residue', () => {
      const engine = strictCanaryEngine({ baseSpreadBps: 60, tickSize: 0.01 });
      engine.updateTruexEbbo({ bestBid: 10000.05, bestAsk: 10050.05, timestamp: Date.now() });

      const quotes = engine.computeDesiredQuotes(10025.05, { bidSkewTicks: 0, askSkewTicks: 0 });
      expect(quotes).toEqual(expect.arrayContaining([
        expect.objectContaining({ side: 'buy', level: 1, price: 10000.05 }),
        expect.objectContaining({ side: 'sell', level: 1, price: 10050.05 }),
      ]));
    });

    it('never improves beyond the TrueX touch and preserves the normal pair when its width is unsafe', () => {
      const engine = strictCanaryEngine({ baseSpreadBps: 60, tickSize: 0.5 });
      engine.updateTruexEbbo({ bestBid: 10000, bestAsk: 10005, timestamp: Date.now() });

      const quotes = engine.computeDesiredQuotes(10002.5, { bidSkewTicks: 0, askSkewTicks: 0 });
      expect(quotes).toEqual(expect.arrayContaining([
        expect.objectContaining({ side: 'buy', level: 1, price: 9972 }),
        expect.objectContaining({ side: 'sell', level: 1, price: 10033 }),
      ]));
      expect(quotes.find(quote => quote.side === 'buy').price).toBeLessThanOrEqual(10000);
      expect(quotes.find(quote => quote.side === 'sell').price).toBeGreaterThanOrEqual(10005);
    });

    it.each([
      ['stale', (engine, advance) => {
        engine.updateTruexEbbo({ bestBid: 10000, bestAsk: 10050, timestamp: 1 });
        advance(3_001);
      }, 'truex-ebbo-stale'],
      ['crossed', (engine) => engine.updateTruexEbbo({ bestBid: 10050, bestAsk: 10000, timestamp: 1 }), 'truex-ebbo-invalid'],
      ['invalid', (engine) => engine.updateTruexEbbo({ bestBid: 'not-a-price', bestAsk: 10050, timestamp: 1 }), 'truex-ebbo-invalid'],
    ])('does not dispatch a canary D when TrueX EBBO is %s', (_name, arrange, reason) => {
      let now = 1_000_000;
      const fixConnection = createMockFix();
      const engine = strictCanaryEngine({ fixConnection, now: () => now, truexMakerEbboMaxAgeMs: 3_000 });
      expect(engine.armMinimalLiveCanary()).toBe(true);
      arrange(engine, (elapsed) => { now += elapsed; });

      expect(engine._sendNewOrder({
        side: 'buy', level: 1, price: 10000, size: 0.0005, postOnly: true,
        contractReferenceMid: 10025, contractOppositePrice: 10050,
      })).toBeNull();
      expect(fixConnection.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ '35': 'D' }));
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe(reason);
    });

    it('enforces the one-level canary envelope, leaving L2 unavailable', () => {
      expect(() => strictCanaryEngine({ levels: 2 })).toThrow('passive canary engine envelope');
    });

    it('is default-disabled and fails closed after EBBO loss without a new FIX D', () => {
      const fixConnection = createMockFix();
      const engine = createEngine({
        fixConnection, levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true,
        quoteDispatchMode: 'live', minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
      });
      engine._recordSuppression({ side: 'buy', level: 1, price: 100 }, 'truex-ebbo-stale');
      expect(engine.getQuoteStatus().minimalLiveCanary.stopReason).toBe('truex-ebbo-stale');
      expect(engine._sendNewOrder({ side: 'buy', level: 1, price: 100, size: 0.0005, postOnly: true })).toBeNull();
      expect(fixConnection.sendMessage).not.toHaveBeenCalled();
    });

    it('stops and safely cancels on a venue rejection of a canary order', () => {
      const fixConnection = createMockFix();
      const engine = createEngine({
        fixConnection, levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true,
        quoteDispatchMode: 'live', minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
      });
      engine.activeOrders.set('QCANARY', { side: 'buy', level: 1, price: 100, size: 0.0005, status: 'pending', minimalLiveCanary: true });
      engine.onExecutionReport({ '11': 'QCANARY', '39': '8', '54': '1', '58': 'venue-reject' });
      expect(engine.getQuoteStatus().minimalLiveCanary.stopReason).toBe('venue-reject');
      expect(engine.activeOrders.size).toBe(0);
    });

    it('stops and safely cancels on the first attributed adverse one-minute markout', () => {
      const fixConnection = createMockFix();
      const engine = createEngine({
        fixConnection, levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true,
        quoteDispatchMode: 'live', minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
      });
      engine.activeOrders.set('QCANARY', { side: 'sell', level: 1, price: 101, size: 0.0005, status: 'active', minimalLiveCanary: true });
      engine.minimalLiveCanaryFillIds.add('QCANARY-E1');
      engine.minimalLiveCanary.recordFill(0.0005, 'QCANARY-E1');
      expect(engine.recordMinimalLiveCanaryMarkout({
        fillId: 'QCANARY-E1', available: true, attributed: true, observedEdgeBps: -1,
      })).toBe(false);
      expect(engine.getQuoteStatus().minimalLiveCanary.stopReason).toBe('adverse-one-minute-markout');
      expect(fixConnection.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ '35': 'F', '41': 'QCANARY' }));
    });

    it('stops and cancels when a canary fill lacks verified LastPx evidence', () => {
      const fixConnection = createMockFix();
      const engine = createEngine({
        fixConnection, levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true,
        quoteDispatchMode: 'live', minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
      });
      engine.activeOrders.set('QCANARY', {
        side: 'sell', level: 1, price: 101, size: 0.0005, status: 'active',
        minimalLiveCanary: true, sentToVenue: true,
      });

      engine.onExecutionReport({
        '11': 'QCANARY', '17': 'E1', '39': '2', '54': '2', '32': '0.0005', '151': '0',
      });

      expect(engine.getQuoteStatus().minimalLiveCanary.stopReason).toBe('invalid-fill-evidence');
      expect(engine.minimalLiveCanaryFillIds.size).toBe(0);
      expect(fixConnection.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ '35': 'F', '41': 'QCANARY' }));
    });

    it('rejects mismatched engine settings and direct non-passive canary sends', () => {
      expect(() => createEngine({
        levels: 2, baseSizeBTC: 0.0005, strictTruexMakerSafety: true, quoteDispatchMode: 'live',
        minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80, contractOrderStateMaxAgeMs: 5000,
        minimalLiveCanaryConfig: canaryConfig,
      })).toThrow('passive canary engine envelope');
      expect(() => createEngine({
        levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true, quoteDispatchMode: 'live',
        allowTakerOrders: true, minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
      })).toThrow('passive canary engine envelope');
      const fixConnection = createMockFix();
      const engine = createEngine({
        fixConnection, levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true,
        quoteDispatchMode: 'live', minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
      });
      engine.armMinimalLiveCanary();
      engine._prepareQuoteForSend = mock(quote => quote);
      expect(engine._sendNewOrder({ side: 'buy', level: 1, price: 100, size: 0.0005, postOnly: false })).toBeNull();
      expect(engine.getQuoteStatus().minimalLiveCanary.stopReason).toBe('invalid-order-envelope');
      expect(fixConnection.sendMessage).not.toHaveBeenCalled();
    });

    it('persists the exact canary decision before its FIX D is sent', async () => {
      const fixConnection = createMockFix();
      fixConnection.sendMessage = mock(() => true);
      const decisionWriter = mock(async decision => {
        expect(fixConnection.sendMessage).not.toHaveBeenCalled();
        expect(decision).toMatchObject({
          eventType: 'create', side: 'buy', price: 100, size: 0.0005, level: 1,
          minimalLiveCanary: true, decisionPersistenceConfirmed: true,
        });
        return true;
      });
      const engine = createEngine({
        fixConnection, levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true,
        quoteDispatchMode: 'live', minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
        minimalLiveCanaryDecisionWriter: decisionWriter,
      });
      engine._prepareQuoteForSend = mock(quote => ({ ...quote }));
      engine._isPreparedQuoteSendableNow = mock(() => true);
      engine.armMinimalLiveCanary();

      expect(engine._dispatchAction({ type: 'place', quote: {
        side: 'buy', level: 1, price: 100, size: 0.0005, postOnly: true,
      } })).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(decisionWriter).toHaveBeenCalledTimes(1);
      expect(fixConnection.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ '35': 'D' }));
    });

    it('fails closed when canary decision persistence is unavailable', async () => {
      const fixConnection = createMockFix();
      fixConnection.sendMessage = mock(() => true);
      const engine = createEngine({
        fixConnection, levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true,
        quoteDispatchMode: 'live', minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
        minimalLiveCanaryDecisionWriter: mock(async () => false),
      });
      engine._prepareQuoteForSend = mock(quote => ({ ...quote }));
      engine.armMinimalLiveCanary();

      engine._dispatchAction({ type: 'place', quote: {
        side: 'buy', level: 1, price: 100, size: 0.0005, postOnly: true,
      } });
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(engine.getQuoteStatus().minimalLiveCanary.stopReason).toBe('durable-decision-persistence-failed');
      expect(fixConnection.sendMessage).not.toHaveBeenCalled();
    });

    it('does not revive a quote when a decision write resolves after cancellation', async () => {
      const fixConnection = createMockFix();
      fixConnection.sendMessage = mock(() => true);
      let resolveDecision;
      const engine = createEngine({
        fixConnection, levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true,
        quoteDispatchMode: 'live', minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
        minimalLiveCanaryDecisionWriter: mock(() => new Promise(resolve => { resolveDecision = resolve; })),
      });
      engine._prepareQuoteForSend = mock(quote => ({ ...quote }));
      engine.armMinimalLiveCanary();
      engine._dispatchAction({ type: 'place', quote: {
        side: 'buy', level: 1, price: 100, size: 0.0005, postOnly: true,
      } });
      engine.cancelAllQuotes('test-withdrawal');
      resolveDecision(true);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(fixConnection.sendMessage).not.toHaveBeenCalled();
      expect(engine.activeOrders.size).toBe(0);
    });

    it('stops the canary when TrueX expires one of its orders', () => {
      const engine = createEngine({
        levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true,
        quoteDispatchMode: 'live', minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
      });
      engine.activeOrders.set('QCANARY', {
        side: 'buy', level: 1, price: 100, size: 0.0005, status: 'active',
        minimalLiveCanary: true, sentToVenue: true,
      });

      engine.onExecutionReport({ '11': 'QCANARY', '39': 'C', '54': '1' });

      expect(engine.getQuoteStatus().minimalLiveCanary.stopReason).toBe('venue-expired');
      expect(engine.fixConnection.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ '35': 'F', '41': 'QCANARY' }),
      );
    });

    it('does not cancel a local pending order that failed before its FIX D was sent', () => {
      const fixConnection = createMockFix();
      const engine = createEngine({
        fixConnection, levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true,
        quoteDispatchMode: 'live', minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
      });
      engine.activeOrders.set('QUNSENT', {
        side: 'buy', level: 1, price: 100, size: 0.0005, status: 'pending',
        minimalLiveCanary: true, sentToVenue: false,
      });
      engine.stopMinimalLiveCanary('truex-ebbo-stale');
      expect(fixConnection.sendMessage).not.toHaveBeenCalled();
      expect(engine.activeOrders.size).toBe(0);
    });

    it('allows non-executable shadow observation alongside the passive canary', () => {
      expect(() => createEngine({
        levels: 1, baseSizeBTC: 0.0005, strictTruexMakerSafety: true, quoteDispatchMode: 'live',
        shadowTakeMode: true, minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
        contractOrderStateMaxAgeMs: 5000, minimalLiveCanaryConfig: canaryConfig,
      })).not.toThrow();
    });
  });

  describe('snapToTick', () => {
    it('should snap $99999.73 to nearest $0.50', () => {
      const engine = createEngine();
      // 99999.73 / 0.50 = 199999.46, round = 199999, * 0.50 = 99999.50
      expect(engine.snapToTick(99999.73)).toBe(99999.50);
    });

    it('should snap $100000.26 to $100000.50', () => {
      const engine = createEngine();
      // 100000.26 / 0.50 = 200000.52, round = 200001, * 0.50 = 100000.50
      expect(engine.snapToTick(100000.26)).toBe(100000.50);
    });

    it('should snap $100000.00 to exactly $100000.00', () => {
      const engine = createEngine();
      expect(engine.snapToTick(100000.00)).toBe(100000.00);
    });

    it('should snap $100000.25 to $100000.50 (midpoint rounds up)', () => {
      const engine = createEngine();
      expect(engine.snapToTick(100000.25)).toBe(100000.50);
    });

    it('should snap $100000.74 to $100000.50', () => {
      const engine = createEngine();
      // 100000.74 / 0.50 = 200001.48, round = 200001, * 0.50 = 100000.50
      expect(engine.snapToTick(100000.74)).toBe(100000.50);
    });

    it('should snap $100000.75 to $100001.00', () => {
      const engine = createEngine();
      // 100000.75 / 0.50 = 200001.50, round = 200002, * 0.50 = 100001.00
      expect(engine.snapToTick(100000.75)).toBe(100001.00);
    });
  });

  describe('computeDesiredQuotes', () => {
    it('should produce N levels on each side', () => {
      const engine = createEngine({ levels: 3 });
      const mid = 100000;
      const skew = { bidSkewTicks: 0, askSkewTicks: 0 };
      const quotes = engine.computeDesiredQuotes(mid, skew);

      const bids = quotes.filter(q => q.side === 'buy');
      const asks = quotes.filter(q => q.side === 'sell');
      expect(bids.length).toBe(3);
      expect(asks.length).toBe(3);
    });

    it('should produce 5 levels when configured for 5', () => {
      const engine = createEngine({ levels: 5 });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const bids = quotes.filter(q => q.side === 'buy');
      const asks = quotes.filter(q => q.side === 'sell');
      expect(bids.length).toBe(5);
      expect(asks.length).toBe(5);
    });

    it('should have sizes that decay with level', () => {
      const engine = createEngine({ levels: 3, baseSizeBTC: 0.1, sizeDecayFactor: 0.8 });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const bids = quotes.filter(q => q.side === 'buy').sort((a, b) => a.level - b.level);

      expect(bids[0].size).toBeCloseTo(0.1, 6);
      expect(bids[1].size).toBeCloseTo(0.08, 6);
      expect(bids[2].size).toBeCloseTo(0.064, 6);
    });

    it('should assign level numbers to each quote', () => {
      const engine = createEngine({ levels: 3 });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const bids = quotes.filter(q => q.side === 'buy').sort((a, b) => a.level - b.level);
      expect(bids[0].level).toBe(1);
      expect(bids[1].level).toBe(2);
      expect(bids[2].level).toBe(3);
    });

    it('should snap all prices to tick size', () => {
      const engine = createEngine({ tickSize: 0.50 });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });

      for (const q of quotes) {
        const remainder = q.price % 0.50;
        expect(remainder).toBeCloseTo(0, 5);
      }
    });
  });

  describe('spread application', () => {
    it('should apply 50bps spread around mid = $100,000', () => {
      const engine = createEngine({ levels: 1, baseSpreadBps: 50, levelSpacingTicks: 1, tickSize: 0.50 });
      const mid = 100000;
      const quotes = engine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 });

      const bid = quotes.find(q => q.side === 'buy');
      const ask = quotes.find(q => q.side === 'sell');

      // halfSpread = 50/10000 * 100000 / 2 = 250
      // level 1 offset = 1 * 1 * 0.50 = 0.50
      // bidRaw = 100000 - 250 - 0.50 = 99749.50
      // askRaw = 100000 + 250 + 0.50 = 100250.50
      expect(bid.price).toBeCloseTo(99749.50, 1);
      expect(ask.price).toBeCloseTo(100250.50, 1);
    });

    it('should have wider spread at deeper levels', () => {
      const engine = createEngine({ levels: 3 });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const bids = quotes.filter(q => q.side === 'buy').sort((a, b) => a.level - b.level);
      const asks = quotes.filter(q => q.side === 'sell').sort((a, b) => a.level - b.level);

      // Deeper levels should have lower bid prices
      expect(bids[0].price).toBeGreaterThan(bids[1].price);
      expect(bids[1].price).toBeGreaterThan(bids[2].price);

      // Deeper levels should have higher ask prices
      expect(asks[0].price).toBeLessThan(asks[1].price);
      expect(asks[1].price).toBeLessThan(asks[2].price);
    });
  });

  describe('coinbase-mirror anchoring', () => {
    const book = { bestBid: 99990, bestAsk: 100010 }; // anchor venue touch, $20 wide

    it('anchors L1 to the venue touch offset by the buffer (1 tick)', () => {
      const engine = createEngine({
        levels: 1, quoteAnchorMode: 'coinbase-mirror', coinbaseAnchorBufferTicks: 1,
        levelSpacingTicks: 2, tickSize: 0.50, baseSpreadBps: 30,
      });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 }, book);
      const bid = quotes.find(q => q.side === 'buy');
      const ask = quotes.find(q => q.side === 'sell');
      // L1 bid = bestBid - 1*0.50 = 99989.50 ; L1 ask = bestAsk + 0.50 = 100010.50
      expect(bid.price).toBeCloseTo(99989.50, 1);
      expect(ask.price).toBeCloseTo(100010.50, 1);
    });

    it('produces a spread close to the venue width (much tighter than baseSpreadBps)', () => {
      const engine = createEngine({
        levels: 1, quoteAnchorMode: 'coinbase-mirror', coinbaseAnchorBufferTicks: 1,
        levelSpacingTicks: 2, tickSize: 0.50, baseSpreadBps: 80,
      });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 }, book);
      const bid = quotes.find(q => q.side === 'buy');
      const ask = quotes.find(q => q.side === 'sell');
      // mirror spread = 20 (venue) + 2*0.50 = 21, vs baseSpreadBps=80 → 800 wide off mid
      expect(ask.price - bid.price).toBeCloseTo(21, 1);
    });

    it('steps a mirror out to the configured full-width floor', () => {
      const engine = createEngine({
        levels: 1, quoteAnchorMode: 'coinbase-mirror', coinbaseAnchorBufferTicks: 1,
        levelSpacingTicks: 1, tickSize: 0.50, baseSpreadBps: 1,
        minimumQuoteWidthBps: 30,
      });
      const tightBook = { bestBid: 99999.5, bestAsk: 100000.0 };
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 }, tightBook);
      const bid = quotes.find(q => q.side === 'buy');
      const ask = quotes.find(q => q.side === 'sell');
      expect(bid.price).toBe(99850);
      expect(ask.price).toBe(100150);
      expect((ask.price - bid.price) / 100000 * 1e4).toBe(30);
    });

    it('keeps an off-tick floor outward after rounding', () => {
      const engine = createEngine({
        levels: 1, quoteAnchorMode: 'coinbase-mirror', tickSize: 0.50,
        minimumQuoteWidthBps: 30,
      });
      const mid = 100000.25;
      const quotes = engine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 }, {
        bestBid: mid - 1, bestAsk: mid + 1,
      });
      const bid = quotes.find(q => q.side === 'buy');
      const ask = quotes.find(q => q.side === 'sell');
      expect(bid.price).toBe(99850);
      expect(ask.price).toBe(100150.5);
      expect(ask.price - bid.price).toBeGreaterThanOrEqual(mid * 30 / 1e4);
    });

    it('steps deeper levels outward beyond L1', () => {
      const engine = createEngine({
        levels: 2, quoteAnchorMode: 'coinbase-mirror', coinbaseAnchorBufferTicks: 1,
        levelSpacingTicks: 2, tickSize: 0.50,
      });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 }, book);
      const bids = quotes.filter(q => q.side === 'buy').sort((a, b) => a.level - b.level);
      const asks = quotes.filter(q => q.side === 'sell').sort((a, b) => a.level - b.level);
      expect(bids[0].price).toBeGreaterThan(bids[1].price);
      expect(asks[0].price).toBeLessThan(asks[1].price);
    });

    it('falls back to mid-anchored quoting when the anchor book is missing', () => {
      const engine = createEngine({
        levels: 1, quoteAnchorMode: 'coinbase-mirror', baseSpreadBps: 50,
        levelSpacingTicks: 1, tickSize: 0.50,
      });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 }, null);
      const bid = quotes.find(q => q.side === 'buy');
      const ask = quotes.find(q => q.side === 'sell');
      expect(bid.price).toBeCloseTo(99749.50, 1);
      expect(ask.price).toBeCloseTo(100250.50, 1);
    });

    it('applies the same floor to the mid fallback when the mirror book is missing', () => {
      const engine = createEngine({
        levels: 1, quoteAnchorMode: 'coinbase-mirror', baseSpreadBps: 1,
        minimumQuoteWidthBps: 30, levelSpacingTicks: 1, tickSize: 0.50,
      });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 }, null);
      expect(quotes.find(q => q.side === 'buy').price).toBe(99850);
      expect(quotes.find(q => q.side === 'sell').price).toBe(100150);
    });

    it('holds the whole desired set with a machine-readable reason when floor and cap have no tick pair', () => {
      const engine = createEngine({
        levels: 1, quoteAnchorMode: 'coinbase-mirror', tickSize: 1,
        minimumQuoteWidthBps: 0.05, contractMaxQuoteSpreadBps: 0.05,
        contractOrderStateMaxAgeMs: 1000,
      });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 }, book);
      expect(quotes).toEqual([]);
      expect(engine.suppressedLevels.get('buy:1').reason).toBe('minimum-width-contract-cap-no-feasible-tick-pair');
      expect(engine.suppressedLevels.get('sell:1').reason).toBe('minimum-width-contract-cap-no-feasible-tick-pair');
    });

    it('suppresses an off-tick floor/cap pair that is passive but narrower than the floor before any send', () => {
      const sent = [];
      const engine = createEngine({
        levels: 1, quoteAnchorMode: 'coinbase-mirror', tickSize: 0.50,
        minimumQuoteWidthBps: 1, contractMaxQuoteSpreadBps: 1,
        contractOrderStateMaxAgeMs: 1000, quoteDispatchMode: 'observe',
        fixConnection: { sendMessage: (message) => sent.push(message) },
      });
      const mid = 100000.25;
      const skew = { bidSkewTicks: 0, askSkewTicks: 0 };
      const book = { bestBid: mid - 1, bestAsk: mid + 1 };

      expect(engine.computeDesiredQuotes(mid, skew, book)).toEqual([]);
      expect(engine.suppressedLevels.get('buy:1').reason).toBe('minimum-width-contract-cap-no-feasible-tick-pair');
      expect(engine.suppressedLevels.get('sell:1').reason).toBe('minimum-width-contract-cap-no-feasible-tick-pair');

      engine.onPriceUpdate({
        ...makePrice(mid),
        sources: [{ exchange: 'coinbase', bid: book.bestBid, ask: book.bestAsk, isStale: false }],
      });
      expect(sent.filter(message => message['35'] === 'D')).toEqual([]);
    });

    it('rejects invalid minimum-width configuration before quote generation', () => {
      expect(() => createEngine({ minimumQuoteWidthBps: -1 }))
        .toThrow('minimumQuoteWidthBps must be a finite non-negative number');
      expect(() => createEngine({
        minimumQuoteWidthBps: 81, contractMaxQuoteSpreadBps: 80, contractOrderStateMaxAgeMs: 1000,
      })).toThrow('minimumQuoteWidthBps cannot exceed contractMaxQuoteSpreadBps');
    });

    it('does not send a D in observer mode when the floor is satisfied', () => {
      const sent = [];
      const engine = createEngine({
        levels: 1, quoteAnchorMode: 'coinbase-mirror', minimumQuoteWidthBps: 30,
        quoteDispatchMode: 'observe', clientId: 'T',
        fixConnection: { sendMessage: (message) => sent.push(message) },
      });
      engine.onPriceUpdate({
        ...makePrice(100000),
        sources: [{ exchange: 'coinbase', bid: 99999.5, ask: 100000, isStale: false }],
      });
      expect(sent.filter(message => message['35'] === 'D')).toEqual([]);
      expect(engine.suppressedLevels.get('buy:1').reason).toBe('quote-dispatch-observe-mode');
    });

    it('default mode stays mid-anchored even when a book is provided', () => {
      const engine = createEngine({ levels: 1, baseSpreadBps: 50, levelSpacingTicks: 1, tickSize: 0.50 });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 }, book);
      const bid = quotes.find(q => q.side === 'buy');
      expect(bid.price).toBeCloseTo(99749.50, 1); // unchanged mid behavior
    });

    // _extractAnchorBook: anchor must come from the named venue's feed, NOT the cross-venue BBO.
    it('sources the anchor from the named venue feed, not cross-venue bestBid/bestAsk', () => {
      const engine = createEngine({ quoteAnchorMode: 'coinbase-mirror', anchorExchange: 'coinbase' });
      const agg = {
        weightedMidpoint: 65700,
        bestBid: 65699, bestAsk: 65701, // synthetic cross-venue BBO (tighter) — must be ignored
        sources: [
          { exchange: 'coinbase', bid: 65690, ask: 65710, isStale: false },
          { exchange: 'kraken', bid: 65699, ask: 65701, isStale: false },
        ],
      };
      expect(engine._extractAnchorBook(agg)).toEqual({ bestBid: 65690, bestAsk: 65710 });
    });

    it('returns null (→ mid fallback) when no fresh coinbase source is present', () => {
      const engine = createEngine({ quoteAnchorMode: 'coinbase-mirror', anchorExchange: 'coinbase' });
      expect(engine._extractAnchorBook({ sources: [{ exchange: 'kraken', bid: 1, ask: 2, isStale: false }] })).toBeNull();
      expect(engine._extractAnchorBook({ sources: [] })).toBeNull();
      expect(engine._extractAnchorBook({})).toBeNull();
    });

    it('ignores a stale coinbase source', () => {
      const engine = createEngine({ quoteAnchorMode: 'coinbase-mirror', anchorExchange: 'coinbase' });
      const agg = { sources: [{ exchange: 'coinbase', bid: 65690, ask: 65710, isStale: true }] };
      expect(engine._extractAnchorBook(agg)).toBeNull();
    });

    // Regression: deferred reprices must honour mirror mode, not silently fall back to mid.
    it('_runDeferredReprice keeps coinbase-mirror anchoring (does not fall back to mid)', () => {
      const sent = [];
      const engine = createEngine({
        levels: 1, quoteAnchorMode: 'coinbase-mirror', coinbaseAnchorBufferTicks: 1,
        levelSpacingTicks: 2, tickSize: 0.50, baseSpreadBps: 80, baseSizeBTC: 0.01,
        sizeDecimalPlaces: 4, minNotional: 1.0, priceBandPct: 2.5, clientId: 'T',
        fixConnection: { sendMessage: (f) => sent.push(f) },
      });
      engine.lastMid = 100000;
      engine.lastAnchorBook = { bestBid: 99990, bestAsk: 100010 };

      engine._runDeferredReprice();

      const bid = sent.filter(f => f['35'] === 'D' && f['54'] === '1').map(f => parseFloat(f['44']));
      expect(bid.length).toBeGreaterThan(0);
      // mirror L1 bid = 99990 - 0.50 = 99989.50; mid fallback (80bps) would be ~99599 — far off.
      expect(Math.max(...bid)).toBeCloseTo(99989.50, 1);
    });
  });

  describe('skew application', () => {
    it('should shift bids down and asks up with positive skew', () => {
      const engine = createEngine({ levels: 1 });
      const mid = 100000;

      const noSkewQuotes = engine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 });
      const skewQuotes = engine.computeDesiredQuotes(mid, { bidSkewTicks: 2, askSkewTicks: 2 });

      const noSkewBid = noSkewQuotes.find(q => q.side === 'buy');
      const skewBid = skewQuotes.find(q => q.side === 'buy');
      const noSkewAsk = noSkewQuotes.find(q => q.side === 'sell');
      const skewAsk = skewQuotes.find(q => q.side === 'sell');

      // bidSkewTicks=2, tickSize=0.50 → bids move down by $1.00
      expect(skewBid.price).toBe(noSkewBid.price - 1.00);
      // askSkewTicks=2, tickSize=0.50 → asks move up by $1.00
      expect(skewAsk.price).toBe(noSkewAsk.price + 1.00);
    });

    it('should shift bids up with negative skew (tighten when short)', () => {
      const engine = createEngine({ levels: 1 });
      const mid = 100000;

      const noSkewQuotes = engine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 });
      const skewQuotes = engine.computeDesiredQuotes(mid, { bidSkewTicks: -2, askSkewTicks: -2 });

      const noSkewBid = noSkewQuotes.find(q => q.side === 'buy');
      const skewBid = skewQuotes.find(q => q.side === 'buy');

      // Negative bidSkewTicks → bids tighten (move up)
      expect(skewBid.price).toBe(noSkewBid.price + 1.00);
    });

    it('applies target-relative inventory skew in the intended quote-price direction', () => {
      const inventoryManager = new InventoryManager({
        maxPositionBTC: 1,
        targetInventoryBTC: 0.4,
        maxSkewTicks: 10,
        skewExponent: 1,
        logger: createMockLogger(),
      });
      const engine = createEngine({ levels: 1, inventoryManager });
      const unskewed = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });

      // 0.6 BTC is 0.2 BTC above target: bids become less aggressive and asks more aggressive.
      inventoryManager.onFill({ side: 'buy', quantity: 0.6, price: 100000, venue: 'truex', execID: 'E1' });
      const aboveTarget = engine.computeDesiredQuotes(100000, inventoryManager.getSkew());
      expect(aboveTarget.find(q => q.side === 'buy').price).toBe(unskewed.find(q => q.side === 'buy').price - 1);
      expect(aboveTarget.find(q => q.side === 'sell').price).toBe(unskewed.find(q => q.side === 'sell').price - 1);

      // 0.2 BTC is 0.2 BTC below target: bids tighten and asks widen.
      inventoryManager.reset();
      inventoryManager.onFill({ side: 'buy', quantity: 0.2, price: 100000, venue: 'truex', execID: 'E2' });
      const belowTarget = engine.computeDesiredQuotes(100000, inventoryManager.getSkew());
      expect(belowTarget.find(q => q.side === 'buy').price).toBe(unskewed.find(q => q.side === 'buy').price + 1);
      expect(belowTarget.find(q => q.side === 'sell').price).toBe(unskewed.find(q => q.side === 'sell').price + 1);
    });

    it('applies the opt-in Gaussian recovery adjustment only below its interim target', () => {
      const recoveryConfig = {
        enabled: true,
        interimTargetInventoryBTC: 1,
        inventorySigmaBTC: 0.25,
        centerBandSigma: 0.5,
        softHedgeBandSigma: 2,
        hardHedgeBandSigma: 3,
        minimumMakerParticipation: 0.25,
        maxSizeAsymmetry: 0.75,
        maxQuoteSkewBps: 10,
      };
      const inventoryManager = createMockInventory({
        getPositionSummary: () => ({ netPosition: 0.5, baseBalance: { total: 0.5 } }),
      });
      inventoryManager.getPositionSummary = () => ({ netPosition: 0.5, baseBalance: { total: 0.5 } });
      const base = createEngine({ levels: 1, inventoryManager });
      const recovery = createEngine({
        levels: 1, inventoryManager, quoteDispatchMode: 'observe', inventoryRecoveryConfig: recoveryConfig,
      });
      const baseQuotes = base.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const recoveryQuotes = recovery.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const baseBid = baseQuotes.find(q => q.side === 'buy');
      const baseAsk = baseQuotes.find(q => q.side === 'sell');
      const recoveryBid = recoveryQuotes.find(q => q.side === 'buy');
      const recoveryAsk = recoveryQuotes.find(q => q.side === 'sell');

      expect(recoveryBid.price).toBeGreaterThanOrEqual(baseBid.price);
      expect(recoveryBid.size).toBeGreaterThanOrEqual(baseBid.size);
      expect(recoveryAsk.price).toBeGreaterThanOrEqual(baseAsk.price);
      expect(recoveryAsk.size).toBeLessThanOrEqual(baseAsk.size);
      expect(recovery.getQuoteStatus().inventoryRecovery).toMatchObject({
        enabled: true, adjustmentApplied: true, reason: 'below-interim-target',
      });

      inventoryManager.getPositionSummary = () => ({ netPosition: 1, baseBalance: { total: 1 } });
      expect(recovery.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 }))
        .toEqual(baseQuotes);
      expect(recovery.getQuoteStatus().inventoryRecovery).toMatchObject({
        adjustmentApplied: false, reason: 'interim-target-reached',
      });

      const symmetric = createEngine({
        levels: 1,
        inventoryManager,
        quoteDispatchMode: 'observe',
        inventoryRecoveryConfig: { ...recoveryConfig, operateOnExcess: true },
      });
      inventoryManager.getPositionSummary = () => ({ netPosition: 1.5, baseBalance: { total: 1.5 } });
      const excessQuotes = symmetric.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      expect(excessQuotes.find(q => q.side === 'buy').price).toBeLessThanOrEqual(baseBid.price);
      expect(excessQuotes.find(q => q.side === 'buy').size).toBeLessThanOrEqual(baseBid.size);
      expect(excessQuotes.find(q => q.side === 'sell').price).toBeLessThanOrEqual(baseAsk.price);
      expect(excessQuotes.find(q => q.side === 'sell').size).toBeGreaterThanOrEqual(baseAsk.size);
    });

    it('keeps recovery-shaped candidates observe-only without local order mutation', () => {
      const inventoryManager = createMockInventory();
      inventoryManager.getPositionSummary = () => ({ netPosition: 0.5, baseBalance: { total: 0.5 } });
      const fixConnection = createMockFix();
      const engine = createEngine({
        levels: 1,
        inventoryManager,
        fixConnection,
        quoteDispatchMode: 'observe',
        inventoryRecoveryConfig: {
          enabled: true, interimTargetInventoryBTC: 1, inventorySigmaBTC: 0.25,
          centerBandSigma: 0.5, softHedgeBandSigma: 2, hardHedgeBandSigma: 3,
          minimumMakerParticipation: 0.25, maxSizeAsymmetry: 0.75, maxQuoteSkewBps: 10,
        },
      });
      engine.onPriceUpdate(makePrice(100000));
      expect(fixConnection.sendMessage).not.toHaveBeenCalled();
      expect(engine.activeOrders.size).toBe(0);
      expect(engine.getQuoteStatus().inventoryRecovery.adjustmentApplied).toBe(true);
    });

    it('rejects enabled recovery in a live engine and blocks tagged candidates if dispatch state is corrupted', () => {
      const inventoryManager = createMockInventory();
      inventoryManager.getPositionSummary = () => ({ netPosition: 0.5, baseBalance: { total: 0.5 } });
      const fixConnection = createMockFix();
      const reservations = {
        reserve: mock(() => ({ accepted: true })),
        getPresence: mock(() => ({ buy: 0, sell: 0 })),
        getReservations: mock(() => []),
        getQuoteCapacityForLevel: mock(() => Number.POSITIVE_INFINITY),
      };
      const config = {
        enabled: true, interimTargetInventoryBTC: 1, inventorySigmaBTC: 0.25,
        centerBandSigma: 0.5, softHedgeBandSigma: 2, hardHedgeBandSigma: 3,
        minimumMakerParticipation: 0.25, maxSizeAsymmetry: 0.75, maxQuoteSkewBps: 10,
      };
      expect(() => createEngine({ inventoryManager, inventoryRecoveryConfig: config }))
        .toThrow('inventoryRecoveryConfig requires quoteDispatchMode=observe');

      const engine = createEngine({
        inventoryManager, fixConnection, capitalReservationManager: reservations,
        quoteDispatchMode: 'observe', inventoryRecoveryConfig: config,
      });
      engine.config.quoteDispatchMode = 'live';
      expect(engine._sendNewOrder({ side: 'buy', price: 99999, size: 0.1, level: 1, inventoryRecovery: true }))
        .toBeNull();
      expect(fixConnection.sendMessage).not.toHaveBeenCalled();
      expect(reservations.reserve).not.toHaveBeenCalled();
      expect(engine.activeOrders.size).toBe(0);
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('inventory-recovery-observe-only');

      // An untagged direct caller cannot bypass the enabled-recovery gate.
      expect(engine._sendNewOrder({ side: 'buy', price: 99999, size: 0.1, level: 1 }))
        .toBeNull();
      expect(fixConnection.sendMessage).not.toHaveBeenCalled();
      expect(reservations.reserve).not.toHaveBeenCalled();
      expect(engine.activeOrders.size).toBe(0);

      // At the interim target the generated ordinary quote has no recovery
      // marker, yet a tampered live dispatch mode still cannot place it.
      inventoryManager.getPositionSummary = () => ({ netPosition: 1, baseBalance: { total: 1 } });
      const targetQuotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      expect(targetQuotes.every((quote) => quote.inventoryRecovery !== true)).toBe(true);
      engine.onPriceUpdate(makePrice(100000));
      expect(fixConnection.sendMessage).not.toHaveBeenCalled();
      expect(reservations.reserve).not.toHaveBeenCalled();
      expect(engine.activeOrders.size).toBe(0);
    });

    it('continues to allow a protective pure cancel if recovery dispatch state is corrupted', () => {
      const fixConnection = createMockFix();
      const engine = createEngine({
        fixConnection,
        quoteDispatchMode: 'observe',
        inventoryRecoveryConfig: {
          enabled: true, interimTargetInventoryBTC: 1, inventorySigmaBTC: 0.25,
          centerBandSigma: 0.5, softHedgeBandSigma: 2, hardHedgeBandSigma: 3,
          minimumMakerParticipation: 0.25, maxSizeAsymmetry: 0.75, maxQuoteSkewBps: 10,
        },
      });
      engine.config.quoteDispatchMode = 'live';
      const order = { side: 'buy', price: 99999, size: 0.1, level: 1, status: 'active' };
      engine.activeOrders.set('C1', order);

      expect(engine._dispatchAction({ type: 'cancel', clOrdID: 'C1', order })).toBe(true);
      expect(fixConnection.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ '35': 'F' }));
      expect(order.status).toBe('cancelling');
    });
  });

  describe('reconciliation', () => {
    it('should place new orders when no active orders exist', () => {
      const engine = createEngine({ levels: 2 });
      const desired = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const actions = engine.reconcileOrders(desired, new Map());

      expect(actions.toPlace.length).toBe(desired.length);
      expect(actions.toCancel.length).toBe(0);
      expect(actions.toReplace.length).toBe(0);
    });

    it('should take no action when price is stable', () => {
      const engine = createEngine({ levels: 1, repriceThresholdTicks: 1 });
      const mid = 100000;
      const desired = engine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 });

      // Simulate existing active orders matching desired
      const active = new Map();
      for (const dq of desired) {
        const id = `EXISTING_${dq.side}_${dq.level}`;
        active.set(id, { side: dq.side, price: dq.price, size: dq.size, level: dq.level, status: 'active', placedAt: Date.now() });
      }

      const actions = engine.reconcileOrders(desired, active);
      expect(actions.toPlace.length).toBe(0);
      expect(actions.toCancel.length).toBe(0);
      expect(actions.toReplace.length).toBe(0);
    });

    it('should replenish a partially-filled (under-sized) order back to target size', () => {
      const engine = createEngine({ levels: 1, repriceThresholdTicks: 1, tickSize: 0.50, minNotional: 1.0 });
      const mid = 100000;
      const desired = engine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 });

      // Active orders at the SAME price but reduced size (as if partially filled)
      const active = new Map();
      for (const dq of desired) {
        active.set(`PF_${dq.side}_${dq.level}`, {
          side: dq.side, price: dq.price, size: dq.size * 0.4, // 60% filled → under-quoted
          level: dq.level, status: 'active', placedAt: Date.now(),
        });
      }

      const actions = engine.reconcileOrders(desired, active);
      expect(actions.toReplace.length).toBe(desired.length); // top up each under-sized level
      expect(actions.toPlace.length).toBe(0);
    });

    it('should NOT replenish when the size shortfall is below minNotional (avoid churn)', () => {
      const engine = createEngine({ levels: 1, repriceThresholdTicks: 1, tickSize: 0.50, minNotional: 1.0 });
      const mid = 100000;
      const desired = engine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 });

      const active = new Map();
      for (const dq of desired) {
        // shortfall * price must be < minNotional ($1): at $100k, shortfall < 0.00001 BTC
        active.set(`TINY_${dq.side}_${dq.level}`, {
          side: dq.side, price: dq.price, size: dq.size - 0.000005,
          level: dq.level, status: 'active', placedAt: Date.now(),
        });
      }

      const actions = engine.reconcileOrders(desired, active);
      expect(actions.toReplace.length).toBe(0); // tiny shortfall ignored
    });

    it('should cancel-replace when price moves >= repriceThresholdTicks', () => {
      const engine = createEngine({ levels: 1, repriceThresholdTicks: 1, tickSize: 0.50 });
      const mid = 100000;
      const desired = engine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 });

      // Simulate active orders at different price (offset by 1 tick = $0.50)
      const active = new Map();
      for (const dq of desired) {
        const id = `OLD_${dq.side}_${dq.level}`;
        active.set(id, {
          side: dq.side,
          price: dq.price + 0.50, // 1 tick off
          size: dq.size,
          level: dq.level,
          status: 'active',
          placedAt: Date.now(),
        });
      }

      const actions = engine.reconcileOrders(desired, active);
      expect(actions.toReplace.length).toBe(desired.length);
      expect(actions.toPlace.length).toBe(0);
      expect(actions.toCancel.length).toBe(0);
    });

    it('should cancel active orders that have no desired counterpart', () => {
      const engine = createEngine({ levels: 1 });
      const desired = []; // No desired quotes (e.g., pullback)

      const active = new Map();
      active.set('STALE_1', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });
      active.set('STALE_2', { side: 'sell', price: 100250, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });

      const actions = engine.reconcileOrders(desired, active);
      expect(actions.toCancel.length).toBe(2);
    });

    it('should place new level when existing levels are insufficient', () => {
      const engine = createEngine({ levels: 2 });
      const mid = 100000;
      const desired = engine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 });

      // Only have level 1 active
      const active = new Map();
      for (const dq of desired) {
        if (dq.level === 1) {
          active.set(`EX_${dq.side}_${dq.level}`, {
            side: dq.side, price: dq.price, size: dq.size, level: dq.level, status: 'active', placedAt: Date.now()
          });
        }
      }

      const actions = engine.reconcileOrders(desired, active);
      // Level 2 orders (1 bid + 1 ask) should be placed
      expect(actions.toPlace.length).toBe(2);
    });
  });

  describe('rate limiting', () => {
    it('should defer actions beyond maxOrdersPerSecond', () => {
      const engine = createEngine({ maxOrdersPerSecond: 3, levels: 3 });
      const rateLimitedEvents = [];
      engine.on('rate-limited', (e) => rateLimitedEvents.push(e));

      // Force reset to now
      engine.lastActionReset = Date.now();
      engine.actionsThisSecond = 0;

      // Create 6 desired quotes (3 bids + 3 asks), all new
      const desired = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const actions = engine.reconcileOrders(desired, new Map());

      engine.executeActions(actions);

      // 3 should execute, 3 should be deferred
      expect(engine.actionsThisSecond).toBe(3);
      expect(engine.actionQueue.length).toBe(3);
      expect(rateLimitedEvents.length).toBe(3);
    });

    it('should allow draining the queue after rate limit resets', () => {
      const engine = createEngine({ maxOrdersPerSecond: 2, levels: 2 });

      engine.lastActionReset = Date.now();
      engine.actionsThisSecond = 0;

      const desired = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const actions = engine.reconcileOrders(desired, new Map());

      engine.executeActions(actions);
      expect(engine.actionQueue.length).toBe(2); // 4 total - 2 executed

      // Simulate time passing (reset rate counter)
      engine.lastActionReset = Date.now() - 1001;
      engine.drainQueue();
      expect(engine.actionQueue.length).toBe(0);
    });

    it('should cancel old order before placing replacement by default on TrueX', () => {
      // High rate limit so nothing gets deferred
      const fixMock = createMockFix();
      const engine = createEngine({ maxOrdersPerSecond: 100, levels: 1, fixConnection: fixMock });

      engine.lastActionReset = Date.now();
      engine.actionsThisSecond = 0;

      // Simulate one active order that needs repricing
      const oldClOrdID = 'OLD001';
      const oldOrder = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set(oldClOrdID, oldOrder);

      const newQuote = { side: 'buy', price: 99500, size: 0.1, level: 1 };

      const actions = {
        toCancel: [],
        toPlace: [],
        toReplace: [{ cancel: oldClOrdID, cancelOrder: oldOrder, place: newQuote }],
      };

      engine.executeActions(actions);

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixMock.sendMessage.mock.calls[0][0]['35']).toBe('F');
      expect(engine.pendingReplacements.has(oldClOrdID)).toBe(true);

      const cancelClOrdID = fixMock.sendMessage.mock.calls[0][0]['11'];
      engine.onExecutionReport({ '11': cancelClOrdID, '39': '4', '54': '1' });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(2);
      expect(fixMock.sendMessage.mock.calls[1][0]['35']).toBe('D');
      expect(engine.pendingReplacements.has(oldClOrdID)).toBe(false);
    });

    it('should preserve place-before-cancel only when explicitly configured', () => {
      const engine = createEngine({ maxOrdersPerSecond: 100, levels: 1, replaceMode: 'place-before-cancel' });
      const oldClOrdID = 'OLD001';
      const oldOrder = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      const newQuote = { side: 'buy', price: 99500, size: 0.1, level: 1 };
      const dispatchedTypes = [];
      engine._dispatchAction = (action) => dispatchedTypes.push(action.type);

      engine.executeActions({
        toCancel: [],
        toPlace: [],
        toReplace: [{ cancel: oldClOrdID, cancelOrder: oldOrder, place: newQuote }],
      });

      expect(dispatchedTypes).toEqual(['place', 'cancel']);
    });

    it('should stagger passive-safe replacements and preserve one live order per side', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        maxOrdersPerSecond: 100,
        levels: 2,
        minActiveLevelsPerSide: 1,
        maxReplacementsPerSidePerCycle: 1,
      });

      const buyL1 = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      const buyL2 = { side: 'buy', price: 98000, size: 0.1, level: 2, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set('B1', buyL1);
      engine.activeOrders.set('B2', buyL2);

      engine.executeActions({
        toCancel: [],
        toPlace: [],
        toReplace: [
          { cancel: 'B1', cancelOrder: buyL1, place: { side: 'buy', price: 99100, size: 0.1, level: 1 } },
          { cancel: 'B2', cancelOrder: buyL2, place: { side: 'buy', price: 98100, size: 0.1, level: 2 } },
        ],
      });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixMock.sendMessage.mock.calls[0][0]['35']).toBe('F');
      const cancelledOrderId = fixMock.sendMessage.mock.calls[0][0]['41'];
      expect(engine.pendingReplacements.has(cancelledOrderId)).toBe(true);
      expect(
        [...engine.activeOrders.entries()].filter(([, order]) =>
          order.side === 'buy' && order.status === 'active'
        ).length
      ).toBe(1);
    });

    it('should still allow a single active quote to reprice in passive-safe mode', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        maxOrdersPerSecond: 100,
        levels: 1,
        minActiveLevelsPerSide: 1,
        maxReplacementsPerSidePerCycle: 1,
      });

      const oldOrder = { side: 'sell', price: 101000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set('S1', oldOrder);

      engine.executeActions({
        toCancel: [],
        toPlace: [],
        toReplace: [
          { cancel: 'S1', cancelOrder: oldOrder, place: { side: 'sell', price: 101100, size: 0.1, level: 1 } },
        ],
      });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixMock.sendMessage.mock.calls[0][0]['35']).toBe('F');
      expect(engine.pendingReplacements.has('S1')).toBe(true);
      expect(engine.activeOrders.get('S1').status).toBe('cancelling');
    });

    it('should not use the single-quote exception when another replacement is already in flight on that side', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        maxOrdersPerSecond: 100,
        levels: 2,
        minActiveLevelsPerSide: 1,
        maxReplacementsPerSidePerCycle: 2,
      });

      const buyL1 = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      const buyL2 = { side: 'buy', price: 98000, size: 0.1, level: 2, status: 'cancelling', placedAt: Date.now() };
      engine.activeOrders.set('B1', buyL1);
      engine.activeOrders.set('B2', buyL2);
      engine.pendingReplacements.set('B2', {
        quote: { side: 'buy', price: 98100, size: 0.1, level: 2 },
        createdAt: Date.now(),
      });

      engine.executeActions({
        toCancel: [],
        toPlace: [],
        toReplace: [
          { cancel: 'B1', cancelOrder: buyL1, place: { side: 'buy', price: 99100, size: 0.1, level: 1 } },
        ],
      });

      expect(engine.deferredRepriceNeeded).toBe(true);
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.pendingReplacements.has('B1')).toBe(false);
    });

    it('should account for same-cycle pure cancels before allowing passive-safe replacements', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        maxOrdersPerSecond: 100,
        levels: 2,
        minActiveLevelsPerSide: 1,
        maxReplacementsPerSidePerCycle: 1,
      });

      const buyL1 = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      const buyL2 = { side: 'buy', price: 98000, size: 0.1, level: 2, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set('B1', buyL1);
      engine.activeOrders.set('B2', buyL2);

      engine.executeActions({
        toCancel: [{ clOrdID: 'B1', order: buyL1 }],
        toPlace: [],
        toReplace: [
          { cancel: 'B2', cancelOrder: buyL2, place: { side: 'buy', price: 98100, size: 0.1, level: 2 } },
        ],
      });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixMock.sendMessage.mock.calls[0][0]['35']).toBe('F');
      expect(fixMock.sendMessage.mock.calls[0][0]['41']).toBe('B1');
      expect(engine.pendingReplacements.size).toBe(0);
      expect(engine.activeOrders.get('B2').status).toBe('active');
    });

    it('should treat pending orders as inflight when enforcing the passive-safe live floor', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        maxOrdersPerSecond: 100,
        levels: 2,
        minActiveLevelsPerSide: 1,
        maxReplacementsPerSidePerCycle: 1,
      });

      const activeBuy = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      const pendingBuy = { side: 'buy', price: 98000, size: 0.1, level: 2, status: 'pending', placedAt: Date.now() };
      engine.activeOrders.set('B1', activeBuy);
      engine.activeOrders.set('B2', pendingBuy);

      engine.executeActions({
        toCancel: [],
        toPlace: [],
        toReplace: [
          { cancel: 'B1', cancelOrder: activeBuy, place: { side: 'buy', price: 99100, size: 0.1, level: 1 } },
        ],
      });

      expect(engine.deferredRepriceNeeded).toBe(true);
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.pendingReplacements.has('B1')).toBe(false);
      expect(engine.activeOrders.get('B1').status).toBe('active');
    });

    it('should rotate passive-safe replacements across levels instead of always picking the deepest level', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        maxOrdersPerSecond: 100,
        levels: 3,
        minActiveLevelsPerSide: 1,
        maxReplacementsPerSidePerCycle: 1,
      });

      const buyL1 = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      const buyL2 = { side: 'buy', price: 98000, size: 0.1, level: 2, status: 'active', placedAt: Date.now() };
      const buyL3 = { side: 'buy', price: 97000, size: 0.1, level: 3, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set('B1', buyL1);
      engine.activeOrders.set('B2', buyL2);
      engine.activeOrders.set('B3', buyL3);

      const actions = {
        toCancel: [],
        toPlace: [],
        toReplace: [
          { cancel: 'B1', cancelOrder: buyL1, place: { side: 'buy', price: 99100, size: 0.1, level: 1 } },
          { cancel: 'B2', cancelOrder: buyL2, place: { side: 'buy', price: 98100, size: 0.1, level: 2 } },
          { cancel: 'B3', cancelOrder: buyL3, place: { side: 'buy', price: 97100, size: 0.1, level: 3 } },
        ],
      };

      engine.executeActions(actions);
      expect(fixMock.sendMessage.mock.calls[0][0]['41']).toBe('B1');
      const firstCancelClOrdID = fixMock.sendMessage.mock.calls[0][0]['11'];
      engine.onExecutionReport({ '11': firstCancelClOrdID, '39': '4', '54': '1' });
      engine.onExecutionReport({ '11': fixMock.sendMessage.mock.calls[1][0]['11'], '39': '0', '54': '1' });

      fixMock.sendMessage.mockClear();
      engine.executeActions(actions);

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixMock.sendMessage.mock.calls[0][0]['41']).toBe('B2');
    });

    it('should rotate passive-safe replacement priority across sides after the last dispatched side', () => {
      const engine = createEngine();
      engine.lastReplacementSide = 'buy';

      const ordered = engine._orderPassiveSafeReplacements([
        { cancel: 'B1', cancelOrder: { side: 'buy', level: 1 }, place: { side: 'buy', level: 1 } },
        { cancel: 'S1', cancelOrder: { side: 'sell', level: 1 }, place: { side: 'sell', level: 1 } },
      ]);

      expect(ordered.map((replacement) => replacement.cancelOrder.side)).toEqual(['sell', 'buy']);
    });

    it('should enforce passive-safe floors greater than one without using the single-quote exception', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        maxOrdersPerSecond: 100,
        levels: 2,
        minActiveLevelsPerSide: 2,
        maxReplacementsPerSidePerCycle: 1,
      });

      const buyL1 = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      const buyL2 = { side: 'buy', price: 98000, size: 0.1, level: 2, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set('B1', buyL1);
      engine.activeOrders.set('B2', buyL2);

      engine.executeActions({
        toCancel: [],
        toPlace: [],
        toReplace: [
          { cancel: 'B1', cancelOrder: buyL1, place: { side: 'buy', price: 99100, size: 0.1, level: 1 } },
        ],
      });

      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.pendingReplacements.size).toBe(0);
    });

    it('should drop rate-limited passive-safe replacements instead of queueing stale cancel intents', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        maxOrdersPerSecond: 1,
        levels: 2,
        minActiveLevelsPerSide: 1,
        maxReplacementsPerSidePerCycle: 1,
      });

      const buyL1 = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      const buyL2 = { side: 'buy', price: 98000, size: 0.1, level: 2, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set('B1', buyL1);
      engine.activeOrders.set('B2', buyL2);
      engine.lastActionReset = Date.now();
      engine.actionsThisSecond = 1;

      const actions = {
        toCancel: [],
        toPlace: [],
        toReplace: [
          { cancel: 'B1', cancelOrder: buyL1, place: { side: 'buy', price: 99100, size: 0.1, level: 1 } },
        ],
      };

      engine.executeActions(actions);

      expect(engine.actionQueue.length).toBe(0);
      expect(engine.pendingReplacements.size).toBe(0);
      expect(fixMock.sendMessage).not.toHaveBeenCalled();

      engine.lastActionReset = Date.now() - 1001;
      engine.actionsThisSecond = 0;
      engine.executeActions(actions);

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixMock.sendMessage.mock.calls[0][0]['35']).toBe('F');
      expect(engine.pendingReplacements.has('B1')).toBe(true);
    });

    it('should trigger a deferred reprice retry after the rate window resets', () => {
      const engine = createEngine({ maxOrdersPerSecond: 1 });
      engine.deferredRepriceNeeded = true;
      engine.actionsThisSecond = 0;
      engine.lastActionReset = Date.now() - 1001;

      let deferredRuns = 0;
      engine._runDeferredReprice = () => {
        deferredRuns++;
        engine.deferredRepriceNeeded = false;
        return true;
      };

      engine.drainQueue();

      expect(deferredRuns).toBe(1);
      expect(engine.deferredRepriceNeeded).toBe(false);
    });

    it('should preserve deferred reprices while quoting remains suspended during drain', () => {
      const engine = createEngine();
      engine.deferredRepriceNeeded = true;
      engine.quotingSuspended = true;

      engine.drainQueue();

      expect(engine.deferredRepriceNeeded).toBe(true);
    });

    it('should schedule another deferred reprice when passive-safe throttles skip replacements', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        maxOrdersPerSecond: 100,
        levels: 2,
        minActiveLevelsPerSide: 1,
        maxReplacementsPerSidePerCycle: 1,
      });

      const buyL1 = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      const buyL2 = { side: 'buy', price: 98000, size: 0.1, level: 2, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set('B1', buyL1);
      engine.activeOrders.set('B2', buyL2);

      engine.executeActions({
        toCancel: [],
        toPlace: [],
        toReplace: [
          { cancel: 'B1', cancelOrder: buyL1, place: { side: 'buy', price: 99100, size: 0.1, level: 1 } },
          { cancel: 'B2', cancelOrder: buyL2, place: { side: 'buy', price: 98100, size: 0.1, level: 2 } },
        ],
      });

      expect(engine.deferredRepriceNeeded).toBe(true);
      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('should not run deferred reprices while quoting is suspended', () => {
      const engine = createEngine();
      engine.lastMid = 100000;
      engine.quotingSuspended = true;

      expect(engine._runDeferredReprice()).toBe(false);
      expect(engine.deferredRepriceNeeded).toBe(true);
    });

    it('should defer deferred-reprice execution until minRepriceInterval has elapsed', () => {
      const engine = createEngine({ minRepriceIntervalMs: 1000 });
      engine.lastMid = 100000;
      engine.lastRepriceAt = Date.now();
      engine.deferredRepriceNeeded = false;

      expect(engine._runDeferredReprice()).toBe(false);
      expect(engine.deferredRepriceNeeded).toBe(true);
    });

    it('should refresh lastRepriceAt after a successful deferred reprice', () => {
      const engine = createEngine();
      engine.lastMid = 100000;
      engine.lastRepriceAt = 1;
      // No resting orders: the deferred reprice places a fresh ladder with no
      // same-side cancels in flight, so nothing is held by the balance-safety gate.
      // (With a resting order present the cycle defers its placements pending the
      // cancel confirm — covered in tests/quote-engine-cancel-gate.test.js.)

      const before = Date.now();
      const ran = engine._runDeferredReprice();

      expect(ran).toBe(true);
      expect(engine.lastRepriceAt).toBeGreaterThanOrEqual(before);
    });

    it('should keep deferred repricing armed when a deferred retry still has passive-safe follow-up work', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        maxOrdersPerSecond: 100,
        levels: 2,
        minActiveLevelsPerSide: 1,
        maxReplacementsPerSidePerCycle: 1,
      });

      const buyL1 = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      const buyL2 = { side: 'buy', price: 98000, size: 0.1, level: 2, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set('B1', buyL1);
      engine.activeOrders.set('B2', buyL2);
      engine.lastMid = 100000;
      engine.computeDesiredQuotes = () => [];
      engine.reconcileOrders = () => ({
        toCancel: [],
        toPlace: [],
        toReplace: [
          { cancel: 'B1', cancelOrder: buyL1, place: { side: 'buy', price: 99100, size: 0.1, level: 1 } },
          { cancel: 'B2', cancelOrder: buyL2, place: { side: 'buy', price: 98100, size: 0.1, level: 2 } },
        ],
      });

      const completed = engine._runDeferredReprice();

      expect(completed).toBe(false);
      expect(engine.deferredRepriceNeeded).toBe(true);
      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('records an attempt timestamp when a passive-safe reprice defers all outbound actions', () => {
      const engine = createEngine({ minRepriceIntervalMs: 60_000 });
      engine.lastRepriceAt = 123;
      engine.computeDesiredQuotes = () => [{ side: 'buy', price: 99100, size: 0.1, level: 1 }];
      engine.reconcileOrders = () => ({
        toCancel: [],
        toPlace: [],
        toReplace: [{ cancel: 'B1', cancelOrder: { side: 'buy', level: 1 }, place: { side: 'buy', price: 99100, size: 0.1, level: 1 } }],
      });
      let executions = 0;
      engine.executeActions = () => {
        executions++;
        engine.deferredRepriceNeeded = true;
        return false;
      };

      engine.onPriceUpdate(makePrice(100000, 0.95));

      expect(engine.deferredRepriceNeeded).toBe(true);
      expect(engine.lastRepriceAt).toBe(123);
      expect(engine.lastRepriceAttemptAt).toBeGreaterThan(123);
      expect(executions).toBe(1);

      // Identical follow-up market data must respect the attempt debounce even
      // though no order was sent in the first cycle.
      engine.onPriceUpdate(makePrice(100000, 0.95));
      expect(executions).toBe(1);
    });

    it('uses the same attempt debounce for deferred retry cycles that dispatch nothing', () => {
      const engine = createEngine({ minRepriceIntervalMs: 60_000 });
      engine.lastMid = 100000;
      engine.computeDesiredQuotes = () => [{ side: 'buy', price: 99100, size: 0.1, level: 1 }];
      engine.reconcileOrders = () => ({
        toCancel: [],
        toPlace: [],
        toReplace: [{ cancel: 'B1', cancelOrder: { side: 'buy', level: 1 }, place: { side: 'buy', price: 99100, size: 0.1, level: 1 } }],
      });
      let executions = 0;
      engine.executeActions = () => {
        executions++;
        engine.deferredRepriceNeeded = true;
        return false;
      };

      expect(engine._runDeferredReprice()).toBe(false);
      expect(engine.lastRepriceAt).toBe(0);
      expect(engine.lastRepriceAttemptAt).toBeGreaterThan(0);
      expect(executions).toBe(1);

      expect(engine._runDeferredReprice()).toBe(false);
      expect(executions).toBe(1);
    });

    it('should clear deferred reprices when cancelAllQuotes suspends quoting', () => {
      const engine = createEngine();
      engine.deferredRepriceNeeded = true;
      engine.actionQueue.push({ type: 'place', quote: { side: 'buy', price: 100, size: 0.1, level: 1 } });
      engine.activeOrders.set('B1', { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });

      engine.cancelAllQuotes('Low confidence');

      expect(engine.deferredRepriceNeeded).toBe(false);
      expect(engine.actionQueue.length).toBe(0);
      expect(engine.quotingSuspended).toBe(true);
    });

    it('should preserve queued actions and deferred reprices during ordinary suspension', () => {
      const engine = createEngine();
      engine.isQuoting = true;
      engine.deferredRepriceNeeded = true;
      engine.actionQueue.push({ type: 'place', quote: { side: 'buy', price: 100, size: 0.1, level: 1 } });

      engine.suspendQuoting();

      expect(engine.isQuoting).toBe(false);
      expect(engine.deferredRepriceNeeded).toBe(true);
      expect(engine.actionQueue.length).toBe(1);
    });

    it('should invalidate queued actions and re-arm a fresh deferred reprice when requested', () => {
      const engine = createEngine();
      engine.deferredRepriceNeeded = true;
      engine.actionQueue.push({ type: 'place', quote: { side: 'buy', price: 100, size: 0.1, level: 1 } });

      engine.invalidateQueuedWork(true);

      expect(engine.deferredRepriceNeeded).toBe(true);
      expect(engine.actionQueue.length).toBe(0);
    });

    it('should resume quoting explicitly after suspension', () => {
      const engine = createEngine();
      engine.suspendQuoting();

      engine.resumeQuoting();

      expect(engine.quotingSuspended).toBe(false);
    });

    it('should ignore direct price updates while quoting is suspended', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock, maxOrdersPerSecond: 100, levels: 1 });

      engine.suspendQuoting();
      engine.onPriceUpdate({ weightedMidpoint: 100000, confidence: 1 });

      expect(engine.lastMid).toBe(100000);
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.isQuoting).toBe(false);
    });

    it('should skip marketable ALO buy orders before send', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock });
      engine.updateTrueXBook({ bestBid: 99, bestAsk: 100, timestamp: Date.now() });

      const result = engine._sendNewOrder({ side: 'buy', price: 100, size: 0.1, level: 1 });

      expect(result).toBeNull();
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.getQuoteStatus().lastMarketableAloSkip.reason).toBe('marketable-post-only');
    });

    it('should include TrueX self-match prevention on maker orders by default', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock });

      engine._sendNewOrder({ side: 'buy', price: 99, size: 0.1, level: 1 });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixMock.sendMessage.mock.calls[0][0]['18']).toBe('6');
      expect(fixMock.sendMessage.mock.calls[0][0]['2964']).toBe('0');
    });

    it('should omit self-match prevention when explicitly disabled', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        selfMatchPreventionInstruction: 'none',
      });

      engine._sendNewOrder({ side: 'sell', price: 101, size: 0.1, level: 1 });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixMock.sendMessage.mock.calls[0][0]['2964']).toBeUndefined();
    });

    it('should preserve numeric 0 self-match prevention config', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        selfMatchPreventionInstruction: 0,
      });

      engine._sendNewOrder({ side: 'buy', price: 99, size: 0.1, level: 1 });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixMock.sendMessage.mock.calls[0][0]['2964']).toBe('0');
    });

    it('should suppress post-only quotes that would cross tracked contra orders', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock });
      engine.activeOrders.set('ASK001', {
        side: 'sell',
        price: 100,
        size: 0.1,
        level: 1,
        status: 'cancelling',
        placedAt: Date.now(),
      });

      const result = engine._sendNewOrder({ side: 'buy', price: 100, size: 0.1, level: 1 });

      expect(result).toBeNull();
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('self-cross-tracked-order');
    });

    it('should not suppress against stale cancelling contra orders', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock });
      engine.activeOrders.set('ASK001', {
        side: 'sell',
        price: 100,
        size: 0.1,
        level: 1,
        status: 'cancelling',
        placedAt: Date.now() - 60000,
        cancellingAt: Date.now() - 60000,
      });

      const result = engine._sendNewOrder({ side: 'buy', price: 100, size: 0.1, level: 1 });

      expect(result).not.toBeNull();
      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('should suppress against fresh pending contra orders', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock });
      engine.activeOrders.set('ASK001', {
        side: 'sell',
        price: 100,
        size: 0.1,
        level: 1,
        status: 'pending',
        placedAt: Date.now(),
      });

      const result = engine._sendNewOrder({ side: 'buy', price: 100, size: 0.1, level: 1 });

      expect(result).toBeNull();
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('self-cross-tracked-order');
    });

    it('should suppress slide-adjusted post-only quotes that would cross tracked contra orders', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        marketablePostOnlyAction: 'slide',
        tickSize: 0.5,
      });
      engine.updateTrueXBook({ bestBid: 99, bestAsk: 100, timestamp: Date.now() });
      engine.activeOrders.set('ASK001', {
        side: 'sell',
        price: 99.5,
        size: 0.1,
        level: 1,
        status: 'active',
        placedAt: Date.now(),
      });

      const result = engine._sendNewOrder({ side: 'buy', price: 100, size: 0.1, level: 1 });

      expect(result).toBeNull();
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('self-cross-tracked-order');
      expect(engine.deferredRepriceNeeded).toBe(true);
    });

    it('should not suppress against stale pending contra orders', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock });
      engine.activeOrders.set('ASK001', {
        side: 'sell',
        price: 100,
        size: 0.1,
        level: 1,
        status: 'pending',
        placedAt: Date.now() - 60000,
      });

      const result = engine._sendNewOrder({ side: 'buy', price: 100, size: 0.1, level: 1 });

      expect(result).not.toBeNull();
      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('should send ALO orders when TrueX book is missing or stale because marketability is unknown', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock, truexBookStaleThresholdMs: 10 });

      expect(engine._sendNewOrder({ side: 'buy', price: 100, size: 0.1, level: 1 })).not.toBeNull();

      const staleBookFixMock = createMockFix();
      const staleBookEngine = createEngine({ fixConnection: staleBookFixMock, truexBookStaleThresholdMs: 10 });
      staleBookEngine.updateTrueXBook({ bestBid: 99, bestAsk: 100, timestamp: Date.now() - 1000 });
      expect(staleBookEngine._sendNewOrder({ side: 'sell', price: 99, size: 0.1, level: 1 })).not.toBeNull();
      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(staleBookFixMock.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('stores truexEbbo separately from truexBook and reports freshness independently', () => {
      const engine = createEngine({ truexBookStaleThresholdMs: 10 });
      const timestamp = Date.now();

      engine.updateTrueXBook({ bestBid: 99, bestAsk: 100, timestamp });
      engine.updateTruexEbbo({
        bestBid: 101,
        bestAsk: 102,
        bestBidQty: 0.5,
        bestAskQty: 0.25,
        bestBidOrderCount: 2,
        bestAskOrderCount: 3,
        lastTradePrice: 101.5,
        lastTradeQty: 0.01,
        lastTradeTs: timestamp - 1,
        timestamp,
      });

      expect(engine.truexBook.bestBid).toBe(99);
      expect(engine.truexEbbo.bestBid).toBe(101);
      expect(engine._isTruexEbboFresh()).toBe(true);
      expect(engine.getQuoteStatus().truexEbbo.bestBidOrderCount).toBe(2);
      expect(engine.getQuoteStatus().truexEbboFresh).toBe(true);
    });

    it('treats stale truexEbbo timestamps as not fresh', () => {
      const engine = createEngine({ truexBookStaleThresholdMs: 10 });
      engine.updateTruexEbbo({
        bestBid: 101,
        bestAsk: 102,
        timestamp: Date.now() - 1000,
      });

      expect(engine._isTruexEbboFresh()).toBe(false);
      expect(engine.getQuoteStatus().truexEbboFresh).toBe(false);
    });

    it('stores pyusdUsd separately and reports freshness independently', () => {
      const engine = createEngine({ pyusdUsdStaleThresholdMs: 10 });
      const timestamp = Date.now();

      engine.updatePyusdUsd({
        price: 1.0004,
        bid: 1.0003,
        ask: 1.0005,
        timestamp,
        source: 'kraken-rest',
        pair: 'PYUSD/USD',
      });

      expect(engine.pyusdUsd.price).toBe(1.0004);
      expect(engine._isPyusdBasisFresh()).toBe(true);
      expect(engine.getQuoteStatus().pyusdUsd).toEqual({
        price: 1.0004,
        bid: 1.0003,
        ask: 1.0005,
        timestamp,
        source: 'kraken-rest',
        pair: 'PYUSD/USD',
      });
      expect(engine.getQuoteStatus().pyusdUsdFresh).toBe(true);
      expect(engine.getQuoteStatus().pyusdBasisSuppressed).toBe(false);
    });

    it('treats missing or stale pyusdUsd references as not fresh', () => {
      const engine = createEngine({ pyusdUsdStaleThresholdMs: 10 });

      expect(engine._isPyusdBasisFresh()).toBe(false);
      expect(engine.shouldSuppressBasisDependentDetection()).toBe(true);
      expect(engine.getQuoteStatus().pyusdUsd).toBeNull();
      expect(engine.getQuoteStatus().pyusdUsdFresh).toBe(false);
      expect(engine.getQuoteStatus().pyusdBasisSuppressed).toBe(true);

      engine.updatePyusdUsd({
        price: 0.9985,
        bid: 0.9984,
        ask: 0.9986,
        timestamp: Date.now() - 1000,
        source: 'kraken-rest',
        pair: 'PYUSD/USD',
      });

      expect(engine._isPyusdBasisFresh()).toBe(false);
      expect(engine.shouldSuppressBasisDependentDetection()).toBe(true);
      expect(engine.getQuoteStatus().pyusdUsd.price).toBe(0.9985);
      expect(engine.getQuoteStatus().pyusdUsdFresh).toBe(false);
      expect(engine.getQuoteStatus().pyusdBasisSuppressed).toBe(true);
    });

    it('should not treat provider books without timestamps as fresh marketability data', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        marketDataProvider: () => ({ bestBid: 99, bestAsk: 100 }),
      });

      expect(engine._sendNewOrder({ side: 'buy', price: 100, size: 0.1, level: 1 })).not.toBeNull();
      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(engine.getQuoteStatus().lastMarketableAloSkip).toBeNull();
    });

    it('should recheck queued ALO orders before final send', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock, maxOrdersPerSecond: 1 });

      engine.actionsThisSecond = 1;
      engine.lastActionReset = Date.now();
      engine.executeActions({
        toCancel: [],
        toReplace: [],
        toPlace: [{ side: 'sell', price: 99, size: 0.1, level: 1 }],
      });

      expect(engine.actionQueue.length).toBe(1);
      engine.updateTrueXBook({ bestBid: 100, bestAsk: 101, timestamp: Date.now() });
      engine.lastActionReset = Date.now() - 1001;
      engine.drainQueue();

      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.actionQueue.length).toBe(0);
    });

    it('should recheck pending replacement against latest book after cancel ack', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock, maxOrdersPerSecond: 100, levels: 1 });
      const oldClOrdID = 'OLD001';
      const oldOrder = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set(oldClOrdID, oldOrder);

      engine.executeActions({
        toCancel: [],
        toPlace: [],
        toReplace: [{ cancel: oldClOrdID, cancelOrder: oldOrder, place: { side: 'buy', price: 100, size: 0.1, level: 1 } }],
      });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      engine.updateTrueXBook({ bestBid: 99, bestAsk: 100, timestamp: Date.now() });
      const cancelClOrdID = fixMock.sendMessage.mock.calls[0][0]['11'];
      engine.onExecutionReport({ '11': cancelClOrdID, '39': '4', '54': '1' });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(engine.getQuoteStatus().lastMarketableAloSkip.reason).toBe('marketable-post-only');
    });

    it('should defer reprice when pending replacement is suppressed by tracked self-cross risk', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock, maxOrdersPerSecond: 100, levels: 1 });
      const oldClOrdID = 'OLD001';
      const oldOrder = { side: 'buy', price: 99, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set(oldClOrdID, oldOrder);
      engine.activeOrders.set('ASK001', {
        side: 'sell',
        price: 100,
        size: 0.1,
        level: 1,
        status: 'active',
        placedAt: Date.now(),
      });

      engine.executeActions({
        toCancel: [],
        toPlace: [],
        toReplace: [{ cancel: oldClOrdID, cancelOrder: oldOrder, place: { side: 'buy', price: 100, size: 0.1, level: 1 } }],
      });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      const cancelClOrdID = fixMock.sendMessage.mock.calls[0][0]['11'];
      engine.onExecutionReport({ '11': cancelClOrdID, '39': '4', '54': '1' });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('self-cross-tracked-order');
      expect(engine.deferredRepriceNeeded).toBe(true);
    });

    it('should not release pending replacements while quoting is suspended', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock, maxOrdersPerSecond: 100, levels: 1 });
      const oldClOrdID = 'OLD001';
      const oldOrder = { side: 'buy', price: 99000, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set(oldClOrdID, oldOrder);

      engine.executeActions({
        toCancel: [],
        toPlace: [],
        toReplace: [{ cancel: oldClOrdID, cancelOrder: oldOrder, place: { side: 'buy', price: 99500, size: 0.1, level: 1 } }],
      });

      engine.suspendQuoting();
      const cancelClOrdID = fixMock.sendMessage.mock.calls[0][0]['11'];
      engine.onExecutionReport({ '11': cancelClOrdID, '39': '4', '54': '1' });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(engine.deferredRepriceNeeded).toBe(true);
    });

    it('should expire pending replacements even when cancel ack never arrives', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        maxOrdersPerSecond: 100,
        levels: 1,
        pendingReplacementTimeoutMs: 1,
      });
      const oldClOrdID = 'OLD001';
      const oldOrder = { side: 'sell', price: 101, size: 0.1, level: 1, status: 'active', placedAt: Date.now() };
      engine.activeOrders.set(oldClOrdID, oldOrder);

      engine.executeActions({
        toCancel: [],
        toPlace: [],
        toReplace: [{ cancel: oldClOrdID, cancelOrder: oldOrder, place: { side: 'sell', price: 102, size: 0.1, level: 1 } }],
      });

      const pending = engine.pendingReplacements.get(oldClOrdID);
      pending.createdAt = Date.now() - 100;
      engine.drainQueue();

      expect(engine.pendingReplacements.has(oldClOrdID)).toBe(false);
      expect(engine.activeOrders.get(oldClOrdID).status).toBe('active');
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('pending-replacement-expired');
    });

    it('should omit ALO only for taker orders that pass post-fee edge threshold', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        allowTakerOrders: true,
        truexTakerFeeBps: 10,
        minTakeEdgeBps: 5,
        takeSlippageBufferBps: 1,
        takeHedgeBufferBps: 1,
      });

      const edge = engine.computeTakeEdgeBps({ side: 'buy', fairValue: 100, executionPrice: 99.8 });
      expect(edge).toBeCloseTo(8, 6);

      engine._sendNewOrder({
        side: 'buy',
        price: 99.8,
        executionPrice: 99.8,
        fairValue: 100,
        size: 0.1,
        level: 1,
        postOnly: false,
      });

      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(fixMock.sendMessage.mock.calls[0][0]['18']).toBeUndefined();
    });

    it('should keep taker orders disabled by default even when postOnly is false', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock });

      const result = engine._sendNewOrder({
        side: 'buy',
        price: 99,
        executionPrice: 99,
        fairValue: 100,
        size: 0.1,
        level: 1,
        postOnly: false,
      });

      expect(result).toBeNull();
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('taker-disabled');
    });

    it('should make the taker send path unreachable when shadowTakeMode is true even if allowTakerOrders is enabled', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        allowTakerOrders: true,
        shadowTakeMode: true,
        minTakeEdgeBps: 1,
      });

      const result = engine._sendNewOrder({
        side: 'buy',
        price: 99,
        executionPrice: 99,
        fairValue: 100,
        size: 0.1,
        level: 1,
        postOnly: false,
      });

      expect(result).toBeNull();
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('shadow-mode-observe-only');
    });

    it('should not use stale lastMid as implicit fair value for taker orders', () => {
      const fixMock = createMockFix();
      const engine = createEngine({ fixConnection: fixMock, allowTakerOrders: true });
      engine.lastMid = 100;

      const result = engine._sendNewOrder({
        side: 'buy',
        price: 99,
        executionPrice: 99,
        size: 0.1,
        level: 1,
        postOnly: false,
      });

      expect(result).toBeNull();
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('taker-missing-edge-inputs');
    });

    it('should skip taker orders below post-fee edge threshold', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        allowTakerOrders: true,
        truexTakerFeeBps: 10,
        minTakeEdgeBps: 5,
      });

      const result = engine._sendNewOrder({
        side: 'buy',
        price: 99.95,
        executionPrice: 99.95,
        fairValue: 100,
        size: 0.1,
        level: 1,
        postOnly: false,
      });

      expect(result).toBeNull();
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('taker-edge-too-low');
    });

    it('should enforce taker order and notional budgets', () => {
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        allowTakerOrders: true,
        truexTakerFeeBps: 0,
        minTakeEdgeBps: 1,
        maxTakerOrdersPerMinute: 1,
        maxTakerNotionalPerMinute: 20,
      });

      const quote = {
        side: 'sell',
        price: 101,
        executionPrice: 101,
        fairValue: 100,
        size: 0.1,
        level: 1,
        postOnly: false,
      };

      expect(engine._sendNewOrder(quote)).not.toBeNull();
      expect(engine._sendNewOrder({ ...quote, level: 2 })).toBeNull();
      expect(fixMock.sendMessage).toHaveBeenCalledTimes(1);
      expect(engine.getQuoteStatus().suppressed.at(-1).reason).toBe('taker-budget-exhausted');
    });
  });

  describe('confidence gating', () => {
    it('should cancel all quotes when confidence < threshold', () => {
      const engine = createEngine({ confidenceThreshold: 0.3 });
      const cancelAllEvents = [];
      engine.on('cancel-all', (e) => cancelAllEvents.push(e));

      // Put some active orders in
      engine.activeOrders.set('ORD1', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });
      engine.activeOrders.set('ORD2', { side: 'sell', price: 100250, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });

      const lowConfidencePrice = makePrice(100000, 0.1); // confidence 0.1 < 0.3
      engine.onPriceUpdate(lowConfidencePrice);

      expect(cancelAllEvents.length).toBe(1);
      expect(cancelAllEvents[0].reason).toContain('Low confidence');
    });

    it('should proceed normally when confidence >= threshold', () => {
      const engine = createEngine({ confidenceThreshold: 0.3 });
      const cancelAllEvents = [];
      engine.on('cancel-all', (e) => cancelAllEvents.push(e));

      const okPrice = makePrice(100000, 0.5);
      engine.onPriceUpdate(okPrice);

      expect(cancelAllEvents.length).toBe(0);
      expect(engine.isQuoting).toBe(true);
    });
  });

  describe('shadow take detection', () => {
    function makeShadowPrice({ coinbaseBid = 100, confidence = 0.95, isStale = false } = {}) {
      return {
        weightedMidpoint: coinbaseBid + 0.5,
        confidence,
        sources: [
          {
            exchange: 'coinbase',
            bid: coinbaseBid,
            ask: coinbaseBid + 1,
            midpoint: coinbaseBid + 0.5,
            weight: 1,
            isStale,
            latencyMs: 25,
          },
        ],
      };
    }

    function makeShadowTape({ price = 101.2, qty = 0.25, ts = Date.now() - 500 } = {}) {
      return {
        latestTradePrice: price,
        latestTradeQty: qty,
        latestTradeTs: ts,
        ageS: (Date.now() - ts) / 1000,
      };
    }

    function seedFreshShadowInputs(engine, { bid = 101.2, bidQty = 0.25, pyusd = 1.0, now = Date.now() } = {}) {
      engine.updateTruexEbbo({
        bestBid: bid,
        bestAsk: bid + 0.5,
        bestBidQty: bidQty,
        bestAskQty: 0.2,
        bestBidOrderCount: 1,
        bestAskOrderCount: 1,
        lastTradePrice: bid,
        lastTradeQty: bidQty,
        lastTradeTs: now,
        timestamp: now,
      });
      engine.updatePyusdUsd({
        price: pyusd,
        bid: pyusd,
        ask: pyusd,
        timestamp: now,
        source: 'kraken-rest',
        pair: 'PYUSD/USD',
      });
    }

    it('logs a would-take only after the persistence threshold and keeps FIX send count at zero', () => {
      const fixMock = createMockFix();
      const inventoryManager = {
        getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
        canQuote: mock(() => true),
        getPositionSummary: mock(() => ({ netPosition: 0.4 })),
        getAvailableForSide: mock(() => 0.4),
      };
      const engine = createEngine({
        fixConnection: fixMock,
        inventoryManager,
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 3,
        minTakeEdgeBps: 10,
        maxTakeNotionalPerOrder: 1000,
      });
      seedFreshShadowInputs(engine);
      const aggregatedPrice = makeShadowPrice({ coinbaseBid: 100 });
      const truexTape = makeShadowTape({ price: 101.2 });

      const first = engine.evaluateShadowTake({ aggregatedPrice, truexTape, now: Date.now(), trigger: 'poll-1' });
      const second = engine.evaluateShadowTake({ aggregatedPrice, truexTape, now: Date.now() + 1, trigger: 'poll-2' });
      const third = engine.evaluateShadowTake({ aggregatedPrice, truexTape, now: Date.now() + 2, trigger: 'poll-3' });

      expect(first.evaluation.suppressReason).toBe('persistence-pending');
      expect(second.evaluation.suppressReason).toBe('persistence-pending');
      expect(third.logs).toHaveLength(1);
      expect(third.logs[0]).toEqual(expect.objectContaining({
        type: 'would-take',
        wouldTake: true,
        side: 'sell',
        truexPrice: 101.2,
      }));
      expect(third.logs[0].rawEdgeBps).toBeCloseTo(120, 6);
      expect(third.logs[0].basisAdjEdgeBps).toBeCloseTo(120, 6);
      expect(third.logs[0].size).toBeCloseTo(0.25, 8);
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
    });

    it('does not suppress detection on a tape aged between the send and detection gates', () => {
      // Detection gate (shadowDetectionTapeMaxAgeMs, default 30s) is intentionally looser than
      // the send gate (truexTapeMaxAgeMs, 5s). A 10s-old tape must NOT be suppressed as
      // `truex-tape-stale` at detection time — otherwise the Phase-2 analyzer starves on
      // illiquid books (BTC-PYUSD trades print < every 5s), which is the regression this split
      // fixes. With a qualifying edge + size, a would-take is logged on a 10s-old tape.
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        inventoryManager: {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          getPositionSummary: mock(() => ({ netPosition: 0.4 })),
          getAvailableForSide: mock(() => 0.4),
        },
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        minTakeEdgeBps: 10,
        maxTakeNotionalPerOrder: 1000,
      });
      seedFreshShadowInputs(engine);
      const truexTape = makeShadowTape({ price: 101.2, ts: Date.now() - 10_000 });

      const result = engine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape,
        now: Date.now(),
        trigger: 'loose-tape-gate',
      });

      expect(result.evaluation.suppressReason).not.toBe('truex-tape-stale');
      expect(result.logs).toHaveLength(1);
      expect(result.logs[0]).toEqual(expect.objectContaining({
        type: 'would-take',
        wouldTake: true,
      }));
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
    });

    it('suppresses with a distinct reason when the trade tape is missing (null/latestTradeTs null)', () => {
      // The nullity path (quote-engine.js ~line 1265: `!latestTradePrice || !latestTradeTs
      // || ageS === null`) and the age path (~line 1284: `now - latestTradeTs > gate`) both
      // previously emitted `truex-tape-stale`, which made production logs ambiguous — a fix
      // to the age gate looked complete while the nullity path silently dominated on a
      // quiet book. This test pins the split: a missing tape must emit `truex-tape-missing`,
      // distinct from an old-but-present tape's `truex-tape-stale`, so downstream
      // analyzers/alerts can tell the two conditions apart.
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        inventoryManager: {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          getPositionSummary: mock(() => ({ netPosition: 0.4 })),
          getAvailableForSide: mock(() => 0.4),
        },
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        minTakeEdgeBps: 10,
        maxTakeNotionalPerOrder: 1000,
      });
      seedFreshShadowInputs(engine);

      const result = engine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape: null,
        now: Date.now(),
        trigger: 'null-tape',
      });

      expect(result.evaluation.suppressReason).toBe('truex-tape-missing');
      expect(result.evaluation.wouldTake).toBe(false);
      expect(result.logs).toHaveLength(0);
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
    });

    it('suppresses with truex-tape-stale (not -missing) when the tape is present but too old', () => {
      // Counterpart to the null-tape test: a tape older than shadowDetectionTapeMaxAgeMs
      // must emit `truex-tape-stale` — NOT `truex-tape-missing` — because the tape exists,
      // it's just aged out. This is the age path (~line 1284), reachable only after the
      // nullity path passes, and must remain distinguishable from the nullity path.
      const fixMock = createMockFix();
      const engine = createEngine({
        fixConnection: fixMock,
        inventoryManager: {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          getPositionSummary: mock(() => ({ netPosition: 0.4 })),
          getAvailableForSide: mock(() => 0.4),
        },
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        minTakeEdgeBps: 10,
        maxTakeNotionalPerOrder: 1000,
      });
      seedFreshShadowInputs(engine);
      const truexTape = makeShadowTape({ price: 101.2, ts: Date.now() - 60_000 });

      const result = engine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape,
        now: Date.now(),
        trigger: 'old-tape',
      });

      expect(result.evaluation.suppressReason).toBe('truex-tape-stale');
      expect(result.evaluation.suppressReason).not.toBe('truex-tape-missing');
      expect(result.evaluation.wouldTake).toBe(false);
      expect(result.logs).toHaveLength(0);
      expect(fixMock.sendMessage).not.toHaveBeenCalled();
    });

    it('applies basis-adjusted edge math without modifying computeTakeEdgeBps', () => {
      const engine = createEngine({
        inventoryManager: {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          getPositionSummary: mock(() => ({ netPosition: 0.4 })),
          getAvailableForSide: mock(() => 0.4),
        },
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        minTakeEdgeBps: 10,
        pyusdDepegThresholdBps: 150,
      });
      seedFreshShadowInputs(engine, { bid: 101.2, pyusd: 1.01 });

      const result = engine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape: makeShadowTape({ price: 101.2 }),
        now: Date.now(),
        trigger: 'basis-math',
      });

      expect(result.evaluation.rawEdgeBps).toBeCloseTo(120, 6);
      expect(result.evaluation.basisAdjEdgeBps).toBeCloseTo(19.801980198, 6);
      expect(result.evaluation.wouldTake).toBe(true);
    });

    it('suppresses detection when basis is stale or missing', () => {
      const engine = createEngine({
        inventoryManager: {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          getPositionSummary: mock(() => ({ netPosition: 0.4 })),
          getAvailableForSide: mock(() => 0.4),
        },
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        pyusdUsdStaleThresholdMs: 1000,
      });
      seedFreshShadowInputs(engine);
      engine.pyusdUsd.timestamp = Date.now() - 10_000;

      const result = engine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape: makeShadowTape({ price: 101.2 }),
        now: Date.now(),
        trigger: 'basis-stale',
      });

      expect(result.evaluation.suppressReason).toBe('basis-stale');
      expect(result.evaluation.wouldTake).toBe(false);
    });

    it('suppresses detection when basis is depegged beyond threshold', () => {
      const engine = createEngine({
        inventoryManager: {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          getPositionSummary: mock(() => ({ netPosition: 0.4 })),
          getAvailableForSide: mock(() => 0.4),
        },
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        pyusdDepegThresholdBps: 100,
      });
      seedFreshShadowInputs(engine, { pyusd: 1.02 });

      const result = engine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape: makeShadowTape({ price: 101.2 }),
        now: Date.now(),
        trigger: 'basis-depeg',
      });

      expect(result.evaluation.suppressReason).toBe('basis-depeg');
      expect(result.evaluation.wouldTake).toBe(false);
    });

    it('dedupes an identical persisting order on subsequent polls', () => {
      const engine = createEngine({
        inventoryManager: {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          getPositionSummary: mock(() => ({ netPosition: 0.4 })),
          getAvailableForSide: mock(() => 0.4),
        },
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        minTakeEdgeBps: 10,
      });
      seedFreshShadowInputs(engine);
      const aggregatedPrice = makeShadowPrice({ coinbaseBid: 100 });
      const truexTape = makeShadowTape({ price: 101.2 });

      const first = engine.evaluateShadowTake({ aggregatedPrice, truexTape, now: Date.now(), trigger: 'first' });
      const second = engine.evaluateShadowTake({ aggregatedPrice, truexTape, now: Date.now() + 1, trigger: 'second' });

      expect(first.logs).toHaveLength(1);
      expect(second.logs).toHaveLength(0);
      expect(second.evaluation.suppressReason).toBe('deduped');
    });

    it('suppresses detection for stale coinbase or low-confidence inputs', () => {
      const engine = createEngine({
        inventoryManager: {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          getPositionSummary: mock(() => ({ netPosition: 0.4 })),
          getAvailableForSide: mock(() => 0.4),
        },
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        confidenceThreshold: 0.3,
      });
      seedFreshShadowInputs(engine);
      const truexTape = makeShadowTape({ price: 101.2 });

      const staleCoinbase = engine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100, isStale: true }),
        truexTape,
        now: Date.now(),
        trigger: 'stale-coinbase',
      });
      const lowConfidence = engine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100, confidence: 0.1 }),
        truexTape,
        now: Date.now() + 1,
        trigger: 'low-confidence',
      });

      expect(staleCoinbase.evaluation.suppressReason).toBe('coinbase-stale');
      expect(lowConfidence.evaluation.suppressReason).toBe('coinbase-low-confidence');
    });

    it('suppresses edge ceilings, tape outliers, dust size, and short inventory states', () => {
      const baseInventory = {
        getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
        canQuote: mock(() => true),
        getPositionSummary: mock(() => ({ netPosition: 0.4 })),
        getAvailableForSide: mock(() => 0.4),
      };
      const edgeEngine = createEngine({
        inventoryManager: baseInventory,
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        maxEdgeCeilingBps: 50,
      });
      seedFreshShadowInputs(edgeEngine);
      const edgeResult = edgeEngine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape: makeShadowTape({ price: 101.2 }),
        now: Date.now(),
        trigger: 'edge-too-high',
      });
      expect(edgeResult.evaluation.suppressReason).toBe('edge-too-high');

      const outlierEngine = createEngine({
        inventoryManager: baseInventory,
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        truexTapeOutlierThresholdBps: 10,
      });
      seedFreshShadowInputs(outlierEngine);
      const outlierResult = outlierEngine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape: makeShadowTape({ price: 99 }),
        now: Date.now(),
        trigger: 'tape-outlier',
      });
      expect(outlierResult.evaluation.suppressReason).toBe('truex-tape-outlier');

      const dustEngine = createEngine({
        inventoryManager: {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          getPositionSummary: mock(() => ({ netPosition: 0.00005 })),
          getAvailableForSide: mock(() => 0.00005),
        },
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        minTakeSizeBTC: 0.0001,
      });
      seedFreshShadowInputs(dustEngine, { bidQty: 0.00005 });
      const dustResult = dustEngine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape: makeShadowTape({ price: 101.2 }),
        now: Date.now(),
        trigger: 'dust-size',
      });
      expect(dustResult.evaluation.suppressReason).toBe('take-size-too-small');

      const shortEngine = createEngine({
        inventoryManager: {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          getPositionSummary: mock(() => ({ netPosition: -0.25 })),
          getAvailableForSide: mock(() => 0.25),
        },
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
      });
      seedFreshShadowInputs(shortEngine);
      const shortResult = shortEngine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape: makeShadowTape({ price: 101.2 }),
        now: Date.now(),
        trigger: 'short-position',
      });
      expect(shortResult.evaluation.suppressReason).toBe('take-size-too-small');
    });

    it('caps shadow sell size by BTC already committed in live sell quotes', () => {
      const engine = createEngine({
        inventoryManager: {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          getPositionSummary: mock(() => ({ netPosition: 0.4 })),
          getAvailableForSide: mock(() => 0.4),
        },
        shadowTakeMode: true,
        shadowPersistenceRequiredPolls: 1,
        minTakeEdgeBps: 10,
      });
      engine.activeOrders.set('ASK-1', {
        side: 'sell',
        price: 101.7,
        size: 0.2,
        level: 1,
        status: 'active',
        placedAt: Date.now(),
      });
      seedFreshShadowInputs(engine, { bidQty: 0.3 });

      const result = engine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape: makeShadowTape({ price: 101.2 }),
        now: Date.now(),
        trigger: 'committed-inventory',
      });

      expect(result.evaluation.wouldTake).toBe(true);
      expect(result.evaluation.size).toBeCloseTo(0.2, 8);
    });

    it('does not evaluate shadow opportunities when shadowTakeMode is false', () => {
      const engine = createEngine();
      seedFreshShadowInputs(engine);

      const result = engine.evaluateShadowTake({
        aggregatedPrice: makeShadowPrice({ coinbaseBid: 100 }),
        truexTape: makeShadowTape({ price: 101.2 }),
        now: Date.now(),
        trigger: 'mode-off',
      });

      expect(result).toBeNull();
      expect(engine.getQuoteStatus().shadowTakeMode).toBe(false);
    });
  });

  describe('price band filtering', () => {
    it('should filter out quotes outside +/-2.5% band', () => {
      const engine = createEngine({
        levels: 1,
        baseSpreadBps: 300, // 3% spread (each side 1.5%), plus level offset
        priceBandPct: 2.5,
      });
      const mid = 100000;
      const quotes = engine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 });

      // With 300bps spread: halfSpread = 1500, level offset = 0.50
      // bid = 100000 - 1500 - 0.50 = 98499.50 → (1500.50/100000)*100 = 1.5005% ✓ within band
      // But if we use even larger spread...
      const bigEngine = createEngine({
        levels: 1,
        baseSpreadBps: 600, // 6% total, each side 3%
        priceBandPct: 2.5,
      });
      const bigQuotes = bigEngine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 });

      // halfSpread = 3000, so bid ~ 96999.50, that's 3.0005% out → should be filtered
      const bids = bigQuotes.filter(q => q.side === 'buy');
      expect(bids.length).toBe(0);
    });

    it('should keep quotes within the band', () => {
      const engine = createEngine({ levels: 1, baseSpreadBps: 50, priceBandPct: 2.5 });
      const mid = 100000;
      const quotes = engine.computeDesiredQuotes(mid, { bidSkewTicks: 0, askSkewTicks: 0 });

      expect(quotes.length).toBe(2); // 1 bid + 1 ask
      for (const q of quotes) {
        expect(engine.withinPriceBand(q.price, mid)).toBe(true);
      }
    });
  });

  describe('min notional filtering', () => {
    it('should filter out orders below min notional', () => {
      // With a very small size and low price, notional will be tiny
      const engine = createEngine({
        levels: 1,
        baseSizeBTC: 0.000001, // Extremely small
        minNotional: 1.0,
      });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });

      // 0.000001 * ~100000 = ~$0.10, less than $1 min notional
      expect(quotes.length).toBe(0);
    });

    it('should keep orders above min notional', () => {
      const engine = createEngine({
        levels: 1,
        baseSizeBTC: 0.1,
        minNotional: 1.0,
      });
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });

      // 0.1 * ~100000 = ~$10000, well above $1
      expect(quotes.length).toBe(2);
    });
  });

  describe('canQuote inventory limit', () => {
    it('should omit buy side when canQuote(buy) returns false', () => {
      const mockInv = {
        getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
        canQuote: mock((side) => side !== 'buy'),
      };
      const engine = createEngine({ inventoryManager: mockInv, levels: 2 });

      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const bids = quotes.filter(q => q.side === 'buy');
      const asks = quotes.filter(q => q.side === 'sell');

      expect(bids.length).toBe(0);
      expect(asks.length).toBe(2);
    });

    it('should omit sell side when canQuote(sell) returns false', () => {
      const mockInv = {
        getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
        canQuote: mock((side) => side !== 'sell'),
      };
      const engine = createEngine({ inventoryManager: mockInv, levels: 2 });

      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const bids = quotes.filter(q => q.side === 'buy');
      const asks = quotes.filter(q => q.side === 'sell');

      expect(bids.length).toBe(2);
      expect(asks.length).toBe(0);
    });

    it('should omit both sides when canQuote returns false for all', () => {
      const mockInv = {
        getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
        canQuote: mock(() => false),
      };
      const engine = createEngine({ inventoryManager: mockInv, levels: 3 });

      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      expect(quotes.length).toBe(0);
    });
  });

  describe('cancelAllQuotes', () => {
    it('should send cancel messages for all active orders', () => {
      const mockFix = createMockFix();
      const engine = createEngine({ fixConnection: mockFix });

      // Add active orders
      engine.activeOrders.set('ORD1', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });
      engine.activeOrders.set('ORD2', { side: 'sell', price: 100250, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });
      engine.activeOrders.set('ORD3', { side: 'buy', price: 99700, size: 0.08, level: 2, status: 'active', placedAt: Date.now() });

      engine.cancelAllQuotes('test emergency');

      // Should have sent 3 cancel messages
      expect(mockFix.sendMessage.mock.calls.length).toBe(3);

      // Each should be a cancel (35=F per TrueX — tag 11, 41, party info, no Side)
      for (const call of mockFix.sendMessage.mock.calls) {
        const fields = call[0];
        expect(fields['35']).toBe('F');
        expect(fields['38']).toBeUndefined(); // No OrderQty in 35=F cancel
        expect(fields['54']).toBeUndefined(); // No Side per Spencer
      }
    });

    it('should emit cancel-all event', () => {
      const engine = createEngine();
      const events = [];
      engine.on('cancel-all', (e) => events.push(e));

      engine.activeOrders.set('ORD1', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });
      engine.cancelAllQuotes('test reason');

      expect(events.length).toBe(1);
      expect(events[0].reason).toBe('test reason');
      expect(events[0].orderCount).toBe(1);
    });

    it('retains a venue-sent canary order through a protective cancel for late-fill attribution', () => {
      const mockFix = createMockFix();
      const engine = createEngine({ fixConnection: mockFix, levels: 1, baseSizeBTC: 0.0005,
        strictTruexMakerSafety: true, quoteDispatchMode: 'live', minimumQuoteWidthBps: 30,
        contractMaxQuoteSpreadBps: 80, contractOrderStateMaxAgeMs: 5000,
        minimalLiveCanaryConfig: { enabled: true, runId: 'cancel-race-0001', durationMs: 900000,
          maxCumulativeFilledBTC: 0.001, oneMinuteMarkoutDeadlineMs: 91000, levels: 1,
          baseSizeBTC: 0.0005, minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80 } });
      engine.armMinimalLiveCanary();
      engine.activeOrders.set('QCANARY', { side: 'buy', price: 100, size: 0.0005, level: 1,
        status: 'active', minimalLiveCanary: true, sentToVenue: true });

      engine.cancelAllQuotes('minimal-live-canary:test');

      expect(engine.activeOrders.get('QCANARY')).toMatchObject({ status: 'cancelling', minimalLiveCanary: true });
    });

    it('should set isQuoting to false', () => {
      const engine = createEngine();
      engine.isQuoting = true;
      engine.activeOrders.set('ORD1', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });

      engine.cancelAllQuotes();
      expect(engine.isQuoting).toBe(false);
    });

    it('should do nothing when no active orders exist', () => {
      const mockFix = createMockFix();
      const engine = createEngine({ fixConnection: mockFix });
      const events = [];
      engine.on('cancel-all', (e) => events.push(e));

      engine.cancelAllQuotes('empty');

      expect(mockFix.sendMessage.mock.calls.length).toBe(0);
      expect(events.length).toBe(0);
    });
  });

  describe('onExecutionReport', () => {
    it('should mark order as active on OrdStatus=0 (New)', () => {
      const engine = createEngine();
      engine.activeOrders.set('CLO001', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'pending', placedAt: Date.now() });

      engine.onExecutionReport({ '11': 'CLO001', '39': '0', '54': '1' });
      expect(engine.activeOrders.get('CLO001').status).toBe('active');
    });

    it('should remove order and emit fill on OrdStatus=2 (Filled)', () => {
      const engine = createEngine();
      const fillEvents = [];
      engine.on('fill', (e) => fillEvents.push(e));

      engine.activeOrders.set('CLO002', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });

      engine.onExecutionReport({
        '11': 'CLO002',
        '39': '2',
        '54': '1',
        '31': '99750.00',
        '32': '0.1',
        '17': 'EXEC123',
      });

      expect(engine.activeOrders.has('CLO002')).toBe(false);
      expect(fillEvents.length).toBe(1);
      expect(fillEvents[0].side).toBe('buy');
      expect(fillEvents[0].price).toBe(99750);
      expect(fillEvents[0].size).toBe(0.1);
      expect(fillEvents[0].clOrdID).toBe('CLO002');
      expect(fillEvents[0].execID).toBe('EXEC123');
    });

    it('should remove order on OrdStatus=4 (Cancelled)', () => {
      const engine = createEngine();
      engine.activeOrders.set('CLO003', { side: 'sell', price: 100250, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });

      engine.onExecutionReport({ '11': 'CLO003', '39': '4', '54': '2' });
      expect(engine.activeOrders.has('CLO003')).toBe(false);
    });

    it('should WARN on an unsolicited venue cancel (active order, we did not cancel it)', () => {
      const mockLogger = createMockLogger();
      const engine = createEngine({ logger: mockLogger });
      // Active order we never sent a cancel for — e.g. a post-only/ALO ask the venue cancels
      engine.activeOrders.set('CLOV1', { side: 'sell', price: 64003, size: 0.01, level: 1, status: 'active', placedAt: Date.now() });

      engine.onExecutionReport({ '11': 'CLOV1', '39': '4', '54': '2', '58': 'POST_ONLY_WOULD_CROSS' });

      expect(engine.activeOrders.has('CLOV1')).toBe(false);
      const msg = mockLogger.warn.mock.calls.map(c => c[0]).join(' ');
      expect(msg).toContain('Venue-cancelled');
      expect(msg).toContain('sell');
      expect(engine.recentRejectsByReason.has('venue-cancel:POST_ONLY_WOULD_CROSS')).toBe(true);
    });

    it('should WARN on an unsolicited venue cancel of a pending order', () => {
      const mockLogger = createMockLogger();
      const engine = createEngine({ logger: mockLogger });
      // Placed but no New ack yet (pending) and the venue cancels it — still unsolicited.
      engine.activeOrders.set('CLOV4', { side: 'sell', price: 64003, size: 0.01, level: 1, status: 'pending', placedAt: Date.now() });
      engine.onExecutionReport({ '11': 'CLOV4', '39': '4', '54': '2', '58': 'POST_ONLY_WOULD_CROSS' });
      expect(mockLogger.warn.mock.calls.map(c => c[0]).join(' ')).toContain('Venue-cancelled');
    });

    it('should NOT warn when WE initiated the cancel (status cancelling)', () => {
      const mockLogger = createMockLogger();
      const engine = createEngine({ logger: mockLogger });
      engine.activeOrders.set('CLOV2', { side: 'sell', price: 100250, size: 0.01, level: 1, status: 'cancelling', placedAt: Date.now() });

      engine.onExecutionReport({ '11': 'CLOV2', '39': '4', '54': '2' });
      expect(engine.activeOrders.has('CLOV2')).toBe(false);
      expect(mockLogger.warn.mock.calls.length).toBe(0); // self-cancel is normal, no warn
    });

    it('should NOT warn on a self-cancel ack resolved via cancelToOrigMap', () => {
      const mockLogger = createMockLogger();
      const engine = createEngine({ logger: mockLogger });
      // status 'active' (NOT cancelling) so the suppression relies ONLY on cancelToOrigMap —
      // isolates the origClOrdID branch from the 'cancelling'-status branch.
      engine.activeOrders.set('ORIGV3', { side: 'buy', price: 64000, size: 0.01, level: 1, status: 'active', placedAt: Date.now() });
      engine.cancelToOrigMap.set('CXV3', 'ORIGV3'); // our cancel request clOrdID -> original

      engine.onExecutionReport({ '11': 'CXV3', '39': '4', '54': '1' });
      expect(engine.activeOrders.has('ORIGV3')).toBe(false);
      expect(mockLogger.warn.mock.calls.length).toBe(0); // origClOrdID alone marks it self-initiated
    });

    it('should remove order and log error on OrdStatus=8 (Rejected)', () => {
      const mockLogger = createMockLogger();
      const engine = createEngine({ logger: mockLogger });
      engine.activeOrders.set('CLO004', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'pending', placedAt: Date.now() });

      engine.onExecutionReport({ '11': 'CLO004', '39': '8', '54': '1', '58': 'Insufficient funds' });

      expect(engine.activeOrders.has('CLO004')).toBe(false);
      expect(mockLogger.error.mock.calls.length).toBeGreaterThan(0);
    });

    it('should emit fill and keep the order (reduced) on OrdStatus=1 (PartiallyFilled)', () => {
      const engine = createEngine();
      const fillEvents = [];
      engine.on('fill', (e) => fillEvents.push(e));
      engine.activeOrders.set('CLO005', { side: 'sell', price: 100250, size: 0.01, level: 1, status: 'active', placedAt: Date.now() });

      engine.onExecutionReport({
        '11': 'CLO005', '39': '1', '54': '2',
        '31': '100250.00', '32': '0.0034', '151': '0.0066', '17': 'EXEC555',
      });

      // Partial fill must be recorded for the filled portion
      expect(fillEvents.length).toBe(1);
      expect(fillEvents[0].side).toBe('sell');
      expect(fillEvents[0].price).toBe(100250);
      expect(fillEvents[0].size).toBe(0.0034);
      expect(fillEvents[0].execID).toBe('EXEC555');
      // Order stays live with its remaining (LeavesQty) size
      expect(engine.activeOrders.has('CLO005')).toBe(true);
      expect(engine.activeOrders.get('CLO005').size).toBeCloseTo(0.0066, 8);
      expect(engine.activeOrders.get('CLO005').status).toBe('active');
    });

    it('should preserve cancelling status on a partial fill of an in-flight cancel', () => {
      const engine = createEngine();
      const fillEvents = [];
      engine.on('fill', (e) => fillEvents.push(e));
      // Order has a cancel in flight (status 'cancelling') when a partial fill lands
      engine.activeOrders.set('CLO008', { side: 'sell', price: 100250, size: 0.01, level: 1, status: 'cancelling', placedAt: Date.now() });

      engine.onExecutionReport({ '11': 'CLO008', '17': 'EXEC008', '39': '1', '54': '2', '31': '100250', '32': '0.004', '151': '0.006' });

      expect(fillEvents.length).toBe(1);                              // fill still recorded
      expect(engine.activeOrders.get('CLO008').size).toBeCloseTo(0.006, 8);
      expect(engine.activeOrders.get('CLO008').status).toBe('cancelling'); // NOT flipped to active
    });

    it('should promote a pending order to active on a partial fill (it is live on the venue)', () => {
      const engine = createEngine();
      // Partial fill arrives before a separate New ack — order still 'pending'
      engine.activeOrders.set('CLO009', { side: 'buy', price: 99750, size: 0.01, level: 1, status: 'pending', placedAt: Date.now() });
      engine.onExecutionReport({ '11': 'CLO009', '17': 'EXEC009', '39': '1', '54': '1', '31': '99750', '32': '0.003', '151': '0.007' });
      expect(engine.activeOrders.get('CLO009').status).toBe('active'); // not stuck pending
      expect(engine.activeOrders.get('CLO009').size).toBeCloseTo(0.007, 8);
    });

    it('should reduce by LastQty when LeavesQty (151) is absent on a legacy partial fill', () => {
      const engine = createEngine();
      engine.activeOrders.set('CLO007', { side: 'buy', price: 99750, size: 0.01, level: 1, status: 'active', placedAt: Date.now() });
      engine.onExecutionReport({ '11': 'CLO007', '17': 'EXEC007', '39': '1', '54': '1', '31': '99750', '32': '0.003' });
      expect(engine.activeOrders.get('CLO007').size).toBeCloseTo(0.007, 8);
    });

    it('should fail closed when LeavesQty (151) is empty in legacy mode', () => {
      const engine = createEngine();
      engine.activeOrders.set('CLO010', { side: 'buy', price: 99750, size: 0.01, level: 1, status: 'active', placedAt: Date.now() });
      // Without the authoritative manager, preserve the prior local-accounting fallback.
      engine.onExecutionReport({ '11': 'CLO010', '17': 'EXEC010', '39': '1', '54': '1', '31': '99750', '32': '0.002', '151': '' });
      expect(Number.isFinite(engine.activeOrders.get('CLO010').size)).toBe(true);
      expect(engine.activeOrders.get('CLO010').size).toBeCloseTo(0.01, 8);
      expect(engine.quotingSuspended).toBe(true);
    });

    it('should fail closed when LeavesQty is partially-numeric garbage in legacy mode', () => {
      const engine = createEngine();
      engine.activeOrders.set('CLO011', { side: 'buy', price: 99750, size: 0.01, level: 1, status: 'active', placedAt: Date.now() });
      // parseFloat would accept a prefix; strict validation fails closed instead.
      engine.onExecutionReport({ '11': 'CLO011', '17': 'EXEC011', '39': '1', '54': '1', '31': '99750', '32': '0.002', '151': '0.007foo' });
      expect(engine.activeOrders.get('CLO011').size).toBeCloseTo(0.01, 8);
      expect(engine.quotingSuspended).toBe(true);
    });

    it('should reset consecutiveRejects on a partial fill', () => {
      const engine = createEngine();
      engine.consecutiveRejects = 2;
      engine.activeOrders.set('CLO006', { side: 'buy', price: 99750, size: 0.01, level: 1, status: 'active', placedAt: Date.now() });
      engine.onExecutionReport({ '11': 'CLO006', '17': 'EXEC006', '39': '1', '54': '1', '31': '99750', '32': '0.005', '151': '0.005' });
      expect(engine.consecutiveRejects).toBe(0);
    });

    it('should warn (not silently drop) on an unhandled OrdStatus', () => {
      const mockLogger = createMockLogger();
      const engine = createEngine({ logger: mockLogger });
      engine.onExecutionReport({ '11': 'CLOX', '39': 'C', '54': '1' }); // 'C' = Expired — not explicitly handled
      expect(mockLogger.warn.mock.calls.length).toBeGreaterThan(0);
    });

    it('should NOT warn on expected pending transition states (A/6/E)', () => {
      const mockLogger = createMockLogger();
      const engine = createEngine({ logger: mockLogger });
      // PendingNew arrives for every order — must be a benign no-op, not a default warn
      engine.onExecutionReport({ '11': 'CLOA', '39': 'A', '54': '1' });
      engine.onExecutionReport({ '11': 'CLOB', '39': '6', '54': '1' });
      engine.onExecutionReport({ '11': 'CLOC', '39': 'E', '54': '1' });
      expect(mockLogger.warn.mock.calls.length).toBe(0);
    });

    it('should handle null fields gracefully', () => {
      const engine = createEngine();
      // Should not throw
      engine.onExecutionReport(null);
      engine.onExecutionReport(undefined);
      engine.onExecutionReport({});
    });
  });

  describe('onOrderCancelReject (35=9)', () => {
    it('should restore original order to active when cancel is rejected', () => {
      const engine = createEngine();
      // Original order being cancelled
      engine.activeOrders.set('ORIG001', { side: 'buy', price: 70000, size: 0.02, level: 1, status: 'cancelling', placedAt: Date.now() });
      // Track the cancel mapping
      engine.cancelToOrigMap.set('CX001', 'ORIG001');

      engine.onOrderCancelReject({
        '35': '9',
        '11': 'CX001',    // Cancel ClOrdID
        '41': 'ORIG001',  // OrigClOrdID
        '58': 'Too late to cancel',
        '102': '0',       // CxlRejReason = Too late
      });

      // Original order should be restored to 'active'
      expect(engine.activeOrders.has('ORIG001')).toBe(true);
      expect(engine.activeOrders.get('ORIG001').status).toBe('active');
      // Cancel mapping should be cleaned up
      expect(engine.cancelToOrigMap.has('CX001')).toBe(false);
    });

    it('should remove order when CxlRejReason=1 (Unknown order)', () => {
      const engine = createEngine();
      engine.activeOrders.set('ORIG002', { side: 'sell', price: 71000, size: 0.02, level: 1, status: 'cancelling', placedAt: Date.now() });
      engine.cancelToOrigMap.set('CX002', 'ORIG002');

      engine.onOrderCancelReject({
        '35': '9',
        '11': 'CX002',
        '41': 'ORIG002',
        '58': 'Unknown order',
        '102': '1',       // CxlRejReason = Unknown order
      });

      // Order gone from exchange, remove from tracking
      expect(engine.activeOrders.has('ORIG002')).toBe(false);
      expect(engine.cancelToOrigMap.has('CX002')).toBe(false);
    });

    it('should resolve origClOrdID via cancelToOrigMap when tag 41 is missing', () => {
      const engine = createEngine();
      engine.activeOrders.set('ORIG003', { side: 'buy', price: 70500, size: 0.02, level: 2, status: 'cancelling', placedAt: Date.now() });
      engine.cancelToOrigMap.set('CX003', 'ORIG003');

      // No tag 41 in message — rely on cancelToOrigMap
      engine.onOrderCancelReject({
        '35': '9',
        '11': 'CX003',
        '58': 'Rate limit',
      });

      expect(engine.activeOrders.get('ORIG003').status).toBe('active');
      expect(engine.cancelToOrigMap.has('CX003')).toBe(false);
    });

    it('should clear stale replacement intent without dropping late cancel recovery mapping', () => {
      const engine = createEngine();
      engine.pendingReplacements.set('ORIG005', { quote: { side: 'buy', price: 99, size: 0.1, level: 1 }, createdAt: Date.now() });
      engine.cancelToOrigMap.set('CX005', 'ORIG005');

      engine.clearPendingReplacement('ORIG005');

      expect(engine.pendingReplacements.has('ORIG005')).toBe(false);
      expect(engine.cancelToOrigMap.get('CX005')).toBe('ORIG005');
    });

    it('should increment consecutiveRejects and trigger backoff after 3', () => {
      const engine = createEngine();
      engine.consecutiveRejects = 2; // Already at 2

      engine.onOrderCancelReject({ '35': '9', '11': 'CX004', '58': 'error' });

      expect(engine.consecutiveRejects).toBe(3);
      expect(engine.rejectBackoffUntil).toBeGreaterThan(Date.now());
    });

    it('should handle null/undefined fields gracefully', () => {
      const engine = createEngine();
      // Should not throw
      engine.onOrderCancelReject(null);
      engine.onOrderCancelReject(undefined);
      engine.onOrderCancelReject({});
    });
  });

  describe('generateClOrdID', () => {
    it('should generate IDs <= 18 chars', () => {
      const engine = createEngine();

      for (let i = 0; i < 100; i++) {
        const id = engine.generateClOrdID();
        expect(id.length).toBeLessThanOrEqual(18);
      }
    });

    it('should generate unique IDs', () => {
      const engine = createEngine();
      const ids = new Set();

      for (let i = 0; i < 100; i++) {
        const id = engine.generateClOrdID();
        expect(ids.has(id)).toBe(false);
        ids.add(id);
      }
    });

    it('should start with Q prefix', () => {
      const engine = createEngine();
      const id = engine.generateClOrdID();
      expect(id.startsWith('Q')).toBe(true);
    });
  });

  describe('getQuoteStatus', () => {
    it('should return accurate summary', () => {
      const engine = createEngine();
      engine.lastMid = 100000;
      engine.lastRepriceAt = 1234567890;
      engine.isQuoting = true;

      engine.activeOrders.set('B1', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });
      engine.activeOrders.set('B2', { side: 'buy', price: 99700, size: 0.08, level: 2, status: 'active', placedAt: Date.now() });
      engine.activeOrders.set('A1', { side: 'sell', price: 100250, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });

      const status = engine.getQuoteStatus();

      expect(status.bidLevels).toBe(2);
      expect(status.askLevels).toBe(1);
      expect(status.activeCount).toBe(3);
      expect(status.lastMid).toBe(100000);
      expect(status.lastRepriceAt).toBe(1234567890);
      expect(status.isQuoting).toBe(true);
    });

    it('should return zeros when no orders active', () => {
      const engine = createEngine();
      const status = engine.getQuoteStatus();

      expect(status.bidLevels).toBe(0);
      expect(status.askLevels).toBe(0);
      expect(status.activeCount).toBe(0);
      expect(status.isQuoting).toBe(false);
    });
  });

  describe('emergency event emission', () => {
    it('should emit cancel-all on low confidence price update', () => {
      const engine = createEngine({ confidenceThreshold: 0.3 });
      const events = [];
      engine.on('cancel-all', (e) => events.push(e));

      engine.activeOrders.set('A', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });
      engine.onPriceUpdate(makePrice(100000, 0.1));

      expect(events.length).toBe(1);
    });

    it('should emit quote-update on successful price update', () => {
      const engine = createEngine({ levels: 2 });
      const events = [];
      engine.on('quote-update', (e) => events.push(e));

      engine.onPriceUpdate(makePrice(100000, 0.8));

      expect(events.length).toBe(1);
      expect(events[0].bidLevels).toBe(2);
      expect(events[0].askLevels).toBe(2);
    });

    it('should emit fill event when execution report indicates fill', () => {
      const engine = createEngine();
      const fills = [];
      engine.on('fill', (f) => fills.push(f));

      engine.activeOrders.set('FILL1', { side: 'sell', price: 100250, size: 0.05, level: 1, status: 'active', placedAt: Date.now() });
      engine.onExecutionReport({
        '11': 'FILL1',
        '39': '2',
        '54': '2',
        '31': '100250.00',
        '32': '0.05',
        '17': 'EX_FILL_1',
      });

      expect(fills.length).toBe(1);
      expect(fills[0].side).toBe('sell');
      expect(fills[0].price).toBe(100250);
    });
  });

  describe('FIX message construction', () => {
    it('should send New Order Single (35=D) with correct fields', () => {
      const mockFix = createMockFix();
      const engine = createEngine({ fixConnection: mockFix, levels: 1 });

      engine.onPriceUpdate(makePrice(100000, 1.0));

      // Should have sent new order messages
      expect(mockFix.sendMessage.mock.calls.length).toBeGreaterThan(0);

      // Find a NewOrderSingle message
      const nosCall = mockFix.sendMessage.mock.calls.find(c => c[0]['35'] === 'D');
      expect(nosCall).toBeDefined();

      const fields = nosCall[0];
      expect(fields['35']).toBe('D');
      expect(fields['55']).toBe('BTC-PYUSD');
      expect(fields['40']).toBe('2'); // Limit
      expect(fields['59']).toBe('1'); // GTC
      expect(fields['11']).toBeDefined(); // ClOrdID
      expect(fields['38']).toBeDefined(); // Size
      expect(fields['44']).toBeDefined(); // Price
      expect(['1', '2']).toContain(fields['54']); // Side
    });

    it('should send OrderCancelRequest (35=F) with OrigClOrdID per TrueX spec', () => {
      const mockFix = createMockFix();
      const engine = createEngine({ fixConnection: mockFix });

      engine.activeOrders.set('ORIG1', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });
      engine.cancelAllQuotes('test');

      const cancelCall = mockFix.sendMessage.mock.calls.find(c => c[0]['35'] === 'F');
      expect(cancelCall).toBeDefined();

      const fields = cancelCall[0];
      expect(fields['35']).toBe('F');
      expect(fields['41']).toBe('ORIG1'); // OrigClOrdID
      expect(fields['38']).toBeUndefined(); // No OrderQty in 35=F cancel
      expect(fields['54']).toBeUndefined(); // No Side per Spencer
    });
  });

  describe('withinPriceBand', () => {
    it('should return true for price within band', () => {
      const engine = createEngine({ priceBandPct: 2.5 });
      expect(engine.withinPriceBand(99000, 100000)).toBe(true);
      expect(engine.withinPriceBand(101000, 100000)).toBe(true);
    });

    it('should return false for price outside band', () => {
      const engine = createEngine({ priceBandPct: 2.5 });
      expect(engine.withinPriceBand(97000, 100000)).toBe(false);
      expect(engine.withinPriceBand(103000, 100000)).toBe(false);
    });

    it('should return false when mid is zero', () => {
      const engine = createEngine({ priceBandPct: 2.5 });
      expect(engine.withinPriceBand(100, 0)).toBe(false);
    });
  });

  describe('onPriceUpdate full flow', () => {
    it('should set lastMid and isQuoting on valid price', () => {
      const engine = createEngine();
      engine.onPriceUpdate(makePrice(100000, 0.8));

      expect(engine.lastMid).toBe(100000);
      expect(engine.isQuoting).toBe(true);
      expect(engine.lastRepriceAt).toBeGreaterThan(0);
    });

    it('should call inventoryManager.getSkew', () => {
      const mockInv = createMockInventory();
      const engine = createEngine({ inventoryManager: mockInv });

      engine.onPriceUpdate(makePrice(100000, 1.0));
      expect(mockInv.getSkew.mock.calls.length).toBeGreaterThan(0);
    });

    it('should handle null/undefined price gracefully', () => {
      const engine = createEngine();
      // Should not throw
      engine.onPriceUpdate(null);
      engine.onPriceUpdate(undefined);
      engine.onPriceUpdate({ weightedMidpoint: 0, confidence: 1 });
    });
  });

  describe('dup guard', () => {
    it('should skip cancel if same clOrdID was actioned within dupGuardMs', () => {
      const engine = createEngine({ dupGuardMs: 500 });

      // Simulate recent action
      engine.lastActionByClOrdID.set('DUP1', Date.now());

      expect(engine._isDupGuarded('DUP1')).toBe(true);
    });

    it('should allow action after dupGuardMs has elapsed', () => {
      const engine = createEngine({ dupGuardMs: 500 });

      engine.lastActionByClOrdID.set('DUP2', Date.now() - 600);
      expect(engine._isDupGuarded('DUP2')).toBe(false);
    });

    it('should allow action for unknown clOrdID', () => {
      const engine = createEngine({ dupGuardMs: 500 });
      expect(engine._isDupGuarded('UNKNOWN')).toBe(false);
    });
  });

  describe('balance-aware quoting', () => {
    function createBalanceAwareInventory({ baseAvailable, quoteAvailable, canQuoteBuy = true, canQuoteSell = true }) {
      return {
        getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
        canQuote: mock((side) => {
          if (side.toLowerCase() === 'buy') return canQuoteBuy;
          if (side.toLowerCase() === 'sell') return canQuoteSell;
          return true;
        }),
        balancesInitialized: true,
        getAvailableForSide: mock((side) => {
          if (side === 'buy') return quoteAvailable;
          if (side === 'sell') return baseAvailable;
          return 0;
        }),
      };
    }

    it('should cap total ask size across levels to available BTC', () => {
      const inv = createBalanceAwareInventory({ baseAvailable: 0.044, quoteAvailable: 0 });
      const engine = createEngine({
        inventoryManager: inv,
        levels: 5,
        baseSizeBTC: 0.02,
        sizeDecayFactor: 0.8,
        sizeDecimalPlaces: 4,
      });

      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const asks = quotes.filter(q => q.side === 'sell');

      // Total ask size across all levels should not exceed 0.044 BTC
      const totalAskSize = asks.reduce((sum, q) => sum + q.size, 0);
      expect(totalAskSize).toBeLessThanOrEqual(0.044 + 0.0001); // small rounding tolerance
      expect(totalAskSize).toBeGreaterThan(0);
    });

    it('should cap total bid notional across levels to available PYUSD', () => {
      const inv = createBalanceAwareInventory({ baseAvailable: 0, quoteAvailable: 3000, canQuoteSell: false });
      const engine = createEngine({
        inventoryManager: inv,
        levels: 5,
        baseSizeBTC: 0.02,
        sizeDecayFactor: 0.8,
        sizeDecimalPlaces: 4,
      });

      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const bids = quotes.filter(q => q.side === 'buy');

      // Total bid notional should not exceed 3000 PYUSD (with rounding tolerance
      // from size quantization at 4 decimal places × price)
      const totalBidNotional = bids.reduce((sum, q) => sum + q.size * q.price, 0);
      expect(totalBidNotional).toBeLessThanOrEqual(3000 + 10); // rounding tolerance for size quantization
    });

    it('should produce no bids when canQuote buy returns false', () => {
      const inv = createBalanceAwareInventory({ baseAvailable: 0.044, quoteAvailable: 0, canQuoteBuy: false });
      const engine = createEngine({
        inventoryManager: inv,
        levels: 3,
      });

      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const bids = quotes.filter(q => q.side === 'buy');
      expect(bids.length).toBe(0);
    });

    it('should produce no asks when canQuote sell returns false', () => {
      const inv = createBalanceAwareInventory({ baseAvailable: 0, quoteAvailable: 5000, canQuoteSell: false });
      const engine = createEngine({
        inventoryManager: inv,
        levels: 3,
      });

      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const asks = quotes.filter(q => q.side === 'sell');
      expect(asks.length).toBe(0);
    });

    it('should produce both sides when both balances available', () => {
      const inv = createBalanceAwareInventory({ baseAvailable: 1.0, quoteAvailable: 100000 });
      const engine = createEngine({
        inventoryManager: inv,
        levels: 3,
      });

      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const bids = quotes.filter(q => q.side === 'buy');
      const asks = quotes.filter(q => q.side === 'sell');
      expect(bids.length).toBe(3);
      expect(asks.length).toBe(3);
    });

    it('should not cap sizes when balances not initialized', () => {
      const inv = {
        getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
        canQuote: mock(() => true),
        balancesInitialized: false,
        getAvailableForSide: mock(() => Infinity),
      };
      const engine = createEngine({
        inventoryManager: inv,
        levels: 1,
        baseSizeBTC: 0.1,
      });

      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const asks = quotes.filter(q => q.side === 'sell');
      expect(asks.length).toBe(1);
      expect(asks[0].size).toBe(0.1); // Full uncapped size
    });

    it('should reduce later levels when early levels consume available balance', () => {
      const inv = createBalanceAwareInventory({ baseAvailable: 0.025, quoteAvailable: 0, canQuoteBuy: false });
      const engine = createEngine({
        inventoryManager: inv,
        levels: 3,
        baseSizeBTC: 0.02,
        sizeDecayFactor: 0.8,
        sizeDecimalPlaces: 4,
      });

      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      const asks = quotes.filter(q => q.side === 'sell');

      // Level 1: min(0.02, 0.025) = 0.02, remaining = 0.005
      // Level 2: min(0.016, 0.005) = 0.005, remaining = 0
      // Level 3: min(0.0128, 0) = 0 — dropped (below minNotional or zero)
      expect(asks.length).toBeLessThanOrEqual(2);
      const totalAskSize = asks.reduce((sum, q) => sum + q.size, 0);
      expect(totalAskSize).toBeLessThanOrEqual(0.025 + 0.0001);
    });

    describe('_capSizeToBalance edge cases', () => {
      it('should return 0 when available is 0', () => {
        const inv = createBalanceAwareInventory({ baseAvailable: 0, quoteAvailable: 0 });
        const engine = createEngine({ inventoryManager: inv });

        expect(engine._capSizeToBalance('sell', 0.1, 100000, 0)).toBe(0);
        expect(engine._capSizeToBalance('buy', 0.1, 100000, 0)).toBe(0);
      });

      it('should return 0 when alreadyCommitted >= available', () => {
        const inv = createBalanceAwareInventory({ baseAvailable: 0.05, quoteAvailable: 5000 });
        const engine = createEngine({ inventoryManager: inv });

        // Sell: 0.05 BTC available, 0.05 already committed
        expect(engine._capSizeToBalance('sell', 0.1, 100000, 0.05)).toBe(0);
        // Buy: 5000 PYUSD available, 5000 already committed
        expect(engine._capSizeToBalance('buy', 0.1, 100000, 5000)).toBe(0);
      });

      it('should return remainder when alreadyCommitted + desired > available', () => {
        const inv = createBalanceAwareInventory({ baseAvailable: 0.05, quoteAvailable: 5000 });
        const engine = createEngine({ inventoryManager: inv, sizeDecimalPlaces: 4 });

        // Sell: 0.05 available, 0.03 committed, want 0.1 → get 0.02
        expect(engine._capSizeToBalance('sell', 0.1, 100000, 0.03)).toBeCloseTo(0.02, 4);
      });

      it('should return desiredSize when balancesInitialized is false', () => {
        const inv = {
          getSkew: mock(() => ({ bidSkewTicks: 0, askSkewTicks: 0 })),
          canQuote: mock(() => true),
          balancesInitialized: false,
          getAvailableForSide: mock(() => Infinity),
        };
        const engine = createEngine({ inventoryManager: inv });

        expect(engine._capSizeToBalance('sell', 0.1, 100000, 0)).toBe(0.1);
        expect(engine._capSizeToBalance('buy', 0.1, 100000, 0)).toBe(0.1);
      });

      it('should return 0 when price is 0 on buy side', () => {
        const inv = createBalanceAwareInventory({ baseAvailable: 1, quoteAvailable: 5000 });
        const engine = createEngine({ inventoryManager: inv });

        expect(engine._capSizeToBalance('buy', 0.1, 0, 0)).toBe(0);
      });
    });
  });

  describe('edge cases', () => {
    it('should work with no inventoryManager injected', () => {
      const engine = new QuoteEngine({
        fixConnection: createMockFix(),
        logger: createMockLogger(),
        levels: 1,
      });

      // Should not throw
      const quotes = engine.computeDesiredQuotes(100000, { bidSkewTicks: 0, askSkewTicks: 0 });
      expect(quotes.length).toBe(2);
    });

    it('should work with no fixConnection injected', () => {
      const engine = new QuoteEngine({
        inventoryManager: createMockInventory(),
        logger: createMockLogger(),
        levels: 1,
      });

      // Should not throw, just no messages sent
      engine.onPriceUpdate(makePrice(100000, 1.0));
      expect(engine.activeOrders.size).toBeGreaterThan(0);
    });

    it('should track active orders after placement', () => {
      const engine = createEngine({ levels: 1 });
      expect(engine.activeOrders.size).toBe(0);

      engine.onPriceUpdate(makePrice(100000, 1.0));
      expect(engine.activeOrders.size).toBe(2); // 1 bid + 1 ask
    });
  });
});
