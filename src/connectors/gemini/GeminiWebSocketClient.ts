/**
 * Gemini WebSocket Client for Fast API
 *
 * Gemini Fast API provides a unified WebSocket connection for both
 * market data and trading operations.
 *
 * API: wss://wsapi.fast.gemini.com
 * Docs: https://docs.gemini.com/websocket/fast-api/introduction
 */

import type {
  OrderBookCallback,
  TradeCallback,
  TickerCallback,
  ConnectionHealth,
} from '../IExchangeConnector';
import { createHmac } from 'crypto';
import type { Logger } from '../../utils/Logger';
import { ConsoleLogger } from '../../utils/Logger';
import type { ErrorCallback } from './errors';
import {
  ConnectionError,
  ParseError,
  ValidationError,
  InvalidSymbolError,
  SubscriptionError,
} from './errors';
import {
  parseGeminiMessage,
  isTradeMessage,
  isDepthMessage,
  isTickerMessage,
  isErrorMessage,
  type GeminiSubscribeMessage,
} from './types';
import { GeminiSymbolMapper } from './GeminiSymbolMapper';

export interface GeminiWebSocketConfig {
  url?: string;
  apiKey?: string;
  apiSecret?: string;
  logger?: Logger;
  onError?: ErrorCallback;
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
}

export class GeminiWebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private apiKey?: string;
  private apiSecret?: string;
  private logger: Logger;
  private onError?: ErrorCallback;

  /**
   * Symbol extracted from URL for Standard API (sandbox) mode.
   * Standard API embeds the symbol in the URL path, not in each message.
   * Format: wss://api.sandbox.gemini.com/v1/marketdata/ETHUSD
   */
  private urlSymbol: string | null = null;

  private connected: boolean = false;
  private lastMessageAt: number = 0;
  private reconnectCount: number = 0;
  private reconnecting: boolean = false;
  private reconnectTimeout: Timer | null = null;
  private shouldReconnect: boolean = true;

  private reconnectConfig: {
    enabled: boolean;
    baseDelayMs: number;
    maxDelayMs: number;
  };

  private orderBookCallbacks: Map<string, OrderBookCallback> = new Map();
  private tradeCallbacks: Map<string, TradeCallback> = new Map();
  private tickerCallbacks: Map<string, TickerCallback> = new Map();

  constructor(config: GeminiWebSocketConfig = {}) {
    this.url = config.url ?? 'wss://wsapi.fast.gemini.com';
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.logger = config.logger ?? new ConsoleLogger('info', 'GeminiWebSocket');
    this.onError = config.onError;

    // Extract symbol from URL for Standard API (sandbox) mode
    // URL format: wss://api.sandbox.gemini.com/v1/marketdata/ETHUSD
    this.urlSymbol = this.extractSymbolFromUrl(this.url);

    this.reconnectConfig = {
      enabled: config.reconnect?.enabled ?? true,
      baseDelayMs: config.reconnect?.baseDelayMs ?? 1000,
      maxDelayMs: config.reconnect?.maxDelayMs ?? 30000,
    };

    this.shouldReconnect = this.reconnectConfig.enabled;
  }

  /**
   * Extract symbol from URL for Standard API (sandbox) mode.
   * Returns null for Fast API URLs.
   */
  private extractSymbolFromUrl(url: string): string | null {
    // Standard API URL format: wss://api.sandbox.gemini.com/v1/marketdata/ETHUSD
    const match = url.match(/\/v1\/marketdata\/([A-Z]+)$/i);
    if (match) {
      const geminiSymbol = match[1].toUpperCase();
      try {
        return GeminiSymbolMapper.toStandard(geminiSymbol);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Generate authentication headers for WebSocket handshake
   * Gemini Fast API requires:
   * - X-GEMINI-APIKEY: API key
   * - X-GEMINI-NONCE: Current timestamp in seconds
   * - X-GEMINI-SIGNATURE: hex(HMAC_SHA384(base64(nonce), api_secret))
   * - X-GEMINI-PAYLOAD: base64(nonce)
   */
  private generateAuthHeaders(): Record<string, string> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('API key and secret required for authentication');
    }

    const nonce = Math.floor(Date.now() / 1000).toString();
    const payload = Buffer.from(nonce).toString('base64');

    // HMAC-SHA384 signature
    const hmac = createHmac('sha384', this.apiSecret);
    hmac.update(payload);
    const signature = hmac.digest('hex');

    return {
      'X-GEMINI-APIKEY': this.apiKey,
      'X-GEMINI-NONCE': nonce,
      'X-GEMINI-PAYLOAD': payload,
      'X-GEMINI-SIGNATURE': signature,
    };
  }

  /**
   * Connect to Gemini WebSocket
   * For authenticated connections, passes auth headers during handshake
   */
  async connect(): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    // Enable reconnection when connecting
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      try {
        // Generate auth headers if credentials are provided
        const headers = this.apiKey && this.apiSecret
          ? this.generateAuthHeaders()
          : undefined;

        this.ws = new WebSocket(this.url, { headers });

        this.ws.onopen = () => {
          this.connected = true;
          this.lastMessageAt = Date.now();
          resolve();
        };

        this.ws.onclose = () => {
          this.handleClose();
        };

        this.ws.onerror = (error) => {
          this.handleError(error);
          reject(new Error('WebSocket connection failed'));
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket
   * Prevents automatic reconnection and clears all callbacks
   *
   * @param options.clearCallbacks - Whether to clear subscription callbacks (default: false)
   *                                  Set to true for permanent shutdown
   */
  disconnect(options: { clearCallbacks?: boolean } = {}): void {
    this.shouldReconnect = false;
    this.logger.info('Disconnecting from Gemini WebSocket', {
      clearCallbacks: options.clearCallbacks ?? false,
    });

    // Clear any pending reconnection timeouts
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Close WebSocket connection
    if (this.ws) {
      // Remove event listeners before closing to prevent events during shutdown
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;

      this.ws.close();
      this.ws = null;
      this.connected = false;
    }

    // Clear callbacks if requested (for permanent shutdown)
    // Keep callbacks by default to allow resubscription on reconnect
    if (options.clearCallbacks) {
      this.logger.debug('Clearing all subscription callbacks');
      this.orderBookCallbacks.clear();
      this.tradeCallbacks.clear();
      this.tickerCallbacks.clear();
    }
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Get connection health metrics
   */
  getConnectionHealth(): ConnectionHealth {
    const now = Date.now();
    const latencyMs = this.lastMessageAt > 0 ? now - this.lastMessageAt : 0;

    return {
      connected: this.connected,
      lastMessageAt: this.lastMessageAt,
      reconnectCount: this.reconnectCount,
      latencyMs,
    };
  }

  /**
   * Validate symbol format and convert to Gemini format
   * @throws InvalidSymbolError if symbol format is invalid
   */
  private validateAndNormalizeSymbol(symbol: string): string {
    try {
      return GeminiSymbolMapper.toGemini(symbol);
    } catch (error) {
      if (error instanceof InvalidSymbolError) {
        this.onError?.(error);
      }
      throw error;
    }
  }

  /**
   * Subscribe to orderbook updates
   * Subscribes to {symbol}@depth stream for L2 differential updates
   * If not connected, just registers the callback (can subscribe after connection)
   *
   * @param symbol - Symbol in standard format (e.g., "BTC/USD")
   * @param callback - Callback to receive orderbook updates
   * @throws InvalidSymbolError if symbol format is invalid
   */
  subscribeOrderBook(symbol: string, callback: OrderBookCallback): void {
    const geminiSymbol = this.validateAndNormalizeSymbol(symbol);

    this.orderBookCallbacks.set(symbol, callback);

    // Only send subscription if connected
    if (!this.isConnected()) {
      this.logger.debug('Not connected, deferring subscription', { symbol, type: 'orderbook' });
      return;
    }

    const streamName = `${geminiSymbol}@depth`;
    this.logger.debug('Subscribing to orderbook', { symbol, streamName });

    this.send({
      id: `${Date.now()}`,
      method: 'subscribe',
      params: {
        streams: [streamName],
      },
    });
  }

  /**
   * Subscribe to trade updates
   * Subscribes to {symbol}@trade stream
   * If not connected, just registers the callback (can subscribe after connection)
   *
   * @param symbol - Symbol in standard format (e.g., "BTC/USD")
   * @param callback - Callback to receive trade updates
   * @throws InvalidSymbolError if symbol format is invalid
   */
  subscribeTrades(symbol: string, callback: TradeCallback): void {
    const geminiSymbol = this.validateAndNormalizeSymbol(symbol);

    this.tradeCallbacks.set(symbol, callback);

    // Only send subscription if connected
    if (!this.isConnected()) {
      this.logger.debug('Not connected, deferring subscription', { symbol, type: 'trades' });
      return;
    }

    const streamName = `${geminiSymbol}@trade`;
    this.logger.debug('Subscribing to trades', { symbol, streamName });

    this.send({
      id: `${Date.now()}`,
      method: 'subscribe',
      params: {
        streams: [streamName],
      },
    });
  }

  /**
   * Subscribe to ticker updates
   * Subscribes to {symbol}@bookTicker stream for best bid/ask
   * If not connected, just registers the callback (can subscribe after connection)
   *
   * @param symbol - Symbol in standard format (e.g., "BTC/USD")
   * @param callback - Callback to receive ticker updates
   * @throws InvalidSymbolError if symbol format is invalid
   */
  subscribeTicker(symbol: string, callback: TickerCallback): void {
    const geminiSymbol = this.validateAndNormalizeSymbol(symbol);

    this.tickerCallbacks.set(symbol, callback);

    // Only send subscription if connected
    if (!this.isConnected()) {
      this.logger.debug('Not connected, deferring subscription', { symbol, type: 'ticker' });
      return;
    }

    const streamName = `${geminiSymbol}@bookTicker`;
    this.logger.debug('Subscribing to ticker', { symbol, streamName });

    this.send({
      id: `${Date.now()}`,
      method: 'subscribe',
      params: {
        streams: [streamName],
      },
    });
  }

  /**
   * Unsubscribe from a data feed
   *
   * @param symbol - Symbol in standard format (e.g., "BTC/USD")
   * @param dataType - Type of data feed to unsubscribe from
   * @throws InvalidSymbolError if symbol format is invalid
   */
  unsubscribe(symbol: string, dataType: 'orderbook' | 'trades' | 'ticker'): void {
    const geminiSymbol = this.validateAndNormalizeSymbol(symbol);
    let streamName: string;

    switch (dataType) {
      case 'orderbook':
        this.orderBookCallbacks.delete(symbol);
        streamName = `${geminiSymbol}@depth`;
        break;
      case 'trades':
        this.tradeCallbacks.delete(symbol);
        streamName = `${geminiSymbol}@trade`;
        break;
      case 'ticker':
        this.tickerCallbacks.delete(symbol);
        streamName = `${geminiSymbol}@bookTicker`;
        break;
    }

    this.logger.debug('Unsubscribing', { symbol, dataType, streamName });

    // Only send unsubscribe if connected
    if (!this.isConnected()) {
      return;
    }

    this.send({
      id: `${Date.now()}`,
      method: 'unsubscribe',
      params: {
        streams: [streamName],
      },
    });
  }

  /**
   * Send a message to WebSocket
   */
  private send(message: GeminiSubscribeMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      const error = new ConnectionError('WebSocket is not connected');
      this.onError?.(error);
      throw error;
    }

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Handle incoming WebSocket messages
   * Routes messages to appropriate callbacks based on message type.
   *
   * Supports two API formats:
   * - Fast API (production): Messages have 's' field with symbol
   * - Standard API (sandbox): Messages have 'type' and 'events' array, symbol from URL
   */
  private handleMessage(event: MessageEvent): void {
    this.lastMessageAt = Date.now();

    try {
      const message = JSON.parse(event.data.toString());

      // Handle subscription responses (status messages) - Fast API
      if (message.status !== undefined) {
        if (message.status !== 200) {
          console.error('Gemini WebSocket error:', message);
        }
        return;
      }

      // Standard API format (sandbox): has 'type' and 'events' array
      if (message.type !== undefined && message.events !== undefined) {
        this.handleStandardApiMessage(message);
        return;
      }

      // Fast API format (production): has 's' field with symbol
      if (message.s !== undefined) {
        this.handleFastApiMessage(message);
        return;
      }

      // Unknown message format - log for debugging
      this.logger.debug('Ignoring unknown message format', { message });

    } catch (error) {
      console.error('Failed to parse WebSocket message:', error);
    }
  }

  /**
   * Handle Standard API messages (sandbox mode)
   * Format: { type: "update", events: [...], timestampms: 123456 }
   */
  private handleStandardApiMessage(message: any): void {
    // Standard API uses symbol from URL
    const symbol = this.urlSymbol;
    if (!symbol) {
      this.logger.warn('Received Standard API message but no symbol extracted from URL');
      return;
    }

    const timestamp = message.timestampms || Date.now();

    // Process events array
    for (const event of message.events || []) {
      if (event.type === 'trade') {
        // Trade event
        const callback = this.tradeCallbacks.get(symbol);
        if (callback) {
          callback({
            symbol,
            exchange: 'gemini',
            timestamp,
            tradeId: String(event.tid),
            // makerSide: "bid" means maker was buyer, so taker sold
            side: event.makerSide === 'bid' ? 'sell' : 'buy',
            price: Number(event.price),
            size: Number(event.amount),
          });
        }
      } else if (event.type === 'change') {
        // Order book change event - Standard API sends differential updates
        // Each event represents a single price level change (add, update, or remove)
        // The consumer is responsible for maintaining the full order book state
        // by applying these deltas. A remaining size of 0 means remove the level.
        const callback = this.orderBookCallbacks.get(symbol);
        if (callback) {
          const isBid = event.side === 'bid';
          const level = {
            price: Number(event.price),
            size: Number(event.remaining),
          };

          callback({
            symbol,
            exchange: 'gemini',
            timestamp,
            bids: isBid ? [level] : [],
            asks: isBid ? [] : [level],
          });
        }
      }
    }

    // Also emit ticker update if we have best bid/ask tracking callbacks
    // Standard API doesn't have a separate ticker stream, so skip this
  }

  /**
   * Handle Fast API messages (production mode)
   * Format: { s: "ETHUSD", t: tradeId, p: price, q: qty, ... }
   */
  private handleFastApiMessage(message: any): void {
    const symbol = GeminiSymbolMapper.toStandard(message.s);

    // Trade update: has fields t (trade id), p (price), q (quantity), m (maker)
    if (message.t !== undefined && message.p !== undefined && message.q !== undefined) {
      const callback = this.tradeCallbacks.get(symbol);
      if (callback) {
        callback({
          symbol,
          exchange: 'gemini',
          timestamp: message.E ? Number(message.E) / 1_000_000 : Date.now(),
          tradeId: String(message.t),
          side: message.m ? 'sell' : 'buy',
          price: Number(message.p),
          size: Number(message.q),
        });
      }
      return;
    }

    // Depth update: has e = 'depthUpdate' with b/a arrays, or bids/asks arrays
    if (message.e === 'depthUpdate' || message.bids || (Array.isArray(message.b) && Array.isArray(message.a))) {
      const callback = this.orderBookCallbacks.get(symbol);
      if (callback) {
        const bids = message.bids || message.b || [];
        const asks = message.asks || message.a || [];

        callback({
          symbol,
          exchange: 'gemini',
          timestamp: message.E ? Number(message.E) / 1_000_000 : Date.now(),
          bids: bids.map((bid: any) => ({
            price: Number(bid[0]),
            size: Number(bid[1]),
          })),
          asks: asks.map((ask: any) => ({
            price: Number(ask[0]),
            size: Number(ask[1]),
          })),
        });
      }
      return;
    }

    // BookTicker update: has b/B (bid/bid size), a/A (ask/ask size) as strings
    if (message.b !== undefined && message.a !== undefined) {
      const callback = this.tickerCallbacks.get(symbol);
      if (callback) {
        callback({
          symbol,
          exchange: 'gemini',
          timestamp: message.E ? Number(message.E) / 1_000_000 : Date.now(),
          bid: Number(message.b),
          ask: Number(message.a),
          last: 0,
          volume24h: 0,
        });
      }
    }
  }

  /**
   * Calculate exponential backoff delay
   * Returns delay in milliseconds using configured base and max delays
   */
  private getReconnectDelay(): number {
    const delay = Math.min(
      this.reconnectConfig.baseDelayMs * Math.pow(2, this.reconnectCount),
      this.reconnectConfig.maxDelayMs
    );
    return delay;
  }

  /**
   * Resubscribe to all active subscriptions
   * Called after successful reconnection
   */
  private resubscribeAll(): void {
    this.logger.info('Resubscribing to all active feeds');

    // Resubscribe to all orderbook feeds
    for (const symbol of this.orderBookCallbacks.keys()) {
      const geminiSymbol = GeminiSymbolMapper.toGemini(symbol);
      const streamName = `${geminiSymbol}@depth`;
      this.send({
        id: `${Date.now()}`,
        method: 'subscribe',
        params: {
          streams: [streamName],
        },
      });
    }

    // Resubscribe to all trade feeds
    for (const symbol of this.tradeCallbacks.keys()) {
      const geminiSymbol = GeminiSymbolMapper.toGemini(symbol);
      const streamName = `${geminiSymbol}@trade`;
      this.send({
        id: `${Date.now()}`,
        method: 'subscribe',
        params: {
          streams: [streamName],
        },
      });
    }

    // Resubscribe to all ticker feeds
    for (const symbol of this.tickerCallbacks.keys()) {
      const geminiSymbol = GeminiSymbolMapper.toGemini(symbol);
      const streamName = `${geminiSymbol}@bookTicker`;
      this.send({
        id: `${Date.now()}`,
        method: 'subscribe',
        params: {
          streams: [streamName],
        },
      });
    }
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  private async attemptReconnect(): Promise<void> {
    if (!this.shouldReconnect || this.reconnecting) {
      return;
    }

    this.reconnecting = true;
    const delay = this.getReconnectDelay();

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectCount + 1})...`);

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;

      try {
        await this.connect();
        // Success - reset
        this.reconnectCount = 0;
        this.reconnecting = false;
        this.resubscribeAll();
        console.log('Reconnected successfully');
      } catch (error) {
        // Failure - increment and retry
        this.reconnectCount++;
        this.reconnecting = false;
        console.error('Reconnection failed:', error);
        this.attemptReconnect();
      }
    }, delay);
  }

  /**
   * Handle WebSocket close event
   * Triggers automatic reconnection with exponential backoff
   */
  private handleClose(): void {
    this.connected = false;
    console.log('WebSocket connection closed');

    if (this.shouldReconnect) {
      this.attemptReconnect();
    }
  }

  /**
   * Handle WebSocket error event
   */
  private handleError(error: Event): void {
    console.error('WebSocket error:', error);
  }
}
