import { describe, expect, jest, test } from 'bun:test';
import {
  ReferenceMarkoutCollector,
  validateReferenceMarkoutConfig,
} from './reference-markout-collector.js';
import { validateRegimeStrategy } from '../analytics/regime-strategy-validator.js';

const VALID_CONFIG = {
  product: 'BTC-USD',
  quoteCurrency: 'USD',
  sourceExchange: 'coinbase',
  sourceType: 'top-of-book',
  horizonsMs: [60_000, 300_000, 3_600_000],
  maxSourceAgeMs: 5_000,
  maxLatenessMs: 30_000,
  pollIntervalMs: 1_000,
  batchSize: 50,
  claimLeaseMs: 5_000,
  retentionMs: 86_400_000,
  retentionSweepIntervalMs: 3_600_000,
  auditMaxGroups: 100,
  maxAbsBasisAdjustmentBps: 25,
};

function market({ sourceTimestamp = 9_900, receivedTimestamp = 9_950, bid = 99, ask = 101 } = {}) {
  return {
    sources: [{
      exchange: 'coinbase', bid, ask, sourceTimestamp, receivedTimestamp, isStale: false,
    }],
  };
}

function basis({ timestamp = 9_900, price = 1.0001 } = {}) {
  return { timestamp, price };
}

describe('reference mark-out configuration', () => {
  test('normalizes unique sorted horizons and rejects unsafe values', () => {
    expect(validateReferenceMarkoutConfig({ ...VALID_CONFIG, horizonsMs: [300_000, 60_000] }).horizonsMs)
      .toEqual([60_000, 300_000]);
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, horizonsMs: [60_000, 60_000] }))
      .toThrow('horizonsMs');
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, maxLatenessMs: -1 }))
      .toThrow('maxLatenessMs');
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, sourceType: '' }))
      .toThrow('sourceType');
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, claimLeaseMs: 999 }))
      .toThrow('claimLeaseMs');
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, batchSize: 1.5 }))
      .toThrow('batchSize');
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, horizonsMs: [Number.MAX_SAFE_INTEGER + 1] }))
      .toThrow('horizonsMs');
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, product: 'ETH-EUR' }))
      .toThrow('Coinbase BTC-USD');
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, sourceType: 'candle' }))
      .toThrow('Coinbase BTC-USD');
  });
});

describe('ReferenceMarkoutCollector', () => {
  test('persists a no-lookahead quote decision with distinct source and receipt timestamps', async () => {
    const writer = { recordReferenceQuoteDecision: jest.fn(async () => true) };
    const collector = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => 10_000,
      marketProvider: () => market(), basisProvider: () => basis(),
    });

    await collector.recordQuoteDecision({
      eventType: 'create', quoteId: 'Q-1', decisionTimestamp: 10_000,
      sessionId: 'S-1', symbol: 'BTC-PYUSD', side: 'buy', level: 1,
      policyId: 'maker-v1', price: 100, size: 0.01,
    });

    expect(writer.recordReferenceQuoteDecision).toHaveBeenCalledWith(expect.objectContaining({
      quoteId: 'Q-1', product: 'BTC-USD', quoteCurrency: 'USD', sourceType: 'top-of-book',
      sourceTimestamp: 9_900, receivedTimestamp: 9_950, bid: 99, ask: 101,
      basisAdjustmentBps: expect.closeTo(-0.99990001, 8), available: true, unavailableReason: null,
    }));
  });

  test('classifies crossed, stale, and future decision books explicitly', async () => {
    const writer = { recordReferenceQuoteDecision: jest.fn(async () => true) };
    const cases = [
      [market({ bid: 102, ask: 101 }), 'crossed-book'],
      [market({ sourceTimestamp: 1_000, receivedTimestamp: 9_950 }), 'stale-source'],
      [market({ sourceTimestamp: 10_001, receivedTimestamp: 10_001 }), 'lookahead-source'],
    ];
    for (const [book, reason] of cases) {
      const collector = new ReferenceMarkoutCollector({
        writer, config: VALID_CONFIG, now: () => 10_000,
        marketProvider: () => book, basisProvider: () => basis(),
      });
      await collector.recordQuoteDecision({ eventType: 'create', quoteId: `Q-${reason}`, decisionTimestamp: 10_000 });
      expect(writer.recordReferenceQuoteDecision.mock.calls.at(-1)[0]).toMatchObject({
        available: false, unavailableReason: reason,
      });
    }
  });

  test('rejects manufactured or misordered provenance and unusable cross-currency basis', async () => {
    const writer = { recordReferenceQuoteDecision: jest.fn(async () => true) };
    const cases = [
      [market({ sourceTimestamp: null }), basis(), 'invalid-timestamp'],
      [market({ sourceTimestamp: 9_960, receivedTimestamp: 9_950 }), basis(), 'invalid-timestamp-order'],
      [market(), null, 'missing-basis'],
      [market(), basis({ timestamp: 10_001 }), 'lookahead-basis'],
      [market(), basis({ timestamp: 1_000 }), 'stale-basis'],
      [market(), basis({ price: 1.01 }), 'basis-out-of-bounds'],
    ];
    for (const [book, basisValue, reason] of cases) {
      const collector = new ReferenceMarkoutCollector({
        writer, config: VALID_CONFIG, now: () => 10_000,
        marketProvider: () => book, basisProvider: () => basisValue,
      });
      await collector.recordQuoteDecision({ eventType: 'create', quoteId: `Q-${reason}`, decisionTimestamp: 10_000 });
      expect(writer.recordReferenceQuoteDecision.mock.calls.at(-1)[0]).toMatchObject({
        available: false, unavailableReason: reason,
      });
    }
  });

  test('schedules every configured horizon once with recoverable quote attribution', async () => {
    const writer = { scheduleReferenceMarkouts: jest.fn(async () => 3) };
    const collector = new ReferenceMarkoutCollector({ writer, config: VALID_CONFIG, now: () => 20_000 });
    await collector.scheduleFill({
      fillId: 'Q-1-E-1', executionId: 'E-1', quoteId: 'Q-1', sessionId: 'S-1',
      fillTimestamp: 20_000, decisionTimestamp: 10_000, side: 'sell', level: 2,
      policyId: 'maker-v1', price: 101, size: 0.01,
    });
    expect(writer.scheduleReferenceMarkouts).toHaveBeenCalledWith(expect.objectContaining({
      fillId: 'Q-1-E-1', horizonsMs: [60_000, 300_000, 3_600_000],
      dueTimestamps: [80_000, 320_000, 3_620_000],
      deadlineTimestamps: [110_000, 350_000, 3_650_000],
      quoteId: 'Q-1', decisionTimestamp: 10_000, level: 2, policyId: 'maker-v1',
    }));
  });

  test('uses a fresh pre-due tick observed at due and terminalizes missing evidence after cutoff', async () => {
    let now = 80_000;
    let currentMarket = market({ sourceTimestamp: 79_000, receivedTimestamp: 79_500 });
    const work = {
      fillId: 'F-1', horizonMs: 60_000, dueTimestamp: 80_000, deadlineTimestamp: 110_000,
      quoteId: 'Q-1', decisionTimestamp: 10_000, side: 'buy', level: 1,
      policyId: 'maker-v1', price: 100,
    };
    const writer = {
      claimDueReferenceMarkouts: jest.fn(async () => [work]),
      releaseReferenceMarkoutClaim: jest.fn(async () => true),
      completeReferenceMarkout: jest.fn(async () => true),
      pruneReferenceMarkoutEvidence: jest.fn(async () => true),
      pruneReferenceQuoteDecisions: jest.fn(async () => true),
    };
    const collector = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => now,
      marketProvider: () => currentMarket, basisProvider: () => basis({ timestamp: now, price: 1 }),
    });

    await collector.processDue();
    expect(writer.completeReferenceMarkout).toHaveBeenLastCalledWith(
      work, expect.any(String), expect.objectContaining({
        available: true, observationTimestamp: 80_000, sourceTimestamp: 79_000,
      }),
    );
    expect(writer.releaseReferenceMarkoutClaim).not.toHaveBeenCalled();

    currentMarket = market({ sourceTimestamp: 80_001, receivedTimestamp: 80_002 });
    now = 80_002;
    await collector.processDue();
    expect(writer.completeReferenceMarkout).toHaveBeenLastCalledWith(
      work, expect.any(String), expect.objectContaining({ available: true, sourceTimestamp: 80_001 }),
    );
    expect(writer.completeReferenceMarkout.mock.calls.at(-1)[2].observedEdgeBps).toBe(0);

    now = 110_001;
    currentMarket = null;
    await collector.processDue();
    expect(writer.completeReferenceMarkout).toHaveBeenLastCalledWith(
      work, expect.any(String), expect.objectContaining({ available: false, unavailableReason: 'after-deadline' }),
    );
  });

  test('is overlap-safe in process and fails soft without touching execution', async () => {
    let resolveClaim;
    const writer = {
      claimDueReferenceMarkouts: jest.fn(() => new Promise(resolve => { resolveClaim = resolve; })),
      pruneReferenceMarkoutEvidence: jest.fn(async () => true),
    };
    const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
    const collector = new ReferenceMarkoutCollector({ writer, logger, config: VALID_CONFIG, now: () => 100 });
    const first = collector.processDue();
    expect(await collector.processDue()).toEqual({ skipped: 'in-flight' });
    resolveClaim([]);
    await first;

    writer.scheduleReferenceMarkouts = jest.fn(async () => { throw new Error('db unavailable'); });
    expect(await collector.scheduleFill({
      fillId: 'F', fillTimestamp: 100, side: 'buy', price: 100,
    })).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('db unavailable'));
    expect(collector.getStats().persistenceErrors).toBe(1);
  });

  test('uses distinct claim-owner tokens across instances with the same clock and sequence', async () => {
    const tokens = [];
    const writer = {
      claimDueReferenceMarkouts: jest.fn(async ({ claimToken }) => {
        tokens.push(claimToken);
        return [];
      }),
    };
    const first = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => 80_000, claimTokenNamespace: 'instance-a',
    });
    const second = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => 80_000, claimTokenNamespace: 'instance-b',
    });

    await Promise.all([first.processDue(), second.processDue()]);

    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(tokens).toEqual(expect.arrayContaining([
      'markout:instance-a:80000:1', 'markout:instance-b:80000:1',
    ]));
  });

  test('rejects an empty injected claim-token namespace', () => {
    expect(() => new ReferenceMarkoutCollector({
      config: VALID_CONFIG, claimTokenNamespace: '',
    })).toThrow('claimTokenNamespace');
  });

  test('retries missing quote attribution then records it unavailable after the deadline', async () => {
    let now = 80_000;
    const work = { fillId: 'F-1', horizonMs: 60_000, dueTimestamp: 80_000, deadlineTimestamp: 80_100 };
    const writer = {
      claimDueReferenceMarkouts: jest.fn(async () => [work]),
      releaseReferenceMarkoutClaim: jest.fn(async () => true),
      completeReferenceMarkout: jest.fn(async () => true),
    };
    const collector = new ReferenceMarkoutCollector({ writer, config: VALID_CONFIG, now: () => now });
    await collector.processDue();
    expect(writer.releaseReferenceMarkoutClaim).toHaveBeenLastCalledWith(
      work, expect.any(String), 'missing-quote-attribution',
    );
    now = 80_101;
    await collector.processDue();
    expect(writer.completeReferenceMarkout).toHaveBeenLastCalledWith(
      work, expect.any(String), expect.objectContaining({
        available: false, unavailableReason: 'missing-quote-attribution', observedEdgeBps: null,
      }),
    );
  });

  test('rejects a fresh observation after the deadline and converts USD midpoint to PYUSD', async () => {
    let now = 200_000;
    const lateWork = {
      fillId: 'late', horizonMs: 60_000, dueTimestamp: 80_000, deadlineTimestamp: 110_000,
      quoteId: 'Q-1', decisionTimestamp: 10_000, side: 'buy', level: 1,
      policyId: 'maker-v1', price: 100,
    };
    const writer = {
      claimDueReferenceMarkouts: jest.fn(async () => [lateWork]),
      completeReferenceMarkout: jest.fn(async () => true),
      releaseReferenceMarkoutClaim: jest.fn(async () => true),
    };
    let basisPrice = 1;
    const collector = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => now,
      marketProvider: () => market({ sourceTimestamp: now - 2, receivedTimestamp: now - 1 }),
      basisProvider: () => basis({ timestamp: now - 2, price: basisPrice }),
    });
    await collector.processDue();
    expect(writer.completeReferenceMarkout).toHaveBeenLastCalledWith(
      lateWork, expect.any(String), expect.objectContaining({
        available: false, unavailableReason: 'after-deadline',
      }),
    );

    const onTimeWork = { ...lateWork, fillId: 'basis', dueTimestamp: 200_000, deadlineTimestamp: 230_000 };
    writer.claimDueReferenceMarkouts.mockResolvedValueOnce([onTimeWork]);
    basisPrice = 1.002;
    now = 200_002;
    await collector.processDue();
    const observation = writer.completeReferenceMarkout.mock.calls.at(-1)[2];
    expect(observation.adjustedMidpoint).toBeCloseTo(100 / 1.002, 8);
    expect(observation.observedEdgeBps).toBeCloseTo(-19.96007984, 6);
  });

  test('bounds coverage groups and throttles retention sweeps', async () => {
    let now = 10_000;
    const writer = {
      claimDueReferenceMarkouts: jest.fn(async () => []),
      pruneReferenceMarkoutEvidence: jest.fn(async () => true),
      pruneReferenceQuoteDecisions: jest.fn(async () => true),
      pruneReferenceMarketObservations: jest.fn(async () => true),
      getReferenceMarkoutCoverage: jest.fn(async input => ({
        groups: [input], truncated: false, limit: input.limit,
      })),
    };
    const collector = new ReferenceMarkoutCollector({ writer, config: VALID_CONFIG, now: () => now });
    expect(await collector.getCoverageAudit({ limit: 10_000 })).toEqual(expect.objectContaining({
      groups: [expect.objectContaining({ limit: VALID_CONFIG.auditMaxGroups })],
      limit: VALID_CONFIG.auditMaxGroups,
    }));
    await collector.processDue();
    now += 1_000;
    await collector.processDue();
    expect(writer.pruneReferenceMarkoutEvidence).toHaveBeenCalledTimes(1);
    expect(writer.pruneReferenceQuoteDecisions).toHaveBeenCalledTimes(1);
    expect(writer.pruneReferenceMarketObservations).toHaveBeenCalledTimes(1);
  });

  test('persists one cycle sample and reuses the earliest valid sample across rows and restart', async () => {
    let now = 80_002;
    let providerCalls = 0;
    const samples = [];
    const completions = [];
    const work = ['A', 'B'].map(fillId => ({
      fillId, horizonMs: 60_000, dueTimestamp: 80_000, deadlineTimestamp: 110_000,
      quoteId: `Q-${fillId}`, decisionTimestamp: 10_000, side: 'buy', level: 1,
      policyId: 'maker-v1', price: 100,
    }));
    const writer = {
      recordReferenceMarketObservation: jest.fn(async observation => { samples.push(observation); }),
      claimDueReferenceMarkouts: jest.fn(async () => []),
      getFirstReferenceMarketObservation: jest.fn(async ({ dueTimestamp, deadlineTimestamp }) =>
        samples.find(sample => sample.observationTimestamp >= dueTimestamp && sample.observationTimestamp <= deadlineTimestamp) || null),
      completeReferenceMarkout: jest.fn(async (item, _token, observation) => {
        completions.push([item.fillId, observation.sourceTimestamp]);
      }),
    };
    const providers = {
      marketProvider: () => {
        providerCalls += 1;
        return market({ sourceTimestamp: now - 1, receivedTimestamp: now });
      },
      basisProvider: () => basis({ timestamp: now - 1, price: 1 }),
    };
    const firstProcess = new ReferenceMarkoutCollector({ writer, config: VALID_CONFIG, now: () => now, ...providers });
    await firstProcess.processDue();
    now = 90_000;
    writer.claimDueReferenceMarkouts.mockResolvedValueOnce(work);
    const restartedProcess = new ReferenceMarkoutCollector({ writer, config: VALID_CONFIG, now: () => now, ...providers });
    await restartedProcess.processDue();
    expect(completions).toEqual([['A', 80_001], ['B', 80_001]]);
    expect(providerCalls).toBe(2);
  });

  test('persists the same fresh exchange tick before and after due as distinct observations', async () => {
    let now = 79_999;
    let claims = [];
    const samples = [];
    const work = {
      fillId: 'same-tick', horizonMs: 60_000, dueTimestamp: 80_000, deadlineTimestamp: 110_000,
      quoteId: 'Q-same', decisionTimestamp: 10_000, side: 'buy', level: 1,
      policyId: 'maker-v1', price: 100,
    };
    const writer = {
      recordReferenceMarketObservation: jest.fn(async observation => { samples.push(observation); }),
      claimDueReferenceMarkouts: jest.fn(async () => claims),
      getFirstReferenceMarketObservation: jest.fn(async ({ dueTimestamp, deadlineTimestamp }) =>
        samples.find(sample => sample.observationTimestamp >= dueTimestamp &&
          sample.observationTimestamp <= deadlineTimestamp) || null),
      completeReferenceMarkout: jest.fn(async () => true),
    };
    const collector = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => now,
      marketProvider: () => market({ sourceTimestamp: 79_998, receivedTimestamp: 79_999 }),
      basisProvider: () => basis({ timestamp: 79_998, price: 1 }),
    });

    await collector.processDue();
    now = 80_001;
    claims = [work];
    await collector.processDue();

    expect(samples.map(sample => sample.observationTimestamp)).toEqual([79_999, 80_001]);
    expect(writer.completeReferenceMarkout).toHaveBeenCalledWith(
      work, expect.any(String), expect.objectContaining({
        available: true, observationTimestamp: 80_001, sourceTimestamp: 79_998,
      }),
    );
  });

  test('rejects a post-deadline observation even when its book predates the deadline', async () => {
    const work = {
      fillId: 'post-deadline-basis', horizonMs: 60_000,
      dueTimestamp: 80_000, deadlineTimestamp: 110_000,
      quoteId: 'Q-late', decisionTimestamp: 10_000, side: 'buy', level: 1,
      policyId: 'maker-v1', price: 100,
    };
    const writer = {
      recordReferenceMarketObservation: jest.fn(async () => true),
      claimDueReferenceMarkouts: jest.fn(async () => [work]),
      completeReferenceMarkout: jest.fn(async () => true),
      getFirstReferenceMarketObservation: jest.fn(async () => null),
    };
    const collector = new ReferenceMarkoutCollector({
      writer,
      config: VALID_CONFIG,
      now: () => 112_000,
      marketProvider: () => market({ sourceTimestamp: 109_000, receivedTimestamp: 109_001 }),
      basisProvider: () => basis({ timestamp: 112_000, price: 1 }),
    });

    await collector.processDue();

    // The sample can serve later work, but its observation/basis availability
    // is after this work item's attribution cutoff.
    expect(writer.recordReferenceMarketObservation).toHaveBeenCalledWith(
      expect.objectContaining({ observationTimestamp: 112_000, basisTimestamp: 112_000 }),
    );
    expect(writer.completeReferenceMarkout).toHaveBeenLastCalledWith(
      work,
      expect.any(String),
      expect.objectContaining({ available: false, unavailableReason: 'after-deadline' }),
    );
  });

  test('uses the same PYUSD conversion convention as the regime validator', () => {
    const basisAdjustmentBps = (1 / 1.002 - 1) * 10_000;
    const result = validateRegimeStrategy({
      fills: [{
        fillId: 'F-1', timestamp: 10_000, decisionTimestamp: 9_000,
        side: 'buy', price: 100, quantity: 0.01,
      }],
      references: [9_000, 70_000].map(timestamp => ({
        timestamp, bid: 99, ask: 101, sourceType: 'top-of-book',
        product: 'BTC-USD', quoteCurrency: 'USD', basisAdjustmentBps,
      })),
      candidateId: 'basis-contract',
      shadowEvidence: {
        observed: true, candidateId: 'basis-contract', fillSurvivalRate: 1, clusterCount: 1,
      },
      config: {
        heldOutDays: 1, primaryHorizon: '1m', bootstrap: { iterations: 10 },
        gates: {
          minReferenceCoverage: 0, minClusters: 0, minObservationDays: 0,
          minLowerBoundBps: 0, minShadowClusters: 0, minShadowFillSurvivalRate: 0,
        },
      },
    });
    expect(result.heldOut.metrics.observedEdgeBps.mean).toBeCloseTo(-19.96007984, 6);
  });
});
