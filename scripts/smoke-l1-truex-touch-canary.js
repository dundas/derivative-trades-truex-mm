#!/usr/bin/env bun
import { QuoteEngine } from '../src/core/quote-engine.js';

const engine = new QuoteEngine({
  fixConnection: { sendMessage() {} },
  inventoryManager: { canQuote: () => true, getSkew: () => ({ bidSkewTicks: 0, askSkewTicks: 0 }) },
  levels: 1, baseSizeBTC: 0.0005, baseSpreadBps: 60, tickSize: 0.5,
  strictTruexMakerSafety: true, quoteDispatchMode: 'live',
  minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80, contractOrderStateMaxAgeMs: 5000,
  authoritativeOrderStateProvider: () => ({ available: true, timestamp: Date.now(), orders: [] }),
  minimalLiveCanaryConfig: {
    enabled: true, runId: 'canary-run-0001', durationMs: 900000, maxCumulativeFilledBTC: 0.001,
    oneMinuteMarkoutDeadlineMs: 60000, levels: 1, baseSizeBTC: 0.0005,
    minimumQuoteWidthBps: 30, contractMaxQuoteSpreadBps: 80,
  },
  logger: { info() {}, warn() {}, error() {} },
});
engine.updateTruexEbbo({ bestBid: 10000, bestAsk: 10050, timestamp: Date.now() });
const quotes = engine.computeDesiredQuotes(10025, { bidSkewTicks: 0, askSkewTicks: 0 });
const bid = quotes.find(quote => quote.side === 'buy');
const ask = quotes.find(quote => quote.side === 'sell');
if (bid?.price !== 10000 || ask?.price !== 10050) throw new Error('canary did not join both TrueX touch prices');
for (const quote of quotes) {
  const prepared = engine._prepareQuoteForSend(quote);
  if (!prepared) throw new Error(`safe touch quote was suppressed: ${quote.side}`);
  if (prepared.side === 'buy' && prepared.price >= 10050) throw new Error('marketable buy prepared');
  if (prepared.side === 'sell' && prepared.price <= 10000) throw new Error('marketable sell prepared');
}
console.log(JSON.stringify({ result: 'PASS', bid: bid.price, ask: ask.price }));
