import { describe, expect, test } from 'bun:test';
import {
  buildInventoryRebalanceShadowConfig,
  buildInventoryRecoveryConfig,
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
