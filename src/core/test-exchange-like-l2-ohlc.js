// 2-minute exchange-like test: Coinbase WS -> L2 snapshots to Redis + OHLC from trades

import { L2OhlcOrchestrator } from './data-pipeline/l2-ohlc-orchestrator.js';
import { TrueXRedisManager } from './data-pipeline/truex-redis-manager.js';
import { RedisClient } from '../../../lib/utils/redis-client.js';
import { MARKET_DATA_CONFIG } from './data-pipeline/market-data-config.js';

const TEST_DURATION_MS = Number(process.env.TEST_DURATION_MS || 120_000);
const SNAPSHOT_MS = Number(process.env.TRUEX_L2_SNAPSHOT_MS || MARKET_DATA_CONFIG.snapshotMs || 1000);
const SYMBOL = (MARKET_DATA_CONFIG.symbols && MARKET_DATA_CONFIG.symbols[0]) || 'BTC-PYUSD';

async function main() {
  const logger = console;
  const redisClient = new RedisClient();
  const sessionId = process.env.TRUEX_SESSION_ID || `session-${Date.now()}`;

  const redisManager = new TrueXRedisManager({
    sessionId,
    symbol: SYMBOL,
    redisClient,
    logger,
  });

  const orchestrator = new L2OhlcOrchestrator({ symbols: [SYMBOL], logger });
  console.log('[Startup] Starting orchestrator...');
  await orchestrator.start();
  console.log('[Startup] Orchestrator started.');

  let snapshots = 0;
  const interval = setInterval(async () => {
    try {
      const depth = orchestrator.getDepth(SYMBOL, MARKET_DATA_CONFIG.depth || 10);
      if (depth) {
        await redisManager.flushL2Snapshot({ bids: depth.bids, asks: depth.asks, ts: depth.ts }, MARKET_DATA_CONFIG.depth || 10);
        snapshots++;
        if (snapshots % 5 === 0) {
          console.log('[Progress] Snapshots flushed:', snapshots);
        }
      }
    } catch (e) {
      logger.error('Snapshot flush error', e.message);
    }
  }, SNAPSHOT_MS);

  await new Promise((r) => setTimeout(r, TEST_DURATION_MS));
  clearInterval(interval);

  // Flush any completed candles
  const completed = orchestrator.flushCompleteCandles(SYMBOL, Date.now());
  if (completed.length > 0) {
    await redisManager.flushOHLC(completed);
  }

  // Summary
  const top = orchestrator.getTopOfBook(SYMBOL);
  logger.info('[Summary] Exchange-like test complete', {
    sessionId,
    symbol: SYMBOL,
    snapshots,
    candlesFlushed: completed.length,
    bestBid: top?.bestBid,
    bestAsk: top?.bestAsk,
  });

  await redisClient.quit();
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});


