import { describe, expect, mock, test } from 'bun:test';
import { MinimalLiveCanary, validateMinimalLiveCanaryConfig } from './minimal-live-canary.js';

const config = { enabled: true, runId: 'canary-run-0001', durationMs: 900_000, maxCumulativeFilledBTC: 0.001,
  oneMinuteMarkoutDeadlineMs: 91_000, levels: 1, baseSizeBTC: 0.0005,
  minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80 };

describe('MinimalLiveCanary', () => {
  test('is disabled unless explicitly configured and rejects any larger envelope', () => {
    expect(validateMinimalLiveCanaryConfig()).toEqual({ enabled: false });
    expect(() => validateMinimalLiveCanaryConfig({ ...config, levels: 2 })).toThrow('one level');
    expect(() => validateMinimalLiveCanaryConfig({ ...config, contractMaxQuoteSpreadBps: 81 })).toThrow('30-80');
    expect(() => validateMinimalLiveCanaryConfig({ ...config, maxCumulativeFilledBTC: 0.0005 })).toThrow('initial two-sided');
    expect(() => validateMinimalLiveCanaryConfig({ ...config, oneMinuteMarkoutDeadlineMs: 59_999 })).toThrow('one-minute horizon');
  });

  test('stops once on expiry, cumulative fill cap, or first adverse attributed markout', () => {
    let now = 1_000;
    const stop = mock(() => {});
    const timers = [];
    const canary = new MinimalLiveCanary(config, { now: () => now, stop,
      setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: mock(() => {}) });
    expect(canary.canPlace()).toBe(false);
    expect(canary.arm()).toBe(true);
    expect(canary.canPlace()).toBe(true);
    expect(canary.recordFill(0.0005, 'F1')).toBe(true);
    expect(timers.at(-1)).toBeDefined();
    expect(canary.canPlace()).toBe(false);
    expect(canary.recordMarkout({ fillId: 'F1', available: true, attributed: true, observedEdgeBps: -0.01 })).toBe(false);
    expect(canary.snapshot().stopReason).toBe('adverse-one-minute-markout');
    expect(stop).toHaveBeenCalledTimes(1);

    const capped = new MinimalLiveCanary(config, { now: () => now, stop: mock(() => {}), setTimer: () => 1, clearTimer: mock(() => {}) });
    capped.arm();
    expect(capped.recordFill(0.001, 'F2')).toBe(false);
    expect(capped.snapshot().stopReason).toBe('cumulative-fill-cap');
    const expired = new MinimalLiveCanary(config, { now: () => now, stop: mock(() => {}), setTimer: () => 1, clearTimer: mock(() => {}) });
    expired.arm();
    now += 900_000;
    expect(expired.canPlace()).toBe(false);
    expect(expired.snapshot().stopReason).toBe('expired');
  });

  test('fails closed when its one-minute markout is unavailable', () => {
    const timers = [];
    const canary = new MinimalLiveCanary(config, { setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: mock(() => {}) });
    canary.arm();
    expect(canary.recordFill(0.0005, 'F1')).toBe(true);
    timers.at(-1)();
    expect(canary.snapshot().stopReason).toBe('one-minute-markout-unavailable');
  });
});
