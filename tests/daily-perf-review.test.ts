import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeFifo,
  computeMarkouts,
  dailyRealized,
  evaluateVerdict,
  hourlyHistogram,
  buildReport,
  parseNumericFlag,
  parseSeedFlags,
  type Fill,
} from '../scripts/daily-perf-review';

const F = (timestamp: number, side: 'buy' | 'sell', qty: number, price: number): Fill => ({
  timestamp,
  side,
  qty,
  price,
});

describe('computeFifo (AC2)', () => {
  test('simple round trip unseeded', () => {
    const r = computeFifo([F(1, 'buy', 1, 100), F(2, 'sell', 1, 110)]);
    expect(r.realized).toBeCloseTo(10, 9);
    expect(r.position).toBe(0);
  });

  test('seeded inventory sells against seed cost basis', () => {
    const r = computeFifo([F(1, 'sell', 1, 110)], { qty: 2, price: 100 });
    expect(r.realized).toBeCloseTo(10, 9);
    expect(r.position).toBeCloseTo(1, 9);
    expect(r.avgCost).toBeCloseTo(100, 9);
  });

  test('seed changes realized vs unseeded', () => {
    const fills = [F(1, 'sell', 1, 110)];
    const seeded = computeFifo(fills, { qty: 2, price: 100 });
    const unseeded = computeFifo(fills);
    // Unseeded sell opens a short: no realized PnL
    expect(unseeded.realized).toBe(0);
    expect(unseeded.position).toBeCloseTo(-1, 9);
    expect(seeded.realized).toBeCloseTo(10, 9);
  });

  test('partial close keeps avg cost', () => {
    const r = computeFifo([F(1, 'buy', 2, 100), F(2, 'sell', 1, 120)]);
    expect(r.realized).toBeCloseTo(20, 9);
    expect(r.position).toBeCloseTo(1, 9);
    expect(r.avgCost).toBeCloseTo(100, 9);
  });

  test('position flip through zero', () => {
    const r = computeFifo([F(1, 'buy', 1, 100), F(2, 'sell', 3, 120), F(3, 'buy', 2, 110)]);
    // Close 1 @ +20, open short 2 @ 120, close short 2 @ +20
    expect(r.realized).toBeCloseTo(40, 9);
    expect(r.position).toBe(0);
    expect(r.avgCost).toBe(0);
  });

  test('short then cover', () => {
    const r = computeFifo([F(1, 'sell', 1, 100), F(2, 'buy', 1, 90)]);
    expect(r.realized).toBeCloseTo(10, 9);
    expect(r.position).toBe(0);
  });

  test('avg cost weighted on extension', () => {
    const r = computeFifo([F(1, 'buy', 1, 100), F(2, 'buy', 3, 200)]);
    expect(r.avgCost).toBeCloseTo(175, 9);
    expect(r.position).toBeCloseTo(4, 9);
  });

  test('true FIFO: oldest long lot closes first (roborev finding)', () => {
    // buy 1 @ 100, buy 1 @ 200, sell 1 @ 150 → closes the 100 lot: +50
    const r = computeFifo([F(1, 'buy', 1, 100), F(2, 'buy', 1, 200), F(3, 'sell', 1, 150)]);
    expect(r.realized).toBeCloseTo(50, 9);
    expect(r.position).toBeCloseTo(1, 9);
    expect(r.avgCost).toBeCloseTo(200, 9); // remaining lot is the 200 one
  });

  test('true FIFO: oldest short lot closes first', () => {
    // sell 1 @ 200, sell 1 @ 100, buy 1 @ 150 → closes the 200 short: +50
    const r = computeFifo([F(1, 'sell', 1, 200), F(2, 'sell', 1, 100), F(3, 'buy', 1, 150)]);
    expect(r.realized).toBeCloseTo(50, 9);
    expect(r.position).toBeCloseTo(-1, 9);
    expect(r.avgCost).toBeCloseTo(100, 9);
  });

  test('cumAfter aligned with fills', () => {
    const r = computeFifo([F(1, 'buy', 1, 100), F(2, 'sell', 1, 110), F(3, 'buy', 1, 105)]);
    expect(r.cumAfter).toHaveLength(3);
    expect(r.cumAfter[0]).toBe(0);
    expect(r.cumAfter[1]).toBeCloseTo(10, 9);
    expect(r.cumAfter[2]).toBeCloseTo(10, 9);
  });
});

describe('dailyRealized (AC2)', () => {
  const dayStart = Date.parse('2026-08-05T00:00:00Z');
  const dayEnd = dayStart + 86400000;

  test('attributes only same-day closes', () => {
    const fills = [
      F(dayStart - 3600000, 'buy', 1, 100), // previous day
      F(dayStart + 1000, 'sell', 1, 110), // +10 today
      F(dayStart + 2000, 'buy', 1, 108),
      F(dayEnd + 1000, 'sell', 1, 200), // next day, excluded
    ];
    const fifo = computeFifo(fills);
    expect(dailyRealized(fills, fifo.cumAfter, dayStart, dayEnd)).toBeCloseTo(10, 9);
  });

  test('zero when no fills that day', () => {
    const fills = [F(dayStart - 7200000, 'buy', 1, 100), F(dayStart - 3600000, 'sell', 1, 110)];
    const fifo = computeFifo(fills);
    expect(dailyRealized(fills, fifo.cumAfter, dayStart, dayEnd)).toBe(0);
  });

  test('zero when no fills at all', () => {
    expect(dailyRealized([], [], dayStart, dayEnd)).toBe(0);
  });
});

describe('computeMarkouts (AC3)', () => {
  test('adverse buy mark-out in bps', () => {
    const marks = computeMarkouts([F(0, 'buy', 1, 100), F(60000, 'sell', 1, 99)], 300000);
    expect(marks).toHaveLength(1);
    expect(marks[0].side).toBe('buy');
    expect(marks[0].bps).toBeCloseTo(100, 9); // fell 1% after our buy
  });

  test('adverse sell mark-out in bps', () => {
    const marks = computeMarkouts([F(0, 'sell', 1, 100), F(60000, 'buy', 1, 101)], 300000);
    expect(marks).toHaveLength(1);
    expect(marks[0].bps).toBeCloseTo(100, 9); // rose 1% after our sell
  });

  test('favorable fill yields negative bps', () => {
    const marks = computeMarkouts([F(0, 'buy', 1, 100), F(60000, 'sell', 1, 102)], 300000);
    expect(marks[0].bps).toBeCloseTo(-200, 9);
  });

  test('opposite fill outside window produces no mark', () => {
    const marks = computeMarkouts([F(0, 'buy', 1, 100), F(300001, 'sell', 1, 99)], 300000);
    expect(marks).toHaveLength(0);
  });

  test('same-side fills are skipped, window measured from origin fill', () => {
    const marks = computeMarkouts(
      [F(0, 'buy', 1, 100), F(10000, 'buy', 1, 101), F(20000, 'sell', 1, 99)],
      300000
    );
    // Both buys mark against the sell; window is from each fill, not chained
    expect(marks).toHaveLength(2);
    expect(marks[0].bps).toBeCloseTo(100, 9);
    expect(marks[1].bps).toBeCloseTo(((101 - 99) / 101) * 1e4, 9);
  });

  test('window bounds are inclusive at exactly windowMs', () => {
    const marks = computeMarkouts([F(0, 'buy', 1, 100), F(300000, 'sell', 1, 99)], 300000);
    expect(marks).toHaveLength(1);
  });
});

describe('hourlyHistogram', () => {
  const dayStart = Date.parse('2026-08-05T00:00:00Z');
  const dayEnd = dayStart + 86400000;

  test('24 buckets with gaps detected', () => {
    const hist = hourlyHistogram([dayStart + 1000, dayStart + 3600000 + 5, dayStart + 3600000 + 6], dayStart, dayEnd);
    expect(hist.size).toBe(24);
    expect(hist.get(dayStart)).toBe(1);
    expect(hist.get(dayStart + 3600000)).toBe(2);
    expect(hist.get(dayStart + 2 * 3600000)).toBe(0);
  });

  test('out-of-range timestamps ignored', () => {
    const hist = hourlyHistogram([dayStart - 1, dayEnd, dayEnd + 999], dayStart, dayEnd);
    expect([...hist.values()].reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe('evaluateVerdict', () => {
  test('OK when within thresholds', () => {
    expect(evaluateVerdict(-10, 5, 50, 10).status).toBe('OK');
  });
  test('WARN on daily loss breach', () => {
    const v = evaluateVerdict(-60, 0, 50, 10);
    expect(v.status).toBe('WARN');
    expect(v.reasons.length).toBe(1);
  });
  test('WARN on adverse bps breach', () => {
    const v = evaluateVerdict(0, 12, 50, 10);
    expect(v.status).toBe('WARN');
  });
  test('null mark-out never breaches bps threshold', () => {
    expect(evaluateVerdict(0, null, 50, 10).status).toBe('OK');
  });
  test('both breaches produce two reasons', () => {
    expect(evaluateVerdict(-60, 12, 50, 10).reasons.length).toBe(2);
  });
});

describe('buildReport end-to-end on fixture data (AC5 shape)', () => {
  const date = '2026-08-05';
  const dayStart = Date.parse(`${date}T00:00:00Z`);

  const input = {
    date,
    sessions: [{ sessionid: 'prod-1', status: 'running', st: String(dayStart - 1000), en: null, lu: String(dayStart + 500000) }],
    orderTimestamps: [dayStart + 1000],
    orderCountByStatus: [{ status: 'pending_new', n: 1 }],
    fillRows: [
      { timestamp: String(dayStart - 86400000), side: 'buy', qty: '1', price: '100', fee: '0' },
      { timestamp: String(dayStart + 1000), side: 'sell', qty: '1', price: '110', fee: '0.5' },
      { timestamp: String(dayStart + 70000), side: 'buy', qty: '1', price: '108', fee: '0' },
    ],
    markoutWindowMin: 5,
    maxDailyLoss: 50,
    maxAdverseBps: 10,
  };

  const r = buildReport(input);

  test('daily realized is seed-consistent (prior-day buy carries in)', () => {
    expect(r.pnl.dayRealized).toBeCloseTo(10, 9);
  });

  test('lifetime includes all fills', () => {
    // +10 from the day's sell; open long 1 @ 108
    expect(r.pnl.lifetimeRealized).toBeCloseTo(10, 9);
    expect(r.pnl.position).toBeCloseTo(1, 9);
  });

  test('fees sum for the day only', () => {
    expect(r.fills.fees).toBeCloseTo(0.5, 9);
  });

  test('round-trip adverse per BTC = vwap(buys) - vwap(sells)', () => {
    expect(r.fills.roundTripAdversePerBtc).toBeCloseTo(108 - 110, 9);
  });

  test('mark-out pair for the sell vs later buy', () => {
    // sell @110 then buy @108 within window → favorable → negative bps
    expect(r.markout.pairs).toBe(1);
    expect(r.markout.avgAdverseBps!).toBeCloseTo(((108 - 110) / 110) * 1e4, 9);
  });

  test('verdict OK and JSON round-trips', () => {
    expect(r.verdict.status).toBe('OK');
    const round = JSON.parse(JSON.stringify(r));
    expect(round.pnl.dayRealized).toBeCloseTo(10, 9);
    expect(round.sessions[0].id).toBe('prod-1');
  });
});

describe('parseNumericFlag (roborev finding: NaN propagation)', () => {
  test('returns default when unset', () => {
    expect(parseNumericFlag({}, 'max-daily-loss', 50)).toBe(50);
  });
  test('parses valid value', () => {
    expect(parseNumericFlag({ 'max-daily-loss': '25.5' }, 'max-daily-loss', 50)).toBe(25.5);
  });
  test('rejects non-numeric input', () => {
    expect(parseNumericFlag({ 'max-daily-loss': 'abc' }, 'max-daily-loss', 50)).toBeNull();
    expect(parseNumericFlag({ 'max-adverse-bps': '' }, 'max-adverse-bps', 10)).toBeNull();
  });
  test('rejects non-positive when positivity required', () => {
    expect(parseNumericFlag({ 'markout-window-min': '0' }, 'markout-window-min', 5, { positive: true })).toBeNull();
    expect(parseNumericFlag({ 'markout-window-min': '-3' }, 'markout-window-min', 5, { positive: true })).toBeNull();
  });
  test('rejects negative thresholds (roborev finding: sign inversion)', () => {
    expect(parseNumericFlag({ 'max-daily-loss': '-1' }, 'max-daily-loss', 50, { nonNegative: true })).toBeNull();
    expect(parseNumericFlag({ 'max-adverse-bps': '-0.5' }, 'max-adverse-bps', 10, { nonNegative: true })).toBeNull();
  });
  test('allows zero when non-negative (zero disables the threshold breach path)', () => {
    expect(parseNumericFlag({ 'max-daily-loss': '0' }, 'max-daily-loss', 50, { nonNegative: true })).toBe(0);
  });
});

describe('buildReport end-of-day mark-out horizon (roborev round 3)', () => {
  const date = '2026-08-05';
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  const dayEnd = dayStart + 86400000;

  const input = {
    date,
    sessions: [],
    orderTimestamps: [],
    orderCountByStatus: [],
    fillRows: [
      { timestamp: String(dayEnd - 60000), side: 'buy', qty: '1', price: '100', fee: '0' },
      { timestamp: String(dayEnd + 120000), side: 'sell', qty: '1', price: '99', fee: '0' },
    ],
    markoutWindowMin: 5,
    maxDailyLoss: 50,
    maxAdverseBps: 200,
  };

  const r = buildReport(input);

  test('post-midnight opposite fill pairs as mark-out target', () => {
    expect(r.markout.pairs).toBe(1);
    expect(r.markout.avgAdverseBps!).toBeCloseTo(100, 9);
  });

  test('post-midnight fill is excluded from PnL and position', () => {
    expect(r.pnl.dayRealized).toBe(0);
    expect(r.pnl.lifetimeRealized).toBe(0);
    expect(r.pnl.position).toBeCloseTo(1, 9);
    expect(r.pnl.positionAvgCost).toBeCloseTo(100, 9);
  });
});

describe('evaluateVerdict zero-threshold semantics (roborev round 3)', () => {
  test('zero thresholds disable the checks, not invert them', () => {
    expect(evaluateVerdict(-60, 25, 0, 0).status).toBe('OK');
    expect(evaluateVerdict(-60, 25, 0, 0).reasons).toHaveLength(0);
  });
});

describe('parseSeedFlags (roborev round 4)', () => {
  test('no flags → no seed, no error', () => {
    expect(parseSeedFlags({})).toEqual({});
  });
  test('flags must be given together', () => {
    expect(parseSeedFlags({ 'seed-btc': '0.044' }).error).toMatch(/together/);
    expect(parseSeedFlags({ 'seed-price': '65000' }).error).toMatch(/together/);
  });
  test('rejects non-numeric', () => {
    expect(parseSeedFlags({ 'seed-btc': 'x', 'seed-price': '65000' }).error).toMatch(/numeric/);
  });
  test('rejects zero or negative seed price or qty', () => {
    expect(parseSeedFlags({ 'seed-btc': '0.044', 'seed-price': '0' }).error).toMatch(/positive/);
    expect(parseSeedFlags({ 'seed-btc': '0.044', 'seed-price': '-1' }).error).toMatch(/positive/);
    expect(parseSeedFlags({ 'seed-btc': '0', 'seed-price': '65000' }).error).toMatch(/positive/);
  });
  test('valid pair returns seed', () => {
    expect(parseSeedFlags({ 'seed-btc': '0.044', 'seed-price': '65000' })).toEqual({
      seed: { qty: 0.044, price: 65000 },
    });
  });
});

describe('buildReport rejects unknown fill sides (roborev round 4)', () => {
  const dayStart = Date.parse('2026-08-05T00:00:00Z');
  test('unknown side throws instead of coercing to sell', () => {
    const input = {
      date: '2026-08-05',
      sessions: [],
      orderTimestamps: [],
      orderCountByStatus: [],
      fillRows: [{ timestamp: String(dayStart + 1000), side: 'HOLD', qty: '1', price: '100', fee: '0' }],
      markoutWindowMin: 5,
      maxDailyLoss: 50,
      maxAdverseBps: 10,
    };
    expect(() => buildReport(input)).toThrow(/unknown fill side/);
  });
  test('uppercase sides are normalized', () => {
    const input = {
      date: '2026-08-05',
      sessions: [],
      orderTimestamps: [],
      orderCountByStatus: [],
      fillRows: [
        { timestamp: String(dayStart + 1000), side: 'BUY', qty: '1', price: '100', fee: '0' },
        { timestamp: String(dayStart + 2000), side: 'SELL', qty: '1', price: '110', fee: '0' },
      ],
      markoutWindowMin: 5,
      maxDailyLoss: 50,
      maxAdverseBps: 10,
    };
    const r = buildReport(input);
    expect(r.fills.buys.n).toBe(1);
    expect(r.fills.sells.n).toBe(1);
    expect(r.pnl.dayRealized).toBeCloseTo(10, 9);
  });
});

describe('buildReport rejects invalid numeric rows (roborev round 5)', () => {
  const dayStart = Date.parse('2026-08-05T00:00:00Z');
  const base = {
    date: '2026-08-05',
    sessions: [],
    orderTimestamps: [],
    orderCountByStatus: [],
    markoutWindowMin: 5,
    maxDailyLoss: 50,
    maxAdverseBps: 10,
  };
  test('non-numeric price throws', () => {
    const input = { ...base, fillRows: [{ timestamp: String(dayStart + 1000), side: 'buy', qty: '1', price: 'abc', fee: '0' }] };
    expect(() => buildReport(input)).toThrow(/invalid fill row/);
  });
  test('null qty throws', () => {
    const input = { ...base, fillRows: [{ timestamp: String(dayStart + 1000), side: 'buy', qty: null as unknown as string, price: '100', fee: '0' }] };
    expect(() => buildReport(input)).toThrow(/invalid fill row/);
  });
  test('null fee is treated as zero', () => {
    const input = { ...base, fillRows: [{ timestamp: String(dayStart + 1000), side: 'buy', qty: '1', price: '100', fee: null }] };
    expect(buildReport(input).fills.fees).toBe(0);
  });
});

describe('read-only guarantee (AC4)', () => {
  test('script source contains no write SQL', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'scripts', 'daily-perf-review.ts'), 'utf8');
    const writeSql = /(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)/i;
    expect(src).not.toMatch(writeSql);
  });
});
