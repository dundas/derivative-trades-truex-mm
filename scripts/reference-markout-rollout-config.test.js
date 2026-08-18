import { describe, expect, test } from 'bun:test';
import { buildReferenceMarkoutRolloutOptions } from './reference-markout-rollout-config.js';

const ENABLED = {
  REFERENCE_MARKOUT_ENABLED: 'true',
  REFERENCE_MARKOUT_BASIS_VENUE_ALLOWLIST: 'PDSL',
};

describe('reference mark-out production rollout options', () => {
  test('defaults off and omits the orchestrator config entirely', () => {
    expect(buildReferenceMarkoutRolloutOptions({})).toEqual({});
    expect(buildReferenceMarkoutRolloutOptions({ REFERENCE_MARKOUT_ENABLED: 'false' }))
      .toEqual({});
  });

  test('does not parse dormant reference settings while disabled', () => {
    expect(buildReferenceMarkoutRolloutOptions({
      REFERENCE_MARKOUT_ENABLED: '0',
      REFERENCE_MARKOUT_HORIZONS_MS: 'not-a-number',
    })).toEqual({});
  });

  test('passes the validated enabled config without wrapper mutations', () => {
    const options = buildReferenceMarkoutRolloutOptions({
      ...ENABLED,
      REFERENCE_MARKOUT_HORIZONS_MS: '300000,60000',
      REFERENCE_MARKOUT_BATCH_SIZE: '25',
      REFERENCE_MARKOUT_RETENTION_BATCH_SIZE: '321',
      REFERENCE_MARKOUT_RETENTION_MAX_BATCHES_PER_SWEEP: '25',
      REFERENCE_MARKOUT_MAX_QUOTE_DECISIONS_PER_SECOND: '1',
      REFERENCE_MARKOUT_PLANNING_FILL_EVENTS_PER_SECOND: '1',
      REFERENCE_MARKOUT_BASIS_VENUE_ALLOWLIST: 'PDSL,ALT1',
      REFERENCE_MARKOUT_MAX_BASIS_RTT_MS: '750',
    });
    expect(options).toEqual({
      referenceMarkoutConfig: expect.objectContaining({
        product: 'BTC-USD', quoteCurrency: 'USD', sourceExchange: 'coinbase',
        sourceType: 'top-of-book', horizonsMs: [60_000, 300_000], batchSize: 25,
        retentionBatchSize: 321,
        retentionMaxBatchesPerSweep: 25, maxQuoteDecisionsPerSecond: 1,
        planningFillEventsPerSecond: 1,
        basisVenueAllowlist: ['PDSL', 'ALT1'], maxBasisRttMs: 750,
      }),
    });
    expect(Object.isFrozen(options.referenceMarkoutConfig)).toBe(true);
  });

  test('cross-checks retention capacity against the enforced production order rate', () => {
    expect(buildReferenceMarkoutRolloutOptions(ENABLED, {
      maxQuoteDecisionsPerSecond: 6,
    }).referenceMarkoutConfig.maxQuoteDecisionsPerSecond).toBe(6);
    expect(() => buildReferenceMarkoutRolloutOptions({
      ...ENABLED,
      REFERENCE_MARKOUT_MAX_QUOTE_DECISIONS_PER_SECOND: '5',
    }, { maxQuoteDecisionsPerSecond: 6 })).toThrow('must equal the enforced order rate');
  });

  test('rejects ambiguous kill-switch and enabled configuration values', () => {
    expect(() => buildReferenceMarkoutRolloutOptions({ REFERENCE_MARKOUT_ENABLED: 'maybe' }))
      .toThrow('REFERENCE_MARKOUT_ENABLED');
    expect(() => buildReferenceMarkoutRolloutOptions({
      ...ENABLED, REFERENCE_MARKOUT_BATCH_SIZE: '1.5',
    })).toThrow('batchSize');
    expect(() => buildReferenceMarkoutRolloutOptions({
      ...ENABLED, REFERENCE_MARKOUT_HORIZONS_MS: '60000,nope',
    })).toThrow('REFERENCE_MARKOUT_HORIZONS_MS');
    expect(() => buildReferenceMarkoutRolloutOptions({ REFERENCE_MARKOUT_ENABLED: 'true' }))
      .toThrow('REFERENCE_MARKOUT_BASIS_VENUE_ALLOWLIST');
    expect(() => buildReferenceMarkoutRolloutOptions({
      ...ENABLED, REFERENCE_MARKOUT_MAX_BASIS_RTT_MS: '1001',
    }, { basisPollTimeoutMs: 1000 })).toThrow('PYUSD_USD_POLL_TIMEOUT_MS');
  });
});
