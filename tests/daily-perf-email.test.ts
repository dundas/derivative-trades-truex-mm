import { describe, it, expect } from 'bun:test';
import {
  subjectLine,
  renderHtml,
  renderIndex,
  emailText,
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
