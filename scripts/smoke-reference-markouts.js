#!/usr/bin/env bun
import { ReferenceMarkoutCollector } from '../src/data-pipeline/reference-markout-collector.js';

const config = {
  product: 'BTC-USD', quoteCurrency: 'USD', sourceExchange: 'coinbase',
  sourceType: 'top-of-book', horizonsMs: [60_000], maxSourceAgeMs: 5_000,
  maxLatenessMs: 30_000, pollIntervalMs: 1_000, batchSize: 10,
  claimLeaseMs: 5_000, retentionMs: 86_400_000, retentionSweepIntervalMs: 3_600_000,
  auditMaxGroups: 10,
  maxAbsBasisAdjustmentBps: 25,
  basisSource: 'kraken-pretrade', basisRequestedPair: 'PYUSD/USD',
  basisResolvedPair: 'PYUSD/USD', basisBase: 'PYUSD', basisQuote: 'USD',
  basisSystem: 'CLOB', basisVenueAllowlist: ['PDSL'], maxBasisRttMs: 1_000,
};

let now = 10_000;
const work = [];
const evidence = [];
const samples = [];
let claimsEnabled = false;
const writer = {
  async scheduleReferenceMarkouts(fill) {
    for (let index = 0; index < fill.horizonsMs.length; index++) {
      if (!work.some(item => item.fillId === fill.fillId && item.horizonMs === fill.horizonsMs[index])) {
        work.push({
          ...fill, horizonMs: fill.horizonsMs[index], dueTimestamp: fill.dueTimestamps[index],
          deadlineTimestamp: fill.deadlineTimestamps[index], state: 'pending',
        });
      }
    }
    return work.length;
  },
  async recordReferenceMarketObservation(observation) { samples.push(observation); },
  async getFirstReferenceMarketObservation({ dueTimestamp, deadlineTimestamp }) {
    return samples.find(sample => sample.observationTimestamp >= dueTimestamp && sample.observationTimestamp <= deadlineTimestamp) || null;
  },
  async claimDueReferenceMarkouts({ claimToken }) {
    if (!claimsEnabled) return [];
    return work.filter(item => item.state === 'pending' && item.dueTimestamp <= now).map(item => {
      item.state = 'claimed';
      item.claimToken = claimToken;
      return item;
    });
  },
  async releaseReferenceMarkoutClaim(item) { item.state = 'pending'; },
  async completeReferenceMarkout(item, claimToken, observation) {
    if (item.claimToken !== claimToken) throw new Error('claim owner mismatch');
    item.state = 'completed';
    evidence.push({ fillId: item.fillId, horizonMs: item.horizonMs, ...observation });
  },
  async pruneReferenceMarkoutEvidence() {},
};

const provider = () => ({ sources: [{
  exchange: 'coinbase', bid: 100, ask: 102, sourceTimestamp: now - 2,
  receivedTimestamp: now - 1, isStale: false,
}] });
const basisProvider = () => ({
  price: 1, timestamp: now - 2, basisTimestamp: now - 2, bid: 0.99995, ask: 1.00005,
  bidQty: 10, askQty: 10, bidCount: 1, askCount: 1,
  bidSubmissionTimestamp: now - 3, askSubmissionTimestamp: now - 3,
  bidPublicationTimestamp: now - 2, askPublicationTimestamp: now - 2,
  requestTimestamp: now - 2, receivedTimestamp: now - 1,
  source: 'kraken-pretrade', requestedPair: 'PYUSD/USD', resolvedPair: 'PYUSD/USD',
  base: 'PYUSD', quote: 'USD', venue: 'PDSL', system: 'CLOB',
});

const firstProcess = new ReferenceMarkoutCollector({
  writer, config, now: () => now, marketProvider: provider, basisProvider,
});
await firstProcess.scheduleFill({
  fillId: 'Q-1-E-1', executionId: 'E-1', quoteId: 'Q-1', sessionId: 'S-1',
  fillTimestamp: now, decisionTimestamp: 9_000, side: 'buy', level: 1,
  policyId: 'maker-v1', price: 100, size: 0.01,
});

now = 70_002;
await firstProcess.processDue(); // Persist the first valid due observation, then simulate a crash.
claimsEnabled = true;
now = 71_002;
const restartedProcess = new ReferenceMarkoutCollector({
  writer, config, now: () => now, marketProvider: provider, basisProvider,
});
const result = await restartedProcess.processDue();
if (result.completed !== 1 || evidence.length !== 1 || evidence[0].sourceTimestamp !== 70_000 ||
    evidence[0].observedEdgeBps !== 100) {
  throw new Error(`reference mark-out smoke failed: ${JSON.stringify({ result, evidence })}`);
}

console.log('PASS: restart-safe 1m reference mark-out completed with zero order/FIX capability');
