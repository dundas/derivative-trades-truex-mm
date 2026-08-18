import { describe, expect, test } from 'bun:test';
import { buildReferenceMarkoutRolloutOptions } from './reference-markout-rollout-config.js';

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
      REFERENCE_MARKOUT_ENABLED: 'true',
      REFERENCE_MARKOUT_HORIZONS_MS: '300000,60000',
      REFERENCE_MARKOUT_BATCH_SIZE: '25',
    });
    expect(options).toEqual({
      referenceMarkoutConfig: expect.objectContaining({
        product: 'BTC-USD', quoteCurrency: 'USD', sourceExchange: 'coinbase',
        sourceType: 'top-of-book', horizonsMs: [60_000, 300_000], batchSize: 25,
      }),
    });
    expect(Object.isFrozen(options.referenceMarkoutConfig)).toBe(true);
  });

  test('rejects ambiguous kill-switch and enabled configuration values', () => {
    expect(() => buildReferenceMarkoutRolloutOptions({ REFERENCE_MARKOUT_ENABLED: 'maybe' }))
      .toThrow('REFERENCE_MARKOUT_ENABLED');
    expect(() => buildReferenceMarkoutRolloutOptions({
      REFERENCE_MARKOUT_ENABLED: 'true', REFERENCE_MARKOUT_BATCH_SIZE: '1.5',
    })).toThrow('batchSize');
    expect(() => buildReferenceMarkoutRolloutOptions({
      REFERENCE_MARKOUT_ENABLED: 'true', REFERENCE_MARKOUT_HORIZONS_MS: '60000,nope',
    })).toThrow('REFERENCE_MARKOUT_HORIZONS_MS');
  });
});
