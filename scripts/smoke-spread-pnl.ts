#!/usr/bin/env bun
/**
 * Smoke test for GET /api/v1/analytics/spread-pnl
 *
 * Hits the running analytics API and asserts the response shape the dashboard reads
 * (spreadPnl, matchedVolume, avgBuyPrice, avgSellPrice, tradingCashFlow) plus basic
 * invariants. Defaults to the prod API; override with API_BASE / ADMIN_API_TOKEN.
 *
 * Usage:
 *   ADMIN_API_TOKEN=... bun scripts/smoke-spread-pnl.ts
 *   API_BASE=http://178.156.230.110:3100 ADMIN_API_TOKEN=... bun scripts/smoke-spread-pnl.ts
 */

const API_BASE = process.env.API_BASE || 'http://178.156.230.110:3100';
const TOKEN = process.env.ADMIN_API_TOKEN;

if (!TOKEN) {
  console.error('BLOCK: ADMIN_API_TOKEN not set');
  process.exit(1);
}

const REQUIRED_KEYS = ['spreadPnl', 'matchedVolume', 'avgBuyPrice', 'avgSellPrice', 'tradingCashFlow'];

async function main() {
  const url = `${API_BASE}/api/v1/analytics/spread-pnl`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(15000) });

  if (res.status !== 200) {
    console.error(`BLOCK: HTTP ${res.status} from ${url}`);
    console.error(await res.text().catch(() => ''));
    process.exit(1);
  }

  const body = await res.json();
  if (!body?.success || !body?.data) {
    console.error('BLOCK: response not wrapped in {success, data}', JSON.stringify(body));
    process.exit(1);
  }

  const data = body.data;
  const missing = REQUIRED_KEYS.filter((k) => typeof data[k] !== 'number' || Number.isNaN(data[k]));
  if (missing.length) {
    console.error(`BLOCK: missing/non-numeric keys: ${missing.join(', ')}`, JSON.stringify(data));
    process.exit(1);
  }

  // Invariants: matched volume cannot be negative; avg prices non-negative.
  if (data.matchedVolume < 0 || data.avgBuyPrice < 0 || data.avgSellPrice < 0) {
    console.error('BLOCK: negative matchedVolume/avg price', JSON.stringify(data));
    process.exit(1);
  }

  console.log('PASS: /api/v1/analytics/spread-pnl');
  console.log(JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error('BLOCK: smoke threw', err);
  process.exit(1);
});
