#!/usr/bin/env bun
/**
 * Smoke test — orphaned order endpoints
 *
 * Real user scenarios:
 *   1. Ops checks health before doing anything
 *   2. Ops tries to inspect orphaned orders without a token → 401
 *   3. Ops inspects orphaned orders with a valid token
 *   4. Ops tries to cancel orphaned orders without a token → 401
 *   5. Ops cancels orphaned orders (dry-run: verify response shape, don't
 *      actually cancel unless SMOKE_LIVE_CANCEL=1 is set)
 *   6. Ops calls cancel again → 0 orphans (idempotent)
 *
 * Usage:
 *   bun scripts/smoke-orphaned-orders.ts              # dry-run (no real cancels)
 *   SMOKE_LIVE_CANCEL=1 bun scripts/smoke-orphaned-orders.ts  # fire real cancels
 *
 * Requires: API server running on $API_URL (default: http://localhost:3100)
 *   Start with: bun src/api/server.js &
 */

const API_URL        = process.env.API_URL || 'http://localhost:3100';
const ADMIN_TOKEN    = process.env.ADMIN_API_TOKEN;
const LIVE_CANCEL    = process.env.SMOKE_LIVE_CANCEL === '1';
const BAD_TOKEN      = 'smoke-test-invalid-token-xyz';

if (!ADMIN_TOKEN) {
  console.error('ADMIN_API_TOKEN not set — load your .env first');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(label: string) {
  console.log(`  ✅  ${label}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.log(`  ❌  ${label}${detail ? ': ' + detail : ''}`);
  failed++;
}

function skip(label: string, reason: string) {
  console.log(`  ⏭  ${label} [SKIP: ${reason}]`);
  skipped++;
}

function section(title: string) {
  console.log(`\n── ${title}`);
}

async function get(path: string, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['x-api-token'] = token;
  const res = await fetch(`${API_URL}${path}`, { headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function post(path: string, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['x-api-token'] = token;
  const res = await fetch(`${API_URL}${path}`, { method: 'POST', headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function assertShape(label: string, body: any, keys: string[]) {
  for (const key of keys) {
    if (!(key in body)) {
      fail(label, `missing key '${key}' in response`);
      return false;
    }
  }
  ok(label);
  return true;
}

// ---------------------------------------------------------------------------
// Scenario 1 — Health check (pre-flight)
// ---------------------------------------------------------------------------

section('Scenario 1: Ops pre-flight — health check');

{
  const { status, body } = await get('/api/v1/health');
  if (status === 200 && body.data?.status === 'healthy') {
    ok('GET /api/v1/health → 200 healthy');
  } else if (status === 200 && body.data?.status === 'unhealthy') {
    fail('GET /api/v1/health → DB unreachable', JSON.stringify(body.data?.database));
  } else {
    fail(`GET /api/v1/health → unexpected status ${status}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2 — Unauthenticated GET is rejected
// ---------------------------------------------------------------------------

section('Scenario 2: Ops inspects orphaned orders — no token → 401');

{
  const { status, body } = await get('/api/v1/orphaned-orders');
  if (status === 401) {
    ok('GET /api/v1/orphaned-orders (no token) → 401');
  } else {
    fail(`GET /api/v1/orphaned-orders (no token) → expected 401, got ${status}`);
  }
}

{
  const { status } = await get('/api/v1/orphaned-orders', BAD_TOKEN);
  if (status === 401) {
    ok('GET /api/v1/orphaned-orders (bad token) → 401');
  } else {
    fail(`GET /api/v1/orphaned-orders (bad token) → expected 401, got ${status}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 3 — Authenticated GET returns orphan list
// ---------------------------------------------------------------------------

section('Scenario 3: Ops inspects orphaned orders — valid token');

let orphanedOrders: any[] = [];
let liveCount = 0;

{
  const { status, body } = await get('/api/v1/orphaned-orders', ADMIN_TOKEN);

  if (status !== 200) {
    fail(`GET /api/v1/orphaned-orders → expected 200, got ${status}`, JSON.stringify(body));
  } else {
    ok('GET /api/v1/orphaned-orders → 200');

    const valid = assertShape(
      'response has live_count, orphaned_count, orphaned[]',
      body.data,
      ['live_count', 'orphaned_count', 'orphaned']
    );

    if (valid) {
      liveCount = body.data.live_count;
      orphanedOrders = body.data.orphaned;

      ok(`live orders on exchange: ${liveCount}`);
      ok(`orphaned (not in DB): ${orphanedOrders.length}`);

      if (orphanedOrders.length > 0) {
        const first = orphanedOrders[0];
        assertShape(
          'orphaned order has required fields',
          first,
          ['exchange_id', 'client_order_id', 'side', 'qty']
        );
        console.log(`     sample: ${first.side} ${first.qty} @ ${first.price ?? 'market'} (exchange_id: ${first.exchange_id})`);
      } else {
        ok('no orphaned orders — book is clean');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 4 — Unauthenticated POST is rejected
// ---------------------------------------------------------------------------

section('Scenario 4: Ops cancels orphaned orders — no token → 401');

{
  const { status } = await post('/api/v1/cancel-orphaned-orders');
  if (status === 401) {
    ok('POST /api/v1/cancel-orphaned-orders (no token) → 401');
  } else {
    fail(`POST /api/v1/cancel-orphaned-orders (no token) → expected 401, got ${status}`);
  }
}

{
  const { status } = await post('/api/v1/cancel-orphaned-orders', BAD_TOKEN);
  if (status === 401) {
    ok('POST /api/v1/cancel-orphaned-orders (bad token) → 401');
  } else {
    fail(`POST /api/v1/cancel-orphaned-orders (bad token) → expected 401, got ${status}`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 5 — Cancel orphaned orders (live or dry-run)
// ---------------------------------------------------------------------------

section(`Scenario 5: Ops cancels orphaned orders${LIVE_CANCEL ? '' : ' [DRY-RUN — set SMOKE_LIVE_CANCEL=1 to send real cancels]'}`);

if (!LIVE_CANCEL && orphanedOrders.length > 0) {
  skip(
    'POST /api/v1/cancel-orphaned-orders',
    `${orphanedOrders.length} orphans found — skipping live cancel in dry-run mode`
  );
} else {
  const { status, body } = await post('/api/v1/cancel-orphaned-orders', ADMIN_TOKEN);

  if (status !== 200) {
    fail(`POST /api/v1/cancel-orphaned-orders → expected 200, got ${status}`, JSON.stringify(body));
  } else {
    ok('POST /api/v1/cancel-orphaned-orders → 200');
    assertShape('response has cancelled, failed, total', body.data, ['cancelled', 'failed', 'total']);

    const { cancelled, failed: failCount, total } = body.data;
    ok(`cancelled: ${cancelled}/${total}, failed: ${failCount}`);

    if (failCount > 0) {
      fail(`${failCount} order(s) failed to cancel`, JSON.stringify(body.data.errors));
    }

    // ---------------------------------------------------------------------------
    // Scenario 6 — Second cancel is idempotent (0 orphans remain)
    // Wait past rate-limit window before retrying.
    // ---------------------------------------------------------------------------

    section('Scenario 6: Ops calls cancel again after rate window → idempotent (0 orphans)');

    const rateWindowMs = parseInt(process.env.ADMIN_RATE_WINDOW_MS || '60000', 10);
    if (rateWindowMs <= 10000) {
      console.log(`     waiting ${rateWindowMs}ms for rate window to expire...`);
      await new Promise(r => setTimeout(r, rateWindowMs + 200));
      const { status: s2, body: b2 } = await post('/api/v1/cancel-orphaned-orders', ADMIN_TOKEN);
      if (s2 === 200 && b2.data?.total === 0) {
        ok('POST /api/v1/cancel-orphaned-orders (after window) → 0 orphans, idempotent');
      } else if (s2 === 200) {
        fail(`2nd cancel → still ${b2.data?.total} orphan(s) remaining`);
      } else {
        fail(`2nd cancel → unexpected status ${s2}`);
      }
    } else {
      skip('idempotency check', `rate window ${rateWindowMs}ms too long for smoke test — set ADMIN_RATE_WINDOW_MS<=10000`);
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario 7 — Rate limiter rejects rapid repeated cancel calls
// ---------------------------------------------------------------------------

section('Scenario 7: Rate limiter blocks second cancel within window');

{
  // First call — should be allowed (resets the window)
  await post('/api/v1/cancel-orphaned-orders', ADMIN_TOKEN);
  // Second call immediately — should be rate limited
  const { status, body } = await post('/api/v1/cancel-orphaned-orders', ADMIN_TOKEN);
  if (status === 429) {
    ok('POST /api/v1/cancel-orphaned-orders (rapid 2nd call) → 429 rate limited');
    const msg: string = body?.error ?? '';
    if (msg.includes('retry after')) {
      ok(`rate limit message includes retry-after: "${msg}"`);
    } else {
      fail('rate limit response missing retry-after detail', msg);
    }
  } else {
    fail(`rapid 2nd cancel → expected 429, got ${status} (rate limiter not working)`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(50)}`);
console.log(`Smoke test complete: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log(`API: ${API_URL}`);
if (failed > 0) {
  process.exit(1);
}
