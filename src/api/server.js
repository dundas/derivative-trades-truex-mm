#!/usr/bin/env bun
/**
 * Market Maker Analytics API Server
 *
 * Exposes PostgreSQL trading data for AI-driven market maker optimization.
 * Uses Bun.serve() with the existing PostgreSQLAPI for data access.
 *
 * Endpoints:
 *   System:    GET /api/v1/health, /api/v1/stats
 *   Data:      GET /api/v1/sessions, /orders, /fills (with pagination & filtering)
 *   Analytics: GET /api/v1/analytics/pnl, /fill-rate, /spread-capture,
 *              /adverse-selection, /inventory, /parameters
 *
 * Environment:
 *   API_PORT      - Listen port (default: 3100)
 *   CORS_ORIGIN   - CORS allowed origin (default: *)
 *   DATABASE_URL   - PostgreSQL connection string (required)
 *
 * Usage:
 *   bun src/api/server.js
 */
import { createPostgreSQLAPIFromEnv } from '../../lib/postgresql-api/index.js';
import { readFileSync, existsSync } from 'fs';

const PORT         = parseInt(process.env.API_PORT || '3100', 10);
const CORS_ORIGIN  = process.env.CORS_ORIGIN || '*';
const ADMIN_TOKEN  = process.env.ADMIN_API_TOKEN || null;
const LOG_FILE     = process.env.LOG_FILE || '/app/logs/market-maker.log';
const MECH_APP_ID  = process.env.MECH_APP_ID;
const MECH_API_KEY = process.env.MECH_API_KEY;
const STORAGE_URL  = process.env.MECH_STORAGE_URL || 'https://storage.mechdna.net';

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = createPostgreSQLAPIFromEnv();
await db.initialize();

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonOk(data, meta = {}) {
  return new Response(JSON.stringify({ success: true, data, meta }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

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

const INTERVAL_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '1d': 86400000 };

function matchRoute(path, pattern) {
  const pp = pattern.split('/');
  const sp = path.split('/');
  if (pp.length !== sp.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(sp[i]);
    else if (pp[i] !== sp[i]) return null;
  }
  return params;
}

// Build a WHERE clause from optional filters. Returns { where, values, idx }.
function buildWhere(filters, startIdx = 1) {
  const conditions = [];
  const values = [];
  let idx = startIdx;
  for (const [col, val] of filters) {
    if (val != null) {
      conditions.push(`${col} = $${idx++}`);
      values.push(val);
    }
  }
  return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', values, idx };
}

function addTimeFilter(conditions, values, idx, col, from, to) {
  if (from) { conditions.push(`${col} >= $${idx++}`); values.push(from); }
  if (to)   { conditions.push(`${col} <= $${idx++}`); values.push(to); }
  return idx;
}

// ---------------------------------------------------------------------------
// System Endpoints
// ---------------------------------------------------------------------------

async function handleHealth() {
  const start = Date.now();
  try {
    await db.query('SELECT 1');
    const latencyMs = Date.now() - start;
    const pool = db.getStats ? db.getStats() : null;
    return jsonOk({ status: 'healthy', database: { connected: true, latencyMs, pool }, uptime: process.uptime(), timestamp: Date.now() });
  } catch (err) {
    return jsonOk({ status: 'unhealthy', database: { connected: false, error: err.message }, uptime: process.uptime(), timestamp: Date.now() });
  }
}

async function handleStats() {
  const r = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM sessions)::int AS session_count,
      (SELECT COUNT(*) FROM orders)::int   AS order_count,
      (SELECT COUNT(*) FROM fills)::int    AS fill_count,
      (SELECT MAX(startedat) FROM sessions) AS latest_session_started,
      (SELECT MAX(timestamp) FROM fills)    AS latest_fill_timestamp
  `);
  return jsonOk(r.rows[0]);
}

// ---------------------------------------------------------------------------
// Core Data Endpoints
// ---------------------------------------------------------------------------

async function handleGetSessions(params) {
  const { page, limit, offset } = parsePagination(params);
  const { from, to } = parseTimeRange(params);
  const conditions = [];
  const values = [];
  let idx = 1;
  const status = params.get('status');
  const symbol = params.get('symbol');
  if (status) { conditions.push(`status = $${idx++}`); values.push(status); }
  if (symbol) { conditions.push(`symbol = $${idx++}`); values.push(symbol); }
  idx = addTimeFilter(conditions, values, idx, 'startedat', from, to);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const countR = await db.query(`SELECT COUNT(*)::int AS total FROM sessions ${where}`, values);
  const total = countR.rows[0].total;
  const dataR = await db.query(
    `SELECT * FROM sessions ${where} ORDER BY startedat DESC NULLS LAST LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset],
  );
  return jsonOk(dataR.rows, { total, page, limit, pages: Math.ceil(total / limit) });
}

async function handleGetSession(id) {
  const r = await db.query('SELECT * FROM sessions WHERE id = $1 OR sessionid = $1 LIMIT 1', [id]);
  if (r.rows.length === 0) return jsonError('Session not found', 404);
  return jsonOk(r.rows[0]);
}

async function handleGetSessionOrders(sessionId, params) {
  const { page, limit, offset } = parsePagination(params);
  const conditions = ['sessionid = $1'];
  const values = [sessionId];
  let idx = 2;
  const status = params.get('status');
  const side = params.get('side');
  if (status) { conditions.push(`status = $${idx++}`); values.push(status); }
  if (side)   { conditions.push(`side = $${idx++}`); values.push(side); }
  const where = conditions.join(' AND ');
  const countR = await db.query(`SELECT COUNT(*)::int AS total FROM orders WHERE ${where}`, values);
  const total = countR.rows[0].total;
  const dataR = await db.query(
    `SELECT * FROM orders WHERE ${where} ORDER BY timestamp DESC NULLS LAST LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset],
  );
  return jsonOk(dataR.rows, { total, page, limit, pages: Math.ceil(total / limit) });
}

async function handleGetSessionFills(sessionId, params) {
  const { page, limit, offset } = parsePagination(params);
  const countR = await db.query('SELECT COUNT(*)::int AS total FROM fills WHERE sessionid = $1', [sessionId]);
  const total = countR.rows[0].total;
  const dataR = await db.query(
    'SELECT * FROM fills WHERE sessionid = $1 ORDER BY timestamp DESC LIMIT $2 OFFSET $3',
    [sessionId, limit, offset],
  );
  return jsonOk(dataR.rows, { total, page, limit, pages: Math.ceil(total / limit) });
}

async function handleGetOrders(params) {
  const { page, limit, offset } = parsePagination(params);
  const { from, to } = parseTimeRange(params);
  const conditions = [];
  const values = [];
  let idx = 1;
  const session = params.get('session');
  const status = params.get('status');
  const side = params.get('side');
  if (session) { conditions.push(`sessionid = $${idx++}`); values.push(session); }
  if (status)  { conditions.push(`status = $${idx++}`); values.push(status); }
  if (side)    { conditions.push(`side = $${idx++}`); values.push(side); }
  idx = addTimeFilter(conditions, values, idx, 'timestamp', from, to);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const countR = await db.query(`SELECT COUNT(*)::int AS total FROM orders ${where}`, values);
  const total = countR.rows[0].total;
  const dataR = await db.query(
    `SELECT * FROM orders ${where} ORDER BY timestamp DESC NULLS LAST LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset],
  );
  return jsonOk(dataR.rows, { total, page, limit, pages: Math.ceil(total / limit) });
}

async function handleGetFills(params) {
  const { page, limit, offset } = parsePagination(params);
  const { from, to } = parseTimeRange(params);
  const conditions = [];
  const values = [];
  let idx = 1;
  const session = params.get('session');
  const side = params.get('side');
  if (session) { conditions.push(`sessionid = $${idx++}`); values.push(session); }
  if (side)    { conditions.push(`side = $${idx++}`); values.push(side); }
  idx = addTimeFilter(conditions, values, idx, 'timestamp', from, to);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const countR = await db.query(`SELECT COUNT(*)::int AS total FROM fills ${where}`, values);
  const total = countR.rows[0].total;
  const dataR = await db.query(
    `SELECT * FROM fills ${where} ORDER BY timestamp DESC LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, limit, offset],
  );
  return jsonOk(dataR.rows, { total, page, limit, pages: Math.ceil(total / limit) });
}

// ---------------------------------------------------------------------------
// Analytics Endpoints
// ---------------------------------------------------------------------------

async function handleAnalyticsPnl(params) {
  const intervalKey = params.get('interval') || '5m';
  const intervalMs = INTERVAL_MS[intervalKey];
  if (!intervalMs) return jsonError(`Invalid interval. Use: ${Object.keys(INTERVAL_MS).join(', ')}`);

  const session = params.get('session');
  const { from, to } = parseTimeRange(params);
  const conditions = [];
  const values = [intervalMs];
  let idx = 2;
  if (session) { conditions.push(`sessionid = $${idx++}`); values.push(session); }
  idx = addTimeFilter(conditions, values, idx, 'timestamp', from, to);
  const where = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

  const r = await db.query(`
    WITH fill_pnl AS (
      SELECT
        (timestamp / $1) * $1 AS bucket,
        SUM(CASE
          WHEN side = 'sell' THEN COALESCE(size, amount, 0)::numeric * price::numeric
          WHEN side = 'buy'  THEN -(COALESCE(size, amount, 0)::numeric * price::numeric)
          ELSE 0
        END) AS period_pnl,
        SUM(CASE WHEN side = 'buy' THEN COALESCE(size, amount, 0)::numeric ELSE 0 END) AS buy_volume,
        SUM(CASE WHEN side = 'sell' THEN COALESCE(size, amount, 0)::numeric ELSE 0 END) AS sell_volume,
        COUNT(*) AS fill_count
      FROM fills
      WHERE 1=1 ${where}
      GROUP BY bucket
      ORDER BY bucket ASC
    )
    SELECT
      bucket,
      period_pnl::float,
      SUM(period_pnl) OVER (ORDER BY bucket)::float AS cumulative_pnl,
      buy_volume::float,
      sell_volume::float,
      fill_count::int
    FROM fill_pnl
  `, values);

  return jsonOk(r.rows, { interval: intervalKey, intervalMs, count: r.rows.length });
}

async function handleAnalyticsFillRate(params) {
  const session = params.get('session');
  const conditions = [];
  const values = [];
  let idx = 1;
  if (session) { conditions.push(`o.sessionid = $${idx++}`); values.push(session); }
  const { from, to } = parseTimeRange(params);
  idx = addTimeFilter(conditions, values, idx, 'o.timestamp', from, to);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const r = await db.query(`
    SELECT
      o.sessionid,
      o.side,
      COUNT(DISTINCT o.id)::int AS total_orders,
      COUNT(DISTINCT CASE WHEN o.status IN ('filled', 'FILLED', '2') THEN o.id END)::int AS filled_orders,
      COUNT(DISTINCT CASE WHEN o.status IN ('partial_fill', 'PARTIALLY_FILLED', '1') THEN o.id END)::int AS partial_fills,
      COUNT(DISTINCT CASE WHEN o.status IN ('cancelled', 'CANCELED', '4') THEN o.id END)::int AS cancelled_orders,
      COUNT(DISTINCT CASE WHEN o.status IN ('rejected', 'REJECTED', '8') THEN o.id END)::int AS rejected_orders,
      CASE WHEN COUNT(DISTINCT o.id) > 0
        THEN ROUND(COUNT(DISTINCT CASE WHEN o.status IN ('filled', 'FILLED', '2') THEN o.id END)::numeric / COUNT(DISTINCT o.id) * 100, 2)::float
        ELSE 0
      END AS fill_rate_pct,
      COUNT(DISTINCT f.id)::int AS total_fills,
      COALESCE(SUM(COALESCE(f.size, f.amount, 0)::numeric), 0)::float AS total_fill_volume
    FROM orders o
    LEFT JOIN fills f ON f.orderid = o.id
    ${where}
    GROUP BY o.sessionid, o.side
    ORDER BY o.sessionid, o.side
  `, values);

  return jsonOk(r.rows, { count: r.rows.length });
}

async function handleAnalyticsSpreadCapture(params) {
  const session = params.get('session');
  const conditions = [];
  const values = [];
  let idx = 1;
  if (session) { conditions.push(`sessionid = $${idx++}`); values.push(session); }
  const { from, to } = parseTimeRange(params);
  idx = addTimeFilter(conditions, values, idx, 'timestamp', from, to);
  const buyWhere = conditions.length ? 'AND ' + conditions.join(' AND ') : '';
  // Duplicate for sell filter (same conditions)
  const sellWhere = buyWhere;

  const r = await db.query(`
    WITH ranked_buys AS (
      SELECT id, sessionid, price::float, COALESCE(size, amount, 0)::float AS qty,
             timestamp, COALESCE(fee, feeamount, 0)::float AS fee,
             ROW_NUMBER() OVER (PARTITION BY sessionid ORDER BY timestamp) AS rn
      FROM fills WHERE side = 'buy' ${buyWhere}
    ),
    ranked_sells AS (
      SELECT id, sessionid, price::float, COALESCE(size, amount, 0)::float AS qty,
             timestamp, COALESCE(fee, feeamount, 0)::float AS fee,
             ROW_NUMBER() OVER (PARTITION BY sessionid ORDER BY timestamp) AS rn
      FROM fills WHERE side = 'sell' ${sellWhere}
    ),
    pairs AS (
      SELECT
        b.sessionid,
        b.id AS buy_fill_id, s.id AS sell_fill_id,
        b.price AS buy_price, s.price AS sell_price,
        LEAST(b.qty, s.qty) AS matched_qty,
        (s.price - b.price) AS gross_spread,
        (s.price - b.price) * LEAST(b.qty, s.qty) AS gross_pnl,
        (b.fee + s.fee) AS total_fees,
        ((s.price - b.price) * LEAST(b.qty, s.qty)) - (b.fee + s.fee) AS net_pnl,
        CASE WHEN b.price > 0
          THEN ROUND(((s.price - b.price) / b.price * 100)::numeric, 4)::float
          ELSE 0
        END AS spread_pct,
        b.timestamp AS buy_timestamp, s.timestamp AS sell_timestamp,
        (s.timestamp - b.timestamp) AS hold_duration_ms
      FROM ranked_buys b
      JOIN ranked_sells s ON b.sessionid = s.sessionid AND b.rn = s.rn
    )
    SELECT * FROM pairs ORDER BY sessionid, buy_timestamp
  `, values);

  // Compute summary
  const summary = {};
  for (const row of r.rows) {
    const s = summary[row.sessionid] || (summary[row.sessionid] = { pairs: 0, gross_pnl: 0, net_pnl: 0, total_fees: 0, spread_pcts: [], hold_durations: [] });
    s.pairs++;
    s.gross_pnl += row.gross_pnl;
    s.net_pnl += row.net_pnl;
    s.total_fees += row.total_fees;
    s.spread_pcts.push(row.spread_pct);
    s.hold_durations.push(row.hold_duration_ms);
  }
  for (const [sid, s] of Object.entries(summary)) {
    s.avg_spread_pct = s.spread_pcts.reduce((a, b) => a + b, 0) / s.spread_pcts.length || 0;
    s.avg_hold_duration_ms = s.hold_durations.reduce((a, b) => a + b, 0) / s.hold_durations.length || 0;
    delete s.spread_pcts;
    delete s.hold_durations;
  }

  return jsonOk({ pairs: r.rows, summary }, { count: r.rows.length });
}

async function handleAnalyticsAdverseSelection(params) {
  const session = params.get('session');
  const conditions = [];
  const values = [];
  let idx = 1;
  if (session) { conditions.push(`f.sessionid = $${idx++}`); values.push(session); }
  const { from, to } = parseTimeRange(params);
  idx = addTimeFilter(conditions, values, idx, 'f.timestamp', from, to);
  const where = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

  const r = await db.query(`
    SELECT
      f.id AS fill_id, f.sessionid, f.side,
      f.price::float AS fill_price,
      COALESCE(f.size, f.amount, 0)::float AS fill_qty,
      f.timestamp AS fill_ts,
      (SELECT o.close::float FROM ohlc o WHERE o.timestamp >= f.timestamp + 1000 ORDER BY o.timestamp ASC LIMIT 1) AS price_1s,
      (SELECT o.close::float FROM ohlc o WHERE o.timestamp >= f.timestamp + 5000 ORDER BY o.timestamp ASC LIMIT 1) AS price_5s,
      (SELECT o.close::float FROM ohlc o WHERE o.timestamp >= f.timestamp + 30000 ORDER BY o.timestamp ASC LIMIT 1) AS price_30s,
      (SELECT o.close::float FROM ohlc o WHERE o.timestamp >= f.timestamp + 60000 ORDER BY o.timestamp ASC LIMIT 1) AS price_60s
    FROM fills f
    WHERE 1=1 ${where}
    ORDER BY f.timestamp ASC
  `, values);

  // Compute adverse selection per fill
  const fills = r.rows.map(row => {
    const impact = {};
    for (const horizon of ['1s', '5s', '30s', '60s']) {
      const futurePrice = row[`price_${horizon}`];
      if (futurePrice != null) {
        // Positive = adverse (market moved against our fill)
        impact[`adverse_${horizon}`] = row.side === 'buy'
          ? row.fill_price - futurePrice
          : futurePrice - row.fill_price;
      } else {
        impact[`adverse_${horizon}`] = null;
      }
    }
    return { ...row, ...impact };
  });

  // Summary by side
  const summary = { total_fills: fills.length, by_side: {} };
  for (const side of ['buy', 'sell']) {
    const sideFills = fills.filter(f => f.side === side);
    const s = { count: sideFills.length };
    for (const horizon of ['1s', '5s', '30s', '60s']) {
      const vals = sideFills.map(f => f[`adverse_${horizon}`]).filter(v => v != null);
      s[`avg_adverse_${horizon}`] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    summary.by_side[side] = s;
  }

  return jsonOk({ fills, summary }, { count: fills.length });
}

async function handleAnalyticsInventory(params) {
  const session = params.get('session');
  const conditions = [];
  const values = [];
  let idx = 1;
  if (session) { conditions.push(`sessionid = $${idx++}`); values.push(session); }
  const { from, to } = parseTimeRange(params);
  idx = addTimeFilter(conditions, values, idx, 'timestamp', from, to);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const r = await db.query(`
    SELECT
      id AS fill_id, sessionid, timestamp, side,
      COALESCE(size, amount, 0)::float AS qty,
      price::float,
      SUM(
        CASE WHEN side = 'buy' THEN COALESCE(size, amount, 0)::numeric
             WHEN side = 'sell' THEN -COALESCE(size, amount, 0)::numeric
             ELSE 0 END
      ) OVER (PARTITION BY sessionid ORDER BY timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::float AS net_position,
      SUM(
        CASE WHEN side = 'buy' THEN COALESCE(size, amount, 0)::numeric * price::numeric
             WHEN side = 'sell' THEN -(COALESCE(size, amount, 0)::numeric * price::numeric)
             ELSE 0 END
      ) OVER (PARTITION BY sessionid ORDER BY timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::float AS net_cost
    FROM fills
    ${where}
    ORDER BY sessionid, timestamp ASC
  `, values);

  // Compute summary per session
  const bySession = {};
  for (const row of r.rows) {
    const s = bySession[row.sessionid] || (bySession[row.sessionid] = { max_long: 0, max_short: 0, max_exposure: 0, final_position: 0, total_fills: 0 });
    s.total_fills++;
    s.final_position = row.net_position;
    if (row.net_position > s.max_long) s.max_long = row.net_position;
    if (row.net_position < s.max_short) s.max_short = row.net_position;
    if (Math.abs(row.net_position) > s.max_exposure) s.max_exposure = Math.abs(row.net_position);
  }

  return jsonOk({ series: r.rows, summary: bySession }, { count: r.rows.length });
}

async function handleAnalyticsParameters(params) {
  const symbol = params.get('symbol');
  const { from, to } = parseTimeRange(params);
  const conditions = [];
  const values = [];
  let idx = 1;
  if (symbol) { conditions.push(`s.symbol = $${idx++}`); values.push(symbol); }
  idx = addTimeFilter(conditions, values, idx, 's.startedat', from, to);
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const r = await db.query(`
    SELECT
      s.id AS session_id, s.sessionid, s.symbol, s.exchange, s.status,
      s.startedat, s.endedat, s.duration,
      s.pricingstrategyconfig, s.settings, s.metrics, s.data AS session_data,
      COALESCE(fs.total_pnl, 0)::float AS realized_pnl,
      COALESCE(fs.buy_volume, 0)::float AS total_buy_volume,
      COALESCE(fs.sell_volume, 0)::float AS total_sell_volume,
      COALESCE(fs.fill_count, 0)::int AS total_fills,
      COALESCE(os.total_orders, 0)::int AS total_orders,
      COALESCE(os.fill_rate, 0)::float AS fill_rate_pct
    FROM sessions s
    LEFT JOIN LATERAL (
      SELECT
        SUM(CASE
          WHEN side = 'sell' THEN COALESCE(size, amount, 0)::numeric * price::numeric
          WHEN side = 'buy'  THEN -(COALESCE(size, amount, 0)::numeric * price::numeric)
          ELSE 0
        END) AS total_pnl,
        SUM(CASE WHEN side = 'buy' THEN COALESCE(size, amount, 0)::numeric ELSE 0 END) AS buy_volume,
        SUM(CASE WHEN side = 'sell' THEN COALESCE(size, amount, 0)::numeric ELSE 0 END) AS sell_volume,
        COUNT(*) AS fill_count
      FROM fills WHERE sessionid = s.sessionid
    ) fs ON true
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS total_orders,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(COUNT(CASE WHEN status IN ('filled', 'FILLED', '2') THEN 1 END)::numeric / COUNT(*) * 100, 2)
          ELSE 0
        END AS fill_rate
      FROM orders WHERE sessionid = s.sessionid
    ) os ON true
    ${where}
    ORDER BY s.startedat DESC NULLS LAST
  `, values);

  return jsonOk(r.rows, { count: r.rows.length });
}

// ---------------------------------------------------------------------------
// Logs — Tail
// ---------------------------------------------------------------------------

function handleLogsTail(params) {
  const lines = Math.min(1000, Math.max(1, parseInt(params.get('lines') || '100', 10)));
  if (!existsSync(LOG_FILE)) {
    return jsonOk({ lines: [], file: LOG_FILE, message: 'Log file not yet created' });
  }
  const content = readFileSync(LOG_FILE, 'utf8');
  const all     = content.split('\n').filter(Boolean);
  const tail    = all.slice(-lines);
  return jsonOk({ lines: tail, total_lines: all.length, returned: tail.length, file: LOG_FILE });
}

// ---------------------------------------------------------------------------
// Logs — Archives (mech-storage)
// ---------------------------------------------------------------------------

async function handleLogsArchiveList(params) {
  if (!MECH_APP_ID || !MECH_API_KEY) return jsonError('Mech storage not configured', 503);
  const limit  = Math.min(100, parseInt(params.get('limit') || '20', 10));
  const offset = parseInt(params.get('offset') || '0', 10);
  const res = await fetch(
    `${STORAGE_URL}/api/apps/${MECH_APP_ID}/storage/objects?limit=${limit}&offset=${offset}`,
    { headers: { 'X-API-Key': MECH_API_KEY } }
  );
  const json = await res.json();
  if (!json.success) return jsonError(json.error?.message || 'Storage error', 502);
  // Filter to truex-mm logs only
  const logs = json.data.filter(o => o.metadata?.source === 'truex-market-maker');
  return jsonOk(logs, { total: logs.length, limit, offset });
}

async function handleLogsArchiveDownload(objectId) {
  if (!MECH_APP_ID || !MECH_API_KEY) return jsonError('Mech storage not configured', 503);
  const res = await fetch(
    `${STORAGE_URL}/api/apps/${MECH_APP_ID}/storage/objects/${objectId}/presigned-download`,
    { method: 'POST', headers: { 'X-API-Key': MECH_API_KEY, 'Content-Type': 'application/json' }, body: '{"ttl":3600}' }
  );
  const json = await res.json();
  if (!json.success) return jsonError(json.error?.message || 'Not found', 404);
  return jsonOk({ download_url: json.data.downloadUrl, filename: json.data.filename, expires_in: json.data.expiresIn });
}

// ---------------------------------------------------------------------------
// Emergency Stop
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared REST client factory
// ---------------------------------------------------------------------------

function makeTrueXClient() {
  return import('../../src/exchanges/truex/TrueXRESTClient.ts').then(({ TrueXRESTClient }) => {
    const restUrl = process.env.TRUEX_REST_URL || 'http://10.20.1.11:9742';
    return new TrueXRESTClient({
      baseURL:   `${restUrl}/api/v1`,
      apiKey:    process.env.TRUEX_PROD_API_KEY,
      apiSecret: process.env.TRUEX_PROD_SECRET_KEY,
      userId:    process.env.TRUEX_CLIENT_ID,
    });
  });
}

function requireAdminToken(req) {
  const token = req.headers.get('x-api-token') || req.headers.get('authorization')?.replace('Bearer ', '');
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return false;
  return true;
}

// Rate limiter for cancel-orphaned-orders — 1 call per RATE_WINDOW_MS per IP.
// Prevents automated abuse if ADMIN_API_TOKEN leaks.
// NOTE: emergency-stop is intentionally NOT rate-limited — it is the kill-switch
// and must always be reachable. Cancelling all orders twice is safe.
const RATE_WINDOW_MS = parseInt(process.env.ADMIN_RATE_WINDOW_MS || '60000', 10);
const _cancelRateLimitMap = new Map(); // ip -> lastAllowedMs

function checkCancelRateLimit(req) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || req.headers.get('cf-connecting-ip')
    || 'unknown';
  const now = Date.now();
  // Evict stale entries to prevent unbounded memory growth
  for (const [k, v] of _cancelRateLimitMap) {
    if (now - v >= RATE_WINDOW_MS) _cancelRateLimitMap.delete(k);
  }
  const last = _cancelRateLimitMap.get(ip) ?? 0;
  if (now - last < RATE_WINDOW_MS) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - last)) / 1000);
    return retryAfter; // seconds to wait
  }
  _cancelRateLimitMap.set(ip, now);
  return 0; // allowed
}

// ---------------------------------------------------------------------------
// Orphaned Orders
// ---------------------------------------------------------------------------

async function getOrphanedOrders(client) {
  const liveOrders = await client.getActiveOrders();

  // external_id is the client-assigned order ID — matches clientorderid in DB.
  // Include partial fills: an order being filled right now must never be treated as orphaned.
  // Canonical values from market-maker-orchestrator.js statusMap: 'new','partial_fill','cancelling','pending_new'
  const tracked = await db.query(`
    SELECT clientorderid FROM orders
    WHERE status IN ('new','pending_new','cancelling','partial_fill')
  `);
  const trackedIds = new Set(tracked.rows.map(r => r.clientorderid).filter(Boolean));

  const orphaned = liveOrders.filter(o => o.external_id && !trackedIds.has(o.external_id));
  return { liveOrders, orphaned };
}

async function handleGetOrphanedOrders(req) {
  if (!requireAdminToken(req)) return jsonError('Unauthorized', 401);

  const client = await makeTrueXClient();
  const { liveOrders, orphaned } = await getOrphanedOrders(client);

  const listed = orphaned.map(o => ({
    exchange_id:     o.id,
    client_order_id: o.external_id,
    side:            o.order_info.side,
    price:           o.order_info.price,
    qty:             o.order_info.qty,
  }));

  return jsonOk({ live_count: liveOrders.length, orphaned_count: orphaned.length, orphaned: listed });
}

async function handleCancelOrphanedOrders(req) {
  if (!requireAdminToken(req)) return jsonError('Unauthorized', 401);
  const wait = checkCancelRateLimit(req);
  if (wait > 0) return jsonError(`Rate limited — retry after ${wait}s`, 429);

  const client = await makeTrueXClient();
  const { orphaned } = await getOrphanedOrders(client);

  if (orphaned.length === 0) {
    return jsonOk({ cancelled: 0, failed: 0, total: 0, message: 'No orphaned orders found' });
  }

  let cancelled = 0;
  let failed = 0;
  const errors = [];

  for (const order of orphaned) {
    try {
      await client.cancelOrder(order.id);  // order.id = exchange order ID
      cancelled++;
    } catch (err) {
      failed++;
      errors.push({ id: order.id, error: err.message });
    }
  }

  console.log(`[cancel-orphaned] cancelled=${cancelled} failed=${failed} total=${orphaned.length}`);
  return jsonOk({ cancelled, failed, total: orphaned.length, errors });
}

// ---------------------------------------------------------------------------

async function handleEmergencyStop(req) {
  if (!requireAdminToken(req)) return jsonError('Unauthorized', 401);
  // No rate limit — kill-switch must always fire immediately

  try {
    const client = await makeTrueXClient();
    await client.cancelAllOrders();
  } catch (err) {
    console.error(`[emergency-stop] Kill-switch error: ${err.message}`);
  }

  // Respond before killing process
  const response = new Response(
    JSON.stringify({ success: true, data: { message: 'Emergency stop initiated — orders cancelled, process shutting down' } }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
  );

  setTimeout(() => process.kill(process.pid, 'SIGTERM'), 200);
  return response;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const params = url.searchParams;

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // POST endpoints
    if (req.method === 'POST') {
      if (path === '/api/v1/emergency-stop')          return await handleEmergencyStop(req);
      if (path === '/api/v1/cancel-orphaned-orders')  return await handleCancelOrphanedOrders(req);
      return jsonError('Method not allowed', 405);
    }

    if (req.method !== 'GET') {
      return jsonError('Method not allowed', 405);
    }

    try {
      // System
      if (path === '/api/v1/health') return await handleHealth();
      if (path === '/api/v1/stats')  return await handleStats();

      let m;

      // Logs (admin-only — contain operational/internal data)
      if (path === '/api/v1/logs/tail' || path === '/api/v1/logs/archives' || path.startsWith('/api/v1/logs/')) {
        if (!requireAdminToken(req)) return jsonError('Unauthorized', 401);
      }
      if (path === '/api/v1/logs/tail')     return handleLogsTail(params);
      if (path === '/api/v1/logs/archives') return await handleLogsArchiveList(params);
      if ((m = matchRoute(path, '/api/v1/logs/archives/:id'))) return await handleLogsArchiveDownload(m.id);

      // Analytics
      if (path === '/api/v1/analytics/pnl')              return await handleAnalyticsPnl(params);
      if (path === '/api/v1/analytics/fill-rate')         return await handleAnalyticsFillRate(params);
      if (path === '/api/v1/analytics/spread-capture')    return await handleAnalyticsSpreadCapture(params);
      if (path === '/api/v1/analytics/adverse-selection') return await handleAnalyticsAdverseSelection(params);
      if (path === '/api/v1/analytics/inventory')         return await handleAnalyticsInventory(params);
      if (path === '/api/v1/analytics/parameters')        return await handleAnalyticsParameters(params);

      // Parameterized routes (order matters — more specific first)
      if ((m = matchRoute(path, '/api/v1/sessions/:id/orders'))) return await handleGetSessionOrders(m.id, params);
      if ((m = matchRoute(path, '/api/v1/sessions/:id/fills')))  return await handleGetSessionFills(m.id, params);
      if ((m = matchRoute(path, '/api/v1/sessions/:id')))        return await handleGetSession(m.id);

      // Operations
      if (path === '/api/v1/orphaned-orders') return await handleGetOrphanedOrders(req);

      // Collections
      if (path === '/api/v1/sessions') return await handleGetSessions(params);
      if (path === '/api/v1/orders')   return await handleGetOrders(params);
      if (path === '/api/v1/fills')    return await handleGetFills(params);

      return jsonError('Not found', 404);
    } catch (err) {
      console.error('[API Error]', path, err);
      return jsonError('Internal server error', 500);
    }
  },
});

console.log(`Analytics API listening on http://localhost:${PORT}`);
console.log('Endpoints: /api/v1/health, /sessions, /orders, /fills, /analytics/*');
