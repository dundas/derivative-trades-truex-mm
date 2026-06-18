#!/usr/bin/env bun
/**
 * Smoke test: PYUSD/USD reference poll populates orchestrator.pyusdUsd without
 * changing the maker price path or sending FIX orders.
 */
import { EventEmitter } from 'events';
import { MarketMakerOrchestrator } from '../src/core/market-maker-orchestrator.js';

function fail(msg: string): never {
  console.error(`BLOCK: ${msg}`);
  process.exit(1);
}

class MockFIXConnection extends EventEmitter {
  isConnected = false;
  isLoggedOn = false;
  msgSeqNum = 1;
  sentMessages: any[] = [];

  async connect() {
    this.isConnected = true;
    this.isLoggedOn = true;
  }

  async disconnect() {
    this.isConnected = false;
    this.isLoggedOn = false;
  }

  sendMessage(fields: any) {
    this.sentMessages.push(fields);
    return Promise.resolve(true);
  }
}

class MockInventoryManager extends EventEmitter {
  balancesInitialized = false;
  baseBalance: any = null;
  quoteBalance: any = null;

  initializeFromBalances({ baseBalance, quoteBalance }: any) {
    this.baseBalance = baseBalance;
    this.quoteBalance = quoteBalance;
    this.balancesInitialized = true;
  }

  refreshBalances({ baseBalance, quoteBalance }: any) {
    this.baseBalance = baseBalance;
    this.quoteBalance = quoteBalance;
  }

  getSkew() {
    return { bidSkewTicks: 0, askSkewTicks: 0 };
  }

  getPositionSummary() {
    return {
      netPosition: 0,
      baseBalance: this.baseBalance,
      quoteBalance: this.quoteBalance,
    };
  }

  canQuote() {
    return true;
  }
}

class MockPnLTracker extends EventEmitter {
  lastMarkedPrice: number | null = null;
  startPeriodicLogging() {}
  stopPeriodicLogging() {}
  markToMarket(price: number) { this.lastMarkedPrice = price; }
  onFill() {}
  getSummary() { return {}; }
  getSessionReport() { return 'smoke'; }
}

class MockHedgeExecutor extends EventEmitter {
  config = { minHedgeSizeBTC: 0.001 };
  getHedgeStats() { return {}; }
  async executeHedge() { return {}; }
}

class MockQuoteEngine extends EventEmitter {
  activeOrders = new Map();
  seenPrices: any[] = [];

  getQuoteStatus() {
    return { truexEbbo: null };
  }

  cancelAllQuotes() {}
  suspendQuoting() {}
  resumeQuoting() {}
  invalidateQueuedWork() {}
  clearPendingReplacement() {}
  drainQueue() {}
  onPriceUpdate(price: any) { this.seenPrices.push(price); }
  onExecutionReport() {}
  onOrderCancelReject() {}
}

const fixConnection = new MockFIXConnection();
const inventoryManager = new MockInventoryManager();
const pnlTracker = new MockPnLTracker();
const quoteEngine = new MockQuoteEngine();
const logger = { info() {}, warn() {}, error() {}, debug() {} };

const priceAggregator = new EventEmitter();

const orchestrator = new MarketMakerOrchestrator({
  fixConnection,
  inventoryManager,
  pnlTracker,
  quoteEngine,
  hedgeExecutor: new MockHedgeExecutor(),
  priceAggregator,
  marketDataFeed: null,
  logger,
  pyusdUsdPollIntervalMs: 1000,
  pyusdUsdPollTimeoutMs: 100,
  krakenRestClient: {
    async getTicker(pair: string) {
      if (pair !== 'PYUSD/USD') fail(`unexpected pair lookup ${pair}`);
      return {
        exchange: 'kraken',
        symbol: pair,
        timestamp: Date.now(),
        bid: 1.0,
        ask: 1.0001,
        last: 1.00005,
        volume24h: 12345,
      };
    },
  },
});

orchestrator.restClient = {
  async getAccountSummary() {
    return {
      balances: [
        { asset_id: 'btc', asset_name: 'BTC', available: '0.5', held: '0', total: '0.5' },
        { asset_id: 'pyusd', asset_name: 'PYUSD', available: '1000', held: '0', total: '1000' },
      ],
    };
  },
};

await orchestrator.start();
await new Promise((resolve) => setTimeout(resolve, 50));

priceAggregator.emit('price', { weightedMidpoint: 100000, confidence: 0.95 });

if (!orchestrator.pyusdUsd) {
  fail('pyusdUsd did not populate');
}
if (orchestrator.pyusdUsd.price !== 1.00005) {
  fail(`unexpected pyusdUsd price ${JSON.stringify(orchestrator.pyusdUsd)}`);
}
if (!orchestrator.getStatus().pyusdUsdFresh) {
  fail('pyusdUsd should be fresh');
}
if (quoteEngine.seenPrices.length !== 1) {
  fail(`expected one maker price update, got ${quoteEngine.seenPrices.length}`);
}
if (pnlTracker.lastMarkedPrice !== 100000) {
  fail(`expected mark-to-market at 100000, got ${pnlTracker.lastMarkedPrice}`);
}
if (fixConnection.sentMessages.length !== 0) {
  fail(`expected zero FIX sends, got ${fixConnection.sentMessages.length}`);
}

orchestrator.pyusdUsd.timestamp = Date.now() - (orchestrator.pyusdUsdStaleThresholdMs + 1000);
if (orchestrator.getStatus().pyusdUsdFresh) {
  fail('expected stale pyusdUsd reference to be flagged');
}

await orchestrator.stop();
console.log(`PASS: pyusdUsd=${orchestrator.pyusdUsd.price.toFixed(6)} fresh/stale surfaced with zero FIX sends`);
