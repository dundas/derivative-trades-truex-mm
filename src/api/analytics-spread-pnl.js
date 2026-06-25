/**
 * Handler for GET /api/v1/analytics/spread-pnl
 *
 * Exported as a pure function that takes (params, db) so it can be tested without
 * importing the full server (which calls Bun.serve() at top level).
 *
 * Returns the dashboard "P&L Summary" object:
 *   - spreadPnl       — spread captured on round-tripped volume, net of fees
 *   - matchedVolume   — base quantity that round-tripped: per session, min(buy qty, sell qty)
 *   - avgBuyPrice     — matched-volume-weighted average buy price (consistent with spreadPnl)
 *   - avgSellPrice    — matched-volume-weighted average sell price
 *   - tradingCashFlow — raw cash flow over all fills (sell proceeds − buy costs)
 *
 * Spread P&L uses a per-session VWAP round-trip model rather than nth-buy↔nth-sell pairing:
 * per session, spreadPnl = matchedVolume × (avgSell − avgBuy) − matched fees, summed across
 * sessions. This is order-independent and stays correct when buy/sell fill sizes differ
 * (one-to-one row pairing silently drops residual quantity and double-counts fees on partial
 * matches). Matching never crosses sessions, so a buy in one session is never matched against
 * a sell in another. Buy and sell fees are prorated separately by each side's own matched
 * fraction. Fees use `feeamount` only — the USD-denominated column — because `fee` may be in
 * the raw fee asset/currency and this metric is reported in dollars.
 */

function parseTimestamp(raw) {
  if (raw === null) return null;
  // Strict: only an entire integer string is accepted. parseInt would silently coerce
  // partially-numeric input ('123abc'→123, '1e3'→1, '0x10'→0), shifting the query window.
  if (!/^-?\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

function parseTimeRangeLocal(params) {
  return { from: parseTimestamp(params.get('from')), to: parseTimestamp(params.get('to')) };
}

function addTimeFilterLocal(conditions, values, idx, col, from, to) {
  if (from !== null) { conditions.push(`${col} >= $${idx++}`); values.push(from); }
  if (to   !== null) { conditions.push(`${col} <= $${idx++}`); values.push(to); }
  return idx;
}

/**
 * Pure aggregation over per-session fill rows. Each row is one session's totals:
 *   { sessionid, buy_qty, sell_qty, buy_notional, sell_notional, buy_fees, sell_fees }
 * Exported separately so the matching/fee/null-session logic is unit-testable without a db.
 */
export function computeSpreadPnlSummary(rows) {
  let spreadPnl = 0, matchedVolume = 0;
  let matchedBuyNotional = 0, matchedSellNotional = 0;
  let totalBuyNotional = 0, totalSellNotional = 0;

  for (const row of rows) {
    const buyQty = row.buy_qty ?? 0;
    const sellQty = row.sell_qty ?? 0;
    const buyNotional = row.buy_notional ?? 0;
    const sellNotional = row.sell_notional ?? 0;

    // tradingCashFlow is raw cash and session-independent, so it counts every fill —
    // including the collapsed NULL-sessionid group.
    totalBuyNotional += buyNotional;
    totalSellNotional += sellNotional;

    // NULL sessionid fills (orphaned/history with no session) all collapse into one GROUP
    // under GROUP BY; they are not a real session, so they are non-matchable — skip matching.
    if (row.sessionid == null) continue;

    const matched = Math.min(buyQty, sellQty);
    if (matched <= 0) continue;

    const avgBuy = buyNotional / buyQty;
    const avgSell = sellNotional / sellQty;

    // Prorate each side's fees by that side's own matched fraction (sides can differ in
    // quantity and fee rate, so they cannot share a single blended pool).
    const matchedBuyFees = (row.buy_fees ?? 0) * (matched / buyQty);
    const matchedSellFees = (row.sell_fees ?? 0) * (matched / sellQty);

    spreadPnl += matched * (avgSell - avgBuy) - matchedBuyFees - matchedSellFees;
    matchedVolume += matched;
    matchedBuyNotional += avgBuy * matched;
    matchedSellNotional += avgSell * matched;
  }

  return {
    spreadPnl,
    matchedVolume,
    // Matched-volume-weighted averages stay consistent with spreadPnl.
    avgBuyPrice: matchedVolume > 0 ? matchedBuyNotional / matchedVolume : 0,
    avgSellPrice: matchedVolume > 0 ? matchedSellNotional / matchedVolume : 0,
    tradingCashFlow: totalSellNotional - totalBuyNotional,
  };
}

/**
 * @param {URLSearchParams} params
 * @param {{ query: (sql: string, values?: any[]) => Promise<{rows: any[]}> }} db
 */
export async function handleAnalyticsSpreadPnl(params, db) {
  const session = params.get('session');
  const { from, to } = parseTimeRangeLocal(params);

  const conditions = [];
  const values = [];
  let idx = 1;
  if (session) { conditions.push(`sessionid = $${idx++}`); values.push(session); }
  idx = addTimeFilterLocal(conditions, values, idx, 'timestamp', from, to);
  const where = conditions.length ? 'AND ' + conditions.join(' AND ') : '';

  // Cast operands to numeric before multiplying/summing (then to float for the response) so
  // financial sums don't accumulate float drift — matches the handleAnalyticsPnl convention.
  const r = await db.query(`
    SELECT
      sessionid,
      COALESCE(SUM(CASE WHEN side = 'buy'  THEN COALESCE(size, amount, 0)::numeric END), 0)::float                 AS buy_qty,
      COALESCE(SUM(CASE WHEN side = 'sell' THEN COALESCE(size, amount, 0)::numeric END), 0)::float                 AS sell_qty,
      COALESCE(SUM(CASE WHEN side = 'buy'  THEN COALESCE(size, amount, 0)::numeric * price::numeric END), 0)::float AS buy_notional,
      COALESCE(SUM(CASE WHEN side = 'sell' THEN COALESCE(size, amount, 0)::numeric * price::numeric END), 0)::float AS sell_notional,
      COALESCE(SUM(CASE WHEN side = 'buy'  THEN COALESCE(feeamount, 0)::numeric END), 0)::float                     AS buy_fees,
      COALESCE(SUM(CASE WHEN side = 'sell' THEN COALESCE(feeamount, 0)::numeric END), 0)::float                     AS sell_fees
    FROM fills WHERE 1=1 ${where}
    GROUP BY sessionid
  `, values);

  return computeSpreadPnlSummary(r.rows);
}
