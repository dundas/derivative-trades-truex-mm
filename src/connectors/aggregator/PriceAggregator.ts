/**
 * PriceAggregator - Combines price feeds from multiple exchanges
 *
 * Features:
 * - Real-time price aggregation from Coinbase, Kraken, Gemini
 * - Weighted average pricing based on volume/liquidity
 * - Automatic failover if an exchange goes down
 * - Staleness detection for each feed
 * - Best bid/ask across all venues
 */

import { EventEmitter } from "events";
import {
  OrderBookUpdate,
  TickerUpdate,
  OrderBookLevel,
} from "../IExchangeConnector";

export interface ExchangeFeed {
  exchange: string;
  lastUpdate: number;
  ticker?: TickerUpdate;
  tickerReceivedAt?: number;
  orderbook?: OrderBookUpdate;
  orderbookReceivedAt?: number;
  weight: number; // Relative weight for averaging (based on volume/reliability)
  isStale: boolean;
}

export interface AggregatedPrice {
  timestamp: number;
  symbol: string;
  midpoint: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadBps: number;
  weightedMidpoint: number;
  sources: {
    exchange: string;
    bid: number;
    ask: number;
    midpoint: number;
    weight: number;
    isStale: boolean;
    latencyMs: number;
    sourceTimestamp: number | null;
    receivedTimestamp: number;
  }[];
  confidence: number; // 0-1, based on number of active feeds
}

export interface AggregatedOrderBook {
  timestamp: number;
  symbol: string;
  bids: (OrderBookLevel & { exchange: string })[];
  asks: (OrderBookLevel & { exchange: string })[];
  totalBidDepth: number;
  totalAskDepth: number;
}

export interface PriceAggregatorConfig {
  symbol: string;
  stalenessThresholdMs?: number;
  updateIntervalMs?: number;
  weights?: Record<string, number>;
}

export class PriceAggregator extends EventEmitter {
  private feeds: Map<string, ExchangeFeed> = new Map();
  private symbol: string;
  private stalenessThresholdMs: number;
  private updateIntervalMs: number;
  private updateInterval?: ReturnType<typeof setInterval>;
  private weights: Record<string, number>;

  constructor(config: PriceAggregatorConfig) {
    super();
    this.symbol = config.symbol;
    this.stalenessThresholdMs = config.stalenessThresholdMs ?? 5000;
    this.updateIntervalMs = config.updateIntervalMs ?? 100;
    this.weights = config.weights ?? {
      coinbase: 0.5, // Highest liquidity for BTC-USD
      kraken: 0.3,
      gemini: 0.2,
    };
  }

  /**
   * Register an exchange feed
   */
  registerExchange(exchange: string, weight?: number): void {
    this.feeds.set(exchange, {
      exchange,
      lastUpdate: 0,
      weight: weight ?? this.weights[exchange] ?? 0.1,
      isStale: true,
    });
  }

  /**
   * Update ticker data from an exchange
   */
  updateTicker(ticker: TickerUpdate): void {
    const feed = this.feeds.get(ticker.exchange);
    if (!feed) {
      this.registerExchange(ticker.exchange);
    }

    const currentFeed = this.feeds.get(ticker.exchange)!;
    currentFeed.ticker = ticker;
    currentFeed.tickerReceivedAt = Date.now();
    currentFeed.lastUpdate = currentFeed.tickerReceivedAt;
    currentFeed.isStale = false;

    this.emit("ticker", ticker);
    this.checkAndEmitAggregatedPrice();
  }

  /**
   * Update orderbook data from an exchange
   */
  updateOrderBook(orderbook: OrderBookUpdate): void {
    const feed = this.feeds.get(orderbook.exchange);
    if (!feed) {
      this.registerExchange(orderbook.exchange);
    }

    const currentFeed = this.feeds.get(orderbook.exchange)!;
    currentFeed.orderbook = orderbook;
    currentFeed.orderbookReceivedAt = Date.now();
    currentFeed.lastUpdate = currentFeed.orderbookReceivedAt;
    currentFeed.isStale = false;

    this.emit("orderbook", orderbook);
    this.checkAndEmitAggregatedPrice();
  }

  /**
   * Start periodic staleness checks
   */
  start(): void {
    this.updateInterval = setInterval(() => {
      this.checkStaleness();
    }, this.updateIntervalMs);
  }

  /**
   * Stop the aggregator
   */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = undefined;
    }
  }

  /**
   * Check for stale feeds
   */
  private checkStaleness(): void {
    const now = Date.now();
    for (const [exchange, feed] of this.feeds) {
      const wasStale = feed.isStale;
      feed.isStale = now - feed.lastUpdate > this.stalenessThresholdMs;

      if (feed.isStale && !wasStale) {
        this.emit("stale", { exchange, lastUpdate: feed.lastUpdate });
      } else if (!feed.isStale && wasStale) {
        this.emit("recovered", { exchange });
      }
    }
  }

  /**
   * Get aggregated price from all active feeds
   */
  getAggregatedPrice(): AggregatedPrice | null {
    const now = Date.now();
    const activeSources: AggregatedPrice["sources"] = [];

    let totalWeight = 0;
    let weightedBidSum = 0;
    let weightedAskSum = 0;
    let bestBid = 0;
    let bestAsk = Infinity;

    for (const [exchange, feed] of this.feeds) {
      if (!feed.ticker && !feed.orderbook) continue;

      const bid = feed.ticker?.bid ?? feed.orderbook?.bids[0]?.price ?? 0;
      const ask = feed.ticker?.ask ?? feed.orderbook?.asks[0]?.price ?? 0;

      if (bid <= 0 || ask <= 0) continue;

      const midpoint = (bid + ask) / 2;
      const latencyMs = now - feed.lastUpdate;
      const isStale = feed.isStale;

      // Only include non-stale feeds in weighted calculation
      if (!isStale) {
        const weight = feed.weight;
        totalWeight += weight;
        weightedBidSum += bid * weight;
        weightedAskSum += ask * weight;

        // Track best bid/ask across venues
        if (bid > bestBid) bestBid = bid;
        if (ask < bestAsk) bestAsk = ask;
      }

      activeSources.push({
        exchange,
        bid,
        ask,
        midpoint,
        weight: feed.weight,
        isStale,
        latencyMs,
        sourceTimestamp: Number.isSafeInteger(feed.ticker?.timestamp)
          ? feed.ticker!.timestamp
          : Number.isSafeInteger(feed.orderbook?.timestamp) ? feed.orderbook!.timestamp : null,
        receivedTimestamp: feed.ticker
          ? feed.tickerReceivedAt ?? feed.lastUpdate
          : feed.orderbookReceivedAt ?? feed.lastUpdate,
      });
    }

    if (activeSources.length === 0 || totalWeight === 0) {
      return null;
    }

    const weightedBid = weightedBidSum / totalWeight;
    const weightedAsk = weightedAskSum / totalWeight;
    const weightedMidpoint = (weightedBid + weightedAsk) / 2;

    // If no non-stale feeds, use best available
    if (bestBid === 0) bestBid = activeSources[0].bid;
    if (bestAsk === Infinity) bestAsk = activeSources[0].ask;

    const midpoint = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadBps = (spread / midpoint) * 10000;

    // Confidence based on number of active (non-stale) feeds
    const activeFeeds = activeSources.filter((s) => !s.isStale).length;
    const confidence = Math.min(activeFeeds / 3, 1); // 3 feeds = 100% confidence

    return {
      timestamp: now,
      symbol: this.symbol,
      midpoint,
      bestBid,
      bestAsk,
      spread,
      spreadBps,
      weightedMidpoint,
      sources: activeSources,
      confidence,
    };
  }

  /**
   * Get aggregated orderbook from all exchanges
   */
  getAggregatedOrderBook(depth: number = 10): AggregatedOrderBook | null {
    const allBids: (OrderBookLevel & { exchange: string })[] = [];
    const allAsks: (OrderBookLevel & { exchange: string })[] = [];

    for (const [exchange, feed] of this.feeds) {
      if (!feed.orderbook || feed.isStale) continue;

      for (const bid of feed.orderbook.bids.slice(0, depth)) {
        allBids.push({ ...bid, exchange });
      }
      for (const ask of feed.orderbook.asks.slice(0, depth)) {
        allAsks.push({ ...ask, exchange });
      }
    }

    if (allBids.length === 0 && allAsks.length === 0) {
      return null;
    }

    // Sort bids descending, asks ascending
    allBids.sort((a, b) => b.price - a.price);
    allAsks.sort((a, b) => a.price - b.price);

    // Calculate total depth
    const totalBidDepth = allBids.reduce((sum, b) => sum + b.size, 0);
    const totalAskDepth = allAsks.reduce((sum, a) => sum + a.size, 0);

    return {
      timestamp: Date.now(),
      symbol: this.symbol,
      bids: allBids.slice(0, depth),
      asks: allAsks.slice(0, depth),
      totalBidDepth,
      totalAskDepth,
    };
  }

  /**
   * Get the best price to use for market making
   * Returns weighted midpoint with safety checks
   */
  getBestPrice(): { price: number; confidence: number } | null {
    const aggregated = this.getAggregatedPrice();
    if (!aggregated) return null;

    return {
      price: aggregated.weightedMidpoint,
      confidence: aggregated.confidence,
    };
  }

  /**
   * Get status of all feeds
   */
  getStatus(): {
    feeds: Record<
      string,
      { isStale: boolean; lastUpdate: number; hasData: boolean }
    >;
    activeFeedCount: number;
    totalFeedCount: number;
  } {
    const feeds: Record<
      string,
      { isStale: boolean; lastUpdate: number; hasData: boolean }
    > = {};

    let activeFeedCount = 0;
    for (const [exchange, feed] of this.feeds) {
      const hasData = !!(feed.ticker || feed.orderbook);
      feeds[exchange] = {
        isStale: feed.isStale,
        lastUpdate: feed.lastUpdate,
        hasData,
      };
      if (!feed.isStale && hasData) activeFeedCount++;
    }

    return {
      feeds,
      activeFeedCount,
      totalFeedCount: this.feeds.size,
    };
  }

  private checkAndEmitAggregatedPrice(): void {
    const price = this.getAggregatedPrice();
    if (price) {
      this.emit("price", price);
    }
  }
}
