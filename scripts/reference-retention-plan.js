#!/usr/bin/env bun
import pg from 'pg';
import { resolvePostgreSQLConnectionConfig } from '../lib/postgresql-api/index.js';

const { Client } = pg;

function positiveSafeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

export function buildReferenceRetentionPlanQueries({ cutoffTimestamp, batchSize, analyze = false }) {
  if (!Number.isSafeInteger(cutoffTimestamp)) throw new Error('cutoffTimestamp must be a safe integer');
  positiveSafeInteger('batchSize', batchSize);
  const prefix = analyze
    ? 'EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, FORMAT JSON) '
    : 'EXPLAIN (FORMAT JSON, COSTS TRUE) ';
  return [
    {
      name: 'completed-work', values: [cutoffTimestamp, batchSize],
      sql: `${prefix}SELECT fill_id, horizon_ms FROM fill_reference_markout_work
        WHERE state = 'completed' AND completed_at < $1
        ORDER BY completed_at, fill_id, horizon_ms LIMIT $2`,
    },
    {
      name: 'quote-decisions', values: [cutoffTimestamp, batchSize],
      sql: `${prefix}SELECT decision_id FROM reference_quote_decisions decision
        WHERE decision_timestamp < $1 AND NOT EXISTS (
          SELECT 1 FROM fill_reference_markout_work work
          WHERE work.state <> 'completed' AND work.session_id = decision.session_id
            AND work.quote_id = decision.quote_id)
        ORDER BY decision_timestamp, decision_id LIMIT $2`,
    },
    {
      name: 'market-observations', values: [cutoffTimestamp, batchSize],
      sql: `${prefix}SELECT observation_id FROM reference_market_observations observation
        WHERE received_timestamp < $1 AND NOT EXISTS (
          SELECT 1 FROM fill_reference_markout_work work WHERE work.state <> 'completed'
            AND observation.observation_timestamp BETWEEN work.due_timestamp AND work.deadline_timestamp)
        ORDER BY received_timestamp, observation_timestamp, observation_id LIMIT $2`,
    },
  ];
}

function planDocument(result) {
  const value = result.rows?.[0]?.['QUERY PLAN'];
  return Array.isArray(value) ? value[0] : value;
}

function scanMetrics(node, totals = {
  scannedRows: 0, removedRows: 0, indexNodes: [], planNodeTypes: [], sortMethods: [],
  tempBlocks: 0, sharedHitBlocks: 0, sharedReadBlocks: 0, localHitBlocks: 0,
  localReadBlocks: 0,
}) {
  if (!node || typeof node !== 'object') return totals;
  if (node['Node Type']) totals.planNodeTypes.push(node['Node Type']);
  if (typeof node['Actual Rows'] === 'number' && /Scan|Index/.test(node['Node Type'] || '')) {
    totals.scannedRows += node['Actual Rows'] * (node['Actual Loops'] || 1);
    totals.removedRows += (node['Rows Removed by Filter'] || 0) * (node['Actual Loops'] || 1);
  }
  if (node['Index Name']) totals.indexNodes.push(node['Index Name']);
  if (node['Sort Method']) totals.sortMethods.push(node['Sort Method']);
  totals.tempBlocks += (node['Temp Read Blocks'] || 0) + (node['Temp Written Blocks'] || 0);
  totals.sharedHitBlocks += node['Shared Hit Blocks'] || 0;
  totals.sharedReadBlocks += node['Shared Read Blocks'] || 0;
  totals.localHitBlocks += node['Local Hit Blocks'] || 0;
  totals.localReadBlocks += node['Local Read Blocks'] || 0;
  for (const child of node.Plans || []) scanMetrics(child, totals);
  return totals;
}

export async function runReadOnlyRetentionPlans(client, { cutoffTimestamp, batchSize }) {
  await client.query('BEGIN READ ONLY');
  try {
    const output = [];
    for (const query of buildReferenceRetentionPlanQueries({ cutoffTimestamp, batchSize })) {
      const startedAt = performance.now();
      const result = await client.query(query.sql, query.values);
      output.push({ name: query.name, planningRoundTripMs: performance.now() - startedAt,
        plan: planDocument(result) });
    }
    return output;
  } finally {
    await client.query('ROLLBACK');
  }
}

export async function runRepresentativeRetentionBenchmark(client, {
  observationRows = 250_000, decisionRows = 250_000, workRows = 750_000,
  batchSize = 10_000, maxExecutionMs = 2_000, maxScanMultiple = 2,
} = {}) {
  for (const [name, value] of Object.entries({ observationRows, decisionRows, workRows, batchSize })) {
    positiveSafeInteger(name, value);
  }
  await client.query('BEGIN');
  try {
    await client.query(`CREATE TEMP TABLE reference_quote_decisions (
      decision_id text PRIMARY KEY, decision_timestamp bigint NOT NULL, session_id text, quote_id text NOT NULL)`);
    await client.query(`CREATE TEMP TABLE reference_market_observations (
      observation_id text PRIMARY KEY, observation_timestamp bigint NOT NULL, received_timestamp bigint NOT NULL)`);
    await client.query(`CREATE TEMP TABLE fill_reference_markout_work (
      fill_id text NOT NULL, horizon_ms bigint NOT NULL, state text NOT NULL,
      completed_at bigint, session_id text, quote_id text, due_timestamp bigint NOT NULL,
      deadline_timestamp bigint NOT NULL, PRIMARY KEY(fill_id, horizon_ms))`);
    await client.query(`INSERT INTO reference_quote_decisions
      SELECT 'd-' || n, n, 's-' || (n % 100), 'q-' || n FROM generate_series(1, $1) n`, [decisionRows]);
    await client.query(`INSERT INTO reference_market_observations
      SELECT 'o-' || n, n, n FROM generate_series(1, $1) n`, [observationRows]);
    await client.query(`INSERT INTO fill_reference_markout_work
      SELECT 'f-' || n, ((n % 3) + 1) * 60000, 'completed', n,
        's-' || (n % 100), 'q-' || n, n, n + 30000 FROM generate_series(1, $1) n`, [workRows]);
    // Representative unfinished windows exercise both anti-join protection paths.
    await client.query(`INSERT INTO fill_reference_markout_work VALUES
      ('unfinished', 60000, 'pending', NULL, 's-1', 'q-1', $1 - 100, $1)`, [observationRows]);
    await client.query(`CREATE INDEX bench_decision_retention ON reference_quote_decisions
      (decision_timestamp, decision_id, session_id, quote_id)`);
    await client.query(`CREATE INDEX bench_market_retention ON reference_market_observations
      (received_timestamp, observation_timestamp, observation_id)`);
    await client.query(`CREATE INDEX bench_work_retention ON fill_reference_markout_work
      (completed_at, fill_id, horizon_ms) WHERE state = 'completed'`);
    await client.query(`CREATE INDEX bench_pending_attribution ON fill_reference_markout_work
      (session_id, quote_id) WHERE state <> 'completed'`);
    await client.query(`CREATE INDEX bench_unfinished_window ON fill_reference_markout_work
      (due_timestamp, deadline_timestamp) WHERE state <> 'completed'`);
    await client.query('ANALYZE reference_quote_decisions');
    await client.query('ANALYZE reference_market_observations');
    await client.query('ANALYZE fill_reference_markout_work');

    const sizeResult = await client.query(`SELECT relation,
      pg_total_relation_size(('pg_temp.' || relation)::regclass)::bigint AS total_bytes,
      pg_relation_size(('pg_temp.' || relation)::regclass)::bigint AS table_bytes,
      pg_indexes_size(('pg_temp.' || relation)::regclass)::bigint AS index_bytes
      FROM unnest(ARRAY['reference_market_observations','reference_quote_decisions',
        'fill_reference_markout_work']) relation ORDER BY relation`);
    const relationSizes = Object.fromEntries(sizeResult.rows.map(row => [row.relation, {
      totalBytes: Number(row.total_bytes), tableBytes: Number(row.table_bytes),
      indexBytes: Number(row.index_bytes),
    }]));

    const results = [];
    for (const query of buildReferenceRetentionPlanQueries({
      cutoffTimestamp: Math.min(observationRows, decisionRows, workRows) + 1,
      batchSize, analyze: true,
    })) {
      const result = await client.query(query.sql, query.values);
      const document = planDocument(result);
      const metrics = scanMetrics(document?.Plan);
      const executionMs = document?.['Execution Time'];
      if (!Number.isFinite(executionMs) || executionMs > maxExecutionMs) {
        throw new Error(`${query.name} exceeded benchmark threshold: ${executionMs}ms > ${maxExecutionMs}ms`);
      }
      const returnedRows = document?.Plan?.['Actual Rows'];
      if (!Number.isFinite(returnedRows) || returnedRows < 1 ||
          metrics.scannedRows > returnedRows * maxScanMultiple) {
        throw new Error(`${query.name} exceeded scan threshold: ${metrics.scannedRows} scanned for ${returnedRows} returned`);
      }
      if (metrics.planNodeTypes.includes('Seq Scan') || metrics.tempBlocks > 0 ||
          metrics.sortMethods.some(method => /external|disk/i.test(method))) {
        throw new Error(`${query.name} used an unsafe scale plan`);
      }
      results.push({ name: query.name, executionMs, returnedRows, ...metrics });
    }
    return { scale: 'scaled-local', volumes: { observationRows, decisionRows, workRows },
      relationSizes, batchSize, thresholds: { maxExecutionMs, maxScanMultiple,
        requireIndexedScans: true, allowTempSpill: false }, results };
  } finally {
    await client.query('ROLLBACK');
  }
}

function connectionStringFromEnv(env) {
  return env.DATABASE_URL || env.POSTGRES_URL || env.NEON_CONN || env.NEON_DATABASE_URL;
}

if (import.meta.main) {
  const connectionString = connectionStringFromEnv(process.env);
  if (!connectionString) throw new Error('a PostgreSQL connection URL is required');
  const client = new Client(resolvePostgreSQLConnectionConfig(
    connectionString, process.env.POSTGRES_SSL_CA || undefined,
  ));
  await client.connect();
  try {
    if (process.argv.includes('--benchmark')) {
      console.log(JSON.stringify(await runRepresentativeRetentionBenchmark(client), null, 2));
    } else {
      const cutoffTimestamp = Number(process.argv[2]);
      const batchSize = Number(process.argv[3] ?? 10_000);
      const plans = await runReadOnlyRetentionPlans(client, { cutoffTimestamp, batchSize });
      console.log(JSON.stringify({ cutoffTimestamp, batchSize, readOnly: true, plans }, null, 2));
    }
  } finally {
    await client.end();
  }
}
