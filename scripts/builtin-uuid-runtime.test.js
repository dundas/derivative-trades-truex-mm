import { describe, expect, test } from 'bun:test';
import { WorkerManager } from '../lib/redis-backend-api/worker-manager.js';
import { duplicateSession } from '../lib/redis-backend-api/session-duplicator.js';

const UUID_RUNTIME_MODULES = [
  '../lib/redis-backend-api/worker-manager.js',
  '../lib/redis-backend-api/internal-session-creator.js',
  '../lib/redis-backend-api/session-duplicator.js',
  '../lib/redis-backend-api/rolling-session-manager.js',
];

describe('built-in UUID runtime dependency', () => {
  test('imports every UUID consumer without a third-party uuid package', async () => {
    for (const path of UUID_RUNTIME_MODULES) {
      await expect(import(path)).resolves.toBeDefined();
      const source = await Bun.file(new URL(path, import.meta.url)).text();
      expect(source).not.toContain("from 'uuid'");
      expect(source).not.toContain("import('uuid')");
    }
  });

  test('preserves short unique worker-id shape', () => {
    const first = WorkerManager.generateWorkerId({ exchange: 'kraken' });
    const second = WorkerManager.generateWorkerId({ exchange: 'kraken' });
    expect(first).toMatch(/^kraken-[0-9a-f]{8}$/);
    expect(second).toMatch(/^kraken-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  test('rejects prototype-mutating session overrides', () => {
    const original = {
      id: 'source', symbol: 'BTC-PYUSD', strategy: 'maker', exchange: 'truex',
      budget: 1, sessionLength: 60,
    };
    const overrides = JSON.parse('{"__proto__":{"polluted":true}}');

    expect(() => duplicateSession(original, { overrides })).toThrow('Unsafe session override key');
    expect({}.polluted).toBeUndefined();
  });
});
