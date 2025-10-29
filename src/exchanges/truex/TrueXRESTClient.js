import crypto from 'crypto';
import axios from 'axios';

/**
 * TrueX REST API Client
 * 
 * Implements the TrueX REST API v1 with HMAC-SHA256 authentication
 * Documentation: https://docs.truemarkets.co/apis/cefi/rest/v1
 */
export class TrueXRESTClient {
  constructor(config) {
    this.baseURL = config.baseURL || 'https://prod.truex.co/api/v1';
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.userId = config.userId;
    this.timeout = config.timeout || 30000;
    
    // Create axios instance
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: this.timeout,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    // Add request interceptor for authentication
    this.client.interceptors.request.use(
      (config) => this._signRequest(config),
      (error) => Promise.reject(error)
    );
    
    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response.data,
      (error) => this._handleError(error)
    );
  }

  /**
   * Signs the request with HMAC-SHA256 authentication
   */
  _signRequest(config) {
    const timestamp = Date.now().toString();
    const method = config.method.toUpperCase();
    const path = config.url;
    
    // Create signature message
    let message = `${timestamp}${method}${path}`;
    
    // Add body for POST/PATCH requests
    if (config.data && (method === 'POST' || method === 'PATCH')) {
      const body = typeof config.data === 'string' 
        ? config.data 
        : JSON.stringify(config.data);
      message += body;
    }
    
    // Generate HMAC signature
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(message)
      .digest('hex');
    
    // Set authentication headers
    config.headers['x-truex-auth-userid'] = this.userId;
    config.headers['x-truex-auth-timestamp'] = timestamp;
    config.headers['x-truex-auth-token'] = this.apiKey;
    config.headers['x-truex-auth-signature'] = signature;
    
    return config;
  }

  /**
   * Handles API errors
   */
  _handleError(error) {
    if (error.response) {
      // API returned an error response
      const { status, data } = error.response;
      const message = data?.message || data?.error || 'Unknown error';
      
      const apiError = new Error(`TrueX API Error: ${message}`);
      apiError.status = status;
      apiError.code = data?.code;
      apiError.details = data;
      
      throw apiError;
    } else if (error.request) {
      // Request was made but no response received
      throw new Error(`TrueX API: No response received - ${error.message}`);
    } else {
      // Something else happened
      throw new Error(`TrueX API: Request failed - ${error.message}`);
    }
  }

  // ========== Assets API ==========

  /**
   * Get assets
   * @param {Object} params
   * @param {string} [params.id] - Asset ID
   * @param {string} [params.name] - Asset name (supports wildcards)
   * @param {number} [params.page] - Page number (default: 1)
   * @param {number} [params.page_size] - Page size (default: 100, max: 500)
   */
  async getAssets(params = {}) {
    return this.client.get('/asset', { params });
  }

  /**
   * Get single asset by ID or name
   */
  async getAsset(idOrName) {
    const params = isNaN(idOrName) ? { name: idOrName } : { id: idOrName };
    const response = await this.getAssets(params);
    return response.data?.[0];
  }

  // ========== Instruments API ==========

  /**
   * Get instruments
   * @param {Object} params
   * @param {string} [params.id] - Instrument ID
   * @param {string} [params.symbol] - Instrument symbol (supports wildcards)
   * @param {number} [params.page] - Page number
   * @param {number} [params.page_size] - Page size
   */
  async getInstruments(params = {}) {
    return this.client.get('/instrument', { params });
  }

  /**
   * Get single instrument by ID or symbol
   */
  async getInstrument(idOrSymbol) {
    const params = isNaN(idOrSymbol) ? { symbol: idOrSymbol } : { id: idOrSymbol };
    const response = await this.getInstruments(params);
    return response.data?.[0];
  }

  // ========== Market Data API ==========

  /**
   * Get market quote (EBBO - Exchange Best Bid and Offer)
   * @param {Object} params
   * @param {string} params.instrument_id - Instrument ID
   * @param {string} [params.as_of] - Point-in-time query
   */
  async getMarketQuote(params) {
    if (!params.instrument_id) {
      throw new Error('instrument_id is required');
    }
    return this.client.get('/market/quote', { params });
  }

  /**
   * Get market quote by symbol
   */
  async getMarketQuoteBySymbol(symbol, asOf) {
    const instrument = await this.getInstrument(symbol);
    if (!instrument) {
      throw new Error(`Instrument not found: ${symbol}`);
    }
    return this.getMarketQuote({ 
      instrument_id: instrument.id,
      as_of: asOf
    });
  }

  // ========== Clients API ==========

  /**
   * Get client details
   * @param {Object} params
   * @param {string} [params.id] - Client ID
   */
  async getClient(params = {}) {
    return this.client.get('/client', { params });
  }

  /**
   * Update client settings
   * @param {Object} data
   * @param {string} [data.ref_client_id] - Reference client ID
   * @param {boolean} [data.cancel_on_disconnect] - Cancel orders on disconnect
   */
  async updateClient(data) {
    return this.client.patch('/client', data);
  }

  // ========== Orders API ==========

  /**
   * Get active orders
   * @param {Object} params
   * @param {string} [params.id] - Order ID
   * @param {string} [params.ref_order_id] - Reference order ID
   * @param {string} [params.ref_client_id] - Reference client ID
   * @param {string} [params.instrument_id] - Instrument ID
   */
  async getActiveOrders(params = {}) {
    return this.client.get('/order/active', { params });
  }

  /**
   * Get orders (historical)
   * @param {Object} params - Same as getActiveOrders plus date filters
   * @param {string} [params.created_at_from] - Start date
   * @param {string} [params.created_at_to] - End date
   */
  async getOrders(params = {}) {
    return this.client.get('/order', { params });
  }

  /**
   * Get order trades
   * @param {Object} params
   * @param {string} [params.order_id] - Order ID
   * @param {string} [params.ref_order_id] - Reference order ID
   */
  async getOrderTrades(params = {}) {
    return this.client.get('/order/trade', { params });
  }

  /**
   * Create new order
   * @param {Object} order
   * @param {string} order.ref_order_id - Client order ID
   * @param {string} order.order_type - 'market' or 'limit'
   * @param {string} order.order_side - 'buy' or 'sell'
   * @param {string} order.symbol - Trading symbol
   * @param {number} order.quantity - Order quantity
   * @param {number} [order.price] - Limit price (required for limit orders)
   * @param {string} [order.time_in_force] - 'IOC', 'GTC', etc.
   * @param {boolean} [order.post_only] - Post-only order
   * @param {string} [order.ref_client_id] - Reference client ID
   */
  async createOrder(order) {
    // Validate required fields
    const required = ['ref_order_id', 'order_type', 'order_side', 'symbol', 'quantity'];
    for (const field of required) {
      if (!order[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
    
    // Validate limit orders have price
    if (order.order_type === 'limit' && !order.price) {
      throw new Error('Price is required for limit orders');
    }
    
    // Get instrument ID from symbol
    const instrument = await this.getInstrument(order.symbol);
    if (!instrument) {
      throw new Error(`Instrument not found: ${order.symbol}`);
    }
    
    // Build order request
    const orderRequest = {
      ref_order_id: order.ref_order_id,
      order_type: order.order_type,
      order_side: order.order_side,
      instrument_id: instrument.id,
      quantity: order.quantity.toString(),
      time_in_force: order.time_in_force || 'GTC'
    };
    
    if (order.price) {
      orderRequest.price = order.price.toString();
    }
    
    if (order.post_only !== undefined) {
      orderRequest.post_only = order.post_only;
    }
    
    if (order.ref_client_id) {
      orderRequest.ref_client_id = order.ref_client_id;
    }
    
    return this.client.post('/order/trade', orderRequest);
  }

  /**
   * Modify existing order
   * @param {Object} modification
   * @param {string} modification.ref_order_id - Original order ID
   * @param {string} modification.ref_order_id_new - New order ID
   * @param {number} [modification.quantity] - New quantity
   * @param {number} [modification.price] - New price
   */
  async modifyOrder(modification) {
    if (!modification.ref_order_id || !modification.ref_order_id_new) {
      throw new Error('ref_order_id and ref_order_id_new are required');
    }
    
    const request = {
      ref_order_id: modification.ref_order_id,
      ref_order_id_new: modification.ref_order_id_new
    };
    
    if (modification.quantity !== undefined) {
      request.quantity = modification.quantity.toString();
    }
    
    if (modification.price !== undefined) {
      request.price = modification.price.toString();
    }
    
    return this.client.patch('/order/trade', request);
  }

  /**
   * Cancel order
   * @param {string} refOrderId - Reference order ID to cancel
   */
  async cancelOrder(refOrderId) {
    if (!refOrderId) {
      throw new Error('refOrderId is required');
    }
    
    return this.client.delete(`/order/${encodeURIComponent(refOrderId)}`);
  }

  /**
   * Cancel all orders
   * @param {string} [symbol] - Optional symbol to filter cancellations
   */
  async cancelAllOrders(symbol) {
    const params = {};
    
    if (symbol) {
      const instrument = await this.getInstrument(symbol);
      if (instrument) {
        params.instrument_id = instrument.id;
      }
    }
    
    const activeOrders = await this.getActiveOrders(params);
    const results = [];
    
    if (activeOrders.data && activeOrders.data.length > 0) {
      for (const order of activeOrders.data) {
        try {
          await this.cancelOrder(order.ref_order_id);
          results.push({ 
            ref_order_id: order.ref_order_id, 
            success: true 
          });
        } catch (error) {
          results.push({ 
            ref_order_id: order.ref_order_id, 
            success: false, 
            error: error.message 
          });
        }
      }
    }
    
    return results;
  }

  // ========== Balances API ==========

  /**
   * Get account balances
   * @param {Object} params
   * @param {string} [params.id] - Balance ID
   * @param {string} [params.asset_id] - Asset ID
   * @param {string} [params.as_of] - Point-in-time query
   */
  async getBalances(params = {}) {
    return this.client.get('/balance', { params });
  }

  /**
   * Get balance for specific asset
   */
  async getBalanceByAsset(assetName) {
    const asset = await this.getAsset(assetName);
    if (!asset) {
      throw new Error(`Asset not found: ${assetName}`);
    }
    
    const response = await this.getBalances({ asset_id: asset.id });
    return response.data?.[0];
  }

  // ========== Transfers API ==========

  /**
   * Get active transfers
   * @param {Object} params
   * @param {string} [params.id] - Transfer ID
   * @param {string} [params.ref_transfer_id] - Reference transfer ID
   */
  async getActiveTransfers(params = {}) {
    return this.client.get('/transfer/active', { params });
  }

  /**
   * Get transfers (historical)
   * @param {Object} params - Same as getActiveTransfers plus date filters
   */
  async getTransfers(params = {}) {
    return this.client.get('/transfer', { params });
  }

  /**
   * Create transfer (deposit/withdrawal)
   * @param {Object} transfer
   * @param {string} transfer.ref_transfer_id - Client transfer ID
   * @param {string} transfer.transfer_type - 'deposit' or 'withdrawal'
   * @param {string} transfer.asset_name - Asset to transfer
   * @param {number} transfer.quantity - Amount to transfer
   * @param {Object} [transfer.details] - Additional transfer details
   */
  async createTransfer(transfer) {
    // Validate required fields
    const required = ['ref_transfer_id', 'transfer_type', 'asset_name', 'quantity'];
    for (const field of required) {
      if (!transfer[field]) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
    
    // Get asset ID from name
    const asset = await this.getAsset(transfer.asset_name);
    if (!asset) {
      throw new Error(`Asset not found: ${transfer.asset_name}`);
    }
    
    // Build transfer request
    const transferRequest = {
      ref_transfer_id: transfer.ref_transfer_id,
      transfer_type: transfer.transfer_type,
      asset_id: asset.id,
      quantity: transfer.quantity.toString()
    };
    
    // Add additional details if provided
    if (transfer.details) {
      Object.assign(transferRequest, transfer.details);
    }
    
    return this.client.post('/transfer', transferRequest);
  }

  // ========== Utility Methods ==========

  /**
   * Test connectivity
   */
  async ping() {
    try {
      await this.getAssets({ page_size: 1 });
      return { success: true, timestamp: Date.now() };
    } catch (error) {
      return { success: false, error: error.message, timestamp: Date.now() };
    }
  }

  /**
   * Get server time (derived from response headers)
   */
  async getServerTime() {
    const response = await this.client.get('/asset', { 
      params: { page_size: 1 },
      transformResponse: [(data, headers) => ({ data, headers })]
    });
    
    const serverDate = response.headers?.date;
    return {
      serverTime: serverDate ? new Date(serverDate).getTime() : null,
      localTime: Date.now()
    };
  }

  /**
   * Format order for API submission
   */
  formatOrder(order) {
    return {
      ref_order_id: order.clientOrderId || `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      order_type: order.type,
      order_side: order.side,
      symbol: order.symbol,
      quantity: order.amount || order.quantity,
      price: order.price,
      time_in_force: order.timeInForce || 'GTC',
      post_only: order.postOnly || false,
      ref_client_id: order.clientId
    };
  }

  /**
   * Parse order from API response
   */
  parseOrder(apiOrder) {
    return {
      id: apiOrder.id,
      clientOrderId: apiOrder.ref_order_id,
      symbol: apiOrder.instrument?.symbol,
      side: apiOrder.order_side,
      type: apiOrder.order_type,
      price: parseFloat(apiOrder.price || 0),
      amount: parseFloat(apiOrder.quantity),
      filled: parseFloat(apiOrder.filled_quantity || 0),
      remaining: parseFloat(apiOrder.remaining_quantity || 0),
      status: this._mapOrderStatus(apiOrder.order_status),
      createdAt: new Date(apiOrder.created_at).getTime(),
      updatedAt: new Date(apiOrder.updated_at).getTime()
    };
  }

  /**
   * Map TrueX order status to internal status
   */
  _mapOrderStatus(status) {
    const statusMap = {
      'NEW': 'open',
      'PARTIALLY_FILLED': 'partially-filled',
      'FILLED': 'closed',
      'CANCELED': 'canceled',
      'REJECTED': 'rejected',
      'EXPIRED': 'expired'
    };
    
    return statusMap[status] || status.toLowerCase();
  }
}

export default TrueXRESTClient;