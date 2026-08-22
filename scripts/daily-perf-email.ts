#!/usr/bin/env bun
/**
 * Daily Email Digest — TrueX MM performance review (task 0011).
 *
 * Builds yesterday's perf report (task 0007 engine), renders a standalone
 * HTML page + 7-day trend, publishes the cumulative site to Cloudflare Pages
 * (project `truex-mm-reports`), and emails a summary with the page link via
 * CircleInbox (REST API — launchd-safe, no CLI dependency).
 *
 * Usage:
 *   bun scripts/daily-perf-email.ts [--date YYYY-MM-DD] [--to EMAIL]
 *       [--send] [--skip-deploy] [--dry-run]
 *
 * Env: DATABASE_URL (required), DAILY_REPORT_EMAIL (default recipient),
 *      CIRCLEINBOX_API_KEY (required for --send).
 *
 * Privacy note: Pages URLs are public-by-convention; report content is
 * low-sensitivity daily PnL. Decision documented in tasks/0011.
 */
import { fetchReportData, buildReport } from './daily-perf-review';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Operational era scoping — keep in sync with scripts/daily-perf-review-job.sh
const ERA_SINCE_MS = Date.parse('2026-06-26T00:00:00Z');
const SEED = { qty: 0.01812, price: 65383 };
const MARKOUT_WINDOW_MIN = 60;
const MAX_DAILY_LOSS = 50;
const MAX_ADVERSE_BPS = 25;

const PAGES_PROJECT = 'truex-mm-reports';
const PAGES_BASE = `https://${PAGES_PROJECT}.pages.dev`;
const SENDER_EMAIL = 'truex-mm@derivative.email';
const SENDER_NAME = 'TrueX MM';

// fileURLToPath decodes URL-encoded characters (paths with spaces/non-ASCII)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Archive lives in the persistent DATA_ROOT (the canonical repo the scheduled
// job points at), NOT the checkout the script runs from — a fresh/ephemeral
// worktree with an empty archive would otherwise overwrite the cumulative
// Pages site and drop previously published reports.
const DATA_ROOT = process.env.TRUEX_PERF_DATA_ROOT ?? REPO_ROOT;
const SITE_DIR = join(DATA_ROOT, 'logs', 'reports-site');

// ---------------------------------------------------------------------------
// Report building (pure-ish; DB reads through task-0007 exports)
// ---------------------------------------------------------------------------

export type DayReport = ReturnType<typeof buildReport>;

export async function buildDayReport(dbUrl: string, date: string): Promise<DayReport> {
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(dayStart)) throw new Error(`invalid date: ${date}`);
  const dayEnd = dayStart + 86400000;
  const data = await fetchReportData(
    dbUrl, dayStart, dayEnd, 'BTC-PYUSD', undefined, MARKOUT_WINDOW_MIN * 60000, ERA_SINCE_MS
  );
  return buildReport({
    date,
    sessions: data.sessions,
    orderTimestamps: data.orderRows.map((r: { timestamp: string }) => Number(r.timestamp)),
    orderCountByStatus: data.orderCountByStatus,
    fillRows: data.fillRows,
    quoteLifecycleEvents: data.quoteLifecycleEvents,
    quoteLifecycleAvailable: data.quoteLifecycleAvailable,
    seed: SEED,
    markoutWindowMin: MARKOUT_WINDOW_MIN,
    maxDailyLoss: MAX_DAILY_LOSS,
    maxAdverseBps: MAX_ADVERSE_BPS,
  });
}

export async function buildTrend(dbUrl: string, endDate: string, days = 7): Promise<DayReport[]> {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const trend: DayReport[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end - i * 86400000).toISOString().slice(0, 10);
    trend.push(await buildDayReport(dbUrl, d));
  }
  return trend;
}

// ---------------------------------------------------------------------------
// Rendering (pure, unit-tested)
// ---------------------------------------------------------------------------

const money = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Round-trip wrong-way is only meaningful when both sides matched volume;
// buildReport returns 0 in that case, which would read as 'neutral execution'
// rather than 'no data' — render n/a instead.
const wrongWay = (day: DayReport): string | null =>
  day.fills.matchedQty > 0 ? `${money(day.fills.roundTripAdversePerBtc)}/BTC` : null;

export function subjectLine(day: DayReport): string {
  const v = day.verdict.status;
  const bps = day.markout.avgAdverseBps;
  const ww = wrongWay(day);
  return `[TrueX MM] ${day.date} — ${v}: ${money(day.pnl.dayRealized)} realized` +
    (bps !== null ? ` · ${bps.toFixed(1)}bps adverse` : '') +
    (ww ? ` · ${ww} wrong-way` : '');
}

function verdictBadge(status: string): string {
  const color = status === 'OK' ? '#1a7f37' : '#b45309';
  return `<span style="background:${color};color:#fff;padding:2px 10px;border-radius:10px;font-size:12px;font-weight:600">${status}</span>`;
}

function metricCard(label: string, value: string, sub = ''): string {
  return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;min-width:150px">
    <div style="font-size:12px;color:#6b7280">${label}</div>
    <div style="font-size:20px;font-weight:700;color:#111827;margin-top:2px">${value}</div>
    ${sub ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px">${sub}</div>` : ''}
  </div>`;
}

function performanceEvidence(day: DayReport): string {
  const performance = day.performance;
  if (!performance) return 'Performance decomposition unavailable: report was generated before lifecycle evidence was added.';
  const proxy = performance.sameDayOpposingFillProxy;
  const proxyText = proxy.evidence === 'observed'
    ? `${money(proxy.pnl)} on ${proxy.matchedQty.toFixed(6)} BTC`
    : `unavailable (${proxy.reason})`;
  const rejects = performance.rejects;
  const rejectText = rejects.evidence === 'observed'
    ? rejects.rate === null
      ? `${rejects.rejects} observed; rate unavailable (${rejects.rateUnavailableReason ?? 'no in-day attempts'}); reasons: ${Object.entries(rejects.byReason).map(([reason, n]) => `${reason} (${n})`).join(', ') || 'none'}`
      : `${rejects.rejects}/${rejects.attempts} (${(rejects.rate * 100).toFixed(2)}%); reasons: ${Object.entries(rejects.byReason).map(([reason, n]) => `${reason} (${n})`).join(', ') || 'none'}`
    : `unavailable (${rejects.reason})`;
  const inventory = performance.inventory.evidence === 'observed'
    ? `start ${performance.inventory.start.toFixed(6)}, range ${performance.inventory.min.toFixed(6)} to ${performance.inventory.max.toFixed(6)}, end ${performance.inventory.end.toFixed(6)}`
    : `unavailable (${performance.inventory.reason})`;
  return `FIFO realized PnL (observed): ${money(performance.pnl.netRealizedAfterFees)} after fees. Realized spread: unavailable (${performance.realizedSpread.reason}). Same-day opposing-fill proxy (not realized spread): ${proxyText}. Rejects: ${rejectText}. Inventory: ${inventory}. Two-sided uptime: unavailable (${performance.uptime.reason}).`;
}

export function renderHtml(day: DayReport, trend: DayReport[]): string {
  const bps = day.markout.avgAdverseBps;
  const trendRows = trend.map((t) => {
    const tbps = t.markout.avgAdverseBps;
    const pnlColor = t.pnl.dayRealized < 0 ? '#b91c1c' : '#1a7f37';
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6">${t.date}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6">${verdictBadge(t.verdict.status)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;color:${pnlColor};font-weight:600">${money(t.pnl.dayRealized)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6">${tbps !== null ? tbps.toFixed(1) + 'bps' : '—'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6">${wrongWay(t) ?? 'n/a'}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6">${t.fills.total}</td>
    </tr>`;
  }).join('\n');

  const warnReasons = day.verdict.reasons.length
    ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;margin-top:16px">
        <b>WARN reasons:</b> ${day.verdict.reasons.map(esc).join('; ')}</div>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TrueX MM — ${day.date}</title></head>
<body style="margin:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:860px;margin:0 auto;padding:24px 16px">
  <div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
    <h1 style="font-size:22px;margin:0;color:#111827">TrueX MM Daily Review</h1>
    ${verdictBadge(day.verdict.status)}
  </div>
  <div style="color:#6b7280;font-size:13px;margin-bottom:20px">${day.date} (UTC) · BTC-PYUSD · generated ${new Date().toISOString()}</div>
  ${warnReasons}
  <div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:16px">
    ${metricCard('Day realized PnL', money(day.pnl.dayRealized), `lifetime ${money(day.pnl.lifetimeRealized)}`)}
    ${metricCard('Mark-out adverse', bps !== null ? bps.toFixed(1) + 'bps' : '—', `${day.markout.pairs} pairs · ${MARKOUT_WINDOW_MIN}m window`)}
    ${metricCard('Round-trip wrong-way', wrongWay(day) ?? 'n/a', `${day.fills.matchedQty.toFixed(6)} BTC matched`)}
    ${metricCard('Fills', String(day.fills.total), `${day.fills.buys.n} buys / ${day.fills.sells.n} sells`)}
    ${metricCard('Orders', String(day.orders.total), day.orders.gapHours.length ? `gaps: ${day.orders.gapHours.length}h` : 'no zero-order hours')}
    ${metricCard('Open position', day.pnl.position.toFixed(6), `@ ${money(day.pnl.positionAvgCost)} avg`)}
  </div>
  <h2 style="font-size:16px;color:#111827;margin:28px 0 8px">Performance decomposition &amp; evidence</h2>
  <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px 16px;font-size:13px;color:#374151;line-height:1.5">${esc(performanceEvidence(day))}</div>
  <h2 style="font-size:16px;color:#111827;margin:28px 0 8px">7-day trend</h2>
  <table style="border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;width:100%">
    <thead><tr style="background:#f9fafb;text-align:left">
      <th style="padding:8px 10px">Date</th><th style="padding:8px 10px">Verdict</th>
      <th style="padding:8px 10px">Realized</th><th style="padding:8px 10px">Adverse mark-out</th>
      <th style="padding:8px 10px">Wrong-way</th><th style="padding:8px 10px">Fills</th>
    </tr></thead>
    <tbody>${trendRows}</tbody>
  </table>
  <div style="color:#9ca3af;font-size:11px;margin-top:20px">
    Era scoping: fills since 2026-06-26; funding seed ${SEED.qty} BTC @ $${SEED.price}.
    Thresholds: WARN if day realized &lt; -${money(MAX_DAILY_LOSS).slice(1)} or adverse &gt; ${MAX_ADVERSE_BPS}bps.
    <a href="${PAGES_BASE}/" style="color:#6b7280">Archive</a>
  </div>
</div></body></html>`;
}

export interface IndexEntry { date: string; verdict: string; dayRealized: number; }

export function renderIndex(entries: IndexEntry[]): string {
  const rows = entries.map((e) => {
    const pnlColor = e.dayRealized < 0 ? '#b91c1c' : '#1a7f37';
    return `<tr>
      <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6"><a href="/${e.date}.html" style="color:#2563eb;text-decoration:none">${e.date}</a></td>
      <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6">${verdictBadge(e.verdict)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;color:${pnlColor};font-weight:600">${money(e.dayRealized)}</td>
    </tr>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>TrueX MM — Daily Reports</title></head>
<body style="margin:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <h1 style="font-size:22px;color:#111827">TrueX MM — Daily Reports</h1>
  <table style="border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;width:100%;margin-top:12px">
    <thead><tr style="background:#f9fafb;text-align:left">
      <th style="padding:8px 10px">Date</th><th style="padding:8px 10px">Verdict</th><th style="padding:8px 10px">Realized</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div></body></html>`;
}

export function emailText(day: DayReport, url: string): string {
  const bps = day.markout.avgAdverseBps;
  return [
    `TrueX MM daily review — ${day.date}`,
    `Verdict: ${day.verdict.status}`,
    `Day realized PnL: ${money(day.pnl.dayRealized)} (lifetime ${money(day.pnl.lifetimeRealized)})`,
    `Mark-out adverse: ${bps !== null ? bps.toFixed(1) + 'bps' : 'n/a'} (${day.markout.pairs} pairs)`,
    `Round-trip wrong-way: ${wrongWay(day) ?? 'n/a'} (${day.fills.matchedQty.toFixed(6)} BTC matched)`,
    `Fills: ${day.fills.total} (${day.fills.buys.n} buys / ${day.fills.sells.n} sells) · Orders: ${day.orders.total}`,
    `Performance decomposition: ${performanceEvidence(day)}`,
    ...(day.verdict.reasons.length ? [`WARN reasons: ${day.verdict.reasons.join('; ')}`] : []),
    '',
    `Full report: ${url}`,
    `Archive: ${PAGES_BASE}/`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Site archive + deploy + send
// ---------------------------------------------------------------------------

function writeSiteFiles(day: DayReport, trend: DayReport[]): string {
  mkdirSync(SITE_DIR, { recursive: true });
  const pagePath = join(SITE_DIR, `${day.date}.html`);
  writeFileSync(pagePath, renderHtml(day, trend));

  // Manifest: verdicts for the index without re-reading HTML
  const manifestPath = join(SITE_DIR, 'manifest.json');
  let manifest: Record<string, { verdict: string; dayRealized: number }> = {};
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { manifest = {}; }
  }
  manifest[day.date] = { verdict: day.verdict.status, dayRealized: day.pnl.dayRealized };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Index: last 14 report files present on disk
  const dates = readdirSync(SITE_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort()
    .reverse()
    .slice(0, 14);
  const entries: IndexEntry[] = dates.map((d) => ({
    date: d,
    verdict: manifest[d]?.verdict ?? 'OK',
    dayRealized: manifest[d]?.dayRealized ?? 0,
  }));
  writeFileSync(join(SITE_DIR, 'index.html'), renderIndex(entries));
  return pagePath;
}

async function deployPages(): Promise<void> {
  const localWrangler = join(REPO_ROOT, 'node_modules', '.bin', 'wrangler');
  // --branch main pins the deployment to the PRODUCTION environment —
  // without it wrangler infers the current git branch (worktrees deploy to
  // Preview and the canonical URL 404s).
  const cmd = existsSync(localWrangler)
    ? [localWrangler, 'pages', 'deploy', SITE_DIR, '--project-name', PAGES_PROJECT, '--branch', 'main']
    : ['bunx', 'wrangler', 'pages', 'deploy', SITE_DIR, '--project-name', PAGES_PROJECT, '--branch', 'main'];
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', cwd: REPO_ROOT });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`wrangler pages deploy failed (exit ${exit}): ${err.slice(0, 500)}`);
  }
}

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<void> {
  const apiKey = process.env.CIRCLEINBOX_API_KEY;
  if (!apiKey) throw new Error('CIRCLEINBOX_API_KEY not set');
  const res = await fetch('https://circleinbox.com/api/v1/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: { email: SENDER_EMAIL, name: SENDER_NAME },
      to,
      subject,
      text,
      html,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`CircleInbox send failed (${res.status}): ${body.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (key === 'send' || key === 'skip-deploy' || key === 'dry-run') { args[key] = 'true'; continue; }
    args[key] = argv[++i];
  }
  return args;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.send && args['skip-deploy']) {
    console.error('ERROR: --send with --skip-deploy would email an unpublished link');
    return 2;
  }
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const date = args.date ?? yesterday;

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('ERROR: DATABASE_URL not set'); return 2; }

  try {
    console.log(`Building report for ${date} (+7-day trend)...`);
    const trend = await buildTrend(dbUrl, date, 7);
    const day = trend[trend.length - 1];

    const pagePath = writeSiteFiles(day, trend);
    console.log(`Wrote ${pagePath}`);

    const url = `${PAGES_BASE}/${date}.html`;
    if (args['dry-run']) {
      console.log(`DRY RUN: skipping deploy + send. Would publish ${url}`);
      return 0;
    }

    if (!args['skip-deploy']) {
      console.log('Deploying to Cloudflare Pages...');
      await deployPages();
      console.log(`Published: ${url}`);
    }

    if (args.send) {
      const to = args.to ?? process.env.DAILY_REPORT_EMAIL;
      if (!to) {
        console.log('No recipient (--to or DAILY_REPORT_EMAIL) — skipping email.');
        return 0;
      }
      const subject = subjectLine(day);
      await sendEmail(to, subject, renderHtml(day, trend), emailText(day, url));
      console.log(`Email sent to ${to}: ${subject}`);
    } else {
      console.log('No --send flag — email skipped.');
    }
    return 0;
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
