import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApiKeySigner, TokenManager } from '../src/truemarkets/auth';
import { TrueMarketsClient } from '../src/truemarkets/client';
import { ExecutionController, OrderJournal, type OrderIntent, type TradingPolicy } from '../src/truemarkets/execution';

function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
const args = process.argv.slice(2);
const command = args.shift() ?? 'preflight';
const arg = (name: string, fallback?: string) => {
  const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1];
};
if (!['preflight','preview','submit','replace','cancel','cancel-owned','reconcile'].includes(command)) throw new Error('Unknown command');
const configPath = resolve(arg('--config', 'config/truemarkets-trading.example.json')!);
const config = await Bun.file(configPath).json() as { authUrl: string; gatewayUrl: string; cefiUrl: string;
  schemaVersion: string; timeoutMs: number; journalDir: string; policy: TradingPolicy };
if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 60000) throw new Error('Invalid timeout');
const expectedClientId = required('TM_EXPECTED_CLIENT_ID');
const auth = new TokenManager({ baseUrl: config.authUrl, expectedUserId: required('TM_EXPECTED_USER_ID'), expectedClientId,
  signer: ApiKeySigner.fromFile(required('TM_KEY_FILE')), timeoutMs: config.timeoutMs });
const client = new TrueMarketsClient({ auth, gatewayUrl: config.gatewayUrl, cefiUrl: config.cefiUrl,
  expectedClientId, schemaVersion: config.schemaVersion, timeoutMs: config.timeoutMs,
  writesEnabled: ['cancel','cancel-owned'].includes(command) || (config.policy.enabled === true && ['submit','replace'].includes(command)) });
const report: any = { checkedAt: new Date().toISOString(), command, entryEnabled: config.policy.enabled === true,
  expectedClientId, checks: {}, readyToSubmit: false };
try {
  if (command === 'preflight') {
    // All account checks are GETs; token mint/refresh are the only POSTs.
    const checks: [string, () => Promise<any>][] = [
      ['availability', () => client.availability()], ['clients', () => client.clients()], ['fees', () => client.fees()],
      ['walletBalances', () => client.walletBalances()], ['allocations', () => client.allocations()],
      ['balances', () => client.balances()], ['activeOrders', () => client.activeOrders()], ['recentTrades', () => client.trades()],
      ['assets', () => client.assets()],
      ...config.policy.instruments.map(p => [`instrument:${p.symbol}`, () => client.instruments(p.symbol)] as [string, () => Promise<any>]),
    ];
    for (const [name, fn] of checks) {
      try { report.checks[name] = { passed: true, result: await fn() }; }
      catch (error) { report.checks[name] = { passed: false, error: error instanceof Error ? error.message : 'Check failed' }; }
    }
    report.identity = auth.identity;
    const availability = report.checks.availability.result;
    report.blockers = [
      ...(config.policy.enabled ? [] : ['Trading disabled in configuration']),
      ...(Date.parse(config.policy.eligibleUntil) > Date.now() ? [] : ['Account eligibility confirmation missing/expired']),
      ...(availability?.allowed_asset_classes?.includes('stock') && availability?.allowed_product_types?.includes('spot') ? [] : ['Stock/spot trading unavailable from current request location']),
      ...config.policy.instruments.filter(p => !p.unitsVerified).map(p => `${p.symbol}: token/share conversion unverified`),
      ...Object.entries(report.checks).filter(([, v]: any) => !v.passed).map(([k]) => `${k}: check failed`),
    ];
    // Preflight never authorizes execution: per-order live freshness, risk and balances are checked at submit.
    report.accountChecksPassed = Object.values(report.checks).every((v: any) => v.passed);
    report.readyForOrderValidation = report.blockers.length === 0;
    if (!report.accountChecksPassed) process.exitCode = 1;
  } else if (command === 'preview') {
    const instrument = config.policy.instruments.find(p => p.symbol === arg('--symbol'));
    const side = arg('--side'), qty = arg('--qty');
    if (!instrument || (side !== 'BUY' && side !== 'SELL') || !qty) throw new Error('Preview requires configured --symbol, --side BUY/SELL and --qty');
    report.result = await client.preview(instrument.instrumentId, side, qty);
  } else {
    const journal = new OrderJournal(resolve(config.journalDir), `${config.cefiUrl}|${expectedClientId}`);
    try {
      const controller = new ExecutionController(client, journal, config.policy);
      const inputPath = arg('--input');
      const input = async () => { if (!inputPath) throw new Error('--input JSON file is required'); return await Bun.file(inputPath).json() as OrderIntent; };
      const id = () => { const id = arg('--id'); if (!id) throw new Error('--id is required'); return id; };
      report.result = command === 'submit' ? await controller.submit(await input())
        : command === 'replace' ? await controller.replace(id(), await input())
        : command === 'cancel' ? await controller.cancel(id())
        : command === 'cancel-owned' ? await controller.cancelOwned() : await controller.reconcile();
    } finally { journal.close(); }
  }
} catch (error) {
  // Libraries never include tokens, response bodies or private key material in errors.
  report.error = error instanceof Error ? error.message : 'Operation failed'; process.exitCode = 1;
}
const output = arg('--out');
if (output) {
  mkdirSync(resolve(output), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify(command === 'preflight' ? { checkedAt: report.checkedAt, command, identity: report.identity,
  accountChecksPassed: report.accountChecksPassed, readyForOrderValidation: report.readyForOrderValidation,
  blockers: report.blockers, checks: Object.fromEntries(Object.entries(report.checks).map(([k, v]: any) => [k, { passed: v.passed,
    ...(v.error ? { error: v.error } : {}), ...(Array.isArray(v.result) ? { count: v.result.length } : {}) }])) } : report, null, 2));
