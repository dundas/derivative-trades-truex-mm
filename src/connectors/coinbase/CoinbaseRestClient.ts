/**
 * Coinbase Advanced Trade API REST Client
 *
 * API Docs: https://docs.cloud.coinbase.com/advanced-trade-api/docs/
 */

export type CoinbaseTicker = {
  price: number;
  bid: number;
  ask: number;
  volume: number;
  timestamp: number;
};

export type CoinbaseCandle = {
  start: number; // Unix timestamp in seconds
  low: number;
  high: number;
  open: number;
  close: number;
  volume: number;
};

export class CoinbaseRestClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs = 15_000;

  // Coinbase uses product IDs like BTC-USD, ETH-USD, SOL-USD
  private static readonly PRODUCT_ID_MAP: Record<string, string> = {
    "BTC/USD": "BTC-USD",
    "ETH/USD": "ETH-USD",
    "SOL/USD": "SOL-USD",
    "XRP/USD": "XRP-USD",
    "ADA/USD": "ADA-USD",
    "DOGE/USD": "DOGE-USD",
    "LINK/USD": "LINK-USD",
    "AVAX/USD": "AVAX-USD",
    "DOT/USD": "DOT-USD",
    "UNI/USD": "UNI-USD",
    "LTC/USD": "LTC-USD",
  };

  // Granularity in seconds
  private static readonly GRANULARITY_MAP: Record<number, number> = {
    1: 60, // 1 min
    5: 300, // 5 min
    15: 900, // 15 min
    60: 3600, // 1 hour
    360: 21600, // 6 hours
    1440: 86400, // 1 day
  };

  constructor(options: { baseUrl?: string } = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.coinbase.com";
  }

  private toProductId(pair: string): string {
    const mapped = CoinbaseRestClient.PRODUCT_ID_MAP[pair];
    if (mapped) return mapped;
    // Fallback: replace / with -
    return pair.replace("/", "-");
  }

  private toGranularity(intervalMin: number): number {
    const mapped = CoinbaseRestClient.GRANULARITY_MAP[intervalMin];
    if (mapped) return mapped;
    // Default to closest available
    if (intervalMin <= 1) return 60;
    if (intervalMin <= 5) return 300;
    if (intervalMin <= 15) return 900;
    if (intervalMin <= 60) return 3600;
    if (intervalMin <= 360) return 21600;
    return 86400;
  }

  /**
   * Get current ticker data
   *
   * API: GET /api/v3/brokerage/products/{product_id}
   */
  async getTicker(pair: string): Promise<CoinbaseTicker> {
    const productId = this.toProductId(pair);
    const url = `${this.baseUrl}/api/v3/brokerage/products/${productId}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Coinbase API error: ${response.status} ${response.statusText} - ${text}`);
      }

      const data = await response.json();

      return {
        price: Number(data.price),
        bid: Number(data.quote_increment), // Note: Coinbase doesn't provide bid/ask in product endpoint
        ask: Number(data.quote_increment),
        volume: Number(data.volume_24h || 0),
        timestamp: Date.now(),
      };
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        throw new Error(`Coinbase request timeout after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Get ticker with best bid/ask from ticker endpoint
   *
   * API: GET /api/v3/brokerage/products/{product_id}/ticker
   */
  async getTickerWithBidAsk(pair: string): Promise<CoinbaseTicker> {
    const productId = this.toProductId(pair);
    const url = `${this.baseUrl}/api/v3/brokerage/products/${productId}/ticker`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Coinbase API error: ${response.status} ${response.statusText} - ${text}`);
      }

      const data = await response.json();

      return {
        price: Number(data.price),
        bid: Number(data.best_bid || data.price),
        ask: Number(data.best_ask || data.price),
        volume: Number(data.volume || 0),
        timestamp: Date.now(),
      };
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        throw new Error(`Coinbase request timeout after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Get historical candles
   *
   * API: GET /api/v3/brokerage/products/{product_id}/candles
   *
   * Note: Coinbase returns max 300 candles per request
   */
  async getCandles(options: {
    pair: string;
    interval: number; // minutes
    start?: number; // Unix timestamp in seconds
    end?: number; // Unix timestamp in seconds
  }): Promise<{ candles: CoinbaseCandle[] }> {
    const productId = this.toProductId(options.pair);
    const granularity = this.toGranularity(options.interval);

    const params = new URLSearchParams({
      granularity: String(granularity),
    });

    if (options.start) {
      params.set("start", String(options.start));
    }
    if (options.end) {
      params.set("end", String(options.end));
    }

    const url = `${this.baseUrl}/api/v3/brokerage/products/${productId}/candles?${params.toString()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Coinbase API error: ${response.status} ${response.statusText} - ${text}`);
      }

      const data = await response.json();

      if (!data.candles || !Array.isArray(data.candles)) {
        throw new Error(`Unexpected response format from Coinbase: ${JSON.stringify(data)}`);
      }

      // Coinbase returns: {start, low, high, open, close, volume}
      const candles: CoinbaseCandle[] = data.candles.map((c: any) => ({
        start: Number(c.start),
        low: Number(c.low),
        high: Number(c.high),
        open: Number(c.open),
        close: Number(c.close),
        volume: Number(c.volume),
      }));

      // Sort ascending by timestamp
      candles.sort((a, b) => a.start - b.start);

      return { candles };
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        throw new Error(`Coinbase request timeout after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }
}
