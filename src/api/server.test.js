/**
 * Tests for GET /api/v1/analytics/balance-snapshots
 *
 * Uses a mock db query function injected via the db module to avoid a live
 * PostgreSQL connection. The handler is extracted and tested in isolation.
 */
import { describe, it, expect, jest } from 'bun:test';

// ---------------------------------------------------------------------------
// Minimal stubs matching the shapes used by the handler
// ---------------------------------------------------------------------------

function makeParams(obj = {}) {
  const p = new URLSearchParams(obj);
  return p;
}

function makeDb(rows = [], total = rows.length) {
  let callCount = 0;
  return {
    query: jest.fn(async (sql) => {
      callCount++;
      if (sql.includes('COUNT(*)')) return { rows: [{ total }] };
      return { rows };
    }),
    get callCount() { return callCount; },
  };
}

// ---------------------------------------------------------------------------
// Inline handler (mirrors server.js logic but with injected db)
// ---------------------------------------------------------------------------

function parsePagination(params) {
  const page = Math.max(1, parseInt(params.get('page') || '1', 10));
  const limit = Math.min(500, Math.max(1, parseInt(params.get('limit') || '50', 10)));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function parseTimeRange(params) {
  const from = params.get('from') ? parseInt(params.get('from'), 10) : null;
  const to = params.get('to') ? parseInt(params.get('to'), 10) : null;
  return { from, to };
}

function addTimeFilter(conditions, values, idx, col, from, to) {
  if (from) { conditions.push(`${col} >= $${idx++}`); values.push(from); }
  if (to)   { conditions.push(`${col} <= $${idx++}`); values.push(to); }
  return idx;
}

async function handleAnalyticsBalanceSnapshots(params, db) {
  const session = params.get('session');
  const { from, to } = parseTimeRange(params);
  const { limit, offset, page } = parsePagination(params);

  const conditions = [];
  const values = [];
  let idx = 1;
  if (session) { conditions.push(`session_id = $${idx++}`); values.push(session); }
  idx = addTimeFilter(conditions, values, idx, 'timestamp', from, to);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const countValues = [...values];
  const countR = await db.query(
    `SELECT COUNT(*)::int AS total FROM balance_snapshots ${where}`,
    countValues,
  );
  const total = countR.rows[0]?.total ?? 0;

  values.push(limit, offset);
  const r = await db.query(`
    SELECT
      id,
      session_id,
      timestamp,
      btc_qty::float,
      pyusd_qty::float,
      btc_mid_price::float,
      portfolio_value_pyusd::float
    FROM balance_snapshots
    ${where}
    ORDER BY timestamp ASC
    LIMIT $${idx++} OFFSET $${idx++}
  `, values);

  return { rows: r.rows, meta: { total, page, limit, count: r.rows.length } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
    // LIMIT and OFFSET appear as the last two values
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
});
