// Per-symbol tick size map and price normalization helpers

export const SYMBOL_TICK_SIZES = {
  'BTC-PYUSD': 0.5,
};

export function getTickSizeForSymbol(symbol) {
  return SYMBOL_TICK_SIZES[symbol] ?? null;
}

function countDecimals(value) {
  const parts = String(value).split('.');
  return parts.length === 2 ? parts[1].length : 0;
}

export function normalizePriceToTick(price, tickSize) {
  if (!tickSize) return Number(price);
  const numericPrice = Number(price);
  const normalized = Math.round(numericPrice / tickSize) * tickSize;
  const decimals = countDecimals(tickSize);
  return Number(normalized.toFixed(decimals));
}

export function normalizePriceForSymbol(symbol, price) {
  const tickSize = getTickSizeForSymbol(symbol);
  return normalizePriceToTick(price, tickSize);
}



