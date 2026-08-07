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
 * True FIFO realized PnL over chronologically ordered fills: the oldest open
 * lot is always closed first, for both long and short inventory. Positions may
 * flip through zero. Optional seed inventory (e.g. funded BTC) enters as an
 * initial long lot at the given cost basis.
 */
export function computeFifo(fills: Fill[], seed?: { qty: number; price: number }): FifoResult {
  interface Lot {
    qty: number;
    price: number;
  }
  const lots: Lot[] = [];
  let sign = 0; // +1 long, -1 short, 0 flat
  let realized = 0;
  const cumAfter: number[] = [];
  const EPS = 1e-9;

  if (seed && seed.qty > 0) {
    lots.push({ qty: seed.qty, price: seed.price });
    sign = 1;
  }

  for (const f of fills) {
    const dir = f.side === 'buy' ? 1 : -1;
    let qty = f.qty;

    if (sign === 0 || dir === sign) {
      // Flat or extending: open a new lot
      lots.push({ qty, price: f.price });
      sign = dir;
    } else {
      // Reducing/flipping: close oldest lots first (FIFO)
      while (qty > EPS && lots.length) {
        const lot = lots[0];
        const closing = Math.min(qty, lot.qty);
        realized += sign === 1 ? closing * (f.price - lot.price) : closing * (lot.price - f.price);
        lot.qty -= closing;
        qty -= closing;
        if (lot.qty <= EPS) lots.shift();
      }
      if (lots.length === 0) {
        sign = 0;
        if (qty > EPS) {
          // Flipped through flat: remainder opens a position at this fill's price
          lots.push({ qty, price: f.price });
          sign = dir;
        }
      }
    }
    cumAfter.push(realized);
  }

  const openQty = lots.reduce((s, l) => s + l.qty, 0);
  const position = sign * openQty;
  const avgCost = openQty > EPS ? lots.reduce((s, l) => s + l.qty * l.price, 0) / openQty : 0;
  return { realized, position, avgCost, cumAfter };
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
  lu: string | null; // lastupdated — diagnostics only, never an end signal
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

    // Only endedat/completedat are true end signals. lastupdated is a
    // heartbeat and must not be treated as an end time (it would wrongly
    // age out running sessions).
    const sessions: SessionRow[] = await q(
      `select sessionid, status,
              coalesce(startedat, starttimestamp, addedat) as st,
              coalesce(endedat, completedat) as en,
              lastupdated as lu
       from sessions
       where coalesce(startedat, starttimestamp, addedat) < $2
         and (coalesce(endedat, completedat) is null
              or coalesce(endedat, completedat) >= $1)
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
      lastActivity: s.lu ? new Date(Number(s.lu)).toISOString() : null,
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
  for (const s of r.sessions)
    L.push(`  - ${s.id} [${s.status}] ${s.start} → ${s.end ?? `running (last activity ${s.lastActivity})`}`);
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
 * or null when set but invalid (not finite, empty, or violating the
 * positivity constraint).
 */
export function parseNumericFlag(
  args: Record<string, string>,
  name: string,
  def: number,
  opts: { positive?: boolean; nonNegative?: boolean } = {}
): number | null {
  const raw = args[name];
  if (raw === undefined) return def;
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (opts.positive && n <= 0) return null;
  if (opts.nonNegative && n < 0) return null;
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
  if (seedQty !== undefined && seedQty <= 0) {
    console.error('ERROR: --seed-btc must be positive (seed enters as a long lot)');
    return 2;
  }

  const markoutWindowMin = parseNumericFlag(args, 'markout-window-min', 5, { positive: true });
  const maxDailyLoss = parseNumericFlag(args, 'max-daily-loss', 50, { nonNegative: true });
  const maxAdverseBps = parseNumericFlag(args, 'max-adverse-bps', 10, { nonNegative: true });
  if (markoutWindowMin === null || maxDailyLoss === null || maxAdverseBps === null) {
    console.error(
      'ERROR: --markout-window-min must be a finite number > 0; --max-daily-loss / --max-adverse-bps must be finite numbers >= 0'
    );
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
