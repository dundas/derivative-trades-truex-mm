import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function reviewInput(ledger: any, runtime: any = null) {
  if (!ledger || !Array.isArray(ledger.tasks) || typeof ledger.status !== 'string') throw new Error('Invalid task ledger');
  const counts = Object.fromEntries(['pending','in_progress','blocked','complete'].map(status =>
    [status, ledger.tasks.filter((task: any) => task.status === status).length]));
  return { checkedAt: new Date().toISOString(), goalThread: ledger.goalThread, status: ledger.status,
    counts, tasks: ledger.tasks, runtime,
    boundaries: 'Read-only shadow module. No orders, funds, credentials, deployment or external messages. Do not expand scope. Evidence outranks checkbox totals.' };
}
export async function runReview(options: {
  ledger: string; out: string; pairingScript: string; timeoutMs: number;
  spawn?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}) {
  const ledger = JSON.parse(readFileSync(options.ledger, 'utf8'));
  const dir = resolve(options.out);
  mkdirSync(dir, { recursive: true });
  const save = (body: any) => {
    const tmp = join(dir, `latest.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(body, null, 2)); renameSync(tmp, join(dir,'latest.json'));
  };
  const summary = reviewInput(ledger);
  if (ledger.status !== 'active') { save({ ...summary, skipped: true, reason: 'Goal is not active' }); return; }
  const source = join(dir, `progress-${Date.now()}.json`);
  const runtimeFile = resolve('logs/equity-shadow/current/status.json');
  if (existsSync(runtimeFile)) summary.runtime = JSON.parse(readFileSync(runtimeFile, 'utf8'));
  writeFileSync(source, JSON.stringify(summary, null, 2));
  const topic = 'Equity shadow goal progress: verify evidence, challenge overengineering and drift, identify the next smallest useful action. Distinguish code completion from uncollected 24-hour evidence. Do not write implementation files.';
  const args = [process.execPath, options.pairingScript, '--topic', topic, '--source', source,
    '--source', resolve('tasks/equity-reference-shadow.md'), '--timeout-ms', String(options.timeoutMs),
    '--participant', 'claude-code', '--participant', 'codex:gpt-6.1-sol'];
  const launch = options.spawn ?? (async (args: string[]) => {
    const child = Bun.spawn(args, { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs + 30000);
    try {
      const [stdout,stderr,code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, stdout, stderr };
    } finally { clearTimeout(timer); }
  });
  const startedAt = new Date().toISOString();
  const result = await launch(args);
  const log = join(dir, `pairing-${Date.now()}.log`);
  writeFileSync(log, result.stdout + '\n' + result.stderr);
  const artifact = result.stdout.match(/Wrote pairing artifact: (.+)/)?.[1]?.trim();
  const voices = artifact && existsSync(artifact) ? (readFileSync(artifact, 'utf8').match(/^## Voice — /gm) ?? []).length : 0;
  const passed = result.code === 0 && voices >= 2;
  save({ ...summary, startedAt, finishedAt: new Date().toISOString(), passed, voiceCount: voices,
    artifact, source, log, synthesisStatus: 'Pair perspectives retained for implementation-session synthesis',
    nextAction: passed ? 'Read both voices and reconcile recommendations against acceptance criteria' : 'Resolve pairing failure; progress is not a successful review' });
  if (!passed) throw new Error(`Pairing review incomplete (${voices}/2 voices); see ${log}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (key: string, fallback?: string) => { const i=args.indexOf(key); return i<0?fallback:args[i+1]; };
  const config = {
    ledger: resolve(flag('--ledger','tasks/equity-reference-shadow.json')!),
    out: resolve(flag('--out','logs/equity-pairing')!),
    pairingScript: resolve(flag('--pairing-script') ?? (()=>{throw new Error('--pairing-script required');})()),
    timeoutMs: Number(flag('--timeout-ms','180000')),
  };
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 300000) throw new Error('Review timeout must be 1000..300000ms');
  if (args.includes('--once')) await runReview(config);
  else {
    const moduleRoot = flag('--agent-process-root');
    if (!moduleRoot) throw new Error('--agent-process-root required for daemon');
    const { createAgent, HeartbeatService } = await import(pathToFileURL(join(resolve(moduleRoot),'dist/index.js')).href);
    const interval = Number(flag('--interval-ms','900000'));
    const port = Number(flag('--port','9167'));
    if (!Number.isInteger(interval) || interval < 900000) throw new Error('Review interval must be at least 15 minutes');
    let running = false;
    const handler = async () => {
      if (running) return;
      running = true;
      try { await runReview(config); } finally { running=false; }
    };
    const agent = createAgent({ name:'equity-shadow-progress-review', port, hostname:'127.0.0.1',
      services:[new HeartbeatService({ interval, runOnStart:false, maxRetries:1, handler })] });
    await agent.start();
  }
}
