/**
 * Handler for GET /api/v1/analytics/balance-snapshots
 *
 * Exported as a pure function that takes (params, db) so it can be
 * tested without importing the full server (which has top-level await).
 */

function parsePosInt(raw, fallback) {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parsePaginationLocal(params) {
  const page = parsePosInt(params.get('page'), 1);
  const limit = Math.min(500, parsePosInt(params.get('limit'), 50));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function parseTimeRangeLocal(params) {
  const rawFrom = params.get('from');
  const rawTo   = params.get('to');
  const from = rawFrom !== null ? parseInt(rawFrom, 10) : null;
  const to   = rawTo   !== null ? parseInt(rawTo,   10) : null;
  return { from, to };
}

function addTimeFilterLocal(conditions, values, idx, col, from, to) {
  if (from !== null) { conditions.push(`${col} >= $${idx++}`); values.push(from); }
  if (to   !== null) { conditions.push(`${col} <= $${idx++}`); values.push(to); }
  return idx;
}

/**
 * @param {URLSearchParams} params
 * @param {{ query: (sql: string, values?: any[]) => Promise<{rows: any[]}> }} db
 */
export async function handleAnalyticsBalanceSnapshots(params, db) {
  const session = params.get('session');
  const { from, to } = parseTimeRangeLocal(params);
  const { limit, offset, page } = parsePaginationLocal(params);

  const conditions = [];
  const values = [];
  let idx = 1;
  if (session) { conditions.push(`session_id = $${idx++}`); values.push(session); }
  idx = addTimeFilterLocal(conditions, values, idx, 'timestamp', from, to);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const countValues = [...values];
  const countR = await db.query(
    `SELECT COUNT(*)::int AS total FROM balance_snapshots ${where}`,
    countValues,
  );
  const total = countR.rows[0]?.total ?? 0;

  const limitIdx = idx++;
  const offsetIdx = idx++;
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
    LIMIT $${limitIdx} OFFSET $${offsetIdx}
  `, values);

  return { rows: r.rows, meta: { total, page, limit, count: r.rows.length } };
}
