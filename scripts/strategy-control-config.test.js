import { describe, expect, test } from 'bun:test';
import {
  buildInventoryRebalanceShadowConfig,
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
});
