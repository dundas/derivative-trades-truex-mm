import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildInventoryRebalanceShadowConfig,
  buildInventoryRecoveryConfig,
  buildMinimalLiveCanaryConfig,
  buildMakerPresenceObservationConfig,
  buildMakerPresenceRecoveryConfig,
} from './strategy-control-config.js';

describe('strategy control config', () => {
  test('keeps live recovery opt-in and shadow inventory observation on by default', () => {
    expect(buildMakerPresenceRecoveryConfig()).toMatchObject({ enabled: false, maxAttemptsPerWindow: 3 });
    expect(buildInventoryRebalanceShadowConfig()).toMatchObject({
      enabled: true,
      targetInventoryBTC: 0.014,
      sampleIntervalMs: 5000,
      minimumMakerParticipation: 0.25,
      maxQuoteSkewBps: 10,
    });
  });

  test('enables bounded presence observations by default and rejects unsafe cadence', () => {
    expect(buildMakerPresenceObservationConfig()).toEqual({ enabled: true, sampleIntervalMs: 30_000 });
    expect(buildMakerPresenceObservationConfig({
      MM_PRESENCE_OBSERVATION_ENABLED: 'false', MM_PRESENCE_OBSERVATION_INTERVAL_MS: '5000',
    })).toEqual({ enabled: false, sampleIntervalMs: 5000 });
    expect(() => buildMakerPresenceObservationConfig({ MM_PRESENCE_OBSERVATION_INTERVAL_MS: '4999' }))
      .toThrow('[5000,300000]');
  });

  test('production Compose forwards operator-configurable presence observation controls', () => {
    const compose = readFileSync(new URL('../docker-compose.prod.yml', import.meta.url), 'utf8');
    expect(compose).toContain('MM_PRESENCE_OBSERVATION_ENABLED=${MM_PRESENCE_OBSERVATION_ENABLED:-true}');
    expect(compose).toContain('MM_PRESENCE_OBSERVATION_INTERVAL_MS=${MM_PRESENCE_OBSERVATION_INTERVAL_MS:-30000}');
  });

  test('accepts explicit policy overrides and rejects ambiguous controls', () => {
    expect(buildMakerPresenceRecoveryConfig({
      MM_PRESENCE_RECOVERY_ENABLED: 'true',
      MM_PRESENCE_RECOVERY_MAX_ATTEMPTS: '4',
    })).toMatchObject({ enabled: true, maxAttemptsPerWindow: 4 });
    expect(buildInventoryRebalanceShadowConfig({
      INVENTORY_REBALANCE_TARGET_BTC: '0.02',
      INVENTORY_REBALANCE_SIGMA_BTC: '0.005',
    })).toMatchObject({ targetInventoryBTC: 0.02, inventorySigmaBTC: 0.005 });
    expect(() => buildMakerPresenceRecoveryConfig({ MM_PRESENCE_RECOVERY_ENABLED: 'maybe' })).toThrow('boolean');
    expect(() => buildInventoryRebalanceShadowConfig({ INVENTORY_REBALANCE_SIGMA_BTC: '0' })).toThrow('positive');
  });

  test('keeps inventory recovery disabled unless every economic control is explicitly supplied', () => {
    expect(buildInventoryRecoveryConfig()).toEqual({ enabled: false });
    expect(() => buildInventoryRecoveryConfig({
      MM_INVENTORY_RECOVERY_ENABLED: 'true', MM_QUOTE_DISPATCH_MODE: 'observe',
    }))
      .toThrow('MM_INVENTORY_RECOVERY_INTERIM_TARGET_BTC is required');
    const config = buildInventoryRecoveryConfig({
      MM_INVENTORY_RECOVERY_ENABLED: 'true',
      MM_QUOTE_DISPATCH_MODE: 'observe',
      MM_INVENTORY_RECOVERY_INTERIM_TARGET_BTC: '0.02',
      MM_INVENTORY_RECOVERY_SIGMA_BTC: '0.005',
      MM_INVENTORY_RECOVERY_CENTER_BAND_SIGMA: '0.5',
      MM_INVENTORY_RECOVERY_SOFT_BAND_SIGMA: '2',
      MM_INVENTORY_RECOVERY_HARD_BAND_SIGMA: '3',
      MM_INVENTORY_RECOVERY_MAKER_FLOOR: '0.25',
      MM_INVENTORY_RECOVERY_MAX_SIZE_ASYMMETRY: '0.75',
      MM_INVENTORY_RECOVERY_MAX_QUOTE_SKEW_BPS: '10',
    });
    expect(config).toMatchObject({ enabled: true, interimTargetInventoryBTC: 0.02 });
  });

  test('rejects recovery enablement in live dispatch mode during production config construction', () => {
    expect(() => buildInventoryRecoveryConfig({ MM_INVENTORY_RECOVERY_ENABLED: 'true' }))
      .toThrow('MM_QUOTE_DISPATCH_MODE=observe');
    expect(() => buildInventoryRecoveryConfig({ MM_INVENTORY_RECOVERY_ENABLED: 'true' }, {
      quoteDispatchMode: 'live',
    })).toThrow('MM_QUOTE_DISPATCH_MODE=observe');
  });
});

describe('minimal live canary config', () => {
  const policy = Object.freeze({
    normalQuoteLevels: 1, baseQuoteSizeBTC: 0.0005,
    minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
  });
  const markouts = Object.freeze({ horizonsMs: [60_000], maxLatenessMs: 30_000, pollIntervalMs: 1_000, claimLeaseMs: 5_000 });

  test('is explicitly disabled by default and requires bounded controls when live', () => {
    expect(buildMinimalLiveCanaryConfig()).toEqual({ enabled: false });
    expect(() => buildMinimalLiveCanaryConfig({
      MM_MINIMAL_LIVE_CANARY_ENABLED: 'true', MM_MINIMAL_LIVE_CANARY_RUN_ID: 'canary-run-0001',
    }, {
      quoteDispatchMode: 'live', makerQuotePolicyConfig: policy, referenceMarkoutConfig: markouts,
    })).toThrow('MM_MINIMAL_LIVE_CANARY_DURATION_MS is required');
    expect(() => buildMinimalLiveCanaryConfig({
      MM_MINIMAL_LIVE_CANARY_ENABLED: 'true',
      MM_MINIMAL_LIVE_CANARY_RUN_ID: 'canary-run-0001',
      MM_MINIMAL_LIVE_CANARY_DURATION_MS: '900000',
      MM_MINIMAL_LIVE_CANARY_MAX_CUMULATIVE_FILLED_BTC: '0.001',
    }, { quoteDispatchMode: 'observe', makerQuotePolicyConfig: policy, referenceMarkoutConfig: markouts }))
      .toThrow('MM_QUOTE_DISPATCH_MODE=live');
  });

  test('accepts only the reviewed live envelope', () => {
    expect(buildMinimalLiveCanaryConfig({
      MM_MINIMAL_LIVE_CANARY_ENABLED: 'true',
      MM_MINIMAL_LIVE_CANARY_RUN_ID: 'canary-run-0001',
      MM_MINIMAL_LIVE_CANARY_DURATION_MS: '900000',
      MM_MINIMAL_LIVE_CANARY_MAX_CUMULATIVE_FILLED_BTC: '0.001',
    }, { quoteDispatchMode: 'live', makerQuotePolicyConfig: policy, referenceMarkoutConfig: markouts }))
      .toMatchObject({ enabled: true, durationMs: 900000, maxCumulativeFilledBTC: 0.001,
        oneMinuteMarkoutDeadlineMs: 96_000 });
    expect(() => buildMinimalLiveCanaryConfig({
      MM_MINIMAL_LIVE_CANARY_ENABLED: 'true',
      MM_MINIMAL_LIVE_CANARY_RUN_ID: 'canary-run-0001',
      MM_MINIMAL_LIVE_CANARY_DURATION_MS: '900001',
      MM_MINIMAL_LIVE_CANARY_MAX_CUMULATIVE_FILLED_BTC: '0.001',
    }, { quoteDispatchMode: 'live', makerQuotePolicyConfig: policy, referenceMarkoutConfig: markouts }))
      .toThrow('15 minutes');
    expect(() => buildMinimalLiveCanaryConfig({
      MM_MINIMAL_LIVE_CANARY_ENABLED: 'true',
      MM_MINIMAL_LIVE_CANARY_RUN_ID: 'canary-run-0001',
      MM_MINIMAL_LIVE_CANARY_DURATION_MS: '900000',
      MM_MINIMAL_LIVE_CANARY_MAX_CUMULATIVE_FILLED_BTC: '0.001',
    }, { quoteDispatchMode: 'live', makerQuotePolicyConfig: policy }))
      .toThrow('60000ms');
  });
});
