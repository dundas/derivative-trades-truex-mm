import { describe, expect, test } from 'bun:test';
import { buildFeedPollConfig } from './feed-poll-config.js';

describe('feed poll config', () => {
  test('uses bounded defaults and permits an explicit PYUSD poll disable', () => {
    expect(buildFeedPollConfig({})).toEqual({
      pyusdUsdPollIntervalMs: 5000,
      pyusdUsdPollTimeoutMs: 1000,
      pyusdUsdStaleThresholdMs: 15000,
      truexEbboPollIntervalMs: 1000,
    });
    expect(buildFeedPollConfig({ PYUSD_USD_POLL_INTERVAL_MS: '0' }).pyusdUsdPollIntervalMs).toBe(0);
  });

  test.each([
    ['PYUSD_USD_POLL_INTERVAL_MS', '-1'],
    ['PYUSD_USD_POLL_INTERVAL_MS', 'NaN'],
    ['PYUSD_USD_POLL_TIMEOUT_MS', '0'],
    ['PYUSD_USD_STALE_THRESHOLD_MS', '1.5'],
    ['TRUEX_EBBO_POLL_INTERVAL_MS', '0'],
  ])('fails closed for invalid %s=%s', (name, value) => {
    expect(() => buildFeedPollConfig({ [name]: value })).toThrow(name);
  });
});
