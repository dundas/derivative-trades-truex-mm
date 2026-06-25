/**
 * Tests for GET /api/v1/analytics/spread-pnl
 *
 * Covers the pure per-session aggregation (computeSpreadPnlSummary) and the handler's
 * query construction (session filter + epoch-0 / NaN time-filter handling) via a mock db.
 */
import { describe, it, expect, jest } from 'bun:test';
import { computeSpreadPnlSummary, handleAnalyticsSpreadPnl } from './analytics-spread-pnl.js';

const params = (obj = {}) => new URLSearchParams(obj);
const makeDb = (rows = []) => ({ query: jest.fn(async () => ({ rows })) });

describe('computeSpreadPnlSummary', () => {
  it('matches even buy/sell within a session and captures the spread', () => {
    const r = computeSpreadPnlSummary([
      { sessionid: 'a', buy_qty: 1, sell_qty: 1, buy_notional: 100, sell_notional: 110, buy_fees: 0, sell_fees: 0 },
    ]);
    expect(r.matchedVolume).toBe(1);
    expect(r.spreadPnl).toBeCloseTo(10, 9);
    expect(r.avgBuyPrice).toBeCloseTo(100, 9);
    expect(r.avgSellPrice).toBeCloseTo(110, 9);
    expect(r.tradingCashFlow).toBeCloseTo(10, 9);
  });

  it('matches only min(buy, sell) when fill sizes are uneven (no residual leakage)', () => {
    const r = computeSpreadPnlSummary([
      { sessionid: 'a', buy_qty: 2, sell_qty: 1, buy_notional: 200, sell_notional: 110, buy_fees: 0, sell_fees: 0 },
    ]);
    expect(r.matchedVolume).toBe(1);              // min(2, 1)
    expect(r.spreadPnl).toBeCloseTo(10, 9);       // 1 * (110 - 100)
    expect(r.tradingCashFlow).toBeCloseTo(-90, 9); // 110 - 200
  });

  it('prorates each side\'s fees by that side\'s own matched fraction', () => {
    const r = computeSpreadPnlSummary([
      { sessionid: 'a', buy_qty: 2, sell_qty: 1, buy_notional: 200, sell_notional: 110, buy_fees: 4, sell_fees: 1 },
    ]);
    // matched=1 → buy fees 4*(1/2)=2, sell fees 1*(1/1)=1 → spread 10 - 2 - 1 = 7
    expect(r.spreadPnl).toBeCloseTo(7, 9);
  });

  it('never matches a buy in one session against a sell in another', () => {
    const r = computeSpreadPnlSummary([
      { sessionid: 'a', buy_qty: 1, sell_qty: 0, buy_notional: 100, sell_notional: 0, buy_fees: 0, sell_fees: 0 },
      { sessionid: 'b', buy_qty: 0, sell_qty: 1, buy_notional: 0, sell_notional: 110, buy_fees: 0, sell_fees: 0 },
    ]);
    expect(r.matchedVolume).toBe(0);
    expect(r.spreadPnl).toBe(0);
    expect(r.tradingCashFlow).toBeCloseTo(10, 9); // 110 - 100, still counted
  });

  it('skips the NULL-sessionid group for matching but still counts its cash flow', () => {
    const r = computeSpreadPnlSummary([
      { sessionid: null, buy_qty: 1, sell_qty: 1, buy_notional: 100, sell_notional: 110, buy_fees: 0, sell_fees: 0 },
    ]);
    expect(r.matchedVolume).toBe(0);     // null session is non-matchable
    expect(r.spreadPnl).toBe(0);
    expect(r.tradingCashFlow).toBeCloseTo(10, 9);
  });

  it('composes a NULL-session row and a real session: only the real one matches, both feed cash flow', () => {
    const r = computeSpreadPnlSummary([
      { sessionid: null, buy_qty: 1, sell_qty: 1, buy_notional: 50, sell_notional: 70, buy_fees: 0, sell_fees: 0 },
      { sessionid: 'a',  buy_qty: 1, sell_qty: 1, buy_notional: 100, sell_notional: 110, buy_fees: 0, sell_fees: 0 },
    ]);
    expect(r.matchedVolume).toBe(1);                 // only session 'a' matches
    expect(r.spreadPnl).toBeCloseTo(10, 9);          // 1 * (110 - 100); null row excluded from matching
    expect(r.avgBuyPrice).toBeCloseTo(100, 9);       // from session 'a' only
    expect(r.avgSellPrice).toBeCloseTo(110, 9);
    expect(r.tradingCashFlow).toBeCloseTo(30, 9);    // (70-50) + (110-100), both rows counted
  });

  it('reports zero for a one-sided session', () => {
    const r = computeSpreadPnlSummary([
      { sessionid: 'a', buy_qty: 0, sell_qty: 3, buy_notional: 0, sell_notional: 330, buy_fees: 0, sell_fees: 0 },
    ]);
    expect(r.matchedVolume).toBe(0);
    expect(r.spreadPnl).toBe(0);
    expect(r.avgBuyPrice).toBe(0);
    expect(r.avgSellPrice).toBe(0);
    expect(r.tradingCashFlow).toBeCloseTo(330, 9);
  });

  it('sums matched volume and reports matched-weighted average prices across sessions', () => {
    const r = computeSpreadPnlSummary([
      { sessionid: 'a', buy_qty: 1, sell_qty: 1, buy_notional: 100, sell_notional: 110, buy_fees: 0, sell_fees: 0 },
      { sessionid: 'b', buy_qty: 1, sell_qty: 1, buy_notional: 200, sell_notional: 230, buy_fees: 0, sell_fees: 0 },
    ]);
    expect(r.matchedVolume).toBe(2);
    expect(r.spreadPnl).toBeCloseTo(40, 9);       // 10 + 30
    expect(r.avgBuyPrice).toBeCloseTo(150, 9);    // (100 + 200) / 2
    expect(r.avgSellPrice).toBeCloseTo(170, 9);   // (110 + 230) / 2
  });

  it('returns zeros for no rows', () => {
    const r = computeSpreadPnlSummary([]);
    expect(r).toEqual({ spreadPnl: 0, matchedVolume: 0, avgBuyPrice: 0, avgSellPrice: 0, tradingCashFlow: 0 });
  });
});

describe('handleAnalyticsSpreadPnl (query construction)', () => {
  it('groups by sessionid and applies no filter when no params', async () => {
    const db = makeDb([]);
    await handleAnalyticsSpreadPnl(params(), db);
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('GROUP BY sessionid');
    expect(sql).toContain('COALESCE(feeamount, 0)');
    expect(sql).not.toContain('COALESCE(feeamount, fee'); // fee fallback removed (USD only)
    expect(values).toEqual([]);
  });

  it('passes the session filter through', async () => {
    const db = makeDb([]);
    await handleAnalyticsSpreadPnl(params({ session: 'prod-1' }), db);
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('sessionid = $1');
    expect(values).toEqual(['prod-1']);
  });

  it('honors an explicit epoch-0 lower bound', async () => {
    const db = makeDb([]);
    await handleAnalyticsSpreadPnl(params({ from: '0' }), db);
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('timestamp >= $1');
    expect(values).toEqual([0]);
  });

  it('applies the to bound, including epoch-0', async () => {
    const db = makeDb([]);
    await handleAnalyticsSpreadPnl(params({ to: '0' }), db);
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('timestamp <= $1');
    expect(values).toEqual([0]);
  });

  it('applies both from and to bounds together', async () => {
    const db = makeDb([]);
    await handleAnalyticsSpreadPnl(params({ from: '1000', to: '2000' }), db);
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('timestamp >= $1');
    expect(sql).toContain('timestamp <= $2');
    expect(values).toEqual([1000, 2000]);
  });

  it('drops a malformed (NaN) time bound instead of sending it to SQL', async () => {
    const db = makeDb([]);
    await handleAnalyticsSpreadPnl(params({ from: 'abc' }), db);
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).not.toContain('timestamp >=');
    expect(values).toEqual([]);
  });

  it('drops partially-numeric time bounds (123abc, 1e3, 0x10) rather than coercing them', async () => {
    for (const bad of ['123abc', '1e3', '0x10', ' 12 3']) {
      const db = makeDb([]);
      await handleAnalyticsSpreadPnl(params({ from: bad }), db);
      const [sql, values] = db.query.mock.calls[0];
      expect(sql).not.toContain('timestamp >=');
      expect(values).toEqual([]);
    }
  });

  it('returns the computed summary from the db rows', async () => {
    const db = makeDb([
      { sessionid: 'a', buy_qty: 1, sell_qty: 1, buy_notional: 100, sell_notional: 110, buy_fees: 0, sell_fees: 0 },
    ]);
    const out = await handleAnalyticsSpreadPnl(params(), db);
    expect(out.spreadPnl).toBeCloseTo(10, 9);
    expect(out.matchedVolume).toBe(1);
  });
});
