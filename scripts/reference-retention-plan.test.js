import { describe, expect, it } from 'bun:test';
import {
  buildReferenceRetentionPlanQueries,
  runReadOnlyRetentionPlans,
} from './reference-retention-plan.js';

describe('reference retention planning harness', () => {
  it('builds bounded non-mutating candidate-plan queries', () => {
    const plans = buildReferenceRetentionPlanQueries({ cutoffTimestamp: 1_000, batchSize: 1_000 });
    expect(plans).toHaveLength(3);
    for (const plan of plans) {
      expect(plan.sql).toStartWith('EXPLAIN (FORMAT JSON, COSTS TRUE) SELECT');
      expect(plan.sql).toContain('LIMIT $2');
      expect(plan.values).toEqual([1_000, 1_000]);
      expect(plan.sql).not.toContain('DELETE');
      expect(plan.sql).not.toContain('ANALYZE');
    }
  });

  it('models quote-decision retention against all matching work, including completed evidence', () => {
    const decisionPlan = buildReferenceRetentionPlanQueries({
      cutoffTimestamp: 1_000, batchSize: 1_000,
    }).find(plan => plan.name === 'quote-decisions');
    expect(decisionPlan.sql).toContain('NOT EXISTS');
    expect(decisionPlan.sql).toContain('WHERE work.session_id = decision.session_id');
    expect(decisionPlan.sql).toContain('AND work.quote_id = decision.quote_id');
    expect(decisionPlan.sql).not.toContain("work.state <> 'completed'");
    expect(decisionPlan.sql).not.toContain('bench_pending_attribution');
  });

  it('enforces a read-only transaction and never initializes or mutates schema', async () => {
    const calls = [];
    const client = { query: async (sql) => {
      calls.push(sql);
      if (String(sql).startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{}] }] };
      return { rows: [] };
    } };
    await runReadOnlyRetentionPlans(client, { cutoffTimestamp: 1_000, batchSize: 100 });
    expect(calls[0]).toBe('BEGIN READ ONLY');
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.join('\n')).not.toContain('CREATE');
    expect(calls.join('\n')).not.toContain('DELETE');
    expect(calls.join('\n')).not.toContain('ANALYZE');
  });
});
