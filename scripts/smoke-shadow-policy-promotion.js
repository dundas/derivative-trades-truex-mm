#!/usr/bin/env bun
import { buildShadowPromotionReport } from '../src/analytics/shadow-policy-promotion.js';

const policy = { targetInventoryBTC: 0, maxSkewTicks: 3, anchorBufferTicks: 1, baseSpreadBps: 50, levelSpacingTicks: 1, baseSizeBTC: 0.01, sizeDecayFactor: 0.8, repriceThresholdTicks: 1 };
const sentMessages = [];
const report = buildShadowPromotionReport({
  events: [{ eventType: 'create', eventId: 'q', timestamp: 110, quoteId: 'q', side: 'buy', price: 100, size: 0.01, policyVector: policy, context: { fairValue: 101 } }, { eventType: 'full_fill', eventId: 'f', timestamp: 120, quoteId: 'q', side: 'buy', price: 100, size: 0.01, context: { fairValue: 101 } }],
  candidates: [{ id: 'candidate', policy }], evaluator: { split: { trainEnd: 100, validationStart: 100, validationEnd: 1000 }, referencePrices: [{ timestamp: 60120, price: 101 }, { timestamp: 300120, price: 101 }, { timestamp: 3600120, price: 101 }] }, criteria: { minObservationEvents: 2, maxInventoryRangeBTC: 1 }, fixConnection: { sendMessage: message => sentMessages.push(message) },
});
if (sentMessages.length !== 0 || report.dispatches !== 0) throw new Error('Shadow policy smoke dispatched a message');
console.log(`PASS: shadow promotion generated ${report.recommendation} with zero FIX sends`);
