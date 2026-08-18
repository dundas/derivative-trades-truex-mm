import { describe, expect, test } from 'bun:test';
import { buildTruexMakerSafetyConfig } from './truex-maker-safety-config.js';

const valid = {
  TRUEX_MAKER_SAFETY_STRICT: 'true',
  TRUEX_MAKER_MARKETABLE_ACTION: 'skip',
  TRUEX_MAKER_EBBO_MAX_AGE_MS: '3000',
  TRUEX_ALO_RETRY_COOLDOWN_MS: '10000',
  TRUEX_ALO_RETRY_MAX_ENTRIES: '128',
};

describe('production TrueX maker safety config', () => {
  test('requires strict mode and returns validated engine options', () => {
    expect(buildTruexMakerSafetyConfig(valid, { ebboPollIntervalMs: 1000, maxOrdersPerSecond: 6 })).toEqual({
      strictTruexMakerSafety: true,
      marketablePostOnlyAction: 'skip',
      truexMakerEbboMaxAgeMs: 3000,
      truexAloRetryCooldownMs: 10000,
      truexAloRetryMaxEntries: 128,
    });
  });

  test.each([
    [{ ...valid, TRUEX_MAKER_SAFETY_STRICT: 'false' }, 'must be true'],
    [{ ...valid, TRUEX_MAKER_MARKETABLE_ACTION: 'join' }, 'skip or slide'],
    [{ ...valid, TRUEX_MAKER_EBBO_MAX_AGE_MS: '999' }, 'at least the EBBO poll interval'],
    [{ ...valid, TRUEX_ALO_RETRY_COOLDOWN_MS: '0' }, 'positive integer'],
    [{ ...valid, TRUEX_ALO_RETRY_MAX_ENTRIES: '1.5' }, 'positive integer'],
    [{ ...valid, TRUEX_MAKER_EBBO_MAX_AGE_MS: '' }, 'is required'],
  ])('fails closed on invalid production input', (env, message) => {
    expect(() => buildTruexMakerSafetyConfig(env, { ebboPollIntervalMs: 1000, maxOrdersPerSecond: 6 })).toThrow(message);
  });

  test.each([
    [{ ...valid, TRUEX_MAKER_EBBO_MAX_AGE_MS: '3001' }, 'within three poll intervals'],
    [{ ...valid, TRUEX_ALO_RETRY_COOLDOWN_MS: '999' }, 'at least the EBBO poll interval'],
    [{ ...valid, TRUEX_ALO_RETRY_COOLDOWN_MS: '60001' }, 'at most 60 poll intervals'],
    [{ ...valid, TRUEX_ALO_RETRY_MAX_ENTRIES: '59' }, 'send-rate cooldown window'],
    [{ ...valid, TRUEX_ALO_RETRY_MAX_ENTRIES: '10001' }, 'at most 10000'],
  ])('bounds safety windows and cache capacity', (env, message) => {
    expect(() => buildTruexMakerSafetyConfig(env, { ebboPollIntervalMs: 1000, maxOrdersPerSecond: 6 })).toThrow(message);
  });

  test('cache lower bound covers the extra fixed-window second at exact and nonexact cooldowns', () => {
    expect(() => buildTruexMakerSafetyConfig({
      ...valid, TRUEX_ALO_RETRY_COOLDOWN_MS: '10000', TRUEX_ALO_RETRY_MAX_ENTRIES: '65',
    }, { ebboPollIntervalMs: 1000, maxOrdersPerSecond: 6 })).toThrow('send-rate cooldown window');
    expect(buildTruexMakerSafetyConfig({
      ...valid, TRUEX_ALO_RETRY_COOLDOWN_MS: '10000', TRUEX_ALO_RETRY_MAX_ENTRIES: '66',
    }, { ebboPollIntervalMs: 1000, maxOrdersPerSecond: 6 }).truexAloRetryMaxEntries).toBe(66);
    expect(() => buildTruexMakerSafetyConfig({
      ...valid, TRUEX_ALO_RETRY_COOLDOWN_MS: '10001', TRUEX_ALO_RETRY_MAX_ENTRIES: '65',
    }, { ebboPollIntervalMs: 1000, maxOrdersPerSecond: 6 })).toThrow('send-rate cooldown window');

    for (const [cooldown, minimum] of [[1999, 18], [10000, 66], [10001, 72]]) {
      expect(() => buildTruexMakerSafetyConfig({
        ...valid,
        TRUEX_ALO_RETRY_COOLDOWN_MS: String(cooldown),
        TRUEX_ALO_RETRY_MAX_ENTRIES: String(minimum - 1),
      }, { ebboPollIntervalMs: 1000, maxOrdersPerSecond: 6 })).toThrow('send-rate cooldown window');
      expect(buildTruexMakerSafetyConfig({
        ...valid,
        TRUEX_ALO_RETRY_COOLDOWN_MS: String(cooldown),
        TRUEX_ALO_RETRY_MAX_ENTRIES: String(minimum),
      }, { ebboPollIntervalMs: 1000, maxOrdersPerSecond: 6 }).truexAloRetryMaxEntries).toBe(minimum);
    }
  });
});
