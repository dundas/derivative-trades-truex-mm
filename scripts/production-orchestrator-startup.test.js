import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { startProductionOrchestrator } from './production-orchestrator-startup.js';

describe('production orchestrator startup authority', () => {
  test('propagates scoped orchestrator startup failure without account-wide cancellation', async () => {
    const cancelAllOrders = mock(async () => {});
    const orchestrator = {
      restClient: { cancelAllOrders },
      start: mock(async () => { throw new Error('scoped strict reconciliation failed'); }),
    };

    await expect(startProductionOrchestrator(orchestrator))
      .rejects.toThrow('scoped strict reconciliation failed');
    expect(orchestrator.start).toHaveBeenCalledTimes(1);
    expect(cancelAllOrders).not.toHaveBeenCalled();
  });

  test('run-prod contains no account-wide cancellation escape hatch', () => {
    const source = readFileSync(new URL('./run-prod.js', import.meta.url), 'utf8');
    expect(source).not.toContain('.cancelAllOrders(');
    expect(source).toContain('startProductionOrchestrator(orchestrator)');
  });
});
