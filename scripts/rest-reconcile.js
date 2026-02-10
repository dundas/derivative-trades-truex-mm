#!/usr/bin/env bun
/**
 * TrueX REST Order Reconciliation — Standalone Script
 *
 * Queries TrueX REST API for active orders and displays them.
 * Use --cancel to cancel all found orders.
 *
 * Usage:
 *   bun scripts/rest-reconcile.js            # Display active orders
 *   bun scripts/rest-reconcile.js --cancel   # Display and cancel all
 */
import { TrueXRESTClient } from '../src/exchanges/truex/TrueXRESTClient.ts';

const baseURL = (process.env.TRUEX_REST_URL || 'http://38.32.101.229:9742') + '/api/v1';
const apiKey = process.env.TRUEX_API_KEY;
const apiSecret = process.env.TRUEX_SECRET_KEY;
const clientId = process.env.TRUEX_CLIENT_ID || '78972918929686546';
const shouldCancel = process.argv.includes('--cancel');

if (!apiKey || !apiSecret) {
  console.error('Missing TRUEX_API_KEY or TRUEX_SECRET_KEY');
  process.exit(1);
}

const client = new TrueXRESTClient({ baseURL, apiKey, apiSecret, userId: clientId });

console.log('=== TrueX Order Reconciliation ===');
console.log(`REST URL:   ${baseURL}`);
console.log(`Client ID:  ${clientId}`);
console.log(`Mode:       ${shouldCancel ? 'CANCEL' : 'READ-ONLY'}`);
console.log('');

try {
  const active = await client.getActiveOrders();
  console.log(`Active orders on exchange: ${active.length}`);

  if (active.length === 0) {
    console.log('No active orders found.');
    process.exit(0);
  }

  console.log('');
  console.log('  ID                 | Side | Qty      | Price      | Status        | ExtID              | Age');
  console.log('  ' + '-'.repeat(105));

  const now = Date.now();
  for (const raw of active) {
    const o = TrueXRESTClient.parseOrder(raw);
    const ageMs = o.createdAt ? now - o.createdAt.getTime() : 0;
    const ageSec = Math.round(ageMs / 1000);
    const ageStr = ageSec > 60 ? `${Math.round(ageSec / 60)}m` : `${ageSec}s`;

    console.log(
      `  ${o.id.padEnd(20)} | ${o.side.padEnd(4)} | ${o.qty.toFixed(4).padStart(8)} | $${o.price.toFixed(2).padStart(9)} | ${o.status.padEnd(13)} | ${(o.externalId || '-').padEnd(18)} | ${ageStr}`
    );
  }

  if (shouldCancel) {
    console.log('');
    console.log('Cancelling all active orders...');
    let cancelled = 0;
    let failed = 0;
    for (const raw of active) {
      try {
        await client.cancelOrder(raw.id);
        cancelled++;
      } catch (err) {
        console.error(`  Failed to cancel ${raw.id}: ${err.message}`);
        failed++;
      }
    }
    console.log(`Done: ${cancelled} cancelled, ${failed} failed`);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  if (err.details) console.error('Details:', JSON.stringify(err.details));
  process.exit(1);
}
