#!/usr/bin/env bun
import { ReferenceMarkoutCollector } from '../src/data-pipeline/reference-markout-collector.js';
import { buildReferenceMarkoutRolloutOptions } from './reference-markout-rollout-config.js';

const endpoint = 'wss://stream.crypto.com/exchange/v1/market';
const { referenceMarkoutConfig } = buildReferenceMarkoutRolloutOptions({
  REFERENCE_MARKOUT_ENABLED: 'true', REFERENCE_MARKOUT_SOURCE_WS_URL: endpoint,
  REFERENCE_MARKOUT_SOURCE_ENDPOINT_ALLOWLIST: endpoint,
  REFERENCE_MARKOUT_MAX_QUOTE_DECISIONS_PER_SECOND: '1',
  REFERENCE_MARKOUT_PLANNING_FILL_EVENTS_PER_SECOND: '1',
  REFERENCE_MARKOUT_RETENTION_BATCH_SIZE: '1000',
  REFERENCE_MARKOUT_RETENTION_MAX_BATCHES_PER_SWEEP: '11',
});
const observations = [];
const writer = {
  hasOpenReferenceMarkoutWindow: async () => true,
  recordReferenceMarketObservation: async value => { observations.push(value); return true; },
  claimDueReferenceMarkouts: async () => [],
};
const collector = new ReferenceMarkoutCollector({ writer, config: referenceMarkoutConfig,
  now: () => 10_000, marketProvider: () => ({ exchange: 'cryptocom',
    sourceType: 'public-ws-book', instrument: 'BTC_PYUSD', channel: 'book.BTC_PYUSD.10',
    sourceEndpoint: endpoint, bid: 99, ask: 101, bidQty: 2, askQty: 3,
    bidCount: 1, askCount: 1, depth: 10, sourceTimestamp: 9_950,
    receivedTimestamp: 9_975, bookUpdateTimestamp: 9_000, sequence: 41,
    generation: 2, sourceSessionId: 'smoke-session', sourceBookHash: 'a'.repeat(64),
  }) });
await collector.processDue();
if (observations.length !== 1 || observations[0].promotionGrade !== true ||
    observations[0].product !== 'BTC-PYUSD' || observations[0].basisPrice !== null) {
  throw new Error('direct reference evidence smoke failed');
}
console.log('PASS: direct BTC-PYUSD evidence persisted with zero quote/FIX capability');
