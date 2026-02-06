import { describe, it, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { QuoteEngine } from '../src/core/quote-engine.js';

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

      // Each should be a cancel (35=F)
      for (const call of mockFix.sendMessage.mock.calls) {
        const fields = call[0];
        expect(fields['35']).toBe('F');
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

    it('should remove order and log error on OrdStatus=8 (Rejected)', () => {
      const mockLogger = createMockLogger();
      const engine = createEngine({ logger: mockLogger });
      engine.activeOrders.set('CLO004', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'pending', placedAt: Date.now() });

      engine.onExecutionReport({ '11': 'CLO004', '39': '8', '54': '1', '58': 'Insufficient funds' });

      expect(engine.activeOrders.has('CLO004')).toBe(false);
      expect(mockLogger.error.mock.calls.length).toBeGreaterThan(0);
    });

    it('should handle null fields gracefully', () => {
      const engine = createEngine();
      // Should not throw
      engine.onExecutionReport(null);
      engine.onExecutionReport(undefined);
      engine.onExecutionReport({});
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

    it('should send Cancel Request (35=F) with OrigClOrdID', () => {
      const mockFix = createMockFix();
      const engine = createEngine({ fixConnection: mockFix });

      engine.activeOrders.set('ORIG1', { side: 'buy', price: 99750, size: 0.1, level: 1, status: 'active', placedAt: Date.now() });
      engine.cancelAllQuotes('test');

      const cancelCall = mockFix.sendMessage.mock.calls.find(c => c[0]['35'] === 'F');
      expect(cancelCall).toBeDefined();

      const fields = cancelCall[0];
      expect(fields['35']).toBe('F');
      expect(fields['41']).toBe('ORIG1'); // OrigClOrdID
      expect(fields['55']).toBe('BTC-PYUSD');
      expect(fields['54']).toBe('1'); // Buy side
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
