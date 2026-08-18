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
  retentionBatchSize: 1_000,
  retentionMaxBatchesPerSweep: 11,
  maxQuoteDecisionsPerSecond: 1,
  planningFillEventsPerSecond: 1,
  auditMaxGroups: 100,
  maxAbsBasisAdjustmentBps: 25,
  basisSource: 'kraken-pretrade',
  basisRequestedPair: 'PYUSD/USD',
  basisResolvedPair: 'PYUSD/USD',
  basisBase: 'PYUSD',
  basisQuote: 'USD',
  basisSystem: 'CLOB',
  basisVenueAllowlist: ['PDSL'],
  maxBasisRttMs: 1_000,
};

const DIRECT_CONFIG = {
  ...VALID_CONFIG, referenceMode: 'cryptocom-direct', product: 'BTC-PYUSD',
  quoteCurrency: 'PYUSD', sourceExchange: 'cryptocom', sourceType: 'public-ws-book',
  sourceInstrument: 'BTC_PYUSD', sourceChannel: 'book.BTC_PYUSD.10',
  sourceEndpointAllowlist: ['wss://stream.crypto.com/exchange/v1/market'],
};

function market({ sourceTimestamp = 9_900, receivedTimestamp = 9_950, bid = 99, ask = 101 } = {}) {
  return {
    sources: [{
      exchange: 'coinbase', bid, ask, sourceTimestamp, receivedTimestamp, isStale: false,
    }],
  };
}

function basis({ timestamp = 9_900, price = 1.0001, ...overrides } = {}) {
  return {
    timestamp, basisTimestamp: timestamp, price, bid: price - 0.00005,
    ask: price + 0.00005, bidQty: 10, askQty: 11, bidCount: 1, askCount: 2,
    bidSubmissionTimestamp: timestamp - 10, askSubmissionTimestamp: timestamp - 10,
    bidPublicationTimestamp: timestamp, askPublicationTimestamp: timestamp,
    requestTimestamp: timestamp - 20, receivedTimestamp: timestamp,
    source: 'kraken-pretrade', requestedPair: 'PYUSD/USD', resolvedPair: 'PYUSD/USD',
    base: 'PYUSD', quote: 'USD', venue: 'PDSL', system: 'CLOB',
    ...overrides,
  };
}

describe('reference mark-out configuration', () => {
  test('validates the exact direct PYUSD source identity without requiring basis', () => {
    const config = validateReferenceMarkoutConfig(DIRECT_CONFIG);
    expect(config).toMatchObject({ referenceMode: 'cryptocom-direct', product: 'BTC-PYUSD',
      quoteCurrency: 'PYUSD', sourceInstrument: 'BTC_PYUSD' });
    expect(config.basisVenueAllowlist).toEqual([]);
    expect(() => validateReferenceMarkoutConfig({ ...DIRECT_CONFIG, sourceInstrument: 'BTC_USD' }))
      .toThrow('Crypto.com BTC_PYUSD');
    expect(() => validateReferenceMarkoutConfig({ ...DIRECT_CONFIG,
      sourceEndpointAllowlist: ['wss://operator.example/exchange/v1/market'] }))
      .toThrow('exact official Crypto.com endpoint');
  });
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
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, retentionBatchSize: 10_001 }))
      .toThrow('retentionBatchSize');
    expect(() => validateReferenceMarkoutConfig({
      ...VALID_CONFIG, retentionBatchSize: 100, retentionMaxBatchesPerSweep: 1,
    })).toThrow('retention throughput');
    expect(() => validateReferenceMarkoutConfig({
      ...VALID_CONFIG, planningFillEventsPerSecond: 2,
    })).toThrow('retention throughput');
    expect(() => validateReferenceMarkoutConfig({
      ...VALID_CONFIG, dbLockTimeoutMs: 3_000, dbStatementTimeoutMs: 2_000,
    })).toThrow('database timeouts');
    expect(() => validateReferenceMarkoutConfig({
      ...VALID_CONFIG, retentionMaxDurationMs: 3_000,
      dbQueryTimeoutMs: 2_500, retentionYieldMs: 500,
    })).toThrow('one query plus yield');
    expect(() => validateReferenceMarkoutConfig({
      ...VALID_CONFIG, telemetryWriteConcurrency: 1, maxPendingFillWrites: 80,
    })).toThrow('earliest horizon');
    expect(() => validateReferenceMarkoutConfig({
      ...VALID_CONFIG, horizonsMs: [18_500], telemetryWriteConcurrency: 1,
      maxPendingFillWrites: 3, maxConsecutiveFillStarts: 1,
      fillHorizonSafetyMarginMs: 1_000,
    })).toThrow('earliest horizon');
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, horizonsMs: [Number.MAX_SAFE_INTEGER + 1] }))
      .toThrow('horizonsMs');
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, product: 'ETH-EUR' }))
      .toThrow('Coinbase BTC-USD');
    expect(() => validateReferenceMarkoutConfig({ ...VALID_CONFIG, sourceType: 'candle' }))
      .toThrow('Coinbase BTC-USD');
    expect(() => validateReferenceMarkoutConfig({
      ...VALID_CONFIG, basisVenueAllowlist: [],
    })).toThrow('basisVenueAllowlist');
    expect(() => validateReferenceMarkoutConfig({
      ...VALID_CONFIG, basisResolvedPair: 'USD/PYUSD',
    })).toThrow('basis identity');
  });
});

describe('ReferenceMarkoutCollector', () => {
  test('records direct PYUSD evidence with t authority and no synthetic basis', async () => {
    const writer = { recordReferenceQuoteDecision: jest.fn(async () => true) };
    const directBook = { exchange: 'cryptocom', sourceType: 'public-ws-book',
      instrument: 'BTC_PYUSD', channel: 'book.BTC_PYUSD.10', bid: 99, ask: 101,
      sourceTimestamp: 9_900, bookUpdateTimestamp: 8_000, receivedTimestamp: 9_950,
      sequence: 41, generation: 2, sourceSessionId: 'session-123' };
    Object.assign(directBook, { sourceEndpoint: 'wss://stream.crypto.com/exchange/v1/market',
      sourceBookHash: 'a'.repeat(64), depth: 10, bidQty: 2, askQty: 3,
      bidCount: 1, askCount: 1 });
    const collector = new ReferenceMarkoutCollector({ writer, config: DIRECT_CONFIG,
      now: () => 10_000, marketProvider: () => directBook });
    await collector.recordQuoteDecision({ quoteId: 'Q-direct', decisionTimestamp: 10_000 });
    expect(writer.recordReferenceQuoteDecision).toHaveBeenCalledWith(expect.objectContaining({
      available: true, product: 'BTC-PYUSD', quoteCurrency: 'PYUSD', bid: 99, ask: 101,
      sourceTimestamp: 9_900, receivedTimestamp: 9_950, sourceBookUpdateTimestamp: 8_000,
      sourceSequence: 41, sourceGeneration: 2, basisPrice: null,
      basisAdjustmentBps: 0, promotionGrade: true,
    }));
  });

  test('fails direct evidence closed on identity, provenance, receipt, and observation violations', async () => {
    const base = { exchange: 'cryptocom', sourceType: 'public-ws-book',
      instrument: 'BTC_PYUSD', channel: 'book.BTC_PYUSD.10', bid: 99, ask: 101,
      sourceTimestamp: 9_900, bookUpdateTimestamp: 8_000, receivedTimestamp: 9_950,
      sequence: 41, generation: 2, sourceSessionId: 'session-123' };
    Object.assign(base, { sourceEndpoint: 'wss://stream.crypto.com/exchange/v1/market',
      sourceBookHash: 'a'.repeat(64), depth: 10, bidQty: 2, askQty: 3,
      bidCount: 1, askCount: 1 });
    for (const [override, reason] of [
      [{ instrument: 'BTC_USD' }, 'source-identity-mismatch'],
      [{ sequence: -1 }, 'invalid-source-provenance'],
      [{ bookUpdateTimestamp: 9_901 }, 'invalid-source-provenance'],
      [{ receivedTimestamp: 10_001 }, 'lookahead-source'],
      [{ sourceTimestamp: 4_000, receivedTimestamp: 9_950 }, 'stale-source'],
    ]) {
      const writer = { recordReferenceQuoteDecision: jest.fn(async () => true) };
      const collector = new ReferenceMarkoutCollector({ writer, config: DIRECT_CONFIG,
        now: () => 10_000, marketProvider: () => ({ ...base, ...override }) });
      await collector.recordQuoteDecision({ quoteId: `Q-${reason}`, decisionTimestamp: 10_000 });
      expect(writer.recordReferenceQuoteDecision).toHaveBeenCalledWith(
        expect.objectContaining({ available: false, unavailableReason: reason }),
      );
    }
  });
  test('reports running counters and a safe immutable configuration identity', () => {
    const collector = new ReferenceMarkoutCollector({ config: VALID_CONFIG });
    collector.stats.decisionsRecorded = 7;
    collector.stats.persistenceErrors = 2;

    const stopped = collector.getStats();
    expect(stopped).toMatchObject({
      running: false, decisionsRecorded: 7, persistenceErrors: 2,
      marketObservationsRecorded: 0, lastCycleAt: null,
      lastMarketObservationAt: null, lastErrorReason: null, lastErrorAt: null,
      config: {
        product: 'BTC-USD', quoteCurrency: 'USD', sourceExchange: 'coinbase',
        sourceType: 'top-of-book', horizonsMs: [60_000, 300_000, 3_600_000],
        maxSourceAgeMs: 5_000, maxLatenessMs: 30_000, pollIntervalMs: 1_000,
        batchSize: 50, claimLeaseMs: 5_000, retentionMs: 86_400_000,
        retentionSweepIntervalMs: 3_600_000, retentionBatchSize: 1_000,
        retentionMaxBatchesPerSweep: 11, maxQuoteDecisionsPerSecond: 1,
        planningFillEventsPerSecond: 1,
        auditMaxGroups: 100, maxAbsBasisAdjustmentBps: 25,
        basisSource: 'kraken-pretrade', basisRequestedPair: 'PYUSD/USD',
        basisResolvedPair: 'PYUSD/USD', basisBase: 'PYUSD', basisQuote: 'USD',
        basisSystem: 'CLOB', basisVenueAllowlist: ['PDSL'], maxBasisRttMs: 1_000,
      },
    });
    expect(Object.isFrozen(stopped.config)).toBe(true);
    expect(Object.isFrozen(stopped.config.horizonsMs)).toBe(true);
    expect(Object.keys(stopped.config).sort()).toEqual(Object.keys(collector.config).sort());
    expect(() => stopped.config.horizonsMs.push(99)).toThrow();
    expect(collector.getStats().config.horizonsMs).toEqual([60_000, 300_000, 3_600_000]);

    collector._timer = 1;
    expect(collector.getStats().running).toBe(true);
    collector._timer = null;
  });

  test('exposes safe source operational identity without affecting collector health', () => {
    const sourceStatus = Object.freeze({ running: true, eligible: false, generation: 4,
      lastSourceTimestamp: null, config: Object.freeze({ endpoint: 'wss://stream.crypto.com/exchange/v1/market',
        instrument: 'BTC_PYUSD', channel: 'book.BTC_PYUSD.10', depth: 10,
        maxAgeMs: 5000, reconnectDelayMs: 750, subscribeDelayMs: 1000,
        heartbeatTimeoutMs: 15000, reconnectJitterMs: 250 }) });
    const collector = new ReferenceMarkoutCollector({ config: DIRECT_CONFIG,
      sourceFeed: { getStats: () => sourceStatus } });
    expect(collector.getStats()).toMatchObject({ running: false, source: sourceStatus });
  });

  test('reports persisted sampling activity and only a sanitized bounded error summary', async () => {
    let now = 10_000;
    const writer = {
      recordReferenceMarketObservation: jest.fn(async () => true),
      claimDueReferenceMarkouts: jest.fn(async () => []),
    };
    const collector = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => now,
      marketProvider: () => market(), basisProvider: () => basis(),
      logger: { warn: jest.fn() },
    });

    await collector.processDue();
    expect(collector.getStats()).toMatchObject({
      processCycles: 1, marketObservationsRecorded: 1,
      promotionGradeMarketObservationsRecorded: 1,
      lastCycleAt: 10_000, lastMarketObservationAt: 10_000,
      lastErrorReason: null, lastErrorAt: null,
    });

    now = 11_000;
    writer.recordReferenceMarketObservation.mockRejectedValueOnce(
      new Error('postgres password=do-not-expose'),
    );
    await collector.processDue();
    const failed = collector.getStats();
    expect(failed.persistenceErrors).toBe(1);
    expect(failed.lastErrorReason).toBe('due processing failed');
    expect(failed.lastErrorReason).not.toContain('password');
    expect(failed.lastErrorAt).toBe(11_000);
    expect(failed.lastMarketObservationAt).toBe(10_000);
  });

  test('samples only for an open durable horizon and persists before claiming it', async () => {
    const calls = [];
    const writer = {
      hasOpenReferenceMarkoutWindow: jest.fn(async () => false),
      recordReferenceMarketObservation: jest.fn(async () => { calls.push('record'); return true; }),
      claimDueReferenceMarkouts: jest.fn(async () => { calls.push('claim'); return []; }),
    };
    const collector = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => 10_000,
      marketProvider: () => market(), basisProvider: () => basis(),
    });

    await collector.processDue();
    expect(writer.recordReferenceMarketObservation).not.toHaveBeenCalled();
    expect(calls).toEqual(['claim']);
    expect(collector.getStats()).toMatchObject({
      openWindow: false, samplingState: 'idle-no-open-window',
      marketObservationsRecorded: 0, lastMarketObservationAt: null,
    });

    calls.length = 0;
    writer.hasOpenReferenceMarkoutWindow.mockResolvedValueOnce(true);
    await collector.processDue();
    expect(calls).toEqual(['record', 'claim']);
    expect(collector.getStats().marketObservationsRecorded).toBe(1);
  });

  test('bounds concurrent telemetry writes while slow persistence cannot touch execution', async () => {
    const sendMessage = jest.fn();
    const cancelAllQuotes = jest.fn();
    const never = new Promise(() => {});
    const writer = { recordReferenceQuoteDecision: jest.fn(() => never) };
    const collector = new ReferenceMarkoutCollector({
      writer, config: {
        ...VALID_CONFIG, telemetryWriteConcurrency: 1, maxPendingFillWrites: 20,
      }, now: () => 10_000,
      marketProvider: () => market(), basisProvider: () => basis(),
      logger: { warn: jest.fn() },
    });

    for (let index = 0; index < collector.config.maxPendingDecisionWrites + 25; index += 1) {
      void collector.recordQuoteDecision({ quoteId: `Q-${index}`, decisionTimestamp: 10_000 });
    }
    await new Promise(resolve => setImmediate(resolve));
    expect(writer.recordReferenceQuoteDecision).toHaveBeenCalledTimes(1);
    expect(collector.getStats()).toMatchObject({
      telemetryWritesActive: 1,
      telemetryWritesWaiting: collector.config.maxPendingDecisionWrites,
      telemetryWritesRejected: 24,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(cancelAllQuotes).not.toHaveBeenCalled();
  });

  test('services the saturated fill lane FIFO before decisions and visibly rejects overflow', async () => {
    let releaseActiveDecision;
    let decisionCalls = 0;
    const serviceOrder = [];
    const writer = {
      recordReferenceQuoteDecision: jest.fn(decision => {
        serviceOrder.push(decision.quoteId);
        decisionCalls += 1;
        if (decisionCalls === 1) return new Promise(resolve => { releaseActiveDecision = resolve; });
        return Promise.resolve();
      }),
      scheduleReferenceMarkouts: jest.fn(async fill => { serviceOrder.push(fill.fillId); }),
    };
    const collector = new ReferenceMarkoutCollector({
      writer, config: {
        ...VALID_CONFIG, telemetryWriteConcurrency: 1, maxPendingFillWrites: 20,
      }, now: () => 10_000,
      marketProvider: () => market(), basisProvider: () => basis(),
      logger: { warn: jest.fn() },
    });
    for (let index = 0; index <= collector.config.maxPendingDecisionWrites; index += 1) {
      void collector.recordQuoteDecision({ quoteId: `Q-${index}`, decisionTimestamp: 10_000 });
    }
    await new Promise(resolve => setImmediate(resolve));
    const fillIds = Array.from({ length: collector.config.maxPendingFillWrites },
      (_, index) => `F-${String(index).padStart(3, '0')}`);
    const fillAdmissions = fillIds.map(fillId => collector.scheduleFill({
      fillId, side: 'buy', price: 100, fillTimestamp: 10_000,
    }));
    const overflow = collector.scheduleFill({
      fillId: 'F-overflow', side: 'buy', price: 100, fillTimestamp: 10_000,
    });
    await Promise.resolve();
    expect(collector._fillWriteQueue).toHaveLength(collector.config.maxPendingFillWrites);
    expect(await overflow).toBe(false);
    expect(collector.getStats()).toMatchObject({
      telemetryWritesActive: 1,
      fillWritesWaiting: collector.config.maxPendingFillWrites,
      telemetryWritesRejected: 1,
      fillWritesRejected: 1,
      decisionWritesRejected: 0,
      lastErrorReason: 'fill scheduling queue saturated',
    });
    releaseActiveDecision(true);
    await expect(Promise.all(fillAdmissions)).resolves.toEqual(fillIds.map(() => true));
    expect(serviceOrder.filter(item => item.startsWith('F-'))).toEqual(fillIds);
    expect(serviceOrder.indexOf('Q-1')).toBeLessThanOrEqual(
      collector.config.maxConsecutiveFillStarts + 1,
    );
    expect(collector.getStats()).toMatchObject({
      maxConsecutiveFillStartsObserved: collector.config.maxConsecutiveFillStarts,
      decisionFairnessStarts: expect.any(Number),
    });
    expect(collector.getStats().decisionFairnessStarts).toBeGreaterThanOrEqual(1);
    const fairnessDecisionStarts = Math.ceil(collector.config.maxPendingFillWrites /
      collector.config.maxConsecutiveFillStarts);
    const worstAdmittedFillLatencyMs = (1 + Math.ceil((collector.config.maxPendingFillWrites +
      fairnessDecisionStarts) / collector.config.telemetryWriteConcurrency)) *
      collector.config.dbQueryTimeoutMs;
    expect(worstAdmittedFillLatencyMs + collector.config.fillHorizonSafetyMarginMs).toBeLessThan(
      Math.min(...collector.config.horizonsMs),
    );
  });

  test('captures one immutable sample when work appears between the open-window check and claim', async () => {
    const marketProvider = jest.fn(() => market());
    const basisProvider = jest.fn(() => basis());
    const writer = {
      hasOpenReferenceMarkoutWindow: jest.fn(async () => false),
      recordReferenceMarketObservation: jest.fn(async () => true),
      claimDueReferenceMarkouts: jest.fn(async () => [{
        fillId: 'F-race', horizonMs: 60_000, dueTimestamp: 10_000,
        deadlineTimestamp: 40_000, decisionTimestamp: 9_000, quoteId: 'Q-1',
        side: 'buy', level: 1, policyId: 'maker-v1', price: 100,
      }]),
      getFirstReferenceMarketObservation: jest.fn(async () => null),
      completeReferenceMarkout: jest.fn(async () => true),
    };
    const collector = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => 10_000, marketProvider, basisProvider,
    });

    await collector.processDue();
    expect(marketProvider).toHaveBeenCalledTimes(1);
    expect(basisProvider).toHaveBeenCalledTimes(1);
    expect(writer.recordReferenceMarketObservation).toHaveBeenCalledTimes(1);
    expect(writer.completeReferenceMarkout).toHaveBeenCalledWith(
      expect.objectContaining({ fillId: 'F-race' }), expect.any(String),
      expect.objectContaining({ observationTimestamp: 10_000 }),
    );
  });

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
      expect(collector.getStats().invalidSampleReasons).toMatchObject({ [reason]: 1 });
    }
  });

  test('rejects manufactured or misordered provenance and unusable cross-currency basis', async () => {
    const writer = { recordReferenceQuoteDecision: jest.fn(async () => true) };
    const cases = [
      [market({ sourceTimestamp: null }), basis(), 'invalid-timestamp'],
      [market({ sourceTimestamp: 9_960, receivedTimestamp: 9_950 }), basis(), 'invalid-timestamp-order'],
      [market(), null, 'missing-basis'],
      [market(), { timestamp: 9_900, price: 1, source: 'kraken-rest' },
        'non-promotion-grade-basis-source'],
      [market(), basis({ timestamp: 10_001 }), 'lookahead-basis-receipt'],
      [market(), basis({ timestamp: 1_000 }), 'stale-basis'],
      [market(), basis({ price: 1.01 }), 'basis-out-of-bounds'],
      [market(), basis({ receivedTimestamp: 10_001 }), 'lookahead-basis-receipt'],
      [market(), basis({ bidSubmissionTimestamp: null }),
        'missing-basis-submission-provenance'],
      [market(), basis({ requestTimestamp: 9_950, receivedTimestamp: 9_940 }), 'invalid-basis-request-order'],
      [market(), basis({ bidSubmissionTimestamp: 9_950, bidPublicationTimestamp: 9_940 }), 'invalid-basis-side-order'],
      [market(), basis({ venue: 'OTHER' }), 'basis-venue-not-allowed'],
      [market(), basis({ resolvedPair: 'USD/PYUSD' }), 'basis-identity-mismatch'],
      [market(), basis({ requestTimestamp: 8_000, receivedTimestamp: 9_900 }), 'basis-rtt-exceeded'],
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

  test('persists validated publication-only basis as diagnostic while malformed basis is not sampled', async () => {
    const diagnosticBasis = basis({
      bidSubmissionTimestamp: null, askSubmissionTimestamp: null,
    });
    const writer = {
      hasOpenReferenceMarkoutWindow: jest.fn(async () => true),
      recordReferenceMarketObservation: jest.fn(async () => true),
      claimDueReferenceMarkouts: jest.fn(async () => []),
      recordReferenceQuoteDecision: jest.fn(async () => true),
    };
    const collector = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => 10_000,
      marketProvider: () => market(), basisProvider: () => diagnosticBasis,
    });
    await collector.recordQuoteDecision({ quoteId: 'Q-diagnostic', decisionTimestamp: 10_000 });
    expect(writer.recordReferenceQuoteDecision).toHaveBeenCalledWith(expect.objectContaining({
      available: false, unavailableReason: 'missing-basis-submission-provenance',
      sourceTimestamp: 9_900, receivedTimestamp: 9_950, bid: 99, ask: 101,
      basisSource: 'kraken-pretrade', basisVenue: 'PDSL',
      basisBidPublicationTimestamp: 9_900, basisAskPublicationTimestamp: 9_900,
      basisBidSubmissionTimestamp: null, promotionGrade: false,
      diagnosticPersistable: true,
    }));
    await collector.processDue();
    expect(writer.recordReferenceMarketObservation).toHaveBeenCalledWith(
      expect.objectContaining({ promotionGrade: false, diagnosticPersistable: true }),
    );

    writer.recordReferenceMarketObservation.mockClear();
    const malformed = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => 10_000,
      marketProvider: () => market(), basisProvider: () => basis({ bid: -1 }),
    });
    await malformed.processDue();
    expect(writer.recordReferenceMarketObservation).not.toHaveBeenCalled();

    const malformedBook = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => 10_000,
      marketProvider: () => market({ bid: -1 }), basisProvider: () => diagnosticBasis,
    });
    await malformedBook.processDue();
    expect(writer.recordReferenceMarketObservation).not.toHaveBeenCalled();
  });

  test('propagates publication-only diagnostic provenance into terminal evidence after cutoff', async () => {
    const work = { fillId: 'F-diag', horizonMs: 60_000, dueTimestamp: 80_000,
      deadlineTimestamp: 110_000, quoteId: 'Q-1', decisionTimestamp: 10_000,
      side: 'buy', level: 1, policyId: 'maker-v1', price: 100 };
    const writer = {
      hasOpenReferenceMarkoutWindow: jest.fn(async () => true),
      recordReferenceMarketObservation: jest.fn(async () => true),
      claimDueReferenceMarkouts: jest.fn(async () => [work]),
      getFirstReferenceMarketObservation: jest.fn(async () => null),
      completeReferenceMarkout: jest.fn(async () => true),
    };
    const collector = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => 112_000,
      marketProvider: () => market({ sourceTimestamp: 111_900, receivedTimestamp: 111_950 }),
      basisProvider: () => basis({ timestamp: 111_900,
        bidSubmissionTimestamp: null, askSubmissionTimestamp: null }),
    });
    await collector.processDue();
    expect(writer.completeReferenceMarkout).toHaveBeenCalledWith(work, expect.any(String),
      expect.objectContaining({
        available: false, unavailableReason: 'after-deadline', sourceTimestamp: 111_900,
        basisSource: 'kraken-pretrade', basisBidSubmissionTimestamp: null,
        basisBidPublicationTimestamp: 111_900, promotionGrade: false,
      }));
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

  test('completes a direct persisted horizon with the BTC-PYUSD midpoint and no basis division', async () => {
    const now = 70_000;
    const work = { fillId: 'F-direct', horizonMs: 60_000, dueTimestamp: 60_000,
      deadlineTimestamp: 90_000, quoteId: 'Q-direct', decisionTimestamp: 9_000,
      side: 'buy', level: 1, policyId: 'maker-v1', price: 100 };
    let persisted;
    const writer = {
      hasOpenReferenceMarkoutWindow: jest.fn(async () => true),
      recordReferenceMarketObservation: jest.fn(async observation => {
        persisted = observation; return true;
      }),
      claimDueReferenceMarkouts: jest.fn(async () => [work]),
      getFirstReferenceMarketObservation: jest.fn(async () => persisted),
      completeReferenceMarkout: jest.fn(async () => true),
      releaseReferenceMarkoutClaim: jest.fn(async () => true),
    };
    const directBook = { exchange: 'cryptocom', sourceType: 'public-ws-book',
      instrument: 'BTC_PYUSD', channel: 'book.BTC_PYUSD.10', bid: 100, ask: 102,
      sourceTimestamp: 69_950, bookUpdateTimestamp: 69_000, receivedTimestamp: 69_975,
      sequence: 41, generation: 2, sourceSessionId: 'session-123',
      sourceEndpoint: 'wss://stream.crypto.com/exchange/v1/market',
      sourceBookHash: 'a'.repeat(64), depth: 10, bidQty: 2, askQty: 3,
      bidCount: 1, askCount: 1 };
    const collector = new ReferenceMarkoutCollector({ writer, config: DIRECT_CONFIG,
      now: () => now, marketProvider: () => directBook });

    await collector.processDue();

    expect(persisted).toMatchObject({ midpoint: 101, basisPrice: null,
      basisTimestamp: null, promotionGrade: true });
    expect(writer.completeReferenceMarkout).toHaveBeenCalledWith(work, expect.any(String),
      expect.objectContaining({ adjustedMidpoint: 101, observedEdgeBps: 100,
        basisPrice: null, referenceMode: 'cryptocom-direct' }));
  });

  test('bounds coverage groups and runs retention outside due processing', async () => {
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
    expect(writer.pruneReferenceMarkoutEvidence).not.toHaveBeenCalled();
    await collector.runRetentionSweep();
    expect(writer.pruneReferenceMarkoutEvidence).toHaveBeenCalledTimes(1);
    expect(writer.pruneReferenceMarkoutEvidence).toHaveBeenCalledWith(
      11_000 - VALID_CONFIG.retentionMs, VALID_CONFIG.retentionBatchSize,
    );
    expect(writer.pruneReferenceQuoteDecisions).toHaveBeenCalledTimes(1);
    expect(writer.pruneReferenceMarketObservations).toHaveBeenCalledTimes(1);
  });

  test('drains retention in bounded batches and exposes remaining backlog', async () => {
    const full = { rowCount: VALID_CONFIG.retentionBatchSize };
    const writer = {
      claimDueReferenceMarkouts: jest.fn(async () => []),
      pruneReferenceMarkoutEvidence: jest.fn(async () => full),
      pruneReferenceQuoteDecisions: jest.fn(async () => ({ rowCount: 3 })),
      pruneReferenceMarketObservations: jest.fn(async () => full),
    };
    const collector = new ReferenceMarkoutCollector({
      writer, config: VALID_CONFIG, now: () => 10_000, yieldFn: async () => {},
    });

    await collector.runRetentionSweep();

    expect(writer.pruneReferenceMarkoutEvidence).toHaveBeenCalledTimes(VALID_CONFIG.retentionMaxBatchesPerSweep);
    expect(writer.pruneReferenceQuoteDecisions).toHaveBeenCalledTimes(1);
    expect(writer.pruneReferenceMarketObservations).toHaveBeenCalledTimes(VALID_CONFIG.retentionMaxBatchesPerSweep);
    expect(collector.getStats()).toMatchObject({
      retentionRowsPruned: {
        work: VALID_CONFIG.retentionBatchSize * VALID_CONFIG.retentionMaxBatchesPerSweep,
        decisions: 3,
        observations: VALID_CONFIG.retentionBatchSize * VALID_CONFIG.retentionMaxBatchesPerSweep,
      },
      retentionBacklog: { work: true, decisions: false, observations: true },
      lastRetentionSweepAt: 10_000,
    });
  });

  test('bounds total retention duration and yields between full batches', async () => {
    let monotonic = 0;
    const yieldFn = jest.fn(async () => { monotonic += 20_000; });
    const full = { rowCount: VALID_CONFIG.retentionBatchSize };
    const writer = {
      pruneReferenceMarkoutEvidence: jest.fn(async () => full),
      pruneReferenceQuoteDecisions: jest.fn(async () => full),
      pruneReferenceMarketObservations: jest.fn(async () => full),
    };
    const collector = new ReferenceMarkoutCollector({
      writer, config: { ...VALID_CONFIG, retentionYieldMs: 20_000 }, now: () => 10_000,
      monotonicNow: () => monotonic, yieldFn,
    });

    await collector.runRetentionSweep();
    expect(yieldFn).toHaveBeenCalledTimes(1);
    expect(writer.pruneReferenceMarkoutEvidence).toHaveBeenCalledTimes(2);
    expect(writer.pruneReferenceQuoteDecisions).not.toHaveBeenCalled();
    expect(collector.getStats().retentionBacklog).toEqual({
      work: true, decisions: true, observations: true,
    });
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
        product: 'BTC-USD', quoteCurrency: 'USD', sourceExchange: 'coinbase',
        sourceTimestamp: timestamp - 20, receivedTimestamp: timestamp - 10,
        basisAdjustmentBps,
        promotionGrade: true, basisSource: 'kraken-pretrade',
        basisRequestedPair: 'PYUSD/USD', basisResolvedPair: 'PYUSD/USD',
        basisBase: 'PYUSD', basisQuote: 'USD', basisVenue: 'TEST', basisSystem: 'CLOB',
        basisPrice: 1.002, basisBid: 1.0019, basisAsk: 1.0021,
        basisBidQty: 1, basisAskQty: 1, basisBidCount: 1, basisAskCount: 1,
        basisRequestTimestamp: timestamp - 50, basisReceivedTimestamp: timestamp - 10,
        basisBidSubmissionTimestamp: timestamp - 40,
        basisBidPublicationTimestamp: timestamp - 20,
        basisAskSubmissionTimestamp: timestamp - 35,
        basisAskPublicationTimestamp: timestamp - 15, basisTimestamp: timestamp - 20,
      })),
      candidateId: 'basis-contract',
      shadowEvidence: {
        observed: true, candidateId: 'basis-contract', fillSurvivalRate: 1, clusterCount: 1,
      },
      config: {
        heldOutDays: 1, primaryHorizon: '1m', bootstrap: { iterations: 10 },
        sourceQuality: { basisVenueAllowlist: ['TEST'] },
        gates: {
          minReferenceCoverage: 0, minClusters: 0, minObservationDays: 0,
          minLowerBoundBps: 0, minShadowClusters: 0, minShadowFillSurvivalRate: 0,
        },
      },
    });
    expect(result.heldOut.metrics.observedEdgeBps.mean).toBeCloseTo(-19.96007984, 6);
  });
});
