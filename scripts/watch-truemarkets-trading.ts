import { resolve } from 'node:path';
import { ApiKeySigner, TokenManager } from '../src/truemarkets/auth';
import { TrueMarketsClient } from '../src/truemarkets/client';
import { ExecutionController, OrderJournal } from '../src/truemarkets/execution';
import { TradingRuntime } from '../src/truemarkets/runtime';
import { TastytradeFeed } from '../src/equities/tastytrade';
import { PublicFeed } from '../src/equities/feeds';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
const config = await Bun.file(resolve(flag('--config', 'config/truemarkets-trading.example.json'))).json();
const duration = Number(flag('--duration-seconds','60'));
if (!Number.isFinite(duration) || duration < 1 || duration > 90000) throw new Error('Duration must be 1–90000 seconds');
if (!Number.isInteger(config.watch?.tickMs) || config.watch.tickMs < 1000 || config.watch.tickMs > 5000) throw new Error('Watch tick must be 1000–5000ms');
const expectedClientId = required('TM_EXPECTED_CLIENT_ID');
const auth = new TokenManager({ baseUrl: config.authUrl, expectedUserId: required('TM_EXPECTED_USER_ID'), expectedClientId,
  signer: ApiKeySigner.fromFile(required('TM_KEY_FILE')), timeoutMs: config.timeoutMs });
const client = new TrueMarketsClient({ auth, gatewayUrl: config.gatewayUrl, cefiUrl: config.cefiUrl,
  expectedClientId, schemaVersion: config.schemaVersion, timeoutMs: config.timeoutMs, writesEnabled: config.policy.enabled === true });
const source = new TastytradeFeed(config.policy.instruments.map((p: any) => p.referenceSymbol), {
  url: config.watch.tastytradeUrl, clientId: process.env.TASTYTRADE_CLIENT_ID, clientSecret: required('TASTYTRADE_CLIENT_SECRET'), refreshToken: required('TASTYTRADE_REFRESH_TOKEN'),
  pollMs: config.watch.referencePollMs, requestTimeoutMs: config.timeoutMs, silenceTimeoutMs: Math.max(75000, config.watch.referencePollMs + 10000),
  retryMaxMs: Math.max(300000, config.watch.referencePollMs), quoteSizeMultiplier: 1,
});
const target = new PublicFeed('truemarkets', config.policy.instruments.map((p: any) => p.symbol), {
  url: config.watch.venueWsUrl, connectTimeoutMs: 10000, silenceTimeoutMs: 30000, reconnectMinMs: 1000, reconnectMaxMs: 30000,
});
if (!['wss://api.truemarkets.co/v1/cefi/market','wss://api.uat.truemarkets.co/v1/cefi/market'].includes(config.watch.venueWsUrl)) throw new Error('Unapproved venue websocket');
if (config.watch.venueWsUrl.includes('.uat.') !== config.cefiUrl.includes('.uat.')) throw new Error('Mixed watch/API environments');
const journal = new OrderJournal(resolve(config.journalDir), `${config.cefiUrl}|${expectedClientId}`);
let stopping = false, failed = false, lastHealth: any;
const controller = new ExecutionController(client, journal, config.policy), runtime = new TradingRuntime(controller, journal, config.policy, source, target);
process.on('SIGINT', () => { stopping = true; }); process.on('SIGTERM', () => { stopping = true; });
const started = Date.now(); let ticks = 0, healthyTicks = 0, errors = 0;
try {
  source.start(); target.start();
  // This runnable watcher submits no strategy orders. TradingRuntime.submit is the strategy hook.
  while (!stopping && Date.now() - started < duration * 1000) {
    try { const health = await runtime.tick(); lastHealth = health; ticks++; if (health?.healthy) healthyTicks++; }
    catch { errors++; console.error(JSON.stringify({ type: 'watch_reconcile_or_cancel_failed', at: new Date().toISOString() })); }
    await Bun.sleep(config.watch.tickMs);
  }
} catch { failed = true; }
finally {
  try { await runtime.stop(); } catch { failed = true; console.error('Owned-order shutdown cancellation unresolved; reconcile with the same journal'); }
  source.stop(); target.stop(); journal.close();
}
console.log(JSON.stringify({ startedAt: new Date(started).toISOString(), stoppedAt: new Date().toISOString(),
  entriesEnabled: config.policy.enabled === true, strategyOrdersSubmitted: 0, ticks, healthyTicks, errors, failed,
  health: lastHealth, note: 'Read-only when policy.enabled=false; active mode cancels owned orders on unhealthy feeds/shutdown' }, null, 2));
if (failed || errors) process.exitCode = 1;
