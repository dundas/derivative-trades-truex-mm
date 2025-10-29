// Runtime configuration for market data builders (L2 + OHLC)
// Values are sourced from environment variables with sensible defaults.

function parseListFromEnv(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  const parts = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : fallback;
}

function getNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMarketDataConfig() {
  const symbols = parseListFromEnv(process.env.TRUEX_MD_SYMBOLS, ['BTC-PYUSD']);
  const depth = getNumberEnv('TRUEX_L2_DEPTH', 10);
  const snapshotMs = getNumberEnv('TRUEX_L2_SNAPSHOT_MS', 1000);
  const ohlcIntervals = parseListFromEnv(process.env.TRUEX_OHLC_INTERVALS, ['1m']);

  return {
    symbols,
    depth,
    snapshotMs,
    ohlcIntervals,
  };
}

export const MARKET_DATA_CONFIG = getMarketDataConfig();



