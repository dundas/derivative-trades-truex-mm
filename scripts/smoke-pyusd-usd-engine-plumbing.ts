#!/usr/bin/env bun
/**
 * Smoke test: PYUSD/USD basis poll reaches QuoteEngine and the engine surfaces
 * fresh/stale basis status without sending FIX orders.
 */
import { EventEmitter } from 'events';
import { MarketMakerOrchestrator } from '../src/core/market-maker-orchestrator.js';
import { QuoteEngine } from '../src/core/quote-engine.js';

function fail(msg: string): never {
  console.error(`BLOCK: ${msg}`);
  process.exit(1);
}

class MockFIXConnection extends EventEmitter {
  isConnected = false;
  isLoggedOn = false;
  msgSeqNum = 1;
  sentMessages: any[] = [];
  senderCompID = 'CLI_CLIENT';
  targetCompID = 'TRUEX_UAT_OE';

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

  getUTCTimestamp() {
    return '20260206-12:00:00.000';
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

const fixConnection = new MockFIXConnection();
const inventoryManager = new MockInventoryManager();
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const quoteEngine = new QuoteEngine({
  fixConnection,
  inventoryManager,
  logger,
  levels: 1,
  pyusdUsdStaleThresholdMs: 1000,
});

if (quoteEngine.getQuoteStatus().pyusdUsd !== null) {
  fail('expected quoteEngine pyusdUsd to default to null');
}
if (quoteEngine.getQuoteStatus().pyusdUsdFresh !== false) {
  fail('expected missing quoteEngine pyusdUsd to be not fresh');
}

const orchestrator = new MarketMakerOrchestrator({
  fixConnection,
  inventoryManager,
  quoteEngine,
  pnlTracker: new MockPnLTracker(),
  hedgeExecutor: new MockHedgeExecutor(),
  priceAggregator: null,
  marketDataFeed: null,
  logger,
  truexEbboPollIntervalMs: 0,
  pyusdUsdPollIntervalMs: 1000,
  pyusdUsdPollTimeoutMs: 100,
  pyusdUsdStaleThresholdMs: 1000,
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

const engineStatus = quoteEngine.getQuoteStatus();
if (!engineStatus.pyusdUsd) {
  fail('quoteEngine pyusdUsd did not populate');
}
if (engineStatus.pyusdUsd.price !== 1.00005) {
  fail(`unexpected quoteEngine pyusdUsd payload ${JSON.stringify(engineStatus.pyusdUsd)}`);
}
if (!engineStatus.pyusdUsdFresh) {
  fail('expected quoteEngine pyusdUsd to be fresh');
}
if (engineStatus.pyusdBasisSuppressed) {
  fail('expected fresh quoteEngine pyusdUsd to allow basis-dependent detection');
}
if (fixConnection.sentMessages.length !== 0) {
  fail(`expected zero FIX sends, got ${fixConnection.sentMessages.length}`);
}

quoteEngine.pyusdUsd.timestamp = Date.now() - 5000;
const staleStatus = quoteEngine.getQuoteStatus();
if (staleStatus.pyusdUsdFresh) {
  fail('expected stale quoteEngine pyusdUsd reference to be flagged');
}
if (!staleStatus.pyusdBasisSuppressed) {
  fail('expected stale quoteEngine pyusdUsd to suppress basis-dependent detection');
}
if (fixConnection.sentMessages.length !== 0) {
  fail(`expected zero FIX sends after stale transition, got ${fixConnection.sentMessages.length}`);
}

await orchestrator.stop();
console.log(`PASS: quoteEngine pyusdUsd=${staleStatus.pyusdUsd.price.toFixed(6)} fresh/stale surfaced with zero FIX sends`);
