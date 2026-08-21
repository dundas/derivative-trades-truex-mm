import { describe, expect, test } from 'bun:test';
import { buildQuoteDispatchMode } from './quote-dispatch-mode-config.js';

describe('quote dispatch mode config', () => {
  test('defaults to live and accepts an explicit observe-only deployment', () => {
    expect(buildQuoteDispatchMode({})).toBe('live');
    expect(buildQuoteDispatchMode({ MM_QUOTE_DISPATCH_MODE: 'observe' })).toBe('observe');
  });

  test.each(['', 'paused', 'true', 'live;observe'])('rejects invalid modes: %s', (mode) => {
    expect(() => buildQuoteDispatchMode({ MM_QUOTE_DISPATCH_MODE: mode }))
      .toThrow('MM_QUOTE_DISPATCH_MODE must be live or observe');
  });
});
