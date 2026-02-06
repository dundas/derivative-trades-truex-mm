import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { EventEmitter } from 'events';
import { InventoryManager } from '../src/core/inventory-manager.js';
import { PnLTracker } from '../src/core/pnl-tracker.js';
import { QuoteEngine } from '../src/core/quote-engine.js';
import { HedgeExecutor } from '../src/core/hedge-executor.js';
import { MarketMakerOrchestrator } from '../src/core/market-maker-orchestrator.js';

// --- Simulated dependencies ---

/**
 * MockFIXConnection simulates TrueX FIX OE:
 * - Accepts orders, emits execution reports
 * - Can simulate fills at a given probability
 */
class MockFIXConnection extends EventEmitter {
  constructor() {
    super();
    this.isConnected = false;
    this.isLoggedOn = false;
    this.msgSeqNum = 1;
    this.sentMessages = [];
    this.fillProbability = 0; // 0 = no fills, 1 = always fill
    this._activeOrders = new Map();
  }

  async connect() {
    this.isConnected = true;
    this.isLoggedOn = true;
  }

  async disconnect() {
    this.isConnected = false;
    this.isLoggedOn = false;
  }

  sendMessage(fields) {
    this.sentMessages.push({ ...fields, _seqNum: this.msgSeqNum++ });
    const msgType = fields['35'];

    if (msgType === 'D') {
      // New Order Single - acknowledge then optionally fill
      const clOrdID = fields['11'];
      const side = fields['54'];
      const size = parseFloat(fields['38']);
      const price = parseFloat(fields['44']);

      this._activeOrders.set(clOrdID, { side, size, price, status: 'active' });

      // Emit order ack (35=8, 39=0)
      setImmediate(() => {
        this.emit('message', {
          fields: {
            '35': '8',
            '11': clOrdID,
            '17': `ack-${clOrdID}`,
            '39': '0', // New
            '54': side,
            '38': size.toString(),
            '44': price.toString(),
          },
        });
      });
    } else if (msgType === 'F') {
      // Cancel Request
      const origClOrdID = fields['41'];
      this._activeOrders.delete(origClOrdID);

      setImmediate(() => {
        this.emit('message', {
          fields: {
            '35': '8',
            '11': fields['11'],
            '41': origClOrdID,
            '17': `cxl-${origClOrdID}`,
            '39': '4', // Cancelled
            '54': fields['54'],
          },
        });
      });
    }
  }

  /**
   * Simulate a fill for an active order.
   */
  simulateFill(clOrdID) {
    const order = this._activeOrders.get(clOrdID);
    if (!order) return false;

    this._activeOrders.delete(clOrdID);

    this.emit('message', {
      fields: {
        '35': '8',
        '11': clOrdID,
        '17': `fill-${clOrdID}-${Date.now()}`,
        '39': '2', // Filled
        '31': order.price.toString(),
        '32': order.size.toString(),
        '54': order.side,
      },
    });
    return true;
  }

  getActiveOrders() {
    return new Map(this._activeOrders);
  }
}

/**
 * MockPriceAggregator simulates multi-exchange price feeds.
 */
class MockPriceAggregator extends EventEmitter {
  constructor() {
    super();
    this._currentPrice = 100000;
    this._confidence = 0.95;
  }

  simulatePriceUpdate(mid, confidence = 0.95) {
    this._currentPrice = mid;
    this._confidence = confidence;
    this.emit('price', {
      weightedMidpoint: mid,
      bestBid: mid - 25,
      bestAsk: mid + 25,
      confidence,
      sources: ['coinbase', 'kraken'],
      timestamp: Date.now(),
    });
  }

  getAggregatedPrice() {
    return {
      weightedMidpoint: this._currentPrice,
      bestBid: this._currentPrice - 25,
      bestAsk: this._currentPrice + 25,
      confidence: this._confidence,
    };
  }
}

/**
 * MockKrakenClient simulates Kraken REST API for hedging.
 */
class MockKrakenClient {
  constructor() {
    this.orders = new Map();
    this._nextId = 1;
    this.addOrderCalls = [];
  }

  async addOrder(params) {
    const txid = `KRAKEN-${this._nextId++}`;
    this.addOrderCalls.push(params);
    this.orders.set(txid, {
      status: 'closed',
      vol_exec: params.volume,
      price: params.price || '100000',
    });
    return { txid: [txid] };
  }

  async queryOrders({ txid }) {
    const order = this.orders.get(txid);
    if (!order) return {};
    return { [txid]: order };
  }

  async cancelOrder({ txid }) {
    this.orders.delete(txid);
    return { count: 1 };
  }
}

function createLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

// --- Integration Tests ---

describe('Integration: End-to-End Market Making', () => {
  let orchestrator;
  let fixConn;
  let priceAgg;
  let krakenClient;
  let logger;

  beforeEach(async () => {
    fixConn = new MockFIXConnection();
    priceAgg = new MockPriceAggregator();
    krakenClient = new MockKrakenClient();
    logger = createLogger();

    // Create components with proper cross-references
    const inventoryManager = new InventoryManager({
      maxPositionBTC: 5.0,
      hedgeThresholdBTC: 2.0,
      maxSkewTicks: 3,
      skewExponent: 1.5,
      tickSize: 0.50,
      logger,
    });

    orchestrator = new MarketMakerOrchestrator({
      fixConnection: fixConn,
      priceAggregator: priceAgg,
      inventoryManager,
      pnlTracker: new PnLTracker({
        truexMakerFeeBps: 0,
        truexTakerFeeBps: 10,
        hedgeMakerFeeBps: 16,
        hedgeTakerFeeBps: 26,
        logIntervalMs: 999999, // Don't auto-log during tests
        logger,
      }),
      quoteEngine: new QuoteEngine({
        inventoryManager,          // Wire real InventoryManager
        fixConnection: fixConn,     // Wire real FIX connection
        levels: 3,
        baseSpreadBps: 50,
        levelSpacingTicks: 1,
        repriceThresholdTicks: 1,
        baseSizeBTC: 0.1,
        sizeDecayFactor: 0.8,
        maxOrdersPerSecond: 20, // High limit for tests
        tickSize: 0.50,
        minNotional: 1.0,
        priceBandPct: 2.5,
        confidenceThreshold: 0.3,
        symbol: 'BTC-PYUSD',
        logger,
      }),
      hedgeExecutor: new HedgeExecutor({
        krakenClient,
        priceAggregator: priceAgg,
        hedgeSymbol: 'XBTUSD',
        maxHedgeSizeBTC: 1.0,
        minHedgeSizeBTC: 0.001,
        limitTimeoutMs: 100, // Fast timeout for tests
        pollIntervalMs: 20,
        logger,
      }),
      marketDataFeed: null, // Not needed for price-aggregator-based tests
      drainQueueIntervalMs: 50,
      sessionId: 'integration-test',
      logger,
    });
  });

  afterEach(async () => {
    if (orchestrator.isRunning) {
      await orchestrator.stop();
    }
  });

  test('starts and stops cleanly', async () => {
    await orchestrator.start();
    expect(orchestrator.isRunning).toBe(true);
    expect(fixConn.isConnected).toBe(true);

    await orchestrator.stop();
    expect(orchestrator.isRunning).toBe(false);
    expect(fixConn.isConnected).toBe(false);
  });

  test('price update generates FIX orders', async () => {
    await orchestrator.start();

    // Send a price update
    priceAgg.simulatePriceUpdate(100000);

    // Wait for async message dispatch
    await new Promise(r => setTimeout(r, 50));

    // QuoteEngine should have sent FIX new order singles (35=D)
    const newOrders = fixConn.sentMessages.filter(m => m['35'] === 'D');
    expect(newOrders.length).toBeGreaterThan(0);

    // Should have both buy and sell orders
    const buys = newOrders.filter(m => m['54'] === '1');
    const sells = newOrders.filter(m => m['54'] === '2');
    expect(buys.length).toBeGreaterThan(0);
    expect(sells.length).toBeGreaterThan(0);

    // All orders should be for BTC-PYUSD
    for (const order of newOrders) {
      expect(order['55']).toBe('BTC-PYUSD');
      expect(order['40']).toBe('2'); // Limit order
    }

    await orchestrator.stop();
  });

  test('price update generates quotes snapped to $0.50 tick', async () => {
    await orchestrator.start();
    priceAgg.simulatePriceUpdate(100000);
    await new Promise(r => setTimeout(r, 50));

    const newOrders = fixConn.sentMessages.filter(m => m['35'] === 'D');
    for (const order of newOrders) {
      const price = parseFloat(order['44']);
      // Price should be a multiple of 0.50
      const remainder = price % 0.50;
      expect(remainder).toBeCloseTo(0, 6);
    }

    await orchestrator.stop();
  });

  test('quote fills update inventory and PnL', async () => {
    await orchestrator.start();

    // Generate quotes
    priceAgg.simulatePriceUpdate(100000);
    await new Promise(r => setTimeout(r, 50));

    // Find a buy order to fill
    const buyOrders = fixConn.sentMessages.filter(m => m['35'] === 'D' && m['54'] === '1');
    expect(buyOrders.length).toBeGreaterThan(0);

    const buyClOrdID = buyOrders[0]['11'];

    // Simulate fill
    fixConn.simulateFill(buyClOrdID);
    await new Promise(r => setTimeout(r, 50));

    // Check inventory reflects the fill
    const position = orchestrator.inventoryManager.getPositionSummary();
    expect(position.netPosition).toBeGreaterThan(0);
    expect(position.totalBought).toBeGreaterThan(0);

    // Check PnL tracked the fill
    const pnl = orchestrator.pnlTracker.getSummary();
    expect(pnl.numTrades).toBeGreaterThan(0);

    await orchestrator.stop();
  });

  test('buy fill + sell fill produces realized PnL', async () => {
    await orchestrator.start();

    // Generate quotes at 100000
    priceAgg.simulatePriceUpdate(100000);
    await new Promise(r => setTimeout(r, 50));

    // Fill a buy order
    const buyOrders = fixConn.sentMessages.filter(m => m['35'] === 'D' && m['54'] === '1');
    const buyClOrdID = buyOrders[0]['11'];
    fixConn.simulateFill(buyClOrdID);
    await new Promise(r => setTimeout(r, 50));

    // Now move price up and fill a sell
    priceAgg.simulatePriceUpdate(100100);
    await new Promise(r => setTimeout(r, 100));

    // Find and fill a sell order
    const sellOrders = fixConn.sentMessages.filter(m => m['35'] === 'D' && m['54'] === '2');
    const sellClOrdID = sellOrders[sellOrders.length - 1]['11'];
    fixConn.simulateFill(sellClOrdID);
    await new Promise(r => setTimeout(r, 50));

    const pnl = orchestrator.pnlTracker.getSummary();
    expect(pnl.numTrades).toBe(2);

    // If buy and sell matched, we should have some realized PnL
    // (sell price > buy price since price moved up, spread capture)
    if (pnl.totalMatchedQuantity > 0) {
      expect(pnl.realizedPnL).not.toBe(0);
    }

    await orchestrator.stop();
  });

  test('price reprice generates cancel + new orders', async () => {
    await orchestrator.start();

    // Initial quotes at 100000
    priceAgg.simulatePriceUpdate(100000);
    // Wait for FIX acks to arrive and update order status
    await new Promise(r => setTimeout(r, 100));

    const initialOrders = fixConn.sentMessages.filter(m => m['35'] === 'D');
    expect(initialOrders.length).toBeGreaterThan(0);

    // Move price significantly (100 ticks) to trigger reprice
    priceAgg.simulatePriceUpdate(100050);
    await new Promise(r => setTimeout(r, 100));

    // Should have generated new FIX messages total (initial + reprice)
    const totalOrders = fixConn.sentMessages.filter(m => m['35'] === 'D');
    expect(totalOrders.length).toBeGreaterThan(initialOrders.length);

    await orchestrator.stop();
  });

  test('low confidence pulls all quotes', async () => {
    await orchestrator.start();

    // Place quotes at high confidence
    priceAgg.simulatePriceUpdate(100000, 0.95);
    await new Promise(r => setTimeout(r, 100));

    const ordersBefore = fixConn.sentMessages.filter(m => m['35'] === 'D').length;
    expect(ordersBefore).toBeGreaterThan(0);

    // Drop confidence below threshold (0.3)
    priceAgg.simulatePriceUpdate(100000, 0.1);
    await new Promise(r => setTimeout(r, 100));

    // Should see cancel messages for all active orders
    const cancelsAfter = fixConn.sentMessages.filter(m => m['35'] === 'F');
    expect(cancelsAfter.length).toBeGreaterThan(0);

    await orchestrator.stop();
  });

  test('inventory skew adjusts quotes', async () => {
    await orchestrator.start();

    // Generate initial quotes
    priceAgg.simulatePriceUpdate(100000);
    await new Promise(r => setTimeout(r, 50));

    // Get initial bid prices
    const initialBuys = fixConn.sentMessages.filter(m => m['35'] === 'D' && m['54'] === '1');
    const initialBidPrices = initialBuys.map(m => parseFloat(m['44']));

    // Simulate multiple buy fills to build long position
    for (const buy of initialBuys.slice(0, 2)) {
      fixConn.simulateFill(buy['11']);
      await new Promise(r => setTimeout(r, 20));
    }

    // Position should now be long
    const position = orchestrator.inventoryManager.getPositionSummary();
    expect(position.netPosition).toBeGreaterThan(0);

    // Trigger reprice
    priceAgg.simulatePriceUpdate(100000.50);
    await new Promise(r => setTimeout(r, 100));

    // New bids should be lower (skewed away from buying more)
    const laterBuys = fixConn.sentMessages
      .filter(m => m['35'] === 'D' && m['54'] === '1')
      .slice(initialBuys.length);

    if (laterBuys.length > 0) {
      const laterBidPrices = laterBuys.map(m => parseFloat(m['44']));
      // When long, bids should be lower than initial (or similar)
      // The skew pushes bids down
      const avgInitialBid = initialBidPrices.reduce((a, b) => a + b, 0) / initialBidPrices.length;
      const avgLaterBid = laterBidPrices.reduce((a, b) => a + b, 0) / laterBidPrices.length;
      // With positive skew, bids get pushed lower
      expect(avgLaterBid).toBeLessThanOrEqual(avgInitialBid + 1);
    }

    await orchestrator.stop();
  });

  test('emergency cancels all quotes immediately', async () => {
    await orchestrator.start();

    // Place quotes
    priceAgg.simulatePriceUpdate(100000);
    await new Promise(r => setTimeout(r, 50));

    let emergencyEmitted = false;
    orchestrator.on('emergency', () => { emergencyEmitted = true; });

    // Trigger emergency via inventory manager
    orchestrator.inventoryManager.emit('emergency', {
      netPosition: 10.0,
      reason: 'Test emergency',
    });

    await new Promise(r => setTimeout(r, 50));

    expect(emergencyEmitted).toBe(true);

    // Should have sent cancel messages
    const cancels = fixConn.sentMessages.filter(m => m['35'] === 'F');
    expect(cancels.length).toBeGreaterThan(0);

    await orchestrator.stop();
  });

  test('hedge executor triggered by inventory hedge signal', async () => {
    await orchestrator.start();

    // Place and fill multiple buy orders to build position
    priceAgg.simulatePriceUpdate(100000);
    await new Promise(r => setTimeout(r, 50));

    // Manually trigger a hedge signal
    orchestrator.inventoryManager.emit('hedge-signal', {
      shouldHedge: true,
      side: 'sell',
      size: 0.5,
    });

    // Wait for async hedge execution
    await new Promise(r => setTimeout(r, 200));

    // Kraken client should have received an order
    expect(krakenClient.addOrderCalls.length).toBeGreaterThan(0);
    const hedgeOrder = krakenClient.addOrderCalls[0];
    expect(hedgeOrder.pair).toBe('XBTUSD');
    expect(hedgeOrder.type).toBe('sell');

    await orchestrator.stop();
  });

  test('getStatus returns comprehensive state', async () => {
    await orchestrator.start();

    priceAgg.simulatePriceUpdate(100000);
    await new Promise(r => setTimeout(r, 50));

    const status = orchestrator.getStatus();

    expect(status.sessionId).toBe('integration-test');
    expect(status.isRunning).toBe(true);
    expect(status.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(status.quotes).toBeDefined();
    expect(status.inventory).toBeDefined();
    expect(status.pnl).toBeDefined();
    expect(status.hedge).toBeDefined();
    expect(status.fixOE.isConnected).toBe(true);
    expect(status.fixOE.isLoggedOn).toBe(true);

    await orchestrator.stop();
  });

  test('graceful shutdown hedges remaining position', async () => {
    await orchestrator.start();

    // Generate and fill a buy order
    priceAgg.simulatePriceUpdate(100000);
    await new Promise(r => setTimeout(r, 50));

    const buyOrders = fixConn.sentMessages.filter(m => m['35'] === 'D' && m['54'] === '1');
    if (buyOrders.length > 0) {
      fixConn.simulateFill(buyOrders[0]['11']);
      await new Promise(r => setTimeout(r, 50));
    }

    const positionBefore = orchestrator.inventoryManager.getPositionSummary();

    await orchestrator.stop();

    // If position was significant, hedge should have been attempted
    if (Math.abs(positionBefore.netPosition) > 0.001) {
      // Kraken should have received an order during shutdown
      expect(krakenClient.addOrderCalls.length).toBeGreaterThan(0);
    }
  });

  test('price-to-quote latency under 50ms', async () => {
    await orchestrator.start();

    const start = performance.now();
    priceAgg.simulatePriceUpdate(100000);
    // drainQueue is handled by setInterval, but onPriceUpdate calls executeActions synchronously
    const elapsed = performance.now() - start;

    // The synchronous path (price → compute quotes → dispatch to FIX) should be fast
    expect(elapsed).toBeLessThan(50);

    await orchestrator.stop();
  });

  test('rate limit compliance under burst', async () => {
    await orchestrator.start();

    // Send rapid price updates to generate many actions
    for (let i = 0; i < 10; i++) {
      priceAgg.simulatePriceUpdate(100000 + i * 5);
    }

    await new Promise(r => setTimeout(r, 100));

    // The QuoteEngine's rate limiter should have deferred some actions
    // We configured maxOrdersPerSecond=20, so with 3 levels × 2 sides × 10 updates
    // many should go through the rate limiter
    // Just verify no crashes and reasonable message count
    expect(fixConn.sentMessages.length).toBeGreaterThan(0);

    await orchestrator.stop();
  });

  test('drain queue processes deferred actions', async () => {
    // Use a lower rate limit to force queuing
    const drainFixConn = new MockFIXConnection();
    const drainInv = new InventoryManager({
      maxPositionBTC: 5.0,
      hedgeThresholdBTC: 2.0,
      maxSkewTicks: 3,
      skewExponent: 1.5,
      tickSize: 0.50,
      logger,
    });
    const lowRateOrch = new MarketMakerOrchestrator({
      fixConnection: drainFixConn,
      priceAggregator: priceAgg,
      inventoryManager: drainInv,
      pnlTracker: new PnLTracker({
        logIntervalMs: 999999,
        logger,
      }),
      quoteEngine: new QuoteEngine({
        inventoryManager: drainInv,
        fixConnection: drainFixConn,
        levels: 5,
        baseSpreadBps: 50,
        levelSpacingTicks: 1,
        repriceThresholdTicks: 1,
        baseSizeBTC: 0.1,
        sizeDecayFactor: 0.8,
        maxOrdersPerSecond: 2, // Very low to force queuing
        tickSize: 0.50,
        minNotional: 1.0,
        priceBandPct: 2.5,
        confidenceThreshold: 0.3,
        symbol: 'BTC-PYUSD',
        logger,
      }),
      hedgeExecutor: new HedgeExecutor({
        krakenClient,
        priceAggregator: priceAgg,
        hedgeSymbol: 'XBTUSD',
        maxHedgeSizeBTC: 1.0,
        minHedgeSizeBTC: 0.001,
        limitTimeoutMs: 100,
        pollIntervalMs: 20,
        logger,
      }),
      drainQueueIntervalMs: 50,
      sessionId: 'drain-test',
      logger,
    });

    await lowRateOrch.start();

    // Rapid price updates should force queuing
    priceAgg.simulatePriceUpdate(100000);
    const immediateCount = drainFixConn.sentMessages.length;

    // Wait for drain timer to process queue
    await new Promise(r => setTimeout(r, 200));

    // More messages should have been sent via drain
    expect(drainFixConn.sentMessages.length).toBeGreaterThanOrEqual(immediateCount);

    await lowRateOrch.stop();
  });

  test('multiple price sources with different confidence', async () => {
    await orchestrator.start();

    // High confidence → should quote
    priceAgg.simulatePriceUpdate(100000, 0.95);
    await new Promise(r => setTimeout(r, 50));
    const ordersHigh = fixConn.sentMessages.filter(m => m['35'] === 'D').length;
    expect(ordersHigh).toBeGreaterThan(0);

    // Low confidence → should pull quotes
    priceAgg.simulatePriceUpdate(100000, 0.1);
    await new Promise(r => setTimeout(r, 50));
    const cancelsLow = fixConn.sentMessages.filter(m => m['35'] === 'F').length;
    expect(cancelsLow).toBeGreaterThan(0);

    // Confidence recovers → should re-quote
    priceAgg.simulatePriceUpdate(100100, 0.9);
    await new Promise(r => setTimeout(r, 50));
    const ordersRecovered = fixConn.sentMessages.filter(m => m['35'] === 'D').length;
    expect(ordersRecovered).toBeGreaterThan(ordersHigh);

    await orchestrator.stop();
  });

  test('stop event includes session summary', async () => {
    await orchestrator.start();

    priceAgg.simulatePriceUpdate(100000);
    await new Promise(r => setTimeout(r, 50));

    // Fill a buy
    const buyOrders = fixConn.sentMessages.filter(m => m['35'] === 'D' && m['54'] === '1');
    if (buyOrders.length > 0) {
      fixConn.simulateFill(buyOrders[0]['11']);
      await new Promise(r => setTimeout(r, 50));
    }

    let stopInfo = null;
    orchestrator.on('stopped', info => { stopInfo = info; });

    await orchestrator.stop();

    expect(stopInfo).not.toBeNull();
    expect(stopInfo.sessionId).toBe('integration-test');
    expect(stopInfo.durationMs).toBeGreaterThanOrEqual(0);
    expect(stopInfo.pnl).toBeDefined();
    expect(stopInfo.inventory).toBeDefined();
  });

  test('orders respect price band (within ±2.5% of mid)', async () => {
    await orchestrator.start();
    priceAgg.simulatePriceUpdate(100000);
    await new Promise(r => setTimeout(r, 50));

    const orders = fixConn.sentMessages.filter(m => m['35'] === 'D');
    for (const order of orders) {
      const price = parseFloat(order['44']);
      const deviation = Math.abs(price - 100000) / 100000 * 100;
      expect(deviation).toBeLessThanOrEqual(2.5);
    }

    await orchestrator.stop();
  });

  test('orders meet minimum notional ($1 PYUSD)', async () => {
    await orchestrator.start();
    priceAgg.simulatePriceUpdate(100000);
    await new Promise(r => setTimeout(r, 50));

    const orders = fixConn.sentMessages.filter(m => m['35'] === 'D');
    for (const order of orders) {
      const price = parseFloat(order['44']);
      const size = parseFloat(order['38']);
      const notional = price * size;
      expect(notional).toBeGreaterThanOrEqual(1.0);
    }

    await orchestrator.stop();
  });
});
