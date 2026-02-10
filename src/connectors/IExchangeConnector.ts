/**
 * Unified interface for exchange connectors
 *
 * All exchanges (Gemini, Kraken, Coinbase) implement this interface to provide
 * consistent access to market data subscriptions, trading, and account operations.
 *
 * Design patterns:
 * - Unified WebSocket (Gemini, Kraken): Single connection for data + trading
 * - Split Architecture (Coinbase): WebSocket for data, REST for trading
 */

export interface ConnectionHealth {
  connected: boolean;
  lastMessageAt: number;
  reconnectCount: number;
  latencyMs: number;
}

export interface RateLimits {
  ordersPerSecond: number;
  requestsPerMinute: number;
}

export interface SymbolInfo {
  symbol: string;
  minOrderSize: number;
  maxOrderSize: number;
  tickSize: number;
  exchange: string;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookUpdate {
  symbol: string;
  exchange: string;
  timestamp: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface TradeUpdate {
  symbol: string;
  exchange: string;
  timestamp: number;
  tradeId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
}

export interface TickerUpdate {
  symbol: string;
  exchange: string;
  timestamp: number;
  bid: number;
  ask: number;
  last: number;
  volume24h: number;
}

export type OrderBookCallback = (data: OrderBookUpdate) => void;
export type TradeCallback = (data: TradeUpdate) => void;
export type TickerCallback = (data: TickerUpdate) => void;

export interface OrderParams {
  symbol: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  price?: number;
  size: number;
  timeInForce: 'GTC' | 'IOC' | 'FOK';
  postOnly?: boolean;
  clientOrderId: string;
}

export interface Order {
  id: string;
  clientOrderId: string;
  timestamp: number;
  symbol: string;
  exchange: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market';
  price: number;
  size: number;
  status: 'pending' | 'open' | 'filled' | 'cancelled' | 'rejected';
  filledSize: number;
  avgFillPrice: number;
  fee: number;
  feeCurrency: string;
}

export interface CancelResult {
  success: boolean;
  orderId?: string;
  count?: number;
  pending?: boolean;
}

export interface Balance {
  [currency: string]: {
    available: number;
    total: number;
  };
}

export interface Position {
  symbol: string;
  exchange: string;
  quantity: number;
  avgPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  lastUpdated: number;
}

export interface Trade {
  id: string;
  orderId: string;
  timestamp: number;
  symbol: string;
  exchange: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  fee: number;
  feeCurrency: string;
  realizedPnl: number;
}

export interface TradeQueryParams {
  symbol?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

/**
 * IExchangeConnector - Unified interface for all exchange integrations
 *
 * Implementations:
 * - GeminiConnector: WebSocket Fast API for data + trading
 * - KrakenConnector: WebSocket v2 for data + trading
 * - CoinbaseConnector: WebSocket for data, REST for trading
 */
export interface IExchangeConnector {
  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getConnectionHealth(): ConnectionHealth;

  // Market Data Subscriptions (always WebSocket)
  subscribeOrderBook(symbol: string, callback: OrderBookCallback): Promise<void>;
  subscribeTrades(symbol: string, callback: TradeCallback): Promise<void>;
  subscribeTicker(symbol: string, callback: TickerCallback): Promise<void>;
  unsubscribe(symbol: string, dataType: 'orderbook' | 'trades' | 'ticker'): Promise<void>;

  // Trading (WebSocket if supported, fallback to REST)
  placeOrder(params: OrderParams): Promise<Order>;
  cancelOrder(orderId: string): Promise<CancelResult>;
  cancelAllOrders(symbol?: string): Promise<CancelResult>;
  getOpenOrders(symbol?: string): Promise<Order[]>;

  // Account (REST)
  getBalance(): Promise<Balance>;
  getPositions(): Promise<Position[]>;
  getTrades(params: TradeQueryParams): Promise<Trade[]>;

  // Metadata
  getSymbolInfo(symbol: string): Promise<SymbolInfo>;
  getRateLimits(): RateLimits;
}
