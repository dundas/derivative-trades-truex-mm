#!/usr/bin/env bun
/**
 * Smoke test: shadow take detection logs exactly one would-take across two
 * identical EBBO polls and never emits a FIX order.
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
  netPosition = 0.5;

  initializeFromBalances({ baseBalance, quoteBalance }: any) {
    this.baseBalance = baseBalance;
    this.quoteBalance = quoteBalance;
    this.balancesInitialized = true;
    this.netPosition = Number(baseBalance?.total ?? this.netPosition);
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
      netPosition: this.netPosition,
      baseBalance: this.baseBalance,
      quoteBalance: this.quoteBalance,
    };
  }

  getAvailableForSide(side: string) {
    if (side === 'sell') return Number(this.baseBalance?.available ?? this.netPosition);
    return Number(this.quoteBalance?.available ?? 0);
  }

  canQuote() {
    return true;
  }

  shouldHedge() {
    return { shouldHedge: false };
  }

  reset() {}
}

class MockPnLTracker extends EventEmitter {
  startPeriodicLogging() {}
  stopPeriodicLogging() {}
  markToMarket() {}
  onFill() {}
  getSummary() { return {}; }
  getSessionReport() { return 'shadow smoke'; }
}

class MockHedgeExecutor extends EventEmitter {
  config = { minHedgeSizeBTC: 0.001 };
  getHedgeStats() { return {}; }
  async executeHedge() { return {}; }
}

const fixConnection = new MockFIXConnection();
const inventoryManager = new MockInventoryManager();
const shadowLogs: string[] = [];
const logger = {
  info(message: string) {
    if (message.startsWith('[SHADOW] ')) shadowLogs.push(message);
  },
  warn() {},
  error() {},
  debug() {},
};

const quoteEngine = new QuoteEngine({
  fixConnection,
  inventoryManager,
  logger,
  levels: 1,
  shadowTakeMode: true,
  shadowPersistenceRequiredPolls: 1,
  minTakeEdgeBps: 10,
  maxTakeNotionalPerOrder: 1000,
  pyusdUsdStaleThresholdMs: 5000,
});

const orchestrator = new MarketMakerOrchestrator({
  fixConnection,
  inventoryManager,
  quoteEngine,
  pnlTracker: new MockPnLTracker(),
  hedgeExecutor: new MockHedgeExecutor(),
  priceAggregator: null,
  marketDataFeed: null,
  logger,
  truexEbboPollIntervalMs: 1000,
  truexEbboPollTimeoutMs: 100,
  truexTradeCacheTtlMs: 0,
  truexTradePollTimeoutMs: 100,
  pyusdUsdPollIntervalMs: 0,
  shadowTakeMode: true,
  shadowPersistenceRequiredPolls: 1,
  minTakeEdgeBps: 10,
  maxTakeNotionalPerOrder: 1000,
});

function nowNanos() {
  return String(Date.now() * 1_000_000);
}

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
    if (symbol !== 'BTC-PYUSD') fail(`unexpected instrument lookup ${symbol}`);
    return { id: '78873627520270354' };
  },
  async getMarketQuote() {
    const ts = nowNanos();
    return [
      {
        id: '78873627520270354',
        symbol: 'BTC-PYUSD',
        info: {
          best_bid: { price: '101.20', qty: '0.25', order_count: '1', last_update: ts },
          best_ask: { price: '101.70', qty: '0.15', order_count: '1', last_update: ts },
          last_trade: { price: '101.20', qty: '0.10', timestamp: ts },
          last_update: ts,
        },
      },
    ];
  },
  async getMarketTrades() {
    return [
      { trade_price: '101.20', trade_qty: '0.10', timestamp: String(Date.now() * 1_000_000) },
    ];
  },
};

quoteEngine.updatePyusdUsd({
  price: 1.0,
  bid: 1.0,
  ask: 1.0,
  timestamp: Date.now(),
  source: 'kraken-rest',
  pair: 'PYUSD/USD',
});

await orchestrator.start();
fixConnection.isLoggedOn = false;
orchestrator._onPriceUpdate({
  weightedMidpoint: 100.5,
  confidence: 0.95,
  sources: [
    {
      exchange: 'coinbase',
      bid: 100,
      ask: 101,
      midpoint: 100.5,
      weight: 1,
      isStale: false,
      latencyMs: 25,
    },
  ],
});

await orchestrator._pollTruexEbbo();
await orchestrator._pollTruexEbbo();

if (shadowLogs.length !== 1) {
  fail(`expected exactly one shadow log across two identical polls, got ${shadowLogs.length}`);
}

const payload = JSON.parse(shadowLogs[0].slice('[SHADOW] '.length));
if (payload.type !== 'would-take' || payload.wouldTake !== true) {
  fail(`unexpected shadow log payload ${shadowLogs[0]}`);
}
if (Math.abs(payload.basisAdjEdgeBps - 120) > 0.0001) {
  fail(`unexpected basis-adjusted edge ${payload.basisAdjEdgeBps}`);
}
if (Math.abs(payload.rawEdgeBps - 120) > 0.0001) {
  fail(`unexpected raw edge ${payload.rawEdgeBps}`);
}
if (fixConnection.sentMessages.length !== 0) {
  fail(`expected zero FIX sends, got ${fixConnection.sentMessages.length}`);
}

orchestrator.shadowTakeMode = false;
quoteEngine.config.shadowTakeMode = false;
const beforeDisabled = shadowLogs.length;
await orchestrator._pollTruexEbbo();
if (shadowLogs.length !== beforeDisabled) {
  fail(`expected no additional shadow logs when mode is off, got ${shadowLogs.length - beforeDisabled}`);
}
if (fixConnection.sentMessages.length !== 0) {
  fail(`expected zero FIX sends after mode-off poll, got ${fixConnection.sentMessages.length}`);
}

await orchestrator.stop();
console.log(`PASS: shadowTakeMode on => one would-take log; off => no log; zero FIX sends throughout`);
