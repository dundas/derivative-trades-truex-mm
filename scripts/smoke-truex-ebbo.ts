#!/usr/bin/env bun
/**
 * Smoke test: TrueX EBBO poll populates quoteEngine.truexEbbo without sending orders.
 *
 * No network, no real FIX, no real REST. Exit 0 = PASS, non-zero = BLOCK.
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
  startPeriodicLogging() {}
  stopPeriodicLogging() {}
  markToMarket() {}
  onFill() {}
  getSummary() { return {}; }
  getSessionReport() { return 'smoke'; }
}

class MockHedgeExecutor extends EventEmitter {
  config = { minHedgeSizeBTC: 0.001 };
  getHedgeStats() { return {}; }
  async executeHedge() { return {}; }
}

class SmokeQuoteEngine extends EventEmitter {
  activeOrders = new Map();
  truexEbbo: any = null;

  updateTruexEbbo(book: any) {
    this.truexEbbo = book;
  }

  getQuoteStatus() {
    return { truexEbbo: this.truexEbbo };
  }

  cancelAllQuotes() {}
  suspendQuoting() {}
  resumeQuoting() {}
  invalidateQueuedWork() {}
  clearPendingReplacement() {}
  drainQueue() {}
  onPriceUpdate() {}
  onExecutionReport() {}
  onOrderCancelReject() {}
}

const fixConnection = new MockFIXConnection();
const quoteEngine = new SmokeQuoteEngine();
const inventoryManager = new MockInventoryManager();
const logger = { info() {}, warn() {}, error() {}, debug() {} };

const orchestrator = new MarketMakerOrchestrator({
  fixConnection,
  quoteEngine,
  inventoryManager,
  pnlTracker: new MockPnLTracker(),
  hedgeExecutor: new MockHedgeExecutor(),
  priceAggregator: null,
  marketDataFeed: null,
  logger,
  truexEbboPollIntervalMs: 1000,
  truexEbboPollTimeoutMs: 100,
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
  async getInstrument(symbol: string) {
    if (symbol !== 'BTC-PYUSD') fail(`unexpected symbol lookup ${symbol}`);
    return { id: '78873627520270354', symbol };
  },
  async getMarketQuote({ instrument_id }: { instrument_id: string }) {
    if (instrument_id !== '78873627520270354') {
      fail(`unexpected instrument_id ${instrument_id}`);
    }
    return [
      {
        id: '78873627520270354',
        symbol: 'BTC-PYUSD',
        info: {
          best_bid: { price: '63788.5', qty: '0.008', order_count: '1', last_update: '1781794727328321122' },
          best_ask: { price: '63933.4', qty: '0.00008', order_count: '1', last_update: '1781794942928366811' },
          last_trade: { price: '63888.6', qty: '0.00008', timestamp: '1781794363428309171' },
          last_update: '1781794942928366896',
        },
      },
    ];
  },
};

await orchestrator.start();
await new Promise((resolve) => setTimeout(resolve, 50));

if (!quoteEngine.truexEbbo) {
  fail('truexEbbo did not populate');
}
if (quoteEngine.truexEbbo.bestBid !== 63788.5 || quoteEngine.truexEbbo.bestAsk !== 63933.4) {
  fail(`unexpected truexEbbo top of book ${JSON.stringify(quoteEngine.truexEbbo)}`);
}
if (fixConnection.sentMessages.length !== 0) {
  fail(`expected zero FIX sends, got ${fixConnection.sentMessages.length}`);
}

await orchestrator.stop();
console.log(`PASS: truexEbbo bid=${quoteEngine.truexEbbo.bestBid} ask=${quoteEngine.truexEbbo.bestAsk} populated with zero FIX sends`);
