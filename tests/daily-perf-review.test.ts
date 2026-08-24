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
  fetchReportData,
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

  test('reports observed performance decomposition without treating absent evidence as zero', () => {
    const r = buildReport({
      ...input,
      quoteLifecycleEvents: [
        { eventType: 'create', timestamp: String(dayStart + 100), quoteId: 'buy-1', side: 'buy' },
        { eventType: 'replace', timestamp: String(dayStart + 200), quoteId: 'sell-1', side: 'sell' },
        { eventType: 'reject', timestamp: String(dayStart + 300), quoteId: 'sell-1', side: 'sell', reason: 'insufficient funds' },
      ],
    });
    expect(r.performance.realizedSpread).toEqual({ evidence: 'unavailable', reason: 'no quote-linked FIFO lot attribution' });
    expect(r.performance.sameDayOpposingFillProxy).toMatchObject({ evidence: 'observed', matchedQty: 1, pnl: 2 });
    expect(r.performance.rejects).toMatchObject({ evidence: 'observed', attempts: 2, rejects: 1, rate: 0.5 });
    expect(r.performance.uptime).toEqual({ evidence: 'unavailable', reason: 'no acknowledged two-sided presence observations' });
    expect(r.performance.inventory).toMatchObject({ evidence: 'observed', start: 1, end: 1, min: 0, max: 1, samples: 2 });
    expect(r.performance.pnl).toMatchObject({ evidence: 'observed', realizedGross: 10, fees: 0.5, netRealizedAfterFees: 9.5 });
    expect(r.performance.pnl.hedgeSlippage).toEqual({ evidence: 'unavailable', reason: 'no linked hedge executions' });
    expect(r.performance.counterfactual).toEqual({ evidence: 'unavailable', reason: 'no counterfactual performance is inferred from observed fills' });
  });

  test('does not imply zero realized spread or reject rate when their source observations are absent', () => {
    const r = buildReport({ ...input, fillRows: [], quoteLifecycleEvents: [] });
    expect(r.performance.realizedSpread).toEqual({ evidence: 'unavailable', reason: 'no quote-linked FIFO lot attribution' });
    expect(r.performance.sameDayOpposingFillProxy).toEqual({ evidence: 'unavailable', reason: 'no matched opposing fill volume' });
    expect(r.performance.rejects).toEqual({ evidence: 'unavailable', reason: 'no quote lifecycle attempt observations' });
    expect(r.performance.inventory).toEqual({ evidence: 'unavailable', reason: 'no in-day fills for inventory distribution' });
  });

  test('reports acknowledged two-sided uptime only from complete sampled evidence', () => {
    const presence = (timestamp: number, twoSided = true) => ({
      eventType: 'maker_presence', timestamp: String(timestamp),
      context: { makerPresence: { twoSided, sampleIntervalMs: 300_000 } },
    });
    const samples = [presence(dayStart - 1), ...Array.from({ length: 288 }, (_, index) =>
      presence(dayStart + index * 300_000))];
    const r = buildReport({ ...input, quoteLifecycleEvents: samples });
    expect(r.performance.uptime).toMatchObject({
      evidence: 'observed', twoSidedUptimePct: 100, maxOneSidedGapMs: 0,
    });
  });

  test('fails closed when an acknowledged-presence sample gap prevents uptime proof', () => {
    const presence = (timestamp: number) => ({
      eventType: 'maker_presence', timestamp: String(timestamp),
      context: { makerPresence: { twoSided: true, sampleIntervalMs: 30_000 } },
    });
    const r = buildReport({ ...input, quoteLifecycleEvents: [presence(dayStart - 1), presence(dayStart + 30_000)] });
    expect(r.performance.uptime).toEqual({
      evidence: 'unavailable', reason: 'acknowledged presence sample missing before day end',
    });
  });
});

describe('performance evidence attribution', () => {
  const date = '2026-08-05';
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  test('does not call a prior-day inventory close realized spread or a same-day proxy', () => {
    const r = buildReport({
      date, sessions: [], orderTimestamps: [], orderCountByStatus: [],
      fillRows: [
        { timestamp: String(dayStart - 1), side: 'buy', qty: '1', price: '100', fee: '0' },
        { timestamp: String(dayStart + 1000), side: 'sell', qty: '1', price: '110', fee: '0' },
      ], markoutWindowMin: 5, maxDailyLoss: 50, maxAdverseBps: 10,
    });
    expect(r.pnl.dayRealized).toBeCloseTo(10, 9);
    expect(r.performance.realizedSpread).toEqual({ evidence: 'unavailable', reason: 'no quote-linked FIFO lot attribution' });
    expect(r.performance.sameDayOpposingFillProxy).toEqual({ evidence: 'unavailable', reason: 'no matched opposing fill volume' });
  });

  test('keeps observed reject count and reasons when attempts are outside the day', () => {
    const r = buildReport({
      date, sessions: [], orderTimestamps: [], orderCountByStatus: [], fillRows: [],
      quoteLifecycleAvailable: true,
      quoteLifecycleEvents: [{ eventType: 'reject', timestamp: String(dayStart + 1), quoteId: 'previous-day-quote', reason: 'late venue reject' }],
      markoutWindowMin: 5, maxDailyLoss: 50, maxAdverseBps: 10,
    });
    expect(r.performance.rejects).toEqual({ evidence: 'observed', attempts: null, rejects: 1, rate: null, byReason: { 'late venue reject': 1 }, rateUnavailableReason: 'one or more observed rejects lack a distinct matching in-day create/replace attempt' });
  });

  test('only reports a rate when every reject maps one-to-one to an in-day quote attempt', () => {
    const r = buildReport({
      date, sessions: [], orderTimestamps: [], orderCountByStatus: [], fillRows: [], quoteLifecycleAvailable: true,
      quoteLifecycleEvents: [
        { eventType: 'create', timestamp: String(dayStart + 10), quoteId: 'current-create', reason: null },
        // A duplicate lifecycle create represents the same quote attempt, not a second denominator unit.
        { eventType: 'create', timestamp: String(dayStart + 11), quoteId: 'current-create', reason: null },
        // The replacement's new quote identity is a separate in-day attempt.
        { eventType: 'replace', timestamp: String(dayStart + 12), quoteId: 'current-replacement', reason: null },
        { eventType: 'reject', timestamp: String(dayStart + 13), quoteId: 'current-replacement', reason: 'post-only' },
        // This observed reject is for a prior-day quote, so its rate attribution is unsafe.
        { eventType: 'reject', timestamp: String(dayStart + 14), quoteId: 'previous-day-quote', reason: 'late venue reject' },
      ],
      markoutWindowMin: 5, maxDailyLoss: 50, maxAdverseBps: 10,
    });
    expect(r.performance.rejects).toEqual({
      evidence: 'observed', attempts: 2, rejects: 2, rate: null,
      byReason: { 'post-only': 1, 'late venue reject': 1 },
      rateUnavailableReason: 'one or more observed rejects lack a distinct matching in-day create/replace attempt',
    });
  });

  test('does not treat duplicate rejects for one quote as distinct attributed attempts', () => {
    const r = buildReport({
      date, sessions: [], orderTimestamps: [], orderCountByStatus: [], fillRows: [], quoteLifecycleAvailable: true,
      quoteLifecycleEvents: [
        { eventType: 'create', timestamp: String(dayStart + 10), quoteId: 'one' },
        { eventType: 'reject', timestamp: String(dayStart + 11), quoteId: 'one', reason: 'venue' },
        { eventType: 'reject', timestamp: String(dayStart + 12), quoteId: 'one', reason: 'duplicate venue report' },
      ],
      markoutWindowMin: 5, maxDailyLoss: 50, maxAdverseBps: 10,
    });
    expect(r.performance.rejects).toMatchObject({ evidence: 'observed', attempts: 1, rejects: 2, rate: null });
  });
});

describe('fetchReportData query boundaries', () => {
  const dayStart = Date.parse('2026-08-05T00:00:00Z');
  const dayEnd = dayStart + 86400000;

  test('uses SELECT-only, symbol/mode-scoped sources and labels absent lifecycle telemetry unavailable', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    let ended = false;
    const rows = [[], [], [], [], [{ relation: null }]];
    const data = await fetchReportData('postgres://ignored', dayStart, dayEnd, 'BTC-PYUSD', 'live', 60000, 123,
      () => ({
        connect: async () => ({
          query: async (text, params = []) => { calls.push({ text, params }); return { rows: rows.shift() ?? [] }; },
          release: () => {},
        }),
        end: async () => { ended = true; },
      })
    );
    expect(data.quoteLifecycleAvailable).toBe(false);
    expect(data.quoteLifecycleEvents).toEqual([]);
    expect(ended).toBe(true);
    expect(calls).toHaveLength(5);
    expect(calls.every(({ text }) => /^\s*select\b/i.test(text))).toBe(true);
    expect(calls[0].text).toContain('and symbol = $3');
    expect(calls[0].text).toContain('tradingmode = $4');
    expect(calls[3].text).toContain('sessionid in');
    expect(calls[3].params).toEqual([dayEnd + 60000, 'BTC-PYUSD', 'live', 123]);
  });

  test('queries lifecycle telemetry only when its source is available and scopes it by symbol/mode', async () => {
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const rows = [[], [], [], [], [{ relation: 'quote_lifecycle_events' }], [{ eventType: 'reject', timestamp: String(dayStart + 1), side: 'sell', reason: 'venue' }]];
    const data = await fetchReportData('postgres://ignored', dayStart, dayEnd, 'BTC-PYUSD', 'observe', 0, 0,
      () => ({
        connect: async () => ({
          query: async (text, params = []) => { calls.push({ text, params }); return { rows: rows.shift() ?? [] }; },
          release: () => {},
        }),
        end: async () => {},
      })
    );
    expect(data.quoteLifecycleAvailable).toBe(true);
    expect(data.quoteLifecycleEvents).toHaveLength(1);
    const lifecycle = calls.at(-1)!;
    expect(lifecycle.text).toContain('from quote_lifecycle_events');
    expect(lifecycle.text).toContain('symbol = $3');
    expect(lifecycle.text).toContain('tradingmode = $4');
    expect(lifecycle.params).toEqual([dayStart - 600_000, dayEnd, 'BTC-PYUSD', 'observe']);
  });

  test('aborting an in-flight report query destroys its client and waits for pool cleanup', async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let startQuery!: () => void;
    let rejectQuery!: (reason: Error) => void;
    const queryStarted = new Promise<void>(resolve => { startQuery = resolve; });
    const result = fetchReportData('postgres://ignored', dayStart, dayEnd, 'BTC-PYUSD', undefined, 0, 0,
      () => ({
        connect: async () => ({
          query: async () => {
            startQuery();
            return await new Promise<{ rows: unknown[] }>((_, reject) => { rejectQuery = reject; });
          },
          release: (error?: Error) => {
            events.push('release');
            if (error) rejectQuery(error);
          },
        }),
        end: async () => { events.push('end'); },
      }),
      { signal: controller.signal, timeoutMs: 10 },
    );

    await queryStarted;
    controller.abort(new Error('database read for 2026-08-05 timed out after 10ms'));
    await expect(result).rejects.toThrow('database read for 2026-08-05 timed out after 10ms');
    expect(events).toEqual(['release', 'end']);
  });

  test('aborts pending connection acquisition promptly despite a stuck pool shutdown, then destroys a late client once', async () => {
    const controller = new AbortController();
    const reason = new Error('database read for 2026-08-05 timed out after 10ms');
    let resolveConnect!: (client: { query: () => Promise<{ rows: unknown[] }>; release: (error?: Error) => void }) => void;
    const releases: Error[] = [];
    let endCalls = 0;
    let observeEndStart!: () => void;
    const endStarted = new Promise<void>(resolve => { observeEndStart = resolve; });
    const lateClient = {
      query: async () => ({ rows: [] }),
      release: (error?: Error) => { if (error) releases.push(error); },
    };
    const result = fetchReportData('postgres://ignored', dayStart, dayEnd, 'BTC-PYUSD', undefined, 0, 0,
      () => ({
        connect: () => new Promise(resolve => { resolveConnect = resolve; }),
        end: () => {
          endCalls += 1;
          observeEndStart();
          return new Promise<void>(() => {});
        },
      }),
      { signal: controller.signal, timeoutMs: 10 },
    );

    controller.abort(reason);
    await endStarted;
    // The next event-loop turn deterministically proves result was not held
    // behind the intentionally never-settling pool.end() promise.
    let outcome = 'pending';
    void result.then(() => { outcome = 'resolved'; }, () => { outcome = 'rejected'; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(outcome).toBe('rejected');
    expect(endCalls).toBe(1);
    expect(releases).toEqual([]);

    resolveConnect(lateClient);
    await Promise.resolve();
    expect(releases).toEqual([reason]);
    expect(endCalls).toBe(1);
  });

  test('caps database connection acquisition by the report deadline', async () => {
    let connectionTimeoutMs: number | undefined;
    await fetchReportData('postgres://ignored', dayStart, dayEnd, 'BTC-PYUSD', undefined, 0, 0,
      (options) => {
        connectionTimeoutMs = options.connectionTimeoutMs;
        return {
          connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
          end: async () => {},
        };
      },
      { timeoutMs: 1 },
    );
    expect(connectionTimeoutMs).toBe(1);
  });

  test('destroys a checked-out client when a query fails', async () => {
    const queryError = new Error('socket closed');
    const releaseErrors: Error[] = [];
    await expect(fetchReportData('postgres://ignored', dayStart, dayEnd, 'BTC-PYUSD', undefined, 0, 0,
      () => ({
        connect: async () => ({
          query: async () => { throw queryError; },
          release: (error?: Error) => { if (error) releaseErrors.push(error); },
        }),
        end: async () => {},
      })
    )).rejects.toThrow('socket closed');
    expect(releaseErrors).toEqual([queryError]);
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

describe('buildReport session staleness labeling (smoke finding)', () => {
  const dayStart = Date.parse('2026-08-05T00:00:00Z');
  const base = {
    date: '2026-08-05',
    orderTimestamps: [],
    orderCountByStatus: [],
    fillRows: [],
    markoutWindowMin: 5,
    maxDailyLoss: 50,
    maxAdverseBps: 10,
  };
  test('running session with old last activity is stale', () => {
    const r = buildReport({
      ...base,
      sessions: [{ sessionid: 'old-1', status: 'running', st: String(dayStart - 90 * 86400000), en: null, lu: String(dayStart - 80 * 86400000) }],
    });
    expect(r.sessions[0].stale).toBe(true);
  });
  test('running session with recent activity is not stale', () => {
    const r = buildReport({
      ...base,
      sessions: [{ sessionid: 'live-1', status: 'running', st: String(dayStart - 86400000), en: null, lu: String(dayStart + 3600000) }],
    });
    expect(r.sessions[0].stale).toBe(false);
  });
  test('stopped session is never stale', () => {
    const r = buildReport({
      ...base,
      sessions: [{ sessionid: 'done-1', status: 'stopped', st: String(dayStart - 86400000), en: String(dayStart + 1000), lu: String(dayStart - 80 * 86400000) }],
    });
    expect(r.sessions[0].stale).toBe(false);
  });
});

describe('read-only guarantee (AC4)', () => {
  test('script source contains no write SQL', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'scripts', 'daily-perf-review.ts'), 'utf8');
    const writeSql = /(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE)/i;
    expect(src).not.toMatch(writeSql);
  });
});
