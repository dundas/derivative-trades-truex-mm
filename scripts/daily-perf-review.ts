#!/usr/bin/env bun
/**
 * Daily Performance Review — read-only analytics over truex_analytics.
 *
 * Reports for a UTC day (default: yesterday):
 *   - session continuity (overlapping sessions, restarts)
 *   - order volume + hourly histogram (gap detection)
 *   - fills by side (count, volume, avg price, fees)
 *   - realized PnL (FIFO over lifetime fills; optional funding seed)
 *   - round-trip quality (avg buy vs avg sell — adverse-selection headline)
 *   - mark-out proxy (fill vs next opposite-side fill within window)
 *   - verdict against thresholds (exit 0 OK / 1 WARN / 2 ERROR)
 *
 * READ-ONLY: issues SELECT statements only.
 *
 * Usage:
 *   bun scripts/daily-perf-review.ts [--date YYYY-MM-DD] [--json]
 *       [--seed-btc N --seed-price P] [--markout-window-min N]
 *       [--max-daily-loss USD] [--max-adverse-bps BPS]
 *       [--symbol SYM] [--trading-mode MODE]
 *
 * Scope: sessions/orders/fills are filtered by --symbol (default BTC-PYUSD);
 * --trading-mode additionally restricts to sessions/orders of that mode
 * (fills are restricted via their session). Unset mode = all modes.
 */
import pg from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Fill {
  timestamp: number; // epoch ms
  side: 'buy' | 'sell';
  qty: number;
  price: number;
}

export interface FifoResult {
  realized: number; // cumulative realized PnL (quote currency)
  position: number; // signed open position (+ long / - short)
  avgCost: number; // average cost of open position
  cumAfter: number[]; // cumulative realized after each fill (aligned with input)
}

export interface Markout {
  timestamp: number;
  side: 'buy' | 'sell';
  bps: number; // positive = adverse (price moved against the fill)
}

export interface Verdict {
  status: 'OK' | 'WARN';
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Pure computation (unit-tested in tests/daily-perf-review.test.ts)
// ---------------------------------------------------------------------------

/**
 * FIFO realized PnL over chronologically ordered fills.
 * Optional seed inventory (e.g. funded BTC) at a given cost basis.
 * Positions may go short; short avg cost tracks the opening sell price.
 */
export function computeFifo(fills: Fill[], seed?: { qty: number; price: number }): FifoResult {
  let pos = seed?.qty ?? 0;
  let avg = seed?.price ?? 0;
  let realized = 0;
  const cumAfter: number[] = [];
  const EPS = 1e-9;

  for (const f of fills) {
    const q = f.qty;
    const p = f.price;
    const signed = f.side === 'buy' ? q : -q;

    if (pos === 0 || Math.sign(pos) === Math.sign(signed)) {
      // Extending (or opening) position
      avg = pos === 0 ? p : (avg * Math.abs(pos) + q * p) / (Math.abs(pos) + q);
      pos += signed;
    } else {
      // Reducing or flipping
      const closing = Math.min(q, Math.abs(pos));
      realized += f.side === 'sell' ? closing * (p - avg) : closing * (avg - p);
      const remainder = q - closing;
      pos += signed;
      if (Math.abs(pos) < EPS) {
        pos = 0;
        avg = 0;
      } else if (remainder > 0) {
        // Flipped through zero: new position opens at this fill's price
        avg = p;
      }
    }
    cumAfter.push(realized);
  }
  return { realized, position: pos, avgCost: avg, cumAfter };
}

/**
 * Realized PnL attributable to one UTC day, from a lifetime FIFO run:
 * cumulative realized at last fill <= dayEnd minus cumulative at last fill < dayStart.
 * `fills` must be sorted ascending and aligned with `cumAfter`.
 */
export function dailyRealized(fills: Fill[], cumAfter: number[], dayStart: number, dayEnd: number): number {
  let endCum = 0;
  let startCum = 0;
  for (let i = 0; i < fills.length; i++) {
    const t = fills[i].timestamp;
    if (t >= dayEnd) break;
    endCum = cumAfter[i];
    if (t < dayStart) startCum = cumAfter[i];
  }
  return endCum - startCum;
}

/**
 * Mark-out proxy: for each fill, compare against the first subsequent
 * OPPOSITE-side fill within windowMs. Positive bps = adverse move.
 * (True fair-value mark-out requires mid history — see task 0007 follow-ups.)
 */
export function computeMarkouts(fills: Fill[], windowMs: number): Markout[] {
  const marks: Markout[] = [];
  for (let i = 0; i < fills.length; i++) {
    const f = fills[i];
    let next: Fill | null = null;
    for (let j = i + 1; j < fills.length && fills[j].timestamp - f.timestamp <= windowMs; j++) {
      if (fills[j].side !== f.side) {
        next = fills[j];
        break;
      }
    }
    if (!next) continue;
    const bps =
      f.side === 'buy'
        ? ((f.price - next.price) / f.price) * 1e4
        : ((next.price - f.price) / f.price) * 1e4;
    marks.push({ timestamp: f.timestamp, side: f.side, bps });
  }
  return marks;
}

/** Count orders per UTC hour bucket. Returns map hourStartMs -> count. */
export function hourlyHistogram(timestamps: number[], dayStart: number, dayEnd: number): Map<number, number> {
  const hist = new Map<number, number>();
  for (let h = dayStart; h < dayEnd; h += 3600000) hist.set(h, 0);
  for (const t of timestamps) {
    if (t < dayStart || t >= dayEnd) continue;
    const bucket = dayStart + Math.floor((t - dayStart) / 3600000) * 3600000;
    hist.set(bucket, (hist.get(bucket) ?? 0) + 1);
  }
  return hist;
}

export function evaluateVerdict(
  dailyPnl: number,
  adverseBps: number | null,
  maxDailyLoss: number,
  maxAdverseBps: number
): Verdict {
  const reasons: string[] = [];
  if (dailyPnl < -maxDailyLoss) {
    reasons.push(`daily realized $${dailyPnl.toFixed(2)} worse than -$${maxDailyLoss.toFixed(2)}`);
  }
  if (adverseBps !== null && adverseBps > maxAdverseBps) {
    reasons.push(`avg adverse mark-out ${adverseBps.toFixed(2)}bps above ${maxAdverseBps}bps`);
  }
  return { status: reasons.length ? 'WARN' : 'OK', reasons };
}

// ---------------------------------------------------------------------------
// DB access (read-only)
// ---------------------------------------------------------------------------

interface SessionRow {
  sessionid: string;
  status: string;
  st: string;
  en: string | null;
}

export async function fetchReportData(
  dbUrl: string,
  dayStart: number,
  dayEnd: number,
  symbol: string,
  tradingMode?: string
) {
  const pool = new pg.Pool({ connectionString: dbUrl, connectionTimeoutMillis: 10000, statement_timeout: 60000 });
  try {
    const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows;

    const sessions: SessionRow[] = await q(
      `select sessionid, status,
              coalesce(startedat, starttimestamp, addedat) as st,
              coalesce(endedat, completedat, lastupdated) as en
       from sessions
       where coalesce(startedat, starttimestamp, addedat) < $2
         and (coalesce(endedat, completedat, lastupdated) is null
              or coalesce(endedat, completedat, lastupdated) >= $1)
         and symbol = $3
         and ($4::text is null or tradingmode = $4)
       order by st`,
      [dayStart, dayEnd, symbol, tradingMode ?? null]
    );

    const orderRows = await q(
      `select timestamp from orders
       where timestamp >= $1 and timestamp < $2 and symbol = $3
         and ($4::text is null or tradingmode = $4)`,
      [dayStart, dayEnd, symbol, tradingMode ?? null]
    );

    const orderCountByStatus = await q(
      `select status, count(*)::int as n
       from orders
       where timestamp >= $1 and timestamp < $2 and symbol = $3
         and ($4::text is null or tradingmode = $4)
       group by status order by n desc`,
      [dayStart, dayEnd, symbol, tradingMode ?? null]
    );

    // Lifetime fills up to dayEnd (bounded scan via idx_fills_timestamp).
    // fills has no tradingmode column — when a mode filter is requested,
    // constrain to sessions carrying that mode.
    const fillRows = await q(
      `select timestamp, side, coalesce(size, quantity, amount) as qty, price,
              coalesce(fee, feeamount, 0) as fee
       from fills
       where timestamp < $1 and symbol = $2
         and ($3::text is null or sessionid in (select sessionid from sessions where tradingmode = $3))
       order by timestamp`,
      [dayEnd, symbol, tradingMode ?? null]
    );

    return { sessions, orderRows, orderCountByStatus, fillRows };
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export interface ReportInput {
  date: string;
  sessions: SessionRow[];
  orderTimestamps: number[];
  orderCountByStatus: { status: string; n: number }[];
  fillRows: { timestamp: string; side: string; qty: string; price: string; fee: string }[];
  seed?: { qty: number; price: number };
  markoutWindowMin: number;
  maxDailyLoss: number;
  maxAdverseBps: number;
}

export function buildReport(input: ReportInput) {
  const dayStart = Date.parse(`${input.date}T00:00:00Z`);
  const dayEnd = dayStart + 86400000;
  if (Number.isNaN(dayStart)) throw new Error(`invalid --date: ${input.date}`);

  const fills: Fill[] = [];
  const feesArr: number[] = [];
  for (const r of input.fillRows) {
    fills.push({
      timestamp: Number(r.timestamp),
      side: r.side === 'buy' ? 'buy' : 'sell',
      qty: Number(r.qty),
      price: Number(r.price),
    });
    feesArr.push(Number(r.fee));
  }

  const fifo = computeFifo(fills, input.seed);
  const dayPnl = dailyRealized(fills, fifo.cumAfter, dayStart, dayEnd);

  const dayIdx: number[] = [];
  for (let i = 0; i < fills.length; i++) {
    if (fills[i].timestamp >= dayStart && fills[i].timestamp < dayEnd) dayIdx.push(i);
  }
  const dayFills = dayIdx.map((i) => fills[i]);
  const buys = dayFills.filter((f) => f.side === 'buy');
  const sells = dayFills.filter((f) => f.side === 'sell');
  const sum = (a: Fill[], fn: (f: Fill) => number) => a.reduce((s, f) => s + fn(f), 0);
  const vwap = (a: Fill[]) => (a.length ? sum(a, (f) => f.qty * f.price) / sum(a, (f) => f.qty) : 0);
  const fees = dayIdx.reduce((s, i) => s + feesArr[i], 0);

  // Round-trip quality (within-day matched volume)
  const matched = Math.min(sum(buys, (f) => f.qty), sum(sells, (f) => f.qty));
  const roundTripAdversePerBtc = buys.length && sells.length ? vwap(buys) - vwap(sells) : 0;

  const marks = computeMarkouts(fills, input.markoutWindowMin * 60000);
  const dayMarks = marks.filter((m) => m.timestamp >= dayStart && m.timestamp < dayEnd);
  const avgAdverseBps = dayMarks.length ? dayMarks.reduce((s, m) => s + m.bps, 0) / dayMarks.length : null;

  const hist = hourlyHistogram(input.orderTimestamps, dayStart, dayEnd);
  const gapHours = [...hist.entries()].filter(([, n]) => n === 0).map(([h]) => h);

  const verdict = evaluateVerdict(dayPnl, avgAdverseBps, input.maxDailyLoss, input.maxAdverseBps);

  return {
    date: input.date,
    sessions: input.sessions.map((s) => ({
      id: s.sessionid,
      status: s.status,
      start: s.st ? new Date(Number(s.st)).toISOString() : null,
      end: s.en ? new Date(Number(s.en)).toISOString() : null,
    })),
    orders: {
      total: input.orderTimestamps.length,
      byStatus: input.orderCountByStatus,
      hourly: [...hist.entries()].map(([h, n]) => ({ hour: new Date(h).toISOString().slice(0, 13) + 'Z', orders: n })),
      gapHours: gapHours.map((h) => new Date(h).toISOString().slice(0, 13) + 'Z'),
    },
    fills: {
      total: dayFills.length,
      buys: { n: buys.length, qty: sum(buys, (f) => f.qty), vwap: vwap(buys) },
      sells: { n: sells.length, qty: sum(sells, (f) => f.qty), vwap: vwap(sells) },
      fees,
      matchedQty: matched,
      roundTripAdversePerBtc,
    },
    pnl: {
      dayRealized: dayPnl,
      lifetimeRealized: fifo.realized,
      position: fifo.position,
      positionAvgCost: fifo.avgCost,
      seeded: input.seed ?? null,
    },
    markout: {
      windowMin: input.markoutWindowMin,
      pairs: dayMarks.length,
      avgAdverseBps,
    },
    verdict,
  };
}

export function renderText(r: ReturnType<typeof buildReport>): string {
  const L: string[] = [];
  const money = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
  L.push(`=== Daily Performance Review — ${r.date} (UTC) ===`);
  L.push('');
  L.push(`Sessions (${r.sessions.length}):`);
  for (const s of r.sessions) L.push(`  - ${s.id} [${s.status}] ${s.start} → ${s.end ?? 'running'}`);
  L.push('');
  L.push(`Orders: ${r.orders.total}`);
  for (const b of r.orders.byStatus) L.push(`  ${b.status}: ${b.n}`);
  L.push(`  zero-order hours: ${r.orders.gapHours.length ? r.orders.gapHours.join(', ') : 'none'}`);
  L.push('');
  L.push(`Fills: ${r.fills.total}`);
  L.push(`  buys : ${r.fills.buys.n} × ${r.fills.buys.qty.toFixed(6)} BTC @ vwap ${money(r.fills.buys.vwap)}`);
  L.push(`  sells: ${r.fills.sells.n} × ${r.fills.sells.qty.toFixed(6)} BTC @ vwap ${money(r.fills.sells.vwap)}`);
  L.push(`  fees: ${money(r.fills.fees)}`);
  if (r.fills.matchedQty > 0) {
    L.push(
      `  round-trip: ${r.fills.matchedQty.toFixed(6)} BTC matched, adverse ${money(r.fills.roundTripAdversePerBtc)}/BTC`
    );
  }
  L.push('');
  L.push(`Realized PnL (FIFO${r.pnl.seeded ? ', seeded' : ', unseeded'}):`);
  L.push(`  day: ${money(r.pnl.dayRealized)}   lifetime: ${money(r.pnl.lifetimeRealized)}`);
  L.push(`  open position: ${r.pnl.position.toFixed(6)} @ ${money(r.pnl.positionAvgCost)}`);
  L.push('');
  if (r.markout.avgAdverseBps === null) {
    L.push(`Mark-out (${r.markout.windowMin}m window): no opposite-side pairs`);
  } else {
    L.push(`Mark-out (${r.markout.windowMin}m window): ${r.markout.pairs} pairs, avg adverse ${r.markout.avgAdverseBps.toFixed(2)}bps`);
  }
  L.push('');
  if (r.verdict.status === 'OK') {
    L.push('VERDICT: OK');
  } else {
    L.push('VERDICT: WARN');
    for (const reason of r.verdict.reasons) L.push(`  ! ${reason}`);
  }
  return L.join('\n');
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
    if (key === 'json' || key === 'help') {
      args[key] = 'true';
      continue;
    }
    args[key] = argv[++i];
  }
  return args;
}

/**
 * Parse an optional numeric CLI flag. Returns the default when unset,
 * or null when set but not a finite number (or not positive when required).
 */
export function parseNumericFlag(
  args: Record<string, string>,
  name: string,
  def: number,
  requirePositive = false
): number | null {
  const raw = args[name];
  if (raw === undefined) return def;
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (requirePositive && n <= 0) return null;
  return n;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: bun scripts/daily-perf-review.ts [--date YYYY-MM-DD] [--json] [--seed-btc N --seed-price P]');
    return 0;
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const date = args.date ?? yesterday;
  const dayStart = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(dayStart)) {
    console.error(`ERROR: invalid --date '${date}' (expected YYYY-MM-DD)`);
    return 2;
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('ERROR: DATABASE_URL not set');
    return 2;
  }

  const seedQty = args['seed-btc'] !== undefined ? Number(args['seed-btc']) : undefined;
  const seedPrice = args['seed-price'] !== undefined ? Number(args['seed-price']) : undefined;
  if ((seedQty === undefined) !== (seedPrice === undefined)) {
    console.error('ERROR: --seed-btc and --seed-price must be given together');
    return 2;
  }
  if (seedQty !== undefined && (!Number.isFinite(seedQty) || !Number.isFinite(seedPrice as number))) {
    console.error('ERROR: seed values must be numeric');
    return 2;
  }

  const markoutWindowMin = parseNumericFlag(args, 'markout-window-min', 5, true);
  const maxDailyLoss = parseNumericFlag(args, 'max-daily-loss', 50);
  const maxAdverseBps = parseNumericFlag(args, 'max-adverse-bps', 10);
  if (markoutWindowMin === null || maxDailyLoss === null || maxAdverseBps === null) {
    console.error('ERROR: --markout-window-min / --max-daily-loss / --max-adverse-bps must be finite numbers (window > 0)');
    return 2;
  }

  const symbol = args.symbol ?? 'BTC-PYUSD';
  const tradingMode = args['trading-mode'];

  try {
    const data = await fetchReportData(dbUrl, dayStart, dayStart + 86400000, symbol, tradingMode);
    const report = buildReport({
      date,
      sessions: data.sessions,
      orderTimestamps: data.orderRows.map((r) => Number(r.timestamp)),
      orderCountByStatus: data.orderCountByStatus,
      fillRows: data.fillRows,
      seed: seedQty !== undefined ? { qty: seedQty, price: seedPrice as number } : undefined,
      markoutWindowMin,
      maxDailyLoss,
      maxAdverseBps,
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(renderText(report));
    return report.verdict.status === 'WARN' ? 1 : 0;
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
