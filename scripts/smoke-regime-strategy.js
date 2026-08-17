#!/usr/bin/env bun
import { validateRegimeStrategy } from '../src/analytics/regime-strategy-validator.js';

const timestamp = Date.UTC(2026, 7, 16, 12);
const input = {
  fills: [{ fillId: 'smoke-fill', timestamp, decisionTimestamp: timestamp - 1_000, side: 'buy', price: 100, quantity: 0.01 }],
  references: [
    { timestamp: timestamp - 1_000, bid: 99.99, ask: 100.01, sourceType: 'top-of-book', product: 'BTC-USD', quoteCurrency: 'USD', basisAdjustmentBps: 0 },
    { timestamp: timestamp + 300_000, bid: 100.04, ask: 100.06, sourceType: 'top-of-book', product: 'BTC-USD', quoteCurrency: 'USD', basisAdjustmentBps: 0 },
  ],
  candidateBuffersBps: [3, 12],
  config: { bootstrap: { iterations: 100, seed: 123 } },
};

const first = validateRegimeStrategy(input);
const second = validateRegimeStrategy(input);
if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Validator output is not deterministic');
if (first.recommendation !== 'HOLD') throw new Error('Insufficient smoke evidence must default to HOLD');
if (first.dispatches !== 0 || first.productionChangeAuthorized) throw new Error('Offline validator must never authorize or dispatch');
if (first.counterfactualSensitivity.usedForPromotion) throw new Error('Same-fill sensitivity must not enter promotion gates');
console.log('PASS: deterministic regime validation held with zero dispatch or production authorization');
