// Orchestrates Coinbase WS ingest with L2 OrderBookBuilder and trade-based OHLC builder

import { CoinbaseWsIngest } from './coinbase-ws-ingest.js';
import { OrderBookBuilder } from './orderbook-builder.js';
import { TrueXOhlcBuilder } from './ohlc-builder.js';
import { MARKET_DATA_CONFIG } from './market-data-config.js';

export class L2OhlcOrchestrator {
  constructor({
    symbols = MARKET_DATA_CONFIG.symbols,
    depth = MARKET_DATA_CONFIG.depth,
    ohlcIntervalMs = 60_000,
    logger = console,
    IngestClass = CoinbaseWsIngest,
  } = {}) {
    this.logger = logger;
    this.symbols = symbols;
    this.depth = depth;
    this.ohlcIntervalMs = ohlcIntervalMs;
    this.IngestClass = IngestClass;

    this.symbolToBook = new Map();
    this.symbolToOhlc = new Map();

    for (const symbol of this.symbols) {
      this.symbolToBook.set(symbol, new OrderBookBuilder(symbol, this.depth));
      this.symbolToOhlc.set(symbol, new TrueXOhlcBuilder({ symbol, intervalMs: this.ohlcIntervalMs, exchange: 'coinbase' }));
    }

    this.ingest = null;
  }

  async start() {
    this.ingest = new this.IngestClass({
      symbols: this.symbols,
      logger: this.logger,
      onSnapshot: (symbol, snapshot) => this.onSnapshot(symbol, snapshot),
      onL2Update: (symbol, deltas) => this.onL2Update(symbol, deltas),
      onTrade: (symbol, trades) => this.onTrade(symbol, trades),
      onTicker: (symbol, ticker) => this.onTicker(symbol, ticker),
    });
    await this.ingest.start();
  }

  stop() {
    if (this.ingest) {
      this.ingest.stop();
    }
  }

  onSnapshot(symbol, snapshot) {
    const book = this.symbolToBook.get(symbol);
    if (!book) return;
    book.applySnapshot(snapshot);
  }

  onL2Update(symbol, deltas) {
    const book = this.symbolToBook.get(symbol);
    if (!book) return;
    book.applyDeltas(deltas);
  }

  onTrade(symbol, trades) {
    const ohlc = this.symbolToOhlc.get(symbol);
    if (!ohlc) return;
    for (const t of trades) {
      ohlc.updateWithTrade({
        timestamp: t.timestamp,
        price: t.price,
        volume: t.volume,
        symbol,
      });
    }
  }

  // Optional: could use ticker for heartbeat or last price prints
  onTicker(_symbol, _ticker) {}

  getDepth(symbol, depth = this.depth) {
    const book = this.symbolToBook.get(symbol);
    return book ? book.getDepth(depth) : null;
  }

  getTopOfBook(symbol) {
    const book = this.symbolToBook.get(symbol);
    return book ? book.getTopOfBook() : null;
  }

  flushCompleteCandles(symbol, nowTs = Date.now()) {
    const ohlc = this.symbolToOhlc.get(symbol);
    return ohlc ? ohlc.flushCompleteCandles(nowTs) : [];
  }
}



