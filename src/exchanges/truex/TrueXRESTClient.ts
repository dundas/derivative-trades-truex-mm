/**
 * TrueX REST API Client v1
 *
 * Implements the TrueX REST API v1 with HMAC-SHA256 authentication
 * Documentation: https://docs.truemarkets.co/apis/cefi/rest/v1
 *
 * Base URL: https://prod.truex.co/api/v1
 */

import { createHmac } from "crypto";

// ============================================================================
// Types - Order Statuses
// ============================================================================

export type OrderStatus =
  | "INITIALIZED" // Order created, not sent yet
  | "NEW_PENDING" // Sent, not confirmed by exchange
  | "REJECTED" // Order or market condition prevents processing
  | "ACTIVE" // Accepted and open to trading
  | "FILLED" // Entire order traded
  | "CANCEL_PENDING" // Cancel request being processed
  | "CANCELED" // Canceled from request, order conditions, or market conditions
  | "MODIFY_PENDING"; // Modification request being processed

export type OrderSide = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET";
export type TimeInForce = "GTC" | "IOC";
export type LiquidityFlag = "TAKER" | "MAKER";
export type SelfTradeProtection =
  | "INVALID"
  | "NONE"
  | "CANCEL_AGGRESSIVE"
  | "CANCEL_BOTH";

// ============================================================================
// Types - Order Info
// ============================================================================

export interface OrderInfo {
  msg_id?: string;
  parent_id?: string;
  client_id: string;
  instrument_id: string;
  qty: string;
  price?: string;
  flags?: ("USE_AGGRESSIVE_PRICING")[];
  side: OrderSide;
  type: OrderType;
  tif?: TimeInForce;
  exec_inst_flags?: ("ALO")[]; // Add Liquidity Only (post-only)
  hold_fee_rate?: string;
  stp?: SelfTradeProtection;
}

export interface ModifyInfo {
  msg_id?: string;
  parent_id?: string;
  client_id: string;
  prev_modify?: string;
  new_qty: string;
  new_price: string;
  new_type?: "MARKET" | "INVALID";
}

// ============================================================================
// Types - Request Bodies
// ============================================================================

export interface CreateOrderRequest {
  external_id: string;
  info: OrderInfo;
}

export interface ModifyOrderRequest {
  id?: string; // Exchange order ID
  external_id?: string; // Client order ID
  info: ModifyInfo;
}

// ============================================================================
// Types - Response Bodies
// ============================================================================

export interface OrderResponse {
  id: string;
  status: OrderStatus;
  order_info: OrderInfo;
  modify_info?: ModifyInfo;
  external_id: string;
  ref_external_id?: string;
  pending_qty: string;
  leaves_qty: string;
  exeuted_qty: string; // Note: typo in API
  executed_vwap: string;
  total?: string;
  timestamp?: string; // Nanosecond timestamp
  update_timestamp?: string;
}

export interface TradeResponse {
  client_id: string;
  instrument_id: string;
  order_id: string;
  trade_price: string;
  trade_qty: string;
  trade_fee_rate: string;
  liq_flag: LiquidityFlag;
  match_id: string;
  timestamp: string;
}

export interface AssetResponse {
  id: string;
  name: string;
  symbol?: string;
  decimals?: number;
}

export interface InstrumentResponse {
  id: string;
  symbol: string;
  base_asset_id: string;
  quote_asset_id: string;
  price_decimals?: number;
  qty_decimals?: number;
  min_order_qty?: string;
  max_order_qty?: string;
}

export interface MarketQuoteLevel {
  price?: string;
  qty?: string;
  order_count?: string;
  last_update?: string;
}

export interface MarketQuoteTrade {
  price?: string;
  qty?: string;
  timestamp?: string;
}

export interface PublicMarketTradeResponse {
  instrument_id?: string;
  price?: string;
  qty?: string;
  timestamp?: string;
  trade_price?: string;
  trade_qty?: string;
  match_id?: string;
}

export interface MarketQuoteEntry {
  id: string;
  symbol?: string;
  info?: {
    best_bid?: MarketQuoteLevel;
    best_ask?: MarketQuoteLevel;
    last_trade?: MarketQuoteTrade;
    last_update?: string;
  };
}

export interface FlatMarketQuoteResponse {
  instrument_id?: string;
  symbol?: string;
  bid_price?: string;
  ask_price?: string;
  bid_qty?: string;
  ask_qty?: string;
  timestamp?: string;
}

export type MarketQuoteResponse = MarketQuoteEntry[] | FlatMarketQuoteResponse;

export interface Balance {
  asset_id: string;
  asset_name?: string;
  available: string;
  held: string;
  total: string;
  pending?: string;
}

export interface BalanceResponse {
  id: string;
  status: "INVALID"; // Exchange-only status, always INVALID
  unsettled_fees: string;
  fees_hold: string;
  balances: Balance[];
}

export interface ClientResponse {
  id: string;
  ref_client_id?: string;
  cancel_on_disconnect?: boolean;
}

// ============================================================================
// Types - Paginated Response
// ============================================================================

export interface PaginatedResponse<T> {
  data: T[];
  total?: number;
  page?: number;
  page_size?: number;
}

// ============================================================================
// Types - Config
// ============================================================================

export interface TrueXRESTClientConfig {
  baseURL?: string;
  apiKey: string;
  apiSecret: string;
  userId: string;
  timeout?: number;
}

interface TrueXRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

// ============================================================================
// Client Implementation
// ============================================================================

export class TrueXRESTClient {
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly userId: string;
  private readonly timeout: number;

  // Cached asset_id → name mapping (fetched once, reused)
  private assetMap: Record<string, string> | null = null;

  // Known production asset IDs — hardcoded fallback if /asset endpoint fails
  private static readonly KNOWN_ASSETS: Record<string, string> = {
    "78873627519877132": "USD",
    "78873627519877133": "PYUSD",
    "78873627519877134": "BTC",
  };

  constructor(config: TrueXRESTClientConfig) {
    this.baseURL = config.baseURL ?? "https://prod.truex.co/api/v1";
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.userId = config.userId;
    this.timeout = config.timeout ?? 30000;
  }

  // ==========================================================================
  // Authentication
  // ==========================================================================

  private signRequest(
    method: string,
    path: string,
    body?: string
  ): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Create signature message: timestamp + method + path + body
    let message = `${timestamp}${method.toUpperCase()}${path}`;
    if (body) {
      message += body;
    }

    // Generate HMAC-SHA256 signature
    const signature = createHmac("sha256", this.apiSecret)
      .update(message)
      .digest("base64");

    return {
      "x-truex-auth-userid": this.userId,
      "x-truex-auth-timestamp": timestamp,
      "x-truex-auth-token": this.apiKey,
      "x-truex-auth-signature": signature,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
    options: TrueXRequestOptions = {}
  ): Promise<T> {
    // Build query string
    let url = `${this.baseURL}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.append(key, String(value));
        }
      }
      const queryString = params.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    // Sign with path only (exclude query string from signature)
    const bodyString = body ? JSON.stringify(body) : undefined;
    const headers = this.signRequest(method, `/api/v1${path}`, bodyString);

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeout;
    let timedOut = false;
    const abortFromUpstream = () => controller.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) {
        abortFromUpstream();
      } else {
        options.signal.addEventListener("abort", abortFromUpstream, { once: true });
      }
    }
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: bodyString,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (options.signal) {
        options.signal.removeEventListener("abort", abortFromUpstream);
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(
          `TrueX API Error: ${errorData.message ?? response.statusText}`
        ) as Error & { status: number; code?: string; details?: unknown };
        error.status = response.status;
        error.code = errorData.code;
        error.details = errorData;
        throw error;
      }

      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (options.signal) {
        options.signal.removeEventListener("abort", abortFromUpstream);
      }
      if (error instanceof Error && error.name === "AbortError") {
        if (timedOut) {
          throw new Error(`TrueX API: Request timeout after ${timeoutMs}ms`);
        }
        if (options.signal?.aborted) {
          const reason = options.signal.reason;
          throw reason instanceof Error ? reason : new Error("TrueX API: Request aborted");
        }
        throw new Error("TrueX API: Request aborted");
      }
      throw error;
    }
  }

  // ==========================================================================
  // Assets API
  // ==========================================================================

  /**
   * Get assets
   */
  async getAssets(params?: {
    id?: string;
    name?: string;
    page?: number;
    page_size?: number;
  }): Promise<AssetResponse[]> {
    return this.request("GET", "/asset", undefined, params);
  }

  /**
   * Get single asset by ID or name
   */
  async getAsset(idOrName: string): Promise<AssetResponse | undefined> {
    const params = isNaN(Number(idOrName))
      ? { name: idOrName }
      : { id: idOrName };
    const assets = await this.getAssets(params);
    return assets[0];
  }

  // ==========================================================================
  // Instruments API
  // ==========================================================================

  /**
   * Get instruments
   */
  async getInstruments(params?: {
    id?: string;
    symbol?: string;
    page?: number;
    page_size?: number;
  }): Promise<InstrumentResponse[]> {
    return this.request("GET", "/instrument", undefined, params);
  }

  /**
   * Get single instrument by ID or symbol
   */
  async getInstrument(
    idOrSymbol: string
  ): Promise<InstrumentResponse | undefined> {
    const params = isNaN(Number(idOrSymbol))
      ? { symbol: idOrSymbol }
      : { id: idOrSymbol };
    const instruments = await this.getInstruments(params);
    return instruments[0];
  }

  // ==========================================================================
  // Market Data API
  // ==========================================================================

  /**
   * Get market quote (EBBO - Exchange Best Bid and Offer)
   */
  async getMarketQuote(params: {
    instrument_id: string;
    as_of?: string;
  }, options: TrueXRequestOptions = {}): Promise<MarketQuoteResponse> {
    return this.request("GET", "/market/quote", undefined, params, options);
  }

  /**
   * Get market quote by symbol
   */
  async getMarketQuoteBySymbol(
    symbol: string,
    asOf?: string
  ): Promise<MarketQuoteResponse> {
    const instrument = await this.getInstrument(symbol);
    if (!instrument) {
      throw new Error(`Instrument not found: ${symbol}`);
    }
    return this.getMarketQuote({
      instrument_id: instrument.id,
      as_of: asOf,
    });
  }

  /**
   * Get recent public market trades for an instrument.
   */
  async getMarketTrades(params: {
    instrument_id: string;
    size?: number;
  }, options: TrueXRequestOptions = {}): Promise<PublicMarketTradeResponse[]> {
    return this.request("GET", "/market/trade", undefined, params, options);
  }

  // ==========================================================================
  // Clients API
  // ==========================================================================

  /**
   * Get client details
   */
  async getClient(params?: { id?: string }): Promise<ClientResponse> {
    return this.request("GET", "/client", undefined, params);
  }

  /**
   * Update client settings
   */
  async updateClient(data: {
    ref_client_id?: string;
    cancel_on_disconnect?: boolean;
  }): Promise<ClientResponse> {
    return this.request("PATCH", "/client", data);
  }

  // ==========================================================================
  // Orders API
  // ==========================================================================

  /**
   * Get order status by ref_id
   * @param refId - Exchange order ID or client external_id
   * @param idType - 'client' or 'exchange' (default: 'exchange')
   */
  async getOrderStatus(
    refId: string,
    idType: "client" | "exchange" = "exchange"
  ): Promise<OrderResponse[]> {
    return this.request(
      "GET",
      `/order/status/${encodeURIComponent(refId)}`,
      undefined,
      { id_type: idType }
    );
  }

  /**
   * Get active orders
   * @param id - Optional order ID to filter
   */
  async getActiveOrders(id?: string): Promise<OrderResponse[]> {
    return this.request("GET", "/order/active", undefined, id ? { id } : undefined);
  }

  /**
   * Get all orders (historical, last 24 hours)
   * @param params - Query parameters with optional filtering
   */
  async getOrders(params?: {
    query?: string; // JSON filter e.g. {"columns":[{"name":"status","filter":[{"$in":["REJECTED","CANCELED"]}]}]}
    skip?: number;
    size?: number;
  }): Promise<OrderResponse[]> {
    return this.request("GET", "/order", undefined, params);
  }

  /**
   * Get orders with status filter
   */
  async getOrdersByStatus(
    statuses: OrderStatus[],
    skip?: number,
    size?: number
  ): Promise<OrderResponse[]> {
    const query = JSON.stringify({
      columns: [{ name: "status", filter: [{ $in: statuses }] }],
    });
    return this.getOrders({ query, skip, size });
  }

  /**
   * Get all order trades (last 24 hours)
   * @param params - Query parameters
   */
  async getOrderTrades(params: {
    timestamp: string; // Required: nanosecond timestamp
    size?: number; // 1-100, default 10
    skip?: number;
  }): Promise<TradeResponse[]> {
    return this.request("GET", "/order/trade", undefined, params);
  }

  /**
   * Create new order
   */
  async createOrder(request: CreateOrderRequest): Promise<OrderResponse> {
    return this.request("POST", "/order", request);
  }

  /**
   * Create order with simplified parameters
   */
  async placeOrder(params: {
    externalId: string;
    clientId: string;
    instrumentId: string;
    side: OrderSide;
    type: OrderType;
    qty: string | number;
    price?: string | number;
    tif?: TimeInForce;
    postOnly?: boolean;
    stp?: SelfTradeProtection;
    useAggressivePricing?: boolean;
  }): Promise<OrderResponse> {
    const request: CreateOrderRequest = {
      external_id: params.externalId,
      info: {
        client_id: params.clientId,
        instrument_id: params.instrumentId,
        side: params.side,
        type: params.type,
        qty: String(params.qty),
        tif: params.tif ?? "GTC",
      },
    };

    if (params.price !== undefined) {
      request.info.price = String(params.price);
    }

    if (params.postOnly) {
      request.info.exec_inst_flags = ["ALO"];
    }

    if (params.stp) {
      request.info.stp = params.stp;
    }

    if (params.useAggressivePricing) {
      request.info.flags = ["USE_AGGRESSIVE_PRICING"];
    }

    return this.createOrder(request);
  }

  /**
   * Place order by symbol (resolves instrument ID automatically)
   */
  async placeOrderBySymbol(params: {
    externalId: string;
    clientId: string;
    symbol: string;
    side: OrderSide;
    type: OrderType;
    qty: string | number;
    price?: string | number;
    tif?: TimeInForce;
    postOnly?: boolean;
    stp?: SelfTradeProtection;
  }): Promise<OrderResponse> {
    const instrument = await this.getInstrument(params.symbol);
    if (!instrument) {
      throw new Error(`Instrument not found: ${params.symbol}`);
    }

    return this.placeOrder({
      ...params,
      instrumentId: instrument.id,
    });
  }

  /**
   * Modify existing order
   */
  async modifyOrder(request: ModifyOrderRequest): Promise<OrderResponse> {
    return this.request("PATCH", "/order", request);
  }

  /**
   * Modify order with simplified parameters
   */
  async amendOrder(params: {
    orderId?: string; // Exchange order ID
    externalId?: string; // Client order ID
    clientId: string;
    newQty: string | number;
    newPrice: string | number;
    convertToMarket?: boolean;
  }): Promise<OrderResponse> {
    const request: ModifyOrderRequest = {
      info: {
        client_id: params.clientId,
        new_qty: String(params.newQty),
        new_price: String(params.newPrice),
      },
    };

    if (params.orderId) {
      request.id = params.orderId;
    }
    if (params.externalId) {
      request.external_id = params.externalId;
    }
    if (params.convertToMarket) {
      request.info.new_type = "MARKET";
    }

    return this.modifyOrder(request);
  }

  /**
   * Cancel order
   * @param refId - Exchange order ID or client external_id
   * @param idType - 'client' or 'exchange' (default: 'exchange')
   */
  async cancelOrder(
    refId: string,
    idType: "client" | "exchange" = "exchange"
  ): Promise<OrderResponse> {
    return this.request(
      "DELETE",
      `/order/${encodeURIComponent(refId)}`,
      undefined,
      { id_type: idType }
    );
  }

  /**
   * Cancel order by client external ID
   */
  async cancelOrderByExternalId(externalId: string): Promise<OrderResponse> {
    return this.cancelOrder(externalId, "client");
  }

  /**
   * Cancel all active orders
   */
  async cancelAllOrders(): Promise<{
    success: boolean;
    canceled: string[];
    failed: { id: string; error: string }[];
  }> {
    const activeOrders = await this.getActiveOrders();
    const canceled: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const order of activeOrders) {
      try {
        await this.cancelOrder(order.id);
        canceled.push(order.id);
      } catch (error) {
        failed.push({
          id: order.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      success: failed.length === 0,
      canceled,
      failed,
    };
  }

  // ==========================================================================
  // Balances API
  // ==========================================================================

  /**
   * Get account balances
   * @param params - Query parameters
   * @param params.asset_id - Filter by asset ID
   * @param params.asset_name - Filter by asset name
   */
  async getBalances(params?: {
    asset_id?: string;
    asset_name?: string;
  }): Promise<BalanceResponse[]> {
    return this.request("GET", "/balance", undefined, params);
  }

  /**
   * Get balance for specific asset by name
   */
  async getBalanceByAssetName(assetName: string): Promise<Balance | undefined> {
    const response = await this.getBalances({ asset_name: assetName });
    if (!response || response.length === 0) {
      return undefined;
    }
    // Find the specific asset balance in the balances array
    return response[0].balances.find(
      (b) => b.asset_name?.toLowerCase() === assetName.toLowerCase()
    );
  }

  /**
   * Get balance for specific asset by ID
   */
  async getBalanceByAssetId(assetId: string): Promise<Balance | undefined> {
    const response = await this.getBalances({ asset_id: assetId });
    if (!response || response.length === 0) {
      return undefined;
    }
    return response[0].balances.find((b) => b.asset_id === assetId);
  }

  /**
   * Get all balances with fee information
   */
  async getAccountSummary(): Promise<{
    balances: Balance[];
    unsettledFees: number;
    feesHold: number;
  } | null> {
    const response = await this.getBalances();
    if (!response || response.length === 0) {
      return null;
    }

    // Resolve asset names (cached after first call, hardcoded fallback)
    const assetMap = await this.getAssetMap();

    // Normalize raw balance fields to Balance interface
    // API returns: { asset_id, balance, order_hold, transfer_hold, unsettled, state }
    // Interface expects: { asset_id, asset_name, available, held, total }
    const normalizedBalances: Balance[] = response[0].balances.map((raw: any) => {
      const balance = parseFloat(raw.balance ?? raw.available ?? "0");
      const orderHold = parseFloat(raw.order_hold ?? raw.held ?? "0");
      const transferHold = parseFloat(raw.transfer_hold ?? "0");
      const unsettled = parseFloat(raw.unsettled ?? raw.pending ?? "0");
      const available = balance - orderHold - transferHold;
      const total = balance;

      return {
        asset_id: raw.asset_id,
        asset_name: assetMap[raw.asset_id] || raw.asset_name,
        available: String(available),
        held: String(orderHold),
        transfer_hold: String(transferHold),
        total: String(total),
        pending: String(unsettled),
      } as any;
    });

    return {
      balances: normalizedBalances,
      unsettledFees: parseFloat(response[0].unsettled_fees),
      feesHold: parseFloat(response[0].fees_hold),
    };
  }

  /**
   * Parse balance to simplified format
   */
  static parseBalance(balance: Balance): {
    assetId: string;
    assetName: string | undefined;
    available: number;
    held: number;
    transferHold: number;
    total: number;
    pending: number;
  } {
    return {
      assetId: balance.asset_id,
      assetName: balance.asset_name,
      available: parseFloat(balance.available),
      held: parseFloat(balance.held),
      transferHold: parseFloat((balance as any).transfer_hold ?? "0"),
      total: parseFloat(balance.total),
      pending: parseFloat(balance.pending ?? "0"),
    };
  }

  /**
   * Get asset_id → name mapping. Cached after first successful call.
   * Falls back to hardcoded KNOWN_ASSETS if /asset endpoint is unavailable.
   */
  async getAssetMap(): Promise<Record<string, string>> {
    if (this.assetMap) return this.assetMap;

    try {
      // NOTE: The raw /asset response nests name under fields: { id, status, fields: { name } }.
      // This differs from the AssetResponse interface (which reflects a simplified internal view).
      // Using a.fields.name is empirically correct — verified against production API responses.
      const assets = await this.request("GET", "/asset") as Array<{
        id: string;
        fields: { name: string };
      }>;
      const map: Record<string, string> = {};
      for (const a of assets) {
        map[a.id] = a.fields.name;
      }
      this.assetMap = map;
      return map;
    } catch {
      // /asset endpoint failed — cache and use hardcoded fallback
      this.assetMap = { ...TrueXRESTClient.KNOWN_ASSETS };
      return this.assetMap;
    }
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Test connectivity
   */
  async ping(): Promise<{ success: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.getAssets({ page_size: 1 });
      return { success: true, latencyMs: Date.now() - start };
    } catch (error) {
      return { success: false, latencyMs: Date.now() - start };
    }
  }

  /**
   * Generate a unique external ID for orders
   */
  static generateExternalId(prefix?: string): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    const id = `${timestamp}-${random}`;
    return prefix ? `${prefix}-${id}`.substring(0, 18) : id.substring(0, 18);
  }

  /**
   * Convert nanosecond timestamp to Date
   */
  static nanosToDate(nanos: string): Date {
    return new Date(Number(BigInt(nanos) / BigInt(1_000_000)));
  }

  /**
   * Get current timestamp in nanoseconds (for API queries)
   */
  static nowNanos(): string {
    return (BigInt(Date.now()) * BigInt(1_000_000)).toString();
  }

  /**
   * Parse order response to simplified format
   */
  static parseOrder(order: OrderResponse): {
    id: string;
    externalId: string;
    status: OrderStatus;
    side: OrderSide;
    type: OrderType;
    instrumentId: string;
    price: number;
    qty: number;
    pendingQty: number;
    leavesQty: number;
    executedQty: number;
    executedVwap: number;
    createdAt: Date | null;
    updatedAt: Date | null;
  } {
    return {
      id: order.id,
      externalId: order.external_id,
      status: order.status,
      side: order.order_info.side,
      type: order.order_info.type,
      instrumentId: order.order_info.instrument_id,
      price: parseFloat(order.order_info.price ?? "0"),
      qty: parseFloat(order.order_info.qty),
      pendingQty: parseFloat(order.pending_qty),
      leavesQty: parseFloat(order.leaves_qty),
      executedQty: parseFloat(order.exeuted_qty), // Note: API typo
      executedVwap: parseFloat(order.executed_vwap),
      createdAt: order.timestamp
        ? TrueXRESTClient.nanosToDate(order.timestamp)
        : null,
      updatedAt: order.update_timestamp
        ? TrueXRESTClient.nanosToDate(order.update_timestamp)
        : null,
    };
  }

  /**
   * Parse trade response to simplified format
   */
  static parseTrade(trade: TradeResponse): {
    orderId: string;
    instrumentId: string;
    price: number;
    qty: number;
    feeRate: number;
    isMaker: boolean;
    matchId: string;
    timestamp: Date;
  } {
    return {
      orderId: trade.order_id,
      instrumentId: trade.instrument_id,
      price: parseFloat(trade.trade_price),
      qty: parseFloat(trade.trade_qty),
      feeRate: parseFloat(trade.trade_fee_rate),
      isMaker: trade.liq_flag === "MAKER",
      matchId: trade.match_id,
      timestamp: TrueXRESTClient.nanosToDate(trade.timestamp),
    };
  }
}

export default TrueXRESTClient;
