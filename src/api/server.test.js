/**
 * Tests for GET /api/v1/analytics/balance-snapshots
 *
 * Imports the real handler from analytics-balance-snapshots.js and
 * injects a mock db so no live PostgreSQL connection is needed.
 */
import { describe, it, expect, jest } from 'bun:test';
import { handleAnalyticsBalanceSnapshots } from './analytics-balance-snapshots.js';
import { buildPublicHealthSnapshot } from './public-health-snapshot.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(obj = {}) {
  return new URLSearchParams(obj);
}

function makeDb(rows = [], total = rows.length) {
  return {
    query: jest.fn(async (sql) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ total }] };
      return { rows };
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/health public payload', () => {
  it('omits inventory-recovery strategy decisions', () => {
    const response = buildPublicHealthSnapshot({
      status: 'healthy',
      inventoryRecovery: {
        enabled: true, direction: 'accumulate', adjustmentApplied: true,
        decision: 'below-interim-target',
      },
    }, { connected: true }, { uptime: () => 12 });

    expect(response).not.toHaveProperty('inventoryRecovery');
    expect(JSON.stringify(response)).not.toContain('accumulate');
    expect(response.database).toEqual({ connected: true });
  });
});

describe('GET /api/v1/analytics/balance-snapshots', () => {
  it('returns all rows when no filters applied', async () => {
    const rows = [
      { id: 1, session_id: 'sess1', timestamp: 1000, btc_qty: 0.044, pyusd_qty: 100, btc_mid_price: 83000, portfolio_value_pyusd: 3752 },
      { id: 2, session_id: 'sess1', timestamp: 2000, btc_qty: 0.044, pyusd_qty: 100, btc_mid_price: 84000, portfolio_value_pyusd: 3796 },
    ];
    const db = makeDb(rows, 2);
    const result = await handleAnalyticsBalanceSnapshots(makeParams(), db);
    expect(result.rows).toHaveLength(2);
    expect(result.meta.total).toBe(2);
    expect(result.meta.page).toBe(1);
    expect(result.meta.limit).toBe(50);
    expect(result.meta.count).toBe(2);
  });

  it('passes session_id filter to both COUNT and SELECT queries', async () => {
    const db = makeDb([], 0);
    await handleAnalyticsBalanceSnapshots(makeParams({ session: 'sess-abc' }), db);
    expect(db.query).toHaveBeenCalledTimes(2);
    const [countSql, countVals] = db.query.mock.calls[0];
    expect(countSql).toContain('session_id = $1');
    expect(countVals).toContain('sess-abc');
    const [selectSql, selectVals] = db.query.mock.calls[1];
    expect(selectSql).toContain('session_id = $1');
    expect(selectVals).toContain('sess-abc');
  });

  it('passes from/to time filters', async () => {
    const db = makeDb([], 0);
    await handleAnalyticsBalanceSnapshots(makeParams({ from: '1000', to: '9000' }), db);
    const [, countVals] = db.query.mock.calls[0];
    expect(countVals).toContain(1000);
    expect(countVals).toContain(9000);
  });

  it('passes session + time filters together', async () => {
    const db = makeDb([], 0);
    await handleAnalyticsBalanceSnapshots(makeParams({ session: 'S1', from: '1000', to: '5000' }), db);
    const [countSql, countVals] = db.query.mock.calls[0];
    expect(countSql).toContain('session_id = $1');
    expect(countSql).toContain('timestamp >= $2');
    expect(countSql).toContain('timestamp <= $3');
    expect(countVals).toEqual(['S1', 1000, 5000]);
  });

  it('applies pagination correctly (page 2, limit 10)', async () => {
    const db = makeDb([], 25);
    await handleAnalyticsBalanceSnapshots(makeParams({ page: '2', limit: '10' }), db);
    const [selectSql, selectVals] = db.query.mock.calls[1];
    // LIMIT and OFFSET are the last two values
    const [limitVal, offsetVal] = selectVals.slice(-2);
    expect(limitVal).toBe(10);
    expect(offsetVal).toBe(10); // (page-1)*limit = 10
    expect(selectSql).toContain('LIMIT');
    expect(selectSql).toContain('OFFSET');
  });

  it('caps limit at 500', async () => {
    const db = makeDb([], 0);
    await handleAnalyticsBalanceSnapshots(makeParams({ limit: '9999' }), db);
    const [, selectVals] = db.query.mock.calls[1];
    const limitVal = selectVals[selectVals.length - 2];
    expect(limitVal).toBe(500);
  });

  it('returns meta.total from COUNT query even when rows is empty', async () => {
    const db = makeDb([], 42);
    const result = await handleAnalyticsBalanceSnapshots(makeParams({ page: '5', limit: '10' }), db);
    expect(result.meta.total).toBe(42);
    expect(result.meta.count).toBe(0);
  });

  it('SELECT query orders by timestamp ASC', async () => {
    const db = makeDb([]);
    await handleAnalyticsBalanceSnapshots(makeParams(), db);
    const [selectSql] = db.query.mock.calls[1];
    expect(selectSql).toContain('ORDER BY timestamp ASC');
  });

  it('SELECT query projects the expected columns', async () => {
    const db = makeDb([]);
    await handleAnalyticsBalanceSnapshots(makeParams(), db);
    const [selectSql] = db.query.mock.calls[1];
    expect(selectSql).toContain('btc_qty::float');
    expect(selectSql).toContain('pyusd_qty::float');
    expect(selectSql).toContain('btc_mid_price::float');
    expect(selectSql).toContain('portfolio_value_pyusd::float');
  });

  it('runs exactly 2 queries (COUNT + SELECT) per request', async () => {
    const db = makeDb([]);
    await handleAnalyticsBalanceSnapshots(makeParams(), db);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('uses default page=1, limit=50 when page/limit params are non-numeric', async () => {
    const db = makeDb([], 0);
    await handleAnalyticsBalanceSnapshots(makeParams({ page: 'abc', limit: 'xyz' }), db);
    const [, selectVals] = db.query.mock.calls[1];
    const [limitVal, offsetVal] = selectVals.slice(-2);
    expect(limitVal).toBe(50);
    expect(offsetVal).toBe(0); // page 1, offset 0
  });

  it('ignores non-numeric from/to params (does not send NaN to SQL)', async () => {
    const db = makeDb([], 0);
    await handleAnalyticsBalanceSnapshots(makeParams({ from: 'abc', to: 'xyz' }), db);
    const [countSql] = db.query.mock.calls[0];
    expect(countSql).not.toContain('timestamp >=');
    expect(countSql).not.toContain('timestamp <=');
  });

  it('treats epoch 0 as a valid time bound (not filtered out as falsy)', async () => {
    const db = makeDb([], 0);
    await handleAnalyticsBalanceSnapshots(makeParams({ from: '0' }), db);
    const [countSql, countVals] = db.query.mock.calls[0];
    expect(countSql).toContain('timestamp >= $1');
    expect(countVals).toContain(0);
  });
});
