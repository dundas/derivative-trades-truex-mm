#!/usr/bin/env bun
/**
 * Kill Switch — emergency cancel-all for the TrueX market maker (task 0012).
 *
 * Cancels every active order for the account on the selected venue, then
 * VERIFIES with a second listing and reports residuals. Referenced by
 * deploy-hetzner.sh (graceful stop), llms.txt, and docs/STRATEGY.md.
 *
 *   --prod            target the PRODUCTION venue (requires explicit flag)
 *   --uat             target UAT (DEFAULT — a bare invocation never touches prod)
 *   --dry-run         list active orders, cancel nothing
 *   --json            machine-readable output
 *
 * Exit codes: 0 = no orders remain; 1 = cancel failures or residuals;
 *             2 = configuration or pre-flight connectivity error;
 *             3 = sweep ran but verification failed (aftermath unconfirmed).
 *
 * No process-kill side effects: stopping the market maker itself is the
 * MM API's /api/v1/emergency-stop endpoint (cancel + SIGTERM) or the
 * container stop, which deploy tooling performs separately.
 *
 * Env (no hardcoded secrets):
 *   prod: TRUEX_PROD_API_KEY / TRUEX_PROD_SECRET_KEY / TRUEX_CLIENT_ID,
 *         url TRUEX_REST_URL || http://178.156.230.110:3006
 *   uat:  TRUEX_API_KEY / TRUEX_SECRET_KEY,
 *         TRUEX_CLIENT_ID_UAT || 78972918929686546 (legacy default),
 *         url TRUEX_UAT_REST_URL || http://38.32.101.229:9742
 */
import { TrueXRESTClient } from '../src/exchanges/truex/TrueXRESTClient.ts';

// ---------------------------------------------------------------------------
// Config resolution (pure, unit-tested)
// ---------------------------------------------------------------------------

export function resolveConfig(env, mode) {
  if (mode === 'prod') {
    const apiKey = env.TRUEX_PROD_API_KEY;
    const apiSecret = env.TRUEX_PROD_SECRET_KEY;
    const clientId = env.TRUEX_CLIENT_ID;
    if (!apiKey || !apiSecret || !clientId) {
      return { error: 'prod mode requires TRUEX_PROD_API_KEY, TRUEX_PROD_SECRET_KEY, TRUEX_CLIENT_ID' };
    }
    return {
      mode,
      baseURL: (env.TRUEX_REST_URL || 'http://178.156.230.110:3006') + '/api/v1',
      apiKey,
      apiSecret,
      clientId,
    };
  }
  // UAT (fail-safe default)
  const apiKey = env.TRUEX_API_KEY;
  const apiSecret = env.TRUEX_SECRET_KEY;
  if (!apiKey || !apiSecret) {
    return { error: 'uat mode requires TRUEX_API_KEY, TRUEX_SECRET_KEY' };
  }
  const clientId = env.TRUEX_CLIENT_ID_UAT || '78972918929686546';
  return {
    mode,
    baseURL: (env.TRUEX_UAT_REST_URL || 'http://38.32.101.229:9742') + '/api/v1',
    apiKey,
    apiSecret,
    clientId,
    usedLegacyClientId: !env.TRUEX_CLIENT_ID_UAT,
  };
}

// ---------------------------------------------------------------------------
// Core flow (client injected, unit-tested)
// ---------------------------------------------------------------------------

export async function runKillSwitch(client, opts = {}) {
  const { dryRun = false } = opts;

  if (dryRun) {
    const before = await client.getActiveOrders();
    const listed = before.map((o) => TrueXRESTClient.parseOrder(o));
    return { dryRun: true, listed, canceled: [], failed: [], residual: listed, verificationFailed: false };
  }

  // Live path: the sweep result is the single source of truth for what was
  // canceled (cancelAllOrders iterates its OWN snapshot internally). A separate
  // pre-fetch would diverge from the swept set if orders are placed/filled in
  // between — and this report is what an operator relies on during an incident.
  const result = await client.cancelAllOrders();

  // Verification pass: what is still live after the sweep? Distinct failure
  // mode from pre-flight errors: the sweep already ran, we just couldn't
  // confirm the aftermath.
  let residual = [];
  let verificationFailed = false;
  let verificationError = null;
  try {
    const after = await client.getActiveOrders();
    residual = after.map((o) => TrueXRESTClient.parseOrder(o));
  } catch (err) {
    verificationFailed = true;
    verificationError = err instanceof Error ? err.message : String(err);
  }

  return { dryRun: false, listed: [], canceled: result.canceled, failed: result.failed, residual, verificationFailed, verificationError };
}

export function decideExit(result) {
  if (result.verificationFailed) return 3; // canceled, but aftermath unverified
  if (result.failed.length > 0 || result.residual.length > 0) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function fmtOrder(p) {
  const age = p.createdAt ? `${Math.max(0, Math.round((Date.now() - p.createdAt.getTime()) / 1000))}s` : '-';
  return `  ${String(p.id).padEnd(20)} ${p.side.padEnd(4)} ${Number(p.qty).toFixed(6).padStart(10)} @ ${Number(p.price).toFixed(2).padStart(10)} ${String(p.status).padEnd(12)} age=${age}`;
}

export function renderText(result, config) {
  const L = [];
  L.push(`Kill switch — venue=${config.mode} url=${config.baseURL} client=${config.clientId}${result.dryRun ? ' [DRY RUN]' : ''}`);
  if (result.dryRun) {
    L.push(`Active orders found: ${result.listed.length}`);
    for (const p of result.listed) L.push(fmtOrder(p));
  } else {
    L.push(`Canceled: ${result.canceled.length}  Failed: ${result.failed.length}`);
    for (const f of result.failed.slice(0, 10)) L.push(`  FAILED ${f.id}: ${f.error}`);
    if (result.verificationFailed) {
      L.push(`!! VERIFICATION FAILED — sweep ran but the aftermath could not be confirmed: ${result.verificationError}`);
    } else {
      L.push(`Residual after verification: ${result.residual.length}`);
      for (const p of result.residual.slice(0, 10)) L.push(fmtOrder(p));
    }
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { prod: false, uat: false, dryRun: false, json: false };
  for (const a of argv) {
    if (a === '--prod') args.prod = true;
    else if (a === '--uat') args.uat = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.prod && args.uat) {
    console.error('ERROR: pass only one of --prod / --uat');
    process.exit(2);
  }
  const mode = args.prod ? 'prod' : 'uat'; // default UAT: fail-safe

  const config = resolveConfig(process.env, mode);
  if (config.error) {
    console.error(`ERROR: ${config.error}`);
    process.exit(2);
  }
  if (config.usedLegacyClientId) {
    console.error(`NOTE: TRUEX_CLIENT_ID_UAT not set — using legacy default ${config.clientId}`);
  }

  const client = new TrueXRESTClient({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    userId: config.clientId,
  });

  try {
    const result = await runKillSwitch(client, { dryRun: args.dryRun });
    if (args.json) {
      console.log(JSON.stringify({ config: { ...config, apiSecret: '***', apiKey: '***' }, ...result }, null, 2));
    } else {
      console.log(renderText(result, config));
    }
    process.exit(args.dryRun ? 0 : decideExit(result));
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    process.exit(2);
  }
}

if (import.meta.main) {
  main();
}
