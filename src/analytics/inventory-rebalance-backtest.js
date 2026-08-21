import { evaluateInventoryRebalance, validateInventoryRebalanceConfig } from './inventory-rebalance-model.js';

function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function nonNegative(value, label) {
  finite(value, label);
  if (value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function normalizeFills(fills = []) {
  const ids = new Set();
  return fills.map((fill, index) => {
    const id = String(fill.id || `fill-${index}`);
    if (ids.has(id)) throw new Error(`duplicate fill id: ${id}`);
    ids.add(id);
    if (!['buy', 'sell'].includes(fill.side)) throw new Error(`fill ${id} requires side buy or sell`);
    finite(fill.timestamp, `fill ${id} timestamp`);
    finite(fill.price, `fill ${id} price`);
    finite(fill.quantity, `fill ${id} quantity`);
    if (fill.price <= 0 || fill.quantity <= 0) throw new Error(`fill ${id} requires positive price and quantity`);
    const orderId = String(fill.orderId || id);
    const orderSize = Number.isFinite(fill.orderSize) && fill.orderSize > 0
      ? fill.orderSize
      : fill.quantity;
    return { ...fill, id, orderId, orderSize };
  }).sort((left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id));
}

export function inferStartingBalances(fills, endingBalances) {
  const normalized = normalizeFills(fills);
  const endBTC = nonNegative(endingBalances.btc, 'endingBalances.btc');
  const endQuote = nonNegative(endingBalances.quote, 'endingBalances.quote');
  let baseDelta = 0;
  let quoteDelta = 0;
  for (const fill of normalized) {
    const sign = fill.side === 'buy' ? 1 : -1;
    baseDelta += sign * fill.quantity;
    quoteDelta -= sign * fill.quantity * fill.price;
  }
  const startBTC = endBTC - baseDelta;
  const startQuote = endQuote - quoteDelta;
  if (startBTC < -1e-10 || startQuote < -1e-6) {
    throw new Error('inferred starting balances are negative; transfers or incomplete fills invalidate inference');
  }
  return {
    btc: Math.max(0, startBTC),
    quote: Math.max(0, startQuote),
    assumption: 'No deposits, withdrawals, fees, or unrecorded fills occurred inside the replay window.',
  };
}

function summarizeReplay(state, {
  startingBalances,
  initialMarkPrice,
  finalMarkPrice,
  targetInventoryBTC,
}) {
  const startingValue = startingBalances.quote + (startingBalances.btc * initialMarkPrice);
  const endingValue = state.quote + (state.btc * finalMarkPrice);
  const holdingValue = startingBalances.quote + (startingBalances.btc * finalMarkPrice);
  return {
    startingBalances,
    endingBalances: { btc: state.btc, quote: state.quote },
    startingValue,
    endingValue,
    pnl: endingValue - startingValue,
    holdingValue,
    pnlVsHolding: endingValue - holdingValue,
    netBTCChange: state.btc - startingBalances.btc,
    endingInventoryDeviationBTC: state.btc - targetInventoryBTC,
    minInventoryBTC: state.minInventoryBTC,
    maxInventoryBTC: state.maxInventoryBTC,
    turnoverQuote: state.turnoverQuote,
    fillFragments: state.fillFragments,
    filledOrders: state.filledOrders.size,
    fillQuantityBTC: state.fillQuantityBTC,
    buyQuantityBTC: state.buyQuantityBTC,
    sellQuantityBTC: state.sellQuantityBTC,
    skippedFragments: state.skippedFragments,
    skippedQuantityBTC: state.skippedQuantityBTC,
    capitalLimitedQuantityBTC: state.capitalLimitedQuantityBTC,
    quotePriceImpact: state.quotePriceImpact,
  };
}

function initialState(startingBalances) {
  return {
    btc: startingBalances.btc,
    quote: startingBalances.quote,
    minInventoryBTC: startingBalances.btc,
    maxInventoryBTC: startingBalances.btc,
    turnoverQuote: 0,
    fillFragments: 0,
    filledOrders: new Set(),
    fillQuantityBTC: 0,
    buyQuantityBTC: 0,
    sellQuantityBTC: 0,
    skippedFragments: 0,
    skippedQuantityBTC: 0,
    capitalLimitedQuantityBTC: 0,
    quotePriceImpact: 0,
  };
}

function applyFill(state, side, quantity, price, referencePrice, orderId) {
  if (quantity <= 0) return;
  if (side === 'buy') {
    state.btc += quantity;
    state.quote -= quantity * price;
    state.buyQuantityBTC += quantity;
    state.quotePriceImpact += quantity * (referencePrice - price);
  } else {
    state.btc -= quantity;
    state.quote += quantity * price;
    state.sellQuantityBTC += quantity;
    state.quotePriceImpact += quantity * (price - referencePrice);
  }
  state.minInventoryBTC = Math.min(state.minInventoryBTC, state.btc);
  state.maxInventoryBTC = Math.max(state.maxInventoryBTC, state.btc);
  state.turnoverQuote += quantity * price;
  state.fillFragments++;
  state.filledOrders.add(orderId);
  state.fillQuantityBTC += quantity;
}

function replayActual(fills, startingBalances) {
  const state = initialState(startingBalances);
  for (const fill of fills) applyFill(state, fill.side, fill.quantity, fill.price, fill.price, fill.orderId);
  return state;
}

function candidatePrice(fill, model) {
  if (fill.side === 'buy') return fill.price * (1 - (model.quote.bidSkewBps / 10_000));
  return fill.price * (1 + (model.quote.askSkewBps / 10_000));
}

function survivesObservedExecution(fill, price) {
  if (fill.side === 'buy') return price >= fill.price - 1e-10;
  return price <= fill.price + 1e-10;
}

function replayCandidate(fills, startingBalances, policy, executionModel) {
  if (!['strict-fill-survival', 'same-opportunity'].includes(executionModel)) {
    throw new Error('executionModel must be strict-fill-survival or same-opportunity');
  }
  const state = initialState(startingBalances);
  const candidateOrders = new Map();
  const orderFillTotals = new Map();
  for (const fill of fills) {
    orderFillTotals.set(fill.orderId, (orderFillTotals.get(fill.orderId) || 0) + fill.quantity);
  }

  for (const fill of fills) {
    let order = candidateOrders.get(fill.orderId);
    if (!order) {
      const model = evaluateInventoryRebalance(state.btc, policy);
      const sizeMultiplier = fill.side === 'buy'
        ? model.quote.bidSizeMultiplier
        : model.quote.askSizeMultiplier;
      const observedOrderSize = Math.max(fill.orderSize, orderFillTotals.get(fill.orderId));
      const price = candidatePrice(fill, model);
      order = {
        price,
        remaining: observedOrderSize * sizeMultiplier,
        survives: executionModel === 'same-opportunity' || survivesObservedExecution(fill, price),
        model,
      };
      candidateOrders.set(fill.orderId, order);
    }

    if (!order.survives || order.remaining <= 1e-12) {
      state.skippedFragments++;
      state.skippedQuantityBTC += fill.quantity;
      continue;
    }

    const requested = Math.min(fill.quantity, order.remaining);
    const funded = fill.side === 'buy'
      ? Math.max(0, Math.min(requested, state.quote / order.price))
      : Math.max(0, Math.min(requested, state.btc));
    state.capitalLimitedQuantityBTC += requested - funded;
    if (funded <= 1e-12) {
      state.skippedFragments++;
      state.skippedQuantityBTC += fill.quantity;
      continue;
    }
    applyFill(state, fill.side, funded, order.price, fill.price, fill.orderId);
    order.remaining -= funded;
    if (funded < fill.quantity) {
      state.skippedQuantityBTC += fill.quantity - funded;
    }
  }
  return state;
}

export function backtestInventoryRebalancing({
  fills = [],
  endingBalances,
  policy,
  initialMarkPrice,
  finalMarkPrice,
} = {}) {
  const normalized = normalizeFills(fills);
  if (normalized.length === 0) throw new Error('backtest requires at least one fill');
  const validatedPolicy = validateInventoryRebalanceConfig(policy);
  positiveMark(initialMarkPrice, 'initialMarkPrice');
  positiveMark(finalMarkPrice, 'finalMarkPrice');
  const startingBalances = inferStartingBalances(normalized, endingBalances);
  const actual = replayActual(normalized, startingBalances);
  const strict = replayCandidate(normalized, startingBalances, validatedPolicy, 'strict-fill-survival');
  const sameOpportunity = replayCandidate(normalized, startingBalances, validatedPolicy, 'same-opportunity');
  const summaryOptions = {
    startingBalances,
    initialMarkPrice,
    finalMarkPrice,
    targetInventoryBTC: validatedPolicy.targetInventoryBTC,
  };
  return {
    methodology: {
      actual: 'Replays every recorded fill at its recorded price and quantity.',
      strictFillSurvival: 'Keeps only recorded execution opportunities where the shifted quote was at least as aggressive as the filled quote; size never exceeds recorded taker quantity.',
      sameOpportunity: 'Assumes every recorded taker opportunity also reaches the shifted quote; size never exceeds recorded taker quantity.',
      limitations: [
        'No new fills are invented.',
        'No queue-position, post-only crossing, transfer, or unrecorded-fee model is available.',
        'Policy state is evaluated when an order first fills because pre-fill decision telemetry is unavailable for most of the window.',
        'Starting balances are inferred from ending balances and recorded fills under a no-transfer assumption.',
      ],
    },
    policy: validatedPolicy,
    window: {
      startTimestamp: normalized[0].timestamp,
      endTimestamp: normalized.at(-1).timestamp,
      recordedFillFragments: normalized.length,
      recordedOrders: new Set(normalized.map(fill => fill.orderId)).size,
      initialMarkPrice,
      finalMarkPrice,
    },
    actual: summarizeReplay(actual, summaryOptions),
    strictFillSurvival: summarizeReplay(strict, summaryOptions),
    sameOpportunity: summarizeReplay(sameOpportunity, summaryOptions),
  };
}

function positiveMark(value, label) {
  finite(value, label);
  if (value <= 0) throw new Error(`${label} must be positive`);
}
