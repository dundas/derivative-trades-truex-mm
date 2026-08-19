#!/usr/bin/env bun

function usage() {
  return 'Usage: bun scripts/export-regime-validator-evidence.js --from EPOCH_MS --to EPOCH_MS [--max-fills N] [--max-references N] [--query-timeout-ms N]';
}

function parseArgs(args) {
  const parsed = {};
  const allowed = new Set(['--from', '--to', '--max-fills', '--max-references',
    '--query-timeout-ms']);
  if (args.length === 0 || args.length % 2 !== 0) throw new Error(usage());
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const raw = args[index + 1];
    if (!allowed.has(flag) || raw === undefined || Object.hasOwn(parsed, flag)) {
      throw new Error(usage());
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${flag} must be a non-negative safe integer`);
    }
    parsed[flag] = value;
  }
  if (parsed['--from'] === undefined || parsed['--to'] === undefined) throw new Error(usage());
  if (parsed['--from'] > parsed['--to']) throw new Error('--from must not exceed --to');
  for (const flag of ['--max-fills', '--max-references']) {
    if (parsed[flag] !== undefined && (parsed[flag] < 1 || parsed[flag] > 1_000_000)) {
      throw new Error(`${flag} must be between 1 and 1000000`);
    }
  }
  const queryTimeoutMs = parsed['--query-timeout-ms'] ?? 30_000;
  if (queryTimeoutMs < 1_000 || queryTimeoutMs > 120_000) {
    throw new Error('--query-timeout-ms must be between 1000 and 120000');
  }
  return {
    fromTimestamp: parsed['--from'], toTimestamp: parsed['--to'],
    maxFills: parsed['--max-fills'] ?? 100_000,
    maxReferences: parsed['--max-references'] ?? 500_000,
    queryTimeoutMs,
  };
}

function collectionEnabledFromEnvironment(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('REFERENCE_MARKOUT_ENABLED must be an unambiguous boolean');
}

let client;
let transactionOpen = false;
try {
  const args = parseArgs(process.argv.slice(2));
  const collectionEnabledAtExport = collectionEnabledFromEnvironment(
    process.env.REFERENCE_MARKOUT_ENABLED,
  );
  const [{ Client }, { resolvePostgreSQLConnectionConfig },
    { buildReferenceMarkoutRolloutOptions }, { loadRegimeValidatorEvidence }] = await Promise.all([
    import('pg'),
    import('../lib/postgresql-api/index.js'),
    import('./reference-markout-rollout-config.js'),
    import('../src/analytics/regime-evidence-export.js'),
  ]);
  // Export remains available after the collector is safely disabled. Force only the copied
  // environment to enabled so the complete dormant source config is validated; record the real
  // toggle separately and never mutate process.env or production state.
  const rollout = buildReferenceMarkoutRolloutOptions({
    ...process.env,
    REFERENCE_MARKOUT_ENABLED: 'true',
  });
  const config = rollout.referenceMarkoutConfig;
  if (!config) throw new Error('validated reference mark-out configuration is required');
  client = new Client({
    ...resolvePostgreSQLConnectionConfig(process.env.DATABASE_URL, process.env.POSTGRES_SSL_CA),
    query_timeout: args.queryTimeoutMs,
  });
  await client.connect();
  await client.query('BEGIN READ ONLY');
  transactionOpen = true;
  await client.query(`SET LOCAL statement_timeout = '${args.queryTimeoutMs}ms'`);
  await client.query("SET LOCAL lock_timeout = '1000ms'");
  const evidence = await loadRegimeValidatorEvidence(client, {
    ...args,
    maxHorizonMs: Math.max(...config.horizonsMs),
    referenceMaxAgeMs: 30_000,
    sourceQuality: config,
  });
  await client.query('COMMIT');
  transactionOpen = false;
  process.stdout.write(`${JSON.stringify({ ...evidence,
    exportMetadata: { ...evidence.exportMetadata, generatedAt: Date.now(),
      collectionEnabledAtExport },
  }, null, 2)}\n`);
} catch (error) {
  if (transactionOpen) await client?.query('ROLLBACK').catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
