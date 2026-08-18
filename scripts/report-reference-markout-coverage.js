#!/usr/bin/env bun
function usage() {
  return 'Usage: bun scripts/report-reference-markout-coverage.js [--from EPOCH_MS] [--to EPOCH_MS] [--limit GROUPS]';
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const raw = args[index + 1];
    if (!['--from', '--to', '--limit'].includes(flag) || raw === undefined) {
      throw new Error(usage());
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || (flag === '--limit' && value < 1)) {
      throw new Error(`${flag} must be ${flag === '--limit' ? 'a positive' : 'a non-negative'} safe integer`);
    }
    result[flag.slice(2)] = value;
  }
  return result;
}

let manager;
try {
  const filters = parseArgs(process.argv.slice(2));
  const { TrueXPostgreSQLManager } = await import('../src/data-pipeline/truex-postgresql-manager.js');
  manager = new TrueXPostgreSQLManager();
  await manager.initialize();
  const audit = await manager.getReferenceMarkoutCoverage({
    fromTimestamp: filters.from, toTimestamp: filters.to, limit: filters.limit,
  });
  console.log(JSON.stringify({ generatedAt: Date.now(), filters, ...audit }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await manager?.close().catch(() => {});
}
