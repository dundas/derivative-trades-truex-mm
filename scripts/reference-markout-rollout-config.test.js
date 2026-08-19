import { describe, expect, test } from 'bun:test';
import { buildReferenceMarkoutRolloutOptions } from './reference-markout-rollout-config.js';

const ENABLED = {
  REFERENCE_MARKOUT_ENABLED: 'true',
  REFERENCE_MARKOUT_SOURCE_WS_URL: 'wss://stream.crypto.com/exchange/v1/market',
  REFERENCE_MARKOUT_SOURCE_ENDPOINT_ALLOWLIST: 'wss://stream.crypto.com/exchange/v1/market',
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
      REFERENCE_MARKOUT_SOURCE_RECONNECT_DELAY_MS: '750',
    });
    expect(options).toEqual({
      referenceMarkoutConfig: expect.objectContaining({
        referenceMode: 'cryptocom-direct', product: 'BTC-PYUSD', quoteCurrency: 'PYUSD',
        sourceExchange: 'cryptocom', sourceType: 'public-ws-book',
        sourceInstrument: 'BTC_PYUSD', sourceChannel: 'book.BTC_PYUSD.10',
        horizonsMs: [60_000, 300_000], batchSize: 25,
        retentionBatchSize: 321,
        retentionMaxBatchesPerSweep: 25, maxQuoteDecisionsPerSecond: 1,
        planningFillEventsPerSecond: 1, basisVenueAllowlist: [],
      }),
      referenceBookFeedConfig: { url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD',
        depth: 10, maxAgeMs: 5000, reconnectDelayMs: 750, subscribeDelayMs: 1000,
        heartbeatTimeoutMs: 15000, reconnectJitterMs: 250 },
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

  test('canonicalizes explicit default TLS port across source, selector, and persisted identity', () => {
    const options = buildReferenceMarkoutRolloutOptions({
      ...ENABLED,
      REFERENCE_MARKOUT_SOURCE_WS_URL: 'wss://stream.crypto.com:443/exchange/v1/market',
      REFERENCE_MARKOUT_SOURCE_ENDPOINT_ALLOWLIST:
        'wss://stream.crypto.com:443/exchange/v1/market,wss://stream.crypto.com/exchange/v1/market',
    });
    expect(options.referenceBookFeedConfig.url)
      .toBe('wss://stream.crypto.com/exchange/v1/market');
    expect(options.referenceMarkoutConfig.sourceEndpointAllowlist)
      .toEqual(['wss://stream.crypto.com/exchange/v1/market']);
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
      .toThrow('REFERENCE_MARKOUT_SOURCE_WS_URL');
    expect(() => buildReferenceMarkoutRolloutOptions({
      ...ENABLED, REFERENCE_MARKOUT_SOURCE_RECONNECT_DELAY_MS: '1',
    })).toThrow('depth/reconnect');
  });
});
