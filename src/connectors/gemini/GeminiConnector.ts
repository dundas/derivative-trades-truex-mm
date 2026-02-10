/**
 * Unified Gemini Exchange Connector
 *
 * Combines GeminiRestClient (for trading) and GeminiWebSocketClient (for market data)
 * Implements IExchangeConnector interface for consistent access across exchanges.
 *
 * Architecture:
 * - WebSocket: Market data subscriptions (orderbook, trades, ticker)
 * - REST: Trading operations (place/cancel orders, account data)
 */

import type {
  IExchangeConnector,
  ConnectionHealth,
  OrderBookCallback,
  TradeCallback,
  TickerCallback,
  OrderParams,
  Order,
  CancelResult,
  Balance,
  Position,
  Trade,
  TradeQueryParams,
  SymbolInfo,
  RateLimits,
} from '../IExchangeConnector';

import { GeminiWebSocketClient } from './GeminiWebSocketClient';
import { GeminiRestClient } from './GeminiRestClient';

export interface GeminiConnectorConfig {
  apiKey?: string;
  apiSecret?: string;
  sandbox?: boolean;
  wsUrl?: string;
  restUrl?: string;
  /** Primary symbol for sandbox mode (required for sandbox WebSocket) */
  primarySymbol?: string;
}

export class GeminiConnector implements IExchangeConnector {
  private wsClient: GeminiWebSocketClient;
  private restClient: GeminiRestClient;
  private config: GeminiConnectorConfig;

  constructor(config: GeminiConnectorConfig = {}) {
    this.config = config;

    // Determine WebSocket URL based on sandbox mode
    // Production: wss://wsapi.fast.gemini.com (Fast API - subscribe after connect)
    // Sandbox: wss://api.sandbox.gemini.com/v1/marketdata/{SYMBOL} (Standard API - symbol in URL)
    let wsUrl: string;
    if (config.wsUrl) {
      wsUrl = config.wsUrl;
    } else if (config.sandbox) {
      // Sandbox requires symbol in URL path (Standard WebSocket API)
      // Validate primarySymbol is provided for sandbox mode
      if (!config.primarySymbol) {
        throw new Error(
          'primarySymbol is required for sandbox mode. ' +
            'Sandbox WebSocket requires the symbol in the URL path.'
        );
      }
      // Convert symbol format: "ETH/USD" -> "ETHUSD"
      const symbol = config.primarySymbol.replace('/', '');
      wsUrl = `wss://api.sandbox.gemini.com/v1/marketdata/${symbol}`;
    } else {
      // Production uses Fast API (no symbol in URL)
      wsUrl = 'wss://wsapi.fast.gemini.com';
    }

    // Initialize WebSocket client
    this.wsClient = new GeminiWebSocketClient({
      url: wsUrl,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
    });

    // Initialize REST client
    this.restClient = new GeminiRestClient({
      sandbox: config.sandbox,
      baseUrl: config.restUrl,
    });
  }

  /**
   * Connect to Gemini (WebSocket for market data)
   */
  async connect(): Promise<void> {
    await this.wsClient.connect();
  }

  /**
   * Disconnect from Gemini
   */
  async disconnect(): Promise<void> {
    this.wsClient.disconnect();
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.wsClient.isConnected();
  }

  /**
   * Get connection health metrics
   */
  getConnectionHealth(): ConnectionHealth {
    return this.wsClient.getConnectionHealth();
  }

  /**
   * Subscribe to orderbook updates (WebSocket)
   */
  async subscribeOrderBook(symbol: string, callback: OrderBookCallback): Promise<void> {
    this.wsClient.subscribeOrderBook(symbol, callback);
  }

  /**
   * Subscribe to trade updates (WebSocket)
   */
  async subscribeTrades(symbol: string, callback: TradeCallback): Promise<void> {
    this.wsClient.subscribeTrades(symbol, callback);
  }

  /**
   * Subscribe to ticker updates (WebSocket)
   */
  async subscribeTicker(symbol: string, callback: TickerCallback): Promise<void> {
    this.wsClient.subscribeTicker(symbol, callback);
  }

  /**
   * Unsubscribe from a data feed (WebSocket)
   */
  async unsubscribe(symbol: string, dataType: 'orderbook' | 'trades' | 'ticker'): Promise<void> {
    this.wsClient.unsubscribe(symbol, dataType);
  }

  /**
   * Place an order (REST API)
   * Note: Gemini Fast API supports WebSocket trading, but we'll implement REST first
   */
  async placeOrder(params: OrderParams): Promise<Order> {
    // TODO: Implement order placement via REST API
    // This will be implemented in a future task
    throw new Error('placeOrder not yet implemented');
  }

  /**
   * Cancel an order (REST API)
   */
  async cancelOrder(orderId: string): Promise<CancelResult> {
    // TODO: Implement order cancellation via REST API
    throw new Error('cancelOrder not yet implemented');
  }

  /**
   * Cancel all orders (REST API)
   */
  async cancelAllOrders(symbol?: string): Promise<CancelResult> {
    // TODO: Implement bulk order cancellation via REST API
    throw new Error('cancelAllOrders not yet implemented');
  }

  /**
   * Get open orders (REST API)
   */
  async getOpenOrders(symbol?: string): Promise<Order[]> {
    // TODO: Implement get open orders via REST API
    throw new Error('getOpenOrders not yet implemented');
  }

  /**
   * Get account balance (REST API)
   */
  async getBalance(): Promise<Balance> {
    // TODO: Implement get balance via REST API
    throw new Error('getBalance not yet implemented');
  }

  /**
   * Get positions (REST API)
   */
  async getPositions(): Promise<Position[]> {
    // TODO: Implement get positions via REST API
    // Note: Gemini is a spot exchange, positions may not apply
    return [];
  }

  /**
   * Get trade history (REST API)
   */
  async getTrades(params: TradeQueryParams): Promise<Trade[]> {
    // TODO: Implement get trades via REST API
    throw new Error('getTrades not yet implemented');
  }

  /**
   * Get symbol information (REST API)
   */
  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    // TODO: Implement get symbol info via REST API
    throw new Error('getSymbolInfo not yet implemented');
  }

  /**
   * Get rate limits
   */
  getRateLimits(): RateLimits {
    // Gemini rate limits (from documentation)
    // Public API: 120 requests per minute
    // Private API: 600 requests per minute
    return {
      ordersPerSecond: 10, // Conservative estimate (600/60)
      requestsPerMinute: 120, // Public API limit
    };
  }
}
