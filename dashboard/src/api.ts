const BASE = '/api/proxy';

async function apiFetch(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const body = await res.json();
  // Upstream wraps successful responses as { success, data, meta }. Unwrap to data
  // when present so callers get the payload directly; fall back to the raw body.
  return (body as { data?: unknown })?.data ?? body;
}

interface SpreadPnlData {
  spreadPnl?: number;
  matchedVolume?: number;
  avgBuyPrice?: number;
  avgSellPrice?: number;
  tradingCashFlow?: number;
  fillCount?: number;
}

export const api = {
  health: () => apiFetch('/api/v1/health'),

  status: async () => {
    const d = (await apiFetch('/api/status')) as { status?: string } | null;
    return { ...d, state: d?.status };
  },

  /**
   * Assembles the dashboard P&L summary from the single /analytics/spread-pnl summary
   * endpoint (one aggregate row — no unbounded history download on the poll loop). If that
   * endpoint is unavailable, spread/cash-flow/matched are backfilled from the live in-memory
   * P&L on /api/status; fillCount stays DB-only (undefined → tile renders "—") because the
   * live session numTrades is a different metric and must not masquerade as the lifetime total.
   */
  pnl: async () => {
    let spread: SpreadPnlData = {};
    try {
      spread = (await apiFetch('/api/v1/analytics/spread-pnl')) as SpreadPnlData;
    } catch {
      /* optional — backfilled from /api/status below if it failed */
    }

    // pnlTracker.getSummary on /api/status: realizedPnL = FIFO spread P&L, netCashFlow =
    // sell − buy, totalMatchedQuantity = matched volume.
    let live: { realizedPnL?: number; netCashFlow?: number; totalMatchedQuantity?: number } = {};
    if (spread.spreadPnl === undefined) {
      try {
        const d = (await apiFetch('/api/status')) as { pnl?: typeof live } | null;
        live = d?.pnl ?? {};
      } catch {
        /* live status optional too — final fallback is zeros */
      }
    }

    return {
      fillCount: spread.fillCount,
      spreadPnl: spread.spreadPnl ?? live.realizedPnL ?? 0,
      matchedVolume: spread.matchedVolume ?? live.totalMatchedQuantity ?? 0,
      avgBuyPrice: spread.avgBuyPrice ?? 0,
      avgSellPrice: spread.avgSellPrice ?? 0,
      tradingCashFlow: spread.tradingCashFlow ?? live.netCashFlow ?? 0,
    };
  },

  fills: async (params = '') => {
    const rows = (await apiFetch(`/api/v1/fills${params}`)) as Array<{
      side?: string;
      price?: number;
      size?: number;
      quantity?: number;
      amount?: number;
      timestamp?: string;
    }>;
    return {
      // qty mirrors the backend's COALESCE(size, amount, ...) convention.
      fills: Array.isArray(rows)
        ? rows.map((f) => ({ side: f.side, price: f.price, qty: f.size ?? f.quantity ?? f.amount, timestamp: f.timestamp }))
        : [],
    };
  },

  sessions: () => apiFetch('/api/v1/sessions'),
  logsTail: (lines = 50) => apiFetch(`/api/v1/logs/tail?lines=${lines}`),
};
