#!/usr/bin/env bun

import pg from 'pg';
import { backtestInventoryRebalancing } from '../src/analytics/inventory-rebalance-backtest.js';

const { Client } = pg;

const KNOWN_ARGS = new Set([
  'since', 'until', 'end-btc', 'end-pyusd', 'initial-mark-price', 'final-mark-price',
  'target-btc', 'sigma-btc', 'max-skew-bps', 'max-size-asymmetry', 'center-sigma',
  'soft-hedge-sigma', 'hard-hedge-sigma', 'maker-floor', 'format',
]);

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    const match = raw.match(/^--([a-z-]+)=(.+)$/);
    if (!match || !KNOWN_ARGS.has(match[1])) throw new Error(`Unsupported argument: ${raw}`);
    args[match[1]] = match[2];
  }
  return args;
}

function required(args, key) {
  if (!(key in args)) throw new Error(`--${key}=VALUE is required`);
  return args[key];
}

function numberArg(args, key, fallback) {
  if (!(key in args)) return fallback;
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be finite`);
  return value;
}

function timestampArg(args, key) {
  const raw = required(args, key);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new Error(`--${key} must be an ISO timestamp`);
  return timestamp;
}

async function fetchFills(client, since, until) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '20000ms'");
    const result = await client.query(`
      WITH window_fills AS (
        SELECT id, orderid, lower(side) AS side, price,
               COALESCE(NULLIF(quantity, 0), NULLIF(size, 0)) AS quantity,
               timestamp
        FROM fills
        WHERE timestamp >= $1 AND timestamp < $2
      ), fill_order_ids AS (
        SELECT DISTINCT orderid FROM window_fills
      ), first_orders AS (
        SELECT DISTINCT ON (orders.clientorderid)
               orders.clientorderid, orders.size
        FROM orders
        JOIN fill_order_ids ON fill_order_ids.orderid = orders.clientorderid
        ORDER BY orders.clientorderid, orders.timestamp ASC
      )
      SELECT window_fills.*, COALESCE(first_orders.size, window_fills.quantity) AS order_size
      FROM window_fills
      LEFT JOIN first_orders ON first_orders.clientorderid = window_fills.orderid
      ORDER BY window_fills.timestamp ASC, window_fills.id ASC
    `, [since, until]);
    await client.query('COMMIT');
    return result.rows.map(row => ({
      id: row.id,
      orderId: row.orderid,
      side: row.side,
      price: Number(row.price),
      quantity: Number(row.quantity),
      orderSize: Number(row.order_size),
      timestamp: Number(row.timestamp),
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

function money(value) {
  return `$${value.toFixed(2)}`;
}

function renderScenario(name, scenario, actual = null) {
  const delta = actual ? ` (${scenario.endingValue >= actual.endingValue ? '+' : ''}${money(scenario.endingValue - actual.endingValue)} vs actual)` : '';
  return [
    `${name}:`,
    `  ending value ${money(scenario.endingValue)}${delta}; P&L ${money(scenario.pnl)}; vs holding ${money(scenario.pnlVsHolding)}`,
    `  end inventory ${scenario.endingBalances.btc.toFixed(8)} BTC; cash ${money(scenario.endingBalances.quote)}; deviation ${scenario.endingInventoryDeviationBTC.toFixed(8)} BTC`,
    `  traded ${scenario.fillQuantityBTC.toFixed(8)} BTC across ${scenario.fillFragments} fragments / ${scenario.filledOrders} orders; turnover ${money(scenario.turnoverQuote)}`,
    `  buys ${scenario.buyQuantityBTC.toFixed(8)} BTC; sells ${scenario.sellQuantityBTC.toFixed(8)} BTC; skipped ${scenario.skippedQuantityBTC.toFixed(8)} BTC`,
  ].join('\n');
}

function renderText(report) {
  const start = new Date(report.window.startTimestamp).toISOString();
  const end = new Date(report.window.endTimestamp).toISOString();
  return [
    `Inventory bell-policy backtest: ${start} to ${end}`,
    `Evidence: ${report.window.recordedFillFragments} fill fragments across ${report.window.recordedOrders} orders`,
    `Inferred start: ${report.actual.startingBalances.btc.toFixed(8)} BTC + ${money(report.actual.startingBalances.quote)}`,
    `Marks: ${money(report.window.initialMarkPrice)} -> ${money(report.window.finalMarkPrice)}`,
    '',
    renderScenario('Actual', report.actual),
    '',
    renderScenario('Strict fill survival', report.strictFillSurvival, report.actual),
    '',
    renderScenario('Same-opportunity replay', report.sameOpportunity, report.actual),
    '',
    'Important: these scenarios replay recorded taker opportunities only; they do not predict new fills or queue position.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const since = timestampArg(args, 'since');
  const until = timestampArg(args, 'until');
  if (since >= until) throw new Error('--since must be before --until');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const fills = await fetchFills(client, since, until);
    const report = backtestInventoryRebalancing({
      fills,
      endingBalances: {
        btc: numberArg(args, 'end-btc'),
        quote: numberArg(args, 'end-pyusd'),
      },
      initialMarkPrice: numberArg(args, 'initial-mark-price'),
      finalMarkPrice: numberArg(args, 'final-mark-price'),
      policy: {
        targetInventoryBTC: numberArg(args, 'target-btc'),
        inventorySigmaBTC: numberArg(args, 'sigma-btc'),
        maxQuoteSkewBps: numberArg(args, 'max-skew-bps'),
        maxSizeAsymmetry: numberArg(args, 'max-size-asymmetry'),
        centerBandSigma: numberArg(args, 'center-sigma', 0.5),
        softHedgeBandSigma: numberArg(args, 'soft-hedge-sigma', 2),
        hardHedgeBandSigma: numberArg(args, 'hard-hedge-sigma', 3),
        minimumMakerParticipation: numberArg(args, 'maker-floor', 0.25),
      },
    });
    console.log((args.format || 'text') === 'json' ? JSON.stringify(report, null, 2) : renderText(report));
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(`Inventory backtest error: ${error.message}`);
  process.exitCode = 1;
});
