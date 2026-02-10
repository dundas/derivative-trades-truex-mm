import { createHmac } from 'crypto';

export type GeminiCandle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type GeminiTicker = {
  bid: number;
  ask: number;
  last: number;
  volume: {
    [symbol: string]: number;
  };
};

export type GeminiOrderBookEntry = {
  price: number;
  amount: number;
};

export type GeminiOrderBook = {
  bids: GeminiOrderBookEntry[];
  asks: GeminiOrderBookEntry[];
};

export type GeminiBalance = {
  currency: string;
  amount: string;
  available: string;
  availableForWithdrawal: string;
  type: string;
};

export type GeminiOrder = {
  order_id: string;
  id: string;
  symbol: string;
  exchange: string;
  avg_execution_price: string;
  side: 'buy' | 'sell';
  type: 'exchange limit' | 'exchange stop limit' | 'market buy' | 'market sell';
  timestamp: string;
  timestampms: number;
  is_live: boolean;
  is_cancelled: boolean;
  is_hidden: boolean;
  was_forced: boolean;
  executed_amount: string;
  remaining_amount: string;
  options?: string[];
  price: string;
  original_amount: string;
};

export type GeminiTrade = {
  price: string;
  amount: string;
  timestamp: number;
  timestampms: number;
  type: 'Buy' | 'Sell';
  aggressor: boolean;
  fee_currency: string;
  fee_amount: string;
  tid: number;
  order_id: string;
  exchange: string;
  is_auction_fill: boolean;
  break?: string;
};

export type GeminiSymbolInfo = {
  symbol: string;
  base_currency: string;
  quote_currency: string;
  tick_size: number;
  quote_increment: number;
  min_order_size: string;
  status: 'open' | 'closed' | 'cancel_only' | 'post_only' | 'limit_only';
  wrap_enabled: boolean;
};

/**
 * Gemini REST API Client
 *
 * Provides methods for interacting with the Gemini cryptocurrency exchange API,
 * including public market data endpoints and authenticated trading operations.
 *
 * @example
 * ```typescript
 * // Public endpoints (no authentication required)
 * const publicClient = new GeminiRestClient();
 * const ticker = await publicClient.getTicker('BTC/USD');
 * const symbols = await publicClient.getSymbols();
 *
 * // Authenticated endpoints (requires API credentials)
 * const tradingClient = new GeminiRestClient({
 *   apiKey: process.env.GEMINI_API_KEY,
 *   apiSecret: process.env.GEMINI_API_SECRET,
 * });
 *
 * const balances = await tradingClient.getBalance();
 * const order = await tradingClient.placeOrder({
 *   pair: 'BTC/USD',
 *   amount: '0.01',
 *   price: '50000.00',
 *   side: 'buy',
 * });
 * ```
 *
 * @remarks
 * **Rate Limits:**
 * - Public endpoints: 120 requests per minute
 * - Private endpoints: 600 requests per minute
 * - Exceeding limits results in HTTP 429 (Too Many Requests)
 *
 * **API Key Permissions:**
 * - Trading operations require an API key with "Trader" permissions
 * - Read-only operations can use "Auditor" permissions
 * - Create API keys at: https://exchange.gemini.com/settings/api
 *
 * **Authentication:**
 * - Uses HMAC-SHA384 signature with API key/secret
 * - Nonce is automatically managed (monotonically increasing)
 * - Nonce format: Unix timestamp in seconds
 *
 * **Supported Environments:**
 * - Production: https://api.gemini.com (default)
 * - Sandbox: https://api.sandbox.gemini.com (set `sandbox: true`)
 *
 * **Common Error Codes:**
 * - 400: Invalid parameters or symbol
 * - 401: Authentication failed (check API key/secret)
 * - 403: Insufficient API key permissions
 * - 429: Rate limit exceeded
 * - 500: Internal server error (retry with exponential backoff)
 *
 * **Troubleshooting:**
 * - "InvalidNonce" error: System clock may be out of sync
 * - "InvalidApiKey" error: Check credentials or use production (not sandbox) keys
 * - Order rejection: Verify price aligns with quote_increment from getSymbolInfo()
 * - Rate limits: Implement request throttling or upgrade account tier
 *
 * @see https://docs.gemini.com/rest-api/ - Official Gemini REST API Documentation
 */
export class GeminiRestClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiSecret?: string;
  private readonly requestTimeoutMs = 15_000;
  private nonce: number = Math.floor(Date.now() / 1000);

  // Gemini uses lowercase symbols without slashes: btcusd, ethusd, etc.
  private static readonly GEMINI_SYMBOL_MAP: Record<string, string> = {
    "BTC/USD": "btcusd",
    "ETH/USD": "ethusd",
    "SOL/USD": "solusd",
    "XRP/USD": "xrpusd",
    "ADA/USD": "adausd",
    "DOT/USD": "dotusd",
    "LINK/USD": "linkusd",
    "AVAX/USD": "avaxusd",
    "ATOM/USD": "atomusd",
    "DOGE/USD": "dogeusd",
    "UNI/USD": "uniusd",
    "LTC/USD": "ltcusd",
    "BCH/USD": "bchusd",
    "XLM/USD": "xlmusd",
  };

  // Map time interval (in minutes) to Gemini time_frame strings
  // Gemini expects: 1m, 5m, 15m, 30m, 1hr, 6hr, 1day
  private static readonly TIME_FRAME_MAP: Record<number, string> = {
    1: "1m",
    5: "5m",
    15: "15m",
    30: "30m",
    60: "1hr",
    360: "6hr",
    1440: "1day",
  };

  constructor(options: {
    baseUrl?: string;
    sandbox?: boolean;
    apiKey?: string;
    apiSecret?: string;
  } = {}) {
    if (options.sandbox) {
      this.baseUrl = "https://api.sandbox.gemini.com";
    } else {
      this.baseUrl = options.baseUrl ?? "https://api.gemini.com";
    }
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
  }

  /**
   * Generate nonce for authenticated requests
   * Gemini requires nonce to be current timestamp in SECONDS (not milliseconds!)
   * Ensures monotonically increasing nonces even for rapid sequential requests
   */
  private generateNonce(): number {
    const now = Math.floor(Date.now() / 1000);
    this.nonce = Math.max(this.nonce + 1, now);
    return this.nonce;
  }

  /**
   * Sign a request payload using HMAC-SHA384
   * @param payload - Base64-encoded JSON payload
   * @returns Hex-encoded signature
   */
  private signPayload(payload: string): string {
    if (!this.apiSecret) {
      throw new Error('API secret is required for authenticated requests');
    }
    return createHmac('sha384', this.apiSecret)
      .update(payload)
      .digest('hex');
  }

  /**
   * Make an authenticated request to Gemini API
   * @param endpoint - API endpoint path (e.g., '/v1/order/new')
   * @param params - Request parameters (will be merged with request and nonce)
   */
  private async makeAuthenticatedRequest<T>(
    endpoint: string,
    params: Record<string, any> = {}
  ): Promise<T> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('API key and secret are required for authenticated requests');
    }

    const nonce = this.generateNonce();
    const payload = {
      request: endpoint,
      nonce,
      ...params,
    };

    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signature = this.signPayload(payloadBase64);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'text/plain',
          'X-GEMINI-APIKEY': this.apiKey,
          'X-GEMINI-PAYLOAD': payloadBase64,
          'X-GEMINI-SIGNATURE': signature,
        },
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${text}`);
      }

      return await response.json();
    } catch (error: unknown) {
      clearTimeout(timeout);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Gemini request timeout after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }

  private toGeminiSymbol(pair: string): string {
    const mapped = GeminiRestClient.GEMINI_SYMBOL_MAP[pair];
    if (mapped) return mapped;
    // Fallback: remove slash and lowercase
    return pair.replace("/", "").toLowerCase();
  }

  private toTimeFrame(intervalMin: number): string {
    const mapped = GeminiRestClient.TIME_FRAME_MAP[intervalMin];
    if (mapped) return mapped;
    // Default to closest available
    if (intervalMin <= 1) return "1m";
    if (intervalMin <= 5) return "5m";
    if (intervalMin <= 15) return "15m";
    if (intervalMin <= 30) return "30m";
    if (intervalMin <= 60) return "1hr";
    if (intervalMin <= 360) return "6hr";
    return "1day";
  }

  /**
   * Fetch OHLC candles from Gemini
   *
   * Gemini API: GET /v2/candles/{symbol}/{time_frame}
   * Response: [[timestamp_ms, open, high, low, close, volume], ...]
   *
   * Note: Gemini returns data in descending order (newest first)
   */
  async getOHLC(options: {
    pair: string;
    interval: number; // minutes
    since?: number; // timestamp in seconds (optional)
  }): Promise<{ candles: GeminiCandle[] }> {
    const symbol = this.toGeminiSymbol(options.pair);
    const timeFrame = this.toTimeFrame(options.interval);
    const url = `${this.baseUrl}/v2/candles/${symbol}/${timeFrame}`;

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
        throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${text}`);
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        throw new Error(`Unexpected response format from Gemini: expected array, got ${typeof data}`);
      }

      // Convert Gemini format: [timestamp, open, high, low, close, volume]
      // to our format: {ts, open, high, low, close, volume}
      const candles: GeminiCandle[] = data
        .map((item: any) => {
          if (!Array.isArray(item) || item.length < 6) {
            return null;
          }
          return {
            ts: Number(item[0]), // Gemini returns timestamp in milliseconds
            open: Number(item[1]),
            high: Number(item[2]),
            low: Number(item[3]),
            close: Number(item[4]),
            volume: Number(item[5]),
          };
        })
        .filter((c): c is GeminiCandle => c !== null);

      // Filter by 'since' if provided (convert seconds to ms)
      const sinceMs = options.since ? options.since * 1000 : 0;
      const filtered = candles.filter((c) => c.ts >= sinceMs);

      // Sort ascending by timestamp (Gemini returns descending)
      filtered.sort((a, b) => a.ts - b.ts);

      return { candles: filtered };
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        throw new Error(`Gemini request timeout after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Get available trading pairs from Gemini
   */
  async getSymbols(): Promise<string[]> {
    const url = `${this.baseUrl}/v1/symbols`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${text}`);
      }

      const data = await response.json();
      return Array.isArray(data) ? data : [];
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        throw new Error(`Gemini request timeout after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Get ticker data (bid, ask, last price)
   *
   * Gemini API: GET /v1/pubticker/{symbol}
   */
  async getTicker(pair: string): Promise<GeminiTicker> {
    const symbol = this.toGeminiSymbol(pair);
    const url = `${this.baseUrl}/v1/pubticker/${symbol}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${text}`);
      }

      const data = await response.json();

      return {
        bid: Number(data.bid),
        ask: Number(data.ask),
        last: Number(data.last),
        volume: data.volume,
      };
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        throw new Error(`Gemini request timeout after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Get order book data
   *
   * Gemini API: GET /v1/book/{symbol}
   * Optional params:
   * - limit_bids: default 50, max 500
   * - limit_asks: default 50, max 500
   */
  async getOrderBook(pair: string, options?: { limitBids?: number; limitAsks?: number }): Promise<GeminiOrderBook> {
    const symbol = this.toGeminiSymbol(pair);
    const params = new URLSearchParams();

    if (options?.limitBids) {
      params.set("limit_bids", String(options.limitBids));
    }
    if (options?.limitAsks) {
      params.set("limit_asks", String(options.limitAsks));
    }

    const url = `${this.baseUrl}/v1/book/${symbol}${params.toString() ? `?${params.toString()}` : ""}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${text}`);
      }

      const data = await response.json();

      return {
        bids: data.bids.map((b: any) => ({
          price: Number(b.price),
          amount: Number(b.amount),
        })),
        asks: data.asks.map((a: any) => ({
          price: Number(a.price),
          amount: Number(a.amount),
        })),
      };
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === "AbortError") {
        throw new Error(`Gemini request timeout after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Get account balances
   *
   * Gemini API: POST /v1/balances
   * Requires authentication
   */
  async getBalance(): Promise<GeminiBalance[]> {
    return this.makeAuthenticatedRequest<GeminiBalance[]>('/v1/balances');
  }

  /**
   * Get symbol details (min/max order size, tick size, etc.)
   *
   * Gemini API: GET /v1/symbols/details/{symbol}
   * Public endpoint (no authentication required)
   */
  async getSymbolInfo(pair: string): Promise<GeminiSymbolInfo> {
    const symbol = this.toGeminiSymbol(pair);
    const url = `${this.baseUrl}/v1/symbols/details/${symbol}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${text}`);
      }

      return await response.json();
    } catch (error: unknown) {
      clearTimeout(timeout);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Gemini request timeout after ${this.requestTimeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Place a new order
   *
   * Gemini API: POST /v1/order/new
   * Requires authentication
   *
   * @param options - Order parameters
   * @param options.pair - Trading pair (e.g., "BTC/USD")
   * @param options.amount - Order amount in base currency
   * @param options.price - Limit price (required for limit orders)
   * @param options.side - Order side: 'buy' or 'sell'
   * @param options.type - Order type (default: 'exchange limit')
   * @param options.options - Additional order options (e.g., ['maker-or-cancel', 'post-only'])
   */
  async placeOrder(options: {
    pair: string;
    amount: string;
    price: string;
    side: 'buy' | 'sell';
    type?: 'exchange limit' | 'exchange stop limit';
    options?: string[];
  }): Promise<GeminiOrder> {
    const symbol = this.toGeminiSymbol(options.pair);

    const params: Record<string, any> = {
      symbol,
      amount: options.amount,
      price: options.price,
      side: options.side,
      type: options.type || 'exchange limit',
    };

    if (options.options && options.options.length > 0) {
      params.options = options.options;
    }

    return this.makeAuthenticatedRequest<GeminiOrder>('/v1/order/new', params);
  }

  /**
   * Get all open orders
   *
   * Gemini API: POST /v1/orders
   * Requires authentication
   */
  async getOpenOrders(): Promise<GeminiOrder[]> {
    return this.makeAuthenticatedRequest<GeminiOrder[]>('/v1/orders');
  }

  /**
   * Cancel a specific order
   *
   * Gemini API: POST /v1/order/cancel
   * Requires authentication
   *
   * @param orderId - The order ID to cancel
   */
  async cancelOrder(orderId: string): Promise<GeminiOrder> {
    return this.makeAuthenticatedRequest<GeminiOrder>('/v1/order/cancel', {
      order_id: orderId,
    });
  }

  /**
   * Cancel all active orders
   *
   * Gemini API: POST /v1/order/cancel/all
   * Requires authentication
   */
  async cancelAllOrders(): Promise<{ result: string; details: { cancelledOrders: string[]; cancelRejects: string[] } }> {
    return this.makeAuthenticatedRequest('/v1/order/cancel/all');
  }

  /**
   * Get past trades for the account
   *
   * Gemini API: POST /v1/mytrades
   * Requires authentication
   *
   * @param pair - Trading pair (e.g., "BTC/USD")
   * @param options - Optional parameters
   * @param options.limit_trades - Maximum number of trades to return (default 50, max 500)
   * @param options.timestamp - Only return trades after this timestamp
   */
  async getTrades(
    pair: string,
    options?: {
      limit_trades?: number;
      timestamp?: number;
    }
  ): Promise<GeminiTrade[]> {
    const symbol = this.toGeminiSymbol(pair);
    const params: Record<string, any> = { symbol };

    if (options?.limit_trades) {
      params.limit_trades = options.limit_trades;
    }

    if (options?.timestamp) {
      params.timestamp = options.timestamp;
    }

    return this.makeAuthenticatedRequest<GeminiTrade[]>('/v1/mytrades', params);
  }
}
