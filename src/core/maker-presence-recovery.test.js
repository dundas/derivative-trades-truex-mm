import { describe, expect, test } from 'bun:test';
import { MakerPresenceRecoveryController } from './maker-presence-recovery.js';

const config = {
  enabled: true,
  cooldownMs: 100,
  attemptWindowMs: 1000,
  maxAttemptsPerWindow: 2,
  rearmTimeoutMs: 50,
};

const gap = {
  executionState: 'degraded',
  reasons: ['missing-acknowledged-sell', 'sell-side-gap-exceeded'],
  present: { buy: true, sell: false, twoSided: false },
};

describe('MakerPresenceRecoveryController', () => {
  test('authorizes one bounded recovery only for a prolonged, recoverable gap', () => {
    let now = 1000;
    const controller = new MakerPresenceRecoveryController(config, { now: () => now });
    expect(controller.observe(gap, { authoritativeRecoveryAvailable: true })).toMatchObject({
      shouldRecover: true, state: 'reconciling', attemptsInWindow: 1,
    });
    expect(controller.observe(gap, { authoritativeRecoveryAvailable: true }).shouldRecover).toBeUndefined();
    controller.failed(new Error('REST timeout'));
    now += 99;
    expect(controller.observe(gap, { authoritativeRecoveryAvailable: true }).state).toBe('cooldown');
    now += 1;
    expect(controller.observe(gap, { authoritativeRecoveryAvailable: true }).shouldRecover).toBe(true);
    controller.failed(new Error('again'));
    now += 100;
    expect(controller.observe(gap, { authoritativeRecoveryAvailable: true }).state).toBe('blocked-attempt-budget');
  });

  test('never recovers unsafe state or without authoritative REST', () => {
    const controller = new MakerPresenceRecoveryController(config);
    expect(controller.observe({ ...gap, executionState: 'unsafe' }, {
      authoritativeRecoveryAvailable: true,
    }).state).toBe('blocked-unsafe');
    expect(controller.observe(gap, { authoritativeRecoveryAvailable: false }).state)
      .toBe('blocked-no-authoritative-rest');
  });

  test('requires observed two-sided presence to complete rearming', () => {
    let now = 1000;
    const controller = new MakerPresenceRecoveryController(config, { now: () => now });
    controller.observe(gap, { authoritativeRecoveryAvailable: true });
    controller.reconciled();
    expect(controller.snapshot().state).toBe('rearming');
    now += 10;
    expect(controller.observe({
      executionState: 'normal', reasons: [], present: { buy: true, sell: true, twoSided: true },
    }).state).toBe('monitoring');
  });
});
