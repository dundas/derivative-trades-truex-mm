import { describe, it, expect } from 'bun:test';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  subjectLine,
  renderHtml,
  renderIndex,
  emailText,
  timeoutMs,
  buildDayReport,
  buildTrend,
  deployPages,
  sendEmail,
} from '../scripts/daily-perf-email';

// Minimal fixture matching buildReport's output shape
function fixtureDay(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-08-08',
    sessions: [],
    orders: { total: 90000, byStatus: [], hourly: [], gapHours: [] },
    fills: {
      total: 41,
      buys: { n: 15, qty: 0.021, vwap: 64383 },
      sells: { n: 26, qty: 0.028, vwap: 64132 },
      fees: 0,
      matchedQty: 0.021,
      roundTripAdversePerBtc: 251.73,
    },
    pnl: {
      dayRealized: -3.32,
      lifetimeRealized: -298.37,
      position: 0.01637,
      positionAvgCost: 64538,
      seeded: { qty: 0.01812, price: 65383 },
    },
    markout: { windowMin: 60, pairs: 20, avgAdverseBps: 15.42 },
    verdict: { status: 'OK', reasons: [] },
    ...overrides,
  } as any;
}

describe('subjectLine (AC2)', () => {
  it('carries verdict + headline numbers', () => {
    const s = subjectLine(fixtureDay());
    expect(s).toContain('2026-08-08');
    expect(s).toContain('OK');
    expect(s).toContain('-$3.32');
    expect(s).toContain('15.4bps');
    expect(s).toContain('$251.73/BTC');
  });

  it('omits bps when no mark-out pairs', () => {
    const s = subjectLine(fixtureDay({ markout: { windowMin: 60, pairs: 0, avgAdverseBps: null } }));
    expect(s).not.toContain('bps adverse');
  });
});

describe('renderHtml (AC1)', () => {
  it('renders a standalone page with verdict, metrics, and 7-day trend', () => {
    const trend = [
      fixtureDay({ date: '2026-08-07', pnl: { dayRealized: -5.05, lifetimeRealized: -290, position: 0.016, positionAvgCost: 64000, seeded: null } }),
      fixtureDay(),
    ];
    const html = renderHtml(fixtureDay(), trend);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('TrueX MM Daily Review');
    expect(html).toContain('>OK<'); // verdict badge
    expect(html).toContain('-$3.32'); // day realized
    expect(html).toContain('15.4bps'); // mark-out
    expect(html).toContain('$251.73/BTC'); // wrong-way
    expect(html).toContain('2026-08-07'); // trend row
    expect(html).toContain('2026-08-08');
    expect(html).toContain('7-day trend');
  });

  it('renders WARN reasons when present', () => {
    const html = renderHtml(
      fixtureDay({ verdict: { status: 'WARN', reasons: ['daily realized -$60.00 worse than -$50.00'] } }),
      [fixtureDay()]
    );
    expect(html).toContain('WARN reasons');
    expect(html).toContain('worse than');
  });

  it('escapes verdict reasons (no raw HTML injection)', () => {
    const html = renderHtml(
      fixtureDay({ verdict: { status: 'WARN', reasons: ['<script>alert(1)</script>'] } }),
      [fixtureDay()]
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderIndex (AC1)', () => {
  it('lists entries with links and verdicts', () => {
    const html = renderIndex([
      { date: '2026-08-08', verdict: 'OK', dayRealized: -3.32 },
      { date: '2026-08-07', verdict: 'WARN', dayRealized: -60.1 },
    ]);
    expect(html).toContain('href="/2026-08-08.html"');
    expect(html).toContain('href="/2026-08-07.html"');
    expect(html).toContain('>WARN<');
    expect(html).toContain('-$3.32');
  });
});

describe('emailText', () => {
  it('includes key figures and the report URL', () => {
    const text = emailText(fixtureDay(), 'https://truex-mm-reports.pages.dev/2026-08-08.html');
    expect(text).toContain('Verdict: OK');
    expect(text).toContain('-$3.32');
    expect(text).toContain('https://truex-mm-reports.pages.dev/2026-08-08.html');
    expect(text).toContain('Fills: 41');
  });
});

describe('roborev round 1 fixes', () => {
  it('round-trip metric renders n/a when no volume matched (subject, html, text)', () => {
    const day = fixtureDay({
      fills: { total: 5, buys: { n: 5, qty: 0.005, vwap: 64000 }, sells: { n: 0, qty: 0, vwap: 0 }, fees: 0, matchedQty: 0, roundTripAdversePerBtc: 0 },
    });
    expect(subjectLine(day)).not.toContain('wrong-way');
    expect(subjectLine(day)).not.toContain('$0.00/BTC');
    const html = renderHtml(day, [day]);
    expect(html).toContain('n/a');
    expect(emailText(day, 'https://x/1.html')).toContain('Round-trip wrong-way: n/a');
  });

  it('main rejects --send with --skip-deploy before any env requirement', async () => {
    const { main } = await import('../scripts/daily-perf-email');
    const rc = await main(['--send', '--skip-deploy']);
    expect(rc).toBe(2);
  });
});

describe('performance decomposition rendering', () => {
  it('labels the opposing-fill measure as a proxy and renders evidence availability', () => {
    const day = fixtureDay({
      performance: {
        realizedSpread: { evidence: 'unavailable', reason: 'no quote-linked FIFO lot attribution' },
        sameDayOpposingFillProxy: { evidence: 'observed', pnl: 1.25, matchedQty: 0.01, perBtc: 125 },
        rejects: { evidence: 'observed', attempts: null, rejects: 1, rate: null, byReason: { 'cross-day attempt': 1 } },
        inventory: { evidence: 'unavailable', reason: 'no in-day fills for inventory distribution' },
        uptime: { evidence: 'unavailable', reason: 'no acknowledged two-sided presence observations' },
        pnl: { evidence: 'observed', realizedGross: 2, fees: 0.25, netRealizedAfterFees: 1.75 },
      },
    });
    const html = renderHtml(day, [day]);
    const text = emailText(day, 'https://x/1.html');
    for (const rendered of [html, text]) {
      expect(rendered).toContain('Same-day opposing-fill proxy (not realized spread)');
      expect(rendered).toContain('Realized spread: unavailable');
      expect(rendered).toContain('rate unavailable (no in-day attempts)');
      expect(rendered).toContain('cross-day attempt (1)');
    }
  });
});

describe('wrapper env propagation (roborev round 2)', () => {
  it('wrapper exports TRUEX_PERF_DATA_ROOT for the email child process', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../scripts/daily-perf-review-job.sh', import.meta.url), 'utf8');
    expect(src).toContain('export TRUEX_PERF_DATA_ROOT="$DATA_ROOT"');
  });

  it('renders all delivery timeout overrides into the scheduled-job template', async () => {
    const { readFileSync } = await import('node:fs');
    const installer = readFileSync(new URL('../ops/launchd/install-daily-perf-review.sh', import.meta.url), 'utf8');
    const plist = readFileSync(new URL('../ops/launchd/com.dundas.truex-daily-perf-review.plist', import.meta.url), 'utf8');
    for (const name of ['BUILD', 'DEPLOY', 'EMAIL']) {
      expect(installer).toContain(`DAILY_REPORT_${name}_TIMEOUT_MS`);
      expect(installer).toContain(`{{REPORT_${name}_TIMEOUT_MS}}`);
      expect(plist).toContain(`{{REPORT_${name}_TIMEOUT_MS}}`);
    }
    expect(installer).toContain('validate_timeout_ms DAILY_REPORT_BUILD_TIMEOUT_MS "$REPORT_BUILD_TIMEOUT_MS"');
    expect(installer).toContain('must be a positive integer of milliseconds no greater than 2147483647');
  });

  it('rejects an invalid scheduled-delivery timeout before touching worktrees', async () => {
    const proc = Bun.spawn(['bash', 'ops/launchd/install-daily-perf-review.sh'], {
      cwd: import.meta.dir + '/..',
      env: { ...process.env, DAILY_REPORT_DEPLOY_TIMEOUT_MS: '0' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(2);
    expect(await new Response(proc.stdout).text()).toContain('DAILY_REPORT_DEPLOY_TIMEOUT_MS must be a positive integer');
  });

  it('alerts through the independent brain-message transport if the digest fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daily-perf-wrapper-'));
    const codeRoot = join(root, 'code');
    const dataRoot = join(root, 'data');
    const marker = join(root, 'alert-called');
    const fakeBun = join(root, 'fake-bun.sh');
    const brainMsg = join(dataRoot, '.claude', 'skills', 'cross-brain-message', 'brain-msg.ts');
    try {
      await mkdir(codeRoot, { recursive: true });
      await mkdir(join(dataRoot, '.claude', 'skills', 'cross-brain-message'), { recursive: true });
      await writeFile(brainMsg, '# mock brain-msg\n');
      await writeFile(fakeBun, `#!/bin/bash
if [ "$1" = "scripts/daily-perf-review.ts" ]; then
  printf 'VERDICT: OK\\n  day: $1.00\\nMark-out: n/a\\n'
  exit 0
fi
if [ "$1" = "scripts/daily-perf-email.ts" ]; then exit 3; fi
if [ "$1" = "${brainMsg}" ]; then touch "$ALERT_MARKER"; exit 0; fi
exit 99
`);
      await chmod(fakeBun, 0o755);
      const proc = Bun.spawn(['bash', 'scripts/daily-perf-review-job.sh'], {
        cwd: import.meta.dir + '/..',
        env: {
          ...process.env,
          TRUEX_PERF_BUN: fakeBun,
          TRUEX_PERF_CODE_ROOT: codeRoot,
          TRUEX_PERF_DATA_ROOT: dataRoot,
          ALERT_MARKER: marker,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await proc.exited).toBe(0);
      expect(await Bun.file(marker).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('report operation timeouts', () => {
  it('uses defaults and rejects invalid timer configuration', () => {
    const original = process.env.DAILY_REPORT_BUILD_TIMEOUT_MS;
    try {
      delete process.env.DAILY_REPORT_BUILD_TIMEOUT_MS;
      expect(timeoutMs('DAILY_REPORT_BUILD_TIMEOUT_MS', 123)).toBe(123);
      process.env.DAILY_REPORT_BUILD_TIMEOUT_MS = '0';
      expect(() => timeoutMs('DAILY_REPORT_BUILD_TIMEOUT_MS', 123)).toThrow('must be a positive integer');
      process.env.DAILY_REPORT_BUILD_TIMEOUT_MS = '1.5';
      expect(() => timeoutMs('DAILY_REPORT_BUILD_TIMEOUT_MS', 123)).toThrow('must be a positive integer');
      process.env.DAILY_REPORT_BUILD_TIMEOUT_MS = '2147483647';
      expect(timeoutMs('DAILY_REPORT_BUILD_TIMEOUT_MS', 123)).toBe(2147483647);
      process.env.DAILY_REPORT_BUILD_TIMEOUT_MS = '2147483648';
      expect(() => timeoutMs('DAILY_REPORT_BUILD_TIMEOUT_MS', 123)).toThrow('no greater than 2147483647');
    } finally {
      if (original === undefined) delete process.env.DAILY_REPORT_BUILD_TIMEOUT_MS;
      else process.env.DAILY_REPORT_BUILD_TIMEOUT_MS = original;
    }
  });

  it('uses one aggregate deadline and gives each trend read only its remaining budget', async () => {
    let clock = 0;
    const budgets: number[] = [];
    const buildDay = async (_dbUrl: string, _date: string, timeout: number) => {
      budgets.push(timeout);
      clock += 30;
      return fixtureDay();
    };
    await buildTrend('postgres://example', '2026-08-08', 3, 100, buildDay as any, () => clock);
    expect(budgets).toEqual([100, 70, 40]);
    await expect(buildTrend('postgres://example', '2026-08-08', 4, 100, buildDay as any, () => clock))
      .rejects.toThrow('Daily report build timed out after 100ms');
  });

  it('rejects a trend day that completes after the aggregate deadline', async () => {
    let clock = 0;
    const buildDay = async () => {
      clock = 101;
      return fixtureDay();
    };

    await expect(buildTrend('postgres://example', '2026-08-08', 1, 100, buildDay as any, () => clock))
      .rejects.toThrow('Daily report build timed out after 100ms');
  });

  it('escalates a timed-out deployment from SIGTERM to SIGKILL and waits for exit', async () => {
    const signals: string[] = [];
    let exit!: (code: number) => void;
    await expect(deployPages(5, () => ({
      exited: new Promise<number>((resolve) => { exit = resolve; }),
      kill: (signal = 'SIGTERM') => {
        signals.push(signal);
        if (signal === 'SIGKILL') exit(137);
      },
      stderr: null,
    }), 1)).rejects.toThrow('Cloudflare Pages deployment timed out after 5ms');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('passes an abort signal to the report fetch and rejects when its deadline expires', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchData = async (...args: any[]) => {
      capturedSignal = args[8].signal;
      await new Promise((_, reject) => capturedSignal!.addEventListener('abort', () => reject(capturedSignal!.reason), { once: true }));
      return fixtureDay();
    };
    await expect(buildDayReport('postgres://example', '2026-08-08', 5, fetchData as any)).rejects.toThrow();
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('rejects a timed-out CircleInbox send using the supplied fetch implementation', async () => {
    const original = process.env.CIRCLEINBOX_API_KEY;
    process.env.CIRCLEINBOX_API_KEY = 'test-key';
    let capturedSignal: AbortSignal | undefined;
    try {
      const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal;
        await new Promise((_, reject) => capturedSignal!.addEventListener('abort', () => reject(capturedSignal!.reason), { once: true }));
        return new Response();
      };
      await expect(sendEmail('to@example.com', 'subject', '<p>html</p>', 'text', 5, fetchFn as typeof fetch)).rejects.toThrow();
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal!.aborted).toBe(true);
    } finally {
      if (original === undefined) delete process.env.CIRCLEINBOX_API_KEY;
      else process.env.CIRCLEINBOX_API_KEY = original;
    }
  });
});
