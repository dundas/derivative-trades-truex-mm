/**
 * Coinbase Futures REST API Client
 * 
 * This module provides a client for the Coinbase Futures REST API with focus on
 * CFM (Coinbase Financial Markets) endpoints and Advanced Trade API for futures trading.
 * 
 * API Documentation:
 * - CFM: https://docs.cloud.coinbase.com/cfm/docs
 * - Advanced Trade: https://docs.cloud.coinbase.com/advanced-trade-api/docs
 */

import fetch from 'node-fetch';
import crypto from 'crypto';
import jsonwebtoken from 'jsonwebtoken';

// Coinbase API endpoints
const COINBASE_REST_BASE = 'https://api.coinbase.com';
const COINBASE_ADVANCED_TRADE_BASE = 'https://api.coinbase.com/api/v3/brokerage';

// CFM-specific endpoints
const CFM_ENDPOINTS = {
  BALANCE_SUMMARY: '/cfm/balance_summary',
  POSITIONS: '/cfm/positions',
  SWEEPS: '/cfm/sweeps',
  SWEEP_HISTORY: '/cfm/sweep_history',
  INTRADAY_MARGIN_SETTING: '/cfm/intraday_margin_setting',
  CURRENT_MARGIN_WINDOW: '/cfm/current_margin_window',
  INTRADAY_MARGIN_REFRESH: '/cfm/intraday_margin_refresh'
};

/**
 * Coinbase Futures REST API Client
 */
export class CoinbaseFuturesRESTClient {
  /**
   * Create a new Coinbase Futures REST API Client
   * 
   * @param {Object} options - Client options
   * @param {Function} options.logger - Logger instance
   * @param {string} options.apiKey - API key ID
   * @param {string} options.apiSecret - API private key (PEM format)
   * @param {string} [options.apiPassphrase] - API passphrase (legacy, not used for JWT)
   * @param {number} [options.timeout=30000] - Request timeout in milliseconds
   * @param {number} [options.rateLimitDelay=100] - Delay between requests in ms
   */
  constructor(options = {}) {
    this.options = options;
    this.logger = options.logger || console;
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
    this.timeout = options.timeout || 30000;
    this.rateLimitDelay = options.rateLimitDelay || 100;
    
    // Rate limiting
    this.lastRequestTime = 0;
    
    // Validate API credentials
    if (this.apiKey && this.apiSecret) {
      this._validateCredentials();
    }
    
    // Bind methods
    this.log = this.log.bind(this);
    this._request = this._request.bind(this);
    this._signRequest = this._signRequest.bind(this);
    this._generateJWT = this._generateJWT.bind(this);
  }
  
  /**
   * Validate API credentials format
   * @private
   */
  _validateCredentials() {
    if (!this.apiKey || typeof this.apiKey !== 'string') {
      throw new Error('Invalid API key format');
    }
    
    if (!this.apiSecret || !this.apiSecret.includes('-----BEGIN EC PRIVATE KEY-----')) {
      throw new Error('Invalid API secret format. Expected PEM format EC private key');
    }
  }
  
  /**
   * Log a message
   * 
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} data - Additional data
   */
  log(level, message, data = {}) {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [CoinbaseFuturesREST] ${message}`;
    
    if (typeof this.logger[level] === 'function') {
      this.logger[level](formattedMessage, data);
    } else {
      console[level](formattedMessage, data);
    }
  }
  
  /**
   * Generate JWT token for authentication
   * @private
   */
  _generateJWT(method, path) {
    const keyName = this.apiKey;
    const privateKey = this.apiSecret;
    const host = 'api.coinbase.com';
    
    // IMPORTANT: uri field is required for Coinbase API
    const uri = `${method} ${host}${path}`;
    
    const payload = {
      iss: 'coinbase-cloud',
      nbf: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
      sub: keyName,
      uri: uri
    };
    
    const header = {
      kid: keyName,
      nonce: crypto.randomBytes(16).toString('hex')
    };
    
    // Use jsonwebtoken library for proper JWT generation
    return jsonwebtoken.sign(payload, privateKey, {
      algorithm: 'ES256',
      header: header
    });
  }
  
  /**
   * Sign a request with JWT
   * @private
   */
  _signRequest(method, path, body = '') {
    const jwt = this._generateJWT(method, path);
    
    return {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json'
    };
  }
  
  /**
   * Make a request with rate limiting
   * 
   * @private
   */
  async _request(url, options = {}) {
    // Implement basic rate limiting
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.rateLimitDelay) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitDelay - timeSinceLastRequest));
    }
    
    this.lastRequestTime = Date.now();
    
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeout);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.message || errorJson.error || errorText;
        } catch {
          errorMessage = errorText;
        }
        throw new Error(`HTTP ${response.status}: ${errorMessage}`);
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    }
  }
  
  // ============================================
  // CFM (Coinbase Financial Markets) Endpoints
  // ============================================
  
  /**
   * Get CFM balance summary
   * 
   * @returns {Promise<Object>} Balance summary data
   */
  async getCFMBalanceSummary() {
    try {
      this.log('info', 'Fetching CFM balance summary');
      
      const path = CFM_ENDPOINTS.BALANCE_SUMMARY;
      const url = `${COINBASE_REST_BASE}${path}`;
      const headers = this._signRequest('GET', path);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatCFMBalanceSummary(response);
    } catch (error) {
      this.log('error', `Failed to fetch CFM balance summary: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Format CFM balance summary response
   * 
   * @private
   */
  _formatCFMBalanceSummary(data) {
    return {
      balances: data.balances || [],
      portfolioValue: parseFloat(data.portfolio_value || 0),
      buyingPower: parseFloat(data.buying_power || 0),
      totalUsdBalance: parseFloat(data.total_usd_balance || 0),
      cfmUsdAvailableForWithdrawal: parseFloat(data.cfm_usd_available_for_withdrawal || 0),
      timestamp: Date.now()
    };
  }
  
  /**
   * Get CFM positions
   * 
   * @param {Object} [params] - Query parameters
   * @param {string} [params.product_id] - Filter by product ID
   * @returns {Promise<Object>} Positions data
   */
  async getCFMPositions(params = {}) {
    try {
      this.log('info', 'Fetching CFM positions', params);
      
      const path = CFM_ENDPOINTS.POSITIONS;
      const queryString = new URLSearchParams(params).toString();
      const fullPath = queryString ? `${path}?${queryString}` : path;
      const url = `${COINBASE_REST_BASE}${fullPath}`;
      const headers = this._signRequest('GET', fullPath);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatCFMPositions(response);
    } catch (error) {
      this.log('error', `Failed to fetch CFM positions: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Format CFM positions response
   * 
   * @private
   */
  _formatCFMPositions(data) {
    const positions = (data.positions || []).map(pos => ({
      productId: pos.product_id,
      productType: pos.product_type,
      symbol: pos.symbol,
      vwap: {
        buyVwap: parseFloat(pos.vwap?.buy_vwap || 0),
        sellVwap: parseFloat(pos.vwap?.sell_vwap || 0)
      },
      positionSide: pos.position_side,
      netSize: parseFloat(pos.net_size || 0),
      buyOrderSize: parseFloat(pos.buy_order_size || 0),
      sellOrderSize: parseFloat(pos.sell_order_size || 0),
      imContribution: parseFloat(pos.im_contribution || 0),
      unrealizedPnl: parseFloat(pos.unrealized_pnl || 0),
      markPrice: parseFloat(pos.mark_price || 0),
      liquidationPrice: parseFloat(pos.liquidation_price || 0),
      leverage: parseFloat(pos.leverage || 0),
      imNotional: parseFloat(pos.im_notional || 0),
      mmNotional: parseFloat(pos.mm_notional || 0),
      positionNotional: parseFloat(pos.position_notional || 0)
    }));
    
    return {
      positions,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get CFM sweeps
   * 
   * @returns {Promise<Object>} Sweeps data
   */
  async getCFMSweeps() {
    try {
      this.log('info', 'Fetching CFM sweeps');
      
      const path = CFM_ENDPOINTS.SWEEPS;
      const url = `${COINBASE_REST_BASE}${path}`;
      const headers = this._signRequest('GET', path);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatCFMSweeps(response);
    } catch (error) {
      this.log('error', `Failed to fetch CFM sweeps: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Format CFM sweeps response
   * 
   * @private
   */
  _formatCFMSweeps(data) {
    const sweeps = (data.sweeps || []).map(sweep => ({
      id: sweep.id,
      requestedAmount: {
        value: parseFloat(sweep.requested_amount?.value || 0),
        currency: sweep.requested_amount?.currency
      },
      shouldSweepAll: sweep.should_sweep_all,
      status: sweep.status,
      scheduledTime: sweep.scheduled_time
    }));
    
    return {
      sweeps,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get CFM sweep history
   * 
   * @param {Object} [params] - Query parameters
   * @param {string} [params.start_time] - Start time (ISO 8601)
   * @param {string} [params.end_time] - End time (ISO 8601)
   * @returns {Promise<Object>} Sweep history data
   */
  async getCFMSweepHistory(params = {}) {
    try {
      this.log('info', 'Fetching CFM sweep history', params);
      
      const path = CFM_ENDPOINTS.SWEEP_HISTORY;
      const queryString = new URLSearchParams(params).toString();
      const fullPath = queryString ? `${path}?${queryString}` : path;
      const url = `${COINBASE_REST_BASE}${fullPath}`;
      const headers = this._signRequest('GET', fullPath);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatCFMSweepHistory(response);
    } catch (error) {
      this.log('error', `Failed to fetch CFM sweep history: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Format CFM sweep history response
   * 
   * @private
   */
  _formatCFMSweepHistory(data) {
    const sweeps = (data.sweeps || []).map(sweep => ({
      id: sweep.id,
      requestedAmount: {
        value: parseFloat(sweep.requested_amount?.value || 0),
        currency: sweep.requested_amount?.currency
      },
      status: sweep.status,
      createdAt: sweep.created_at,
      updatedAt: sweep.updated_at
    }));
    
    return {
      sweeps,
      hasNext: data.has_next || false,
      cursor: data.cursor,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get CFM intraday margin setting
   * 
   * @returns {Promise<Object>} Intraday margin setting
   */
  async getCFMIntradayMarginSetting() {
    try {
      this.log('info', 'Fetching CFM intraday margin setting');
      
      const path = CFM_ENDPOINTS.INTRADAY_MARGIN_SETTING;
      const url = `${COINBASE_REST_BASE}${path}`;
      const headers = this._signRequest('GET', path);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return {
        intradayMarginSetting: response.intraday_margin_setting,
        timestamp: Date.now()
      };
    } catch (error) {
      this.log('error', `Failed to fetch CFM intraday margin setting: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Update CFM intraday margin setting
   * 
   * @param {string} setting - New setting value
   * @returns {Promise<Object>} Updated setting
   */
  async updateCFMIntradayMarginSetting(setting) {
    try {
      this.log('info', 'Updating CFM intraday margin setting', { setting });
      
      const path = CFM_ENDPOINTS.INTRADAY_MARGIN_SETTING;
      const url = `${COINBASE_REST_BASE}${path}`;
      const body = JSON.stringify({ intraday_margin_setting: setting });
      const headers = this._signRequest('POST', path, body);
      
      const response = await this._request(url, {
        method: 'POST',
        headers,
        body
      });
      
      return {
        intradayMarginSetting: response.intraday_margin_setting,
        timestamp: Date.now()
      };
    } catch (error) {
      this.log('error', `Failed to update CFM intraday margin setting: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get CFM current margin window
   * 
   * @returns {Promise<Object>} Current margin window
   */
  async getCFMCurrentMarginWindow() {
    try {
      this.log('info', 'Fetching CFM current margin window');
      
      const path = CFM_ENDPOINTS.CURRENT_MARGIN_WINDOW;
      const url = `${COINBASE_REST_BASE}${path}`;
      const headers = this._signRequest('GET', path);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return {
        marginWindow: response.margin_window,
        isIntradayMarginKillswitchEnabled: response.is_intraday_margin_killswitch_enabled,
        isIntradayMarginEnrollmentKillswitchEnabled: response.is_intraday_margin_enrollment_killswitch_enabled,
        timestamp: Date.now()
      };
    } catch (error) {
      this.log('error', `Failed to fetch CFM current margin window: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Refresh CFM intraday margin
   * 
   * @returns {Promise<Object>} Refresh result
   */
  async refreshCFMIntradayMargin() {
    try {
      this.log('info', 'Refreshing CFM intraday margin');
      
      const path = CFM_ENDPOINTS.INTRADAY_MARGIN_REFRESH;
      const url = `${COINBASE_REST_BASE}${path}`;
      const headers = this._signRequest('POST', path);
      
      const response = await this._request(url, {
        method: 'POST',
        headers,
        body: '{}'
      });
      
      return {
        portfolioBalances: response.portfolio_balances,
        timestamp: Date.now()
      };
    } catch (error) {
      this.log('error', `Failed to refresh CFM intraday margin: ${error.message}`);
      throw error;
    }
  }
  
  // ============================================
  // Advanced Trade API - Futures Orders
  // ============================================
  
  /**
   * Create a futures order
   * 
   * @param {Object} orderParams - Order parameters
   * @param {string} orderParams.client_order_id - Client order ID
   * @param {string} orderParams.product_id - Futures product ID (e.g., 'BTC-PERP-INTX')
   * @param {string} orderParams.side - Order side ('BUY' or 'SELL')
   * @param {Object} orderParams.order_configuration - Order configuration
   * @returns {Promise<Object>} Order creation result
   */
  async createFuturesOrder(orderParams) {
    try {
      this.log('info', 'Creating futures order', orderParams);
      
      const path = '/api/v3/brokerage/orders';
      const url = `${COINBASE_REST_BASE}${path}`;
      const body = JSON.stringify(orderParams);
      const headers = this._signRequest('POST', path, body);
      
      const response = await this._request(url, {
        method: 'POST',
        headers,
        body
      });
      
      return this._formatOrder(response);
    } catch (error) {
      this.log('error', `Failed to create futures order: ${error.message}`, orderParams);
      throw error;
    }
  }
  
  /**
   * Cancel a futures order
   * 
   * @param {Array<string>} orderIds - Order IDs to cancel
   * @returns {Promise<Object>} Cancellation results
   */
  async cancelFuturesOrders(orderIds) {
    try {
      this.log('info', 'Cancelling futures orders', { orderIds });
      
      const path = '/api/v3/brokerage/orders/batch_cancel';
      const url = `${COINBASE_REST_BASE}${path}`;
      const body = JSON.stringify({ order_ids: orderIds });
      const headers = this._signRequest('POST', path, body);
      
      const response = await this._request(url, {
        method: 'POST',
        headers,
        body
      });
      
      return {
        results: response.results || [],
        timestamp: Date.now()
      };
    } catch (error) {
      this.log('error', `Failed to cancel futures orders: ${error.message}`, { orderIds });
      throw error;
    }
  }
  
  /**
   * Get futures orders
   * 
   * @param {Object} [params] - Query parameters
   * @param {string} [params.product_id] - Filter by product ID
   * @param {string} [params.order_status] - Filter by status
   * @param {number} [params.limit] - Limit number of results
   * @param {string} [params.start_date] - Start date (ISO 8601)
   * @param {string} [params.end_date] - End date (ISO 8601)
   * @returns {Promise<Object>} Orders data
   */
  async getFuturesOrders(params = {}) {
    try {
      this.log('info', 'Fetching futures orders', params);
      
      const path = '/api/v3/brokerage/orders/historical/batch';
      const queryString = new URLSearchParams(params).toString();
      const fullPath = queryString ? `${path}?${queryString}` : path;
      const url = `${COINBASE_REST_BASE}${fullPath}`;
      const headers = this._signRequest('GET', fullPath);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatOrders(response);
    } catch (error) {
      this.log('error', `Failed to fetch futures orders: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get a specific futures order
   * 
   * @param {string} orderId - Order ID
   * @returns {Promise<Object>} Order data
   */
  async getFuturesOrder(orderId) {
    try {
      this.log('info', 'Fetching futures order', { orderId });
      
      const path = `/api/v3/brokerage/orders/historical/${orderId}`;
      const url = `${COINBASE_REST_BASE}${path}`;
      const headers = this._signRequest('GET', path);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatOrder(response.order);
    } catch (error) {
      this.log('error', `Failed to fetch futures order: ${error.message}`, { orderId });
      throw error;
    }
  }
  
  /**
   * Format order response
   * 
   * @private
   */
  _formatOrder(order) {
    return {
      orderId: order.order_id,
      clientOrderId: order.client_order_id,
      productId: order.product_id,
      userId: order.user_id,
      side: order.side,
      status: order.status,
      timeInForce: order.time_in_force,
      createdTime: order.created_time,
      completionPercentage: parseFloat(order.completion_percentage || 0),
      filledSize: parseFloat(order.filled_size || 0),
      averageFilledPrice: parseFloat(order.average_filled_price || 0),
      fee: parseFloat(order.fee || 0),
      numberOfFills: parseInt(order.number_of_fills || 0),
      filledValue: parseFloat(order.filled_value || 0),
      pendingCancel: order.pending_cancel,
      sizeInQuote: order.size_in_quote,
      totalFees: parseFloat(order.total_fees || 0),
      sizeInclusiveOfFees: order.size_inclusive_of_fees,
      totalValueAfterFees: parseFloat(order.total_value_after_fees || 0),
      triggerStatus: order.trigger_status,
      orderType: order.order_type,
      rejectReason: order.reject_reason,
      settled: order.settled,
      productType: order.product_type,
      rejectMessage: order.reject_message,
      cancelMessage: order.cancel_message,
      orderConfiguration: order.order_configuration
    };
  }
  
  /**
   * Format orders response
   * 
   * @private
   */
  _formatOrders(data) {
    return {
      orders: (data.orders || []).map(order => this._formatOrder(order)),
      hasNext: data.has_next || false,
      cursor: data.cursor,
      timestamp: Date.now()
    };
  }
  
  // ============================================
  // Market Data Endpoints
  // ============================================
  
  /**
   * Get futures product details
   * 
   * @param {string} productId - Product ID (e.g., 'BTC-PERP-INTX')
   * @returns {Promise<Object>} Product details
   */
  async getFuturesProduct(productId) {
    try {
      this.log('info', 'Fetching futures product', { productId });
      
      const path = `/api/v3/brokerage/products/${productId}`;
      const url = `${COINBASE_REST_BASE}${path}`;
      const headers = this._signRequest('GET', path);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatProduct(response);
    } catch (error) {
      this.log('error', `Failed to fetch futures product: ${error.message}`, { productId });
      throw error;
    }
  }
  
  /**
   * Get all futures products
   * 
   * @param {Object} [params] - Query parameters
   * @param {string} [params.product_type] - Filter by type ('FUTURE')
   * @returns {Promise<Object>} Products data
   */
  async getFuturesProducts(params = {}) {
    try {
      this.log('info', 'Fetching futures products', params);
      
      const path = '/api/v3/brokerage/products';
      const url = `${COINBASE_REST_BASE}${path}`;
      const headers = this._signRequest('GET', path);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      // Filter futures products after fetching
      if (params.product_type === 'FUTURE' || !params.product_type) {
        const allProducts = this._formatProducts(response);
        const futuresProducts = allProducts.products.filter(p => 
          p.productType === 'FUTURE' || 
          p.productId?.includes('PERP') ||
          p.productId?.includes('BIT') ||
          p.productId?.includes('-CDE')
        );
        return {
          ...allProducts,
          products: futuresProducts
        };
      }
      
      return this._formatProducts(response);
    } catch (error) {
      this.log('error', `Failed to fetch futures products: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Format product response
   * 
   * @private
   */
  _formatProduct(product) {
    return {
      productId: product.product_id,
      price: parseFloat(product.price || 0),
      pricePercentageChange24h: parseFloat(product.price_percentage_change_24h || 0),
      volume24h: parseFloat(product.volume_24h || 0),
      volumePercentageChange24h: parseFloat(product.volume_percentage_change_24h || 0),
      baseIncrement: parseFloat(product.base_increment || 0),
      quoteIncrement: parseFloat(product.quote_increment || 0),
      quoteMinSize: parseFloat(product.quote_min_size || 0),
      quoteMaxSize: parseFloat(product.quote_max_size || 0),
      baseMinSize: parseFloat(product.base_min_size || 0),
      baseMaxSize: parseFloat(product.base_max_size || 0),
      baseName: product.base_name,
      quoteName: product.quote_name,
      watched: product.watched,
      isDisabled: product.is_disabled,
      new: product.new,
      status: product.status,
      cancelOnly: product.cancel_only,
      limitOnly: product.limit_only,
      postOnly: product.post_only,
      tradingDisabled: product.trading_disabled,
      auctionMode: product.auction_mode,
      productType: product.product_type,
      quoteCurrencyId: product.quote_currency_id,
      baseCurrencyId: product.base_currency_id,
      midMarketPrice: parseFloat(product.mid_market_price || 0),
      alias: product.alias,
      aliasTo: product.alias_to,
      baseDisplaySymbol: product.base_display_symbol,
      quoteDisplaySymbol: product.quote_display_symbol,
      viewOnly: product.view_only,
      priceIncrement: parseFloat(product.price_increment || 0),
      futureProductDetails: product.future_product_details
    };
  }
  
  /**
   * Format products response
   * 
   * @private
   */
  _formatProducts(data) {
    return {
      products: (data.products || []).map(product => this._formatProduct(product)),
      numProducts: data.num_products || 0,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get futures ticker
   * 
   * @param {string} productId - Product ID (e.g., 'BTC-PERP-INTX')
   * @returns {Promise<Object>} Ticker data
   */
  async getFuturesTicker(productId) {
    try {
      this.log('info', 'Fetching futures ticker', { productId });
      
      const path = `/api/v3/brokerage/products/${productId}/ticker`;
      const url = `${COINBASE_REST_BASE}${path}`;
      const headers = this._signRequest('GET', path);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatTicker(response);
    } catch (error) {
      this.log('error', `Failed to fetch futures ticker: ${error.message}`, { productId });
      throw error;
    }
  }
  
  /**
   * Format ticker response
   * 
   * @private
   */
  _formatTicker(data) {
    const trades = data.trades || [];
    const bestBid = data.best_bid || '0';
    const bestAsk = data.best_ask || '0';
    
    return {
      trades: trades.map(trade => ({
        tradeId: trade.trade_id,
        productId: trade.product_id,
        price: parseFloat(trade.price || 0),
        size: parseFloat(trade.size || 0),
        time: trade.time,
        side: trade.side,
        bid: parseFloat(trade.bid || 0),
        ask: parseFloat(trade.ask || 0)
      })),
      bestBid: parseFloat(bestBid),
      bestAsk: parseFloat(bestAsk),
      timestamp: Date.now()
    };
  }
  
  /**
   * Get futures order book
   * 
   * @param {string} productId - Product ID (e.g., 'BTC-PERP-INTX')
   * @param {number} [level=2] - Order book level (1 or 2)
   * @returns {Promise<Object>} Order book data
   */
  async getFuturesOrderBook(productId, level = 2) {
    try {
      this.log('info', 'Fetching futures order book', { productId, level });
      
      const path = `/api/v3/brokerage/products/${productId}/book`;
      const queryString = new URLSearchParams({ level: level.toString() }).toString();
      const fullPath = `${path}?${queryString}`;
      const url = `${COINBASE_REST_BASE}${fullPath}`;
      const headers = this._signRequest('GET', fullPath);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatOrderBook(response, productId);
    } catch (error) {
      this.log('error', `Failed to fetch futures order book: ${error.message}`, { productId });
      throw error;
    }
  }
  
  /**
   * Format order book response
   * 
   * @private
   */
  _formatOrderBook(data, productId) {
    const formatSide = (side = []) => side.map(([price, size]) => ({
      price: parseFloat(price),
      size: parseFloat(size)
    }));
    
    const bids = formatSide(data.bids);
    const asks = formatSide(data.asks);
    
    const midPrice = bids.length > 0 && asks.length > 0
      ? (bids[0].price + asks[0].price) / 2
      : 0;
    
    return {
      productId,
      bids,
      asks,
      midPrice,
      time: data.time,
      timestamp: Date.now()
    };
  }
  
  // ============================================
  // Account Endpoints
  // ============================================
  
  /**
   * Get all accounts
   * 
   * @param {Object} [params] - Query parameters
   * @param {number} [params.limit] - Limit number of results
   * @param {string} [params.cursor] - Pagination cursor
   * @returns {Promise<Object>} Accounts data
   */
  async getAccounts(params = {}) {
    try {
      this.log('info', 'Fetching accounts', params);
      
      const path = '/api/v3/brokerage/accounts';
      const queryString = new URLSearchParams(params).toString();
      const fullPath = queryString ? `${path}?${queryString}` : path;
      const url = `${COINBASE_REST_BASE}${fullPath}`;
      const headers = this._signRequest('GET', fullPath);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatAccounts(response);
    } catch (error) {
      this.log('error', `Failed to fetch accounts: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get a specific account
   * 
   * @param {string} accountId - Account UUID
   * @returns {Promise<Object>} Account data
   */
  async getAccount(accountId) {
    try {
      this.log('info', 'Fetching account', { accountId });
      
      const path = `/api/v3/brokerage/accounts/${accountId}`;
      const url = `${COINBASE_REST_BASE}${path}`;
      const headers = this._signRequest('GET', path);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatAccount(response.account);
    } catch (error) {
      this.log('error', `Failed to fetch account: ${error.message}`, { accountId });
      throw error;
    }
  }
  
  /**
   * Format account response
   * 
   * @private
   */
  _formatAccount(account) {
    return {
      uuid: account.uuid,
      name: account.name,
      currency: account.currency,
      availableBalance: {
        value: parseFloat(account.available_balance?.value || 0),
        currency: account.available_balance?.currency
      },
      default: account.default,
      active: account.active,
      createdAt: account.created_at,
      updatedAt: account.updated_at,
      deletedAt: account.deleted_at,
      type: account.type,
      ready: account.ready,
      hold: {
        value: parseFloat(account.hold?.value || 0),
        currency: account.hold?.currency
      }
    };
  }
  
  /**
   * Format accounts response
   * 
   * @private
   */
  _formatAccounts(data) {
    return {
      accounts: (data.accounts || []).map(account => this._formatAccount(account)),
      hasNext: data.has_next || false,
      cursor: data.cursor,
      size: data.size || 0,
      timestamp: Date.now()
    };
  }
  
  // ============================================
  // Fills Endpoints
  // ============================================
  
  /**
   * Get futures fills
   * 
   * @param {Object} [params] - Query parameters
   * @param {string} [params.order_id] - Filter by order ID
   * @param {string} [params.product_id] - Filter by product ID
   * @param {string} [params.start_sequence_timestamp] - Start timestamp
   * @param {string} [params.end_sequence_timestamp] - End timestamp
   * @param {number} [params.limit] - Limit number of results
   * @param {string} [params.cursor] - Pagination cursor
   * @returns {Promise<Object>} Fills data
   */
  async getFuturesFills(params = {}) {
    try {
      this.log('info', 'Fetching futures fills', params);
      
      const path = '/api/v3/brokerage/orders/historical/fills';
      const queryString = new URLSearchParams(params).toString();
      const fullPath = queryString ? `${path}?${queryString}` : path;
      const url = `${COINBASE_REST_BASE}${fullPath}`;
      const headers = this._signRequest('GET', fullPath);
      
      const response = await this._request(url, {
        method: 'GET',
        headers
      });
      
      return this._formatFills(response);
    } catch (error) {
      this.log('error', `Failed to fetch futures fills: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Format fills response
   * 
   * @private
   */
  _formatFills(data) {
    const fills = (data.fills || []).map(fill => ({
      entryId: fill.entry_id,
      tradeId: fill.trade_id,
      orderId: fill.order_id,
      tradeTime: fill.trade_time,
      tradeType: fill.trade_type,
      price: parseFloat(fill.price || 0),
      size: parseFloat(fill.size || 0),
      commission: parseFloat(fill.commission || 0),
      productId: fill.product_id,
      sequenceTimestamp: fill.sequence_timestamp,
      liquidityIndicator: fill.liquidity_indicator,
      sizeInQuote: fill.size_in_quote,
      userId: fill.user_id,
      side: fill.side
    }));
    
    return {
      fills,
      cursor: data.cursor,
      timestamp: Date.now()
    };
  }
}