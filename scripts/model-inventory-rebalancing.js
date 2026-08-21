#!/usr/bin/env bun

import { buildInventoryRebalanceCurve } from '../src/analytics/inventory-rebalance-model.js';

function parseArgs(argv) {
  const values = {};
  for (const arg of argv) {
    const match = arg.match(/^--([a-z-]+)=(.+)$/);
    if (!match) throw new Error(`Unsupported argument: ${arg}`);
    values[match[1]] = match[2];
  }
  return values;
}

function requiredNumber(args, key) {
  if (!(key in args)) throw new Error(`--${key}=VALUE is required`);
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be finite`);
  return value;
}

function optionalNumber(args, key, fallback) {
  if (!(key in args)) return fallback;
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be finite`);
  return value;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function renderTable(points) {
  const header = [
    'sigma'.padStart(6),
    'inventory'.padStart(11),
    'zone'.padEnd(19),
    'trade'.padStart(7),
    'rebalance'.padStart(9),
    'bid bps'.padStart(8),
    'ask bps'.padStart(8),
    'bid size'.padStart(9),
    'ask size'.padStart(9),
    'hedge'.padStart(7),
  ].join('  ');
  const rows = points.map(point => [
    point.zScore.toFixed(2).padStart(6),
    point.inventoryBTC.toFixed(8).padStart(11),
    point.zone.padEnd(19),
    percent(point.tradingWeight).padStart(7),
    percent(point.rebalancingWeight).padStart(9),
    point.quote.bidSkewBps.toFixed(2).padStart(8),
    point.quote.askSkewBps.toFixed(2).padStart(8),
    `${point.quote.bidSizeMultiplier.toFixed(2)}x`.padStart(9),
    `${point.quote.askSizeMultiplier.toFixed(2)}x`.padStart(9),
    percent(point.hedge.intensity).padStart(7),
  ].join('  '));
  return [header, ...rows].join('\n');
}

try {
  const args = parseArgs(process.argv.slice(2));
  const config = {
    targetInventoryBTC: requiredNumber(args, 'target-btc'),
    inventorySigmaBTC: requiredNumber(args, 'sigma-btc'),
    maxQuoteSkewBps: requiredNumber(args, 'max-skew-bps'),
    maxSizeAsymmetry: requiredNumber(args, 'max-size-asymmetry'),
    centerBandSigma: optionalNumber(args, 'center-sigma', 0.5),
    softHedgeBandSigma: optionalNumber(args, 'soft-hedge-sigma', 2),
    hardHedgeBandSigma: optionalNumber(args, 'hard-hedge-sigma', 3),
    minimumMakerParticipation: optionalNumber(args, 'maker-floor', 0.25),
  };
  const points = buildInventoryRebalanceCurve(config, {
    minSigma: optionalNumber(args, 'min-sigma', -3),
    maxSigma: optionalNumber(args, 'max-sigma', 3),
    stepSigma: optionalNumber(args, 'step-sigma', 0.5),
  });
  if ((args.format || 'table') === 'json') {
    console.log(JSON.stringify({ config, points }, null, 2));
  } else if ((args.format || 'table') === 'table') {
    console.log(renderTable(points));
  } else {
    throw new Error('--format must be table or json');
  }
} catch (error) {
  console.error(`Inventory rebalance model error: ${error.message}`);
  process.exitCode = 1;
}
