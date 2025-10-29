/**
 * Kraken Futures REST API Client
 * 
 * This module provides a client for the Kraken Futures REST API with focus on
 * market data retrieval, especially OHLC data for technical analysis.
 * 
 * API Documentation: https://docs.futures.kraken.com/#rest-api
 */

import fetch from 'node-fetch';
import crypto from 'crypto';

// Kraken Futures REST API endpoints
const KRAKEN_FUTURES_REST_PUBLIC = 'https://futures.kraken.com/derivatives/api/v3';
const KRAKEN_FUTURES_REST_PRIVATE = 'https://futures.kraken.com/derivatives/api/v3';

// Note: Symbol conversion is not handled automatically
// Users must provide symbols in Kraken Futures format (e.g., PI_XBTUSD, PF_XRPUSD)

// Timeframe mapping
const TIMEFRAME_MAP = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '12h': '12h',
  '1d': '1d',
  '1w': '1w'
};

/**
 * Kraken Futures REST API Client
 */
export class KrakenFuturesRESTClient {
  /**
   * Create a new Kraken Futures REST API Client
   * 
   * @param {Object} options - Client options
   * @param {Function} options.logger - Logger instance
   * @param {string} [options.apiKey] - API key for authenticated endpoints
   * @param {string} [options.apiSecret] - API secret for authenticated endpoints
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
    
    // Bind methods
    this.log = this.log.bind(this);
    this._request = this._request.bind(this);
    this._publicRequest = this._publicRequest.bind(this);
    this._privateRequest = this._privateRequest.bind(this);
    this._signRequest = this._signRequest.bind(this);
    this.getOHLC = this.getOHLC.bind(this);
    this.getTicker = this.getTicker.bind(this);
    this.getOrderBook = this.getOrderBook.bind(this);
    this.getTrades = this.getTrades.bind(this);
    this.getInstruments = this.getInstruments.bind(this);
    this.getFundingRates = this.getFundingRates.bind(this);
    this.getMarkPrice = this.getMarkPrice.bind(this);
    this.getOpenInterest = this.getOpenInterest.bind(this);
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
    const formattedMessage = `[${timestamp}] [KrakenFuturesREST] ${message}`;
    
    if (typeof this.logger[level] === 'function') {
      this.logger[level](formattedMessage, data);
    } else {
      console[level](formattedMessage, data);
    }
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
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }
      
      const data = await response.json();
      
      // Check for API errors
      if (data.result === 'error') {
        throw new Error(`API Error: ${data.error}`);
      }
      
      return data;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    }
  }
  
  /**
   * Make a public API request
   * 
   * @private
   */
  async _publicRequest(endpoint, params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const url = `${KRAKEN_FUTURES_REST_PUBLIC}${endpoint}${queryString ? '?' + queryString : ''}`;
    
    this.log('debug', `Public request to ${endpoint}`, { params });
    
    return this._request(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'KrakenFuturesRESTClient/1.0'
      }
    });
  }
  
  /**
   * Make a private API request
   * 
   * @private
   */
  async _privateRequest(endpoint, params = {}, method = 'GET') {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('API credentials required for private endpoints');
    }
    
    const nonce = Date.now().toString();
    const body = method === 'POST' ? JSON.stringify(params) : '';
    
    // Create signature
    const signature = this._signRequest(endpoint, nonce, body);
    
    const url = method === 'GET' && Object.keys(params).length > 0
      ? `${KRAKEN_FUTURES_REST_PRIVATE}${endpoint}?${new URLSearchParams(params).toString()}`
      : `${KRAKEN_FUTURES_REST_PRIVATE}${endpoint}`;
    
    this.log('debug', `Private request to ${endpoint}`, { method });
    
    return this._request(url, {
      method,
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'KrakenFuturesRESTClient/1.0',
        'APIKey': this.apiKey,
        'Nonce': nonce,
        'Authent': signature
      },
      body: method === 'POST' ? body : undefined
    });
  }
  
  /**
   * Sign a request for authentication
   * 
   * @private
   */
  _signRequest(endpoint, nonce, postData = '') {
    // Concatenate postData + nonce + endpointPath
    const message = postData + nonce + endpoint;
    
    // Hash with SHA-256
    const hash = crypto.createHash('sha256').update(message).digest();
    
    // Base64-decode the api_secret
    const decodedSecret = Buffer.from(this.apiSecret, 'base64');
    
    // Hash with HMAC-SHA-512 using decoded secret
    const hmac = crypto.createHmac('sha512', decodedSecret);
    hmac.update(hash);
    
    // Base64-encode the final result
    return hmac.digest('base64');
  }
  
  /**
   * Get OHLC (candlestick) data
   * 
   * NOTE: Kraken Futures v3 API does not provide a traditional OHLC endpoint.
   * Consider using the WebSocket API for real-time candle data or constructing
   * candles from trade history data.
   * 
   * @param {string} symbol - Symbol in Kraken Futures format (e.g., 'PI_XBTUSD')
   * @param {string} timeframe - Timeframe ('1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d', '1w')
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} OHLC data
   */
  async getOHLC(symbol, timeframe, options = {}) {
    // For now, return empty candles array
    // In production, you would either:
    // 1. Use WebSocket candle feeds
    // 2. Aggregate trade data into candles
    // 3. Use a different data provider
    
    this.log('warn', `OHLC endpoint not available in Kraken Futures v3 API. Returning empty data.`);
    
    return {
      symbol,
      timeframe,
      candles: [],
      timestamp: Date.now(),
      message: 'OHLC data not available via REST API. Use WebSocket candle feeds instead.'
    };
  }
  
  /**
   * Format OHLC response
   * 
   * @private
   */
  _formatOHLCResponse(data, symbol, timeframe) {
    if (!data || !data.candles) {
      return {
        symbol,
        timeframe,
        candles: [],
        timestamp: Date.now()
      };
    }
    
    const candles = data.candles.map(candle => ({
      timestamp: candle.time * 1000, // Convert to milliseconds
      open: parseFloat(candle.open),
      high: parseFloat(candle.high),
      low: parseFloat(candle.low),
      close: parseFloat(candle.close),
      volume: parseFloat(candle.volume || 0)
    }));
    
    return {
      symbol,
      timeframe,
      candles,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get ticker information
   * 
   * @param {string} symbol - Symbol in Kraken Futures format
   * @returns {Promise<Object>} Ticker data
   */
  async getTicker(symbol) {
    try {
      this.log('info', `Fetching ticker for ${symbol}`);
      
      const response = await this._publicRequest('/tickers');
      
      // Find the ticker for our symbol
      const ticker = response.tickers?.find(t => t.symbol === symbol);
      
      if (!ticker) {
        throw new Error(`Ticker not found for ${symbol}`);
      }
      
      return this._formatTicker(ticker, symbol);
    } catch (error) {
      this.log('error', `Failed to fetch ticker: ${error.message}`, { symbol });
      throw error;
    }
  }
  
  /**
   * Format ticker data
   * 
   * @private
   */
  _formatTicker(ticker, symbol) {
    return {
      symbol,
      bid: parseFloat(ticker.bid || 0),
      ask: parseFloat(ticker.ask || 0),
      last: parseFloat(ticker.last || 0),
      markPrice: parseFloat(ticker.markPrice || 0),
      indexPrice: parseFloat(ticker.indexPrice || 0),
      volume24h: parseFloat(ticker.volume24h || 0),
      openInterest: parseFloat(ticker.openInterest || 0),
      fundingRate: parseFloat(ticker.fundingRate || 0),
      fundingRatePrediction: parseFloat(ticker.fundingRatePrediction || 0),
      timestamp: Date.now()
    };
  }
  
  /**
   * Get order book
   * 
   * @param {string} symbol - Symbol in Kraken Futures format
   * @param {number} [depth=25] - Order book depth
   * @returns {Promise<Object>} Order book data
   */
  async getOrderBook(symbol, depth = 25) {
    try {
      this.log('info', `Fetching order book for ${symbol}`);
      
      const response = await this._publicRequest('/orderbook', {
        symbol: symbol
      });
      
      return this._formatOrderBook(response, symbol, depth);
    } catch (error) {
      this.log('error', `Failed to fetch order book: ${error.message}`, { symbol });
      throw error;
    }
  }
  
  /**
   * Format order book data
   * 
   * @private
   */
  _formatOrderBook(data, symbol, maxDepth) {
    const orderBook = data.orderBook || {};
    
    const formatSide = (side = []) => side
      .slice(0, maxDepth)
      .map(([price, size]) => ({
        price: parseFloat(price),
        size: parseFloat(size)
      }));
    
    const bids = formatSide(orderBook.bids);
    const asks = formatSide(orderBook.asks);
    
    const midPrice = bids.length > 0 && asks.length > 0
      ? (bids[0].price + asks[0].price) / 2
      : 0;
    
    return {
      symbol,
      bids,
      asks,
      midPrice,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get recent trades
   * 
   * @param {string} symbol - Symbol in Kraken Futures format
   * @param {number} [limit=100] - Number of trades to return
   * @returns {Promise<Object>} Trade data
   */
  async getTrades(symbol, limit = 100) {
    try {
      this.log('info', `Fetching trades for ${symbol}`);
      
      const response = await this._publicRequest('/history', {
        symbol: symbol,
        limit
      });
      
      return this._formatTrades(response, symbol);
    } catch (error) {
      this.log('error', `Failed to fetch trades: ${error.message}`, { symbol });
      throw error;
    }
  }
  
  /**
   * Format trade data
   * 
   * @private
   */
  _formatTrades(data, symbol) {
    const trades = (data.history || []).map(trade => ({
      symbol,
      price: parseFloat(trade.price),
      size: parseFloat(trade.size),
      side: trade.side,
      timestamp: new Date(trade.time).getTime(),
      tradeId: trade.uid
    }));
    
    return {
      symbol,
      trades,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get available instruments
   * 
   * @returns {Promise<Object>} Instruments data
   */
  async getInstruments() {
    try {
      this.log('info', 'Fetching available instruments');
      
      const response = await this._publicRequest('/instruments');
      
      return this._formatInstruments(response);
    } catch (error) {
      this.log('error', `Failed to fetch instruments: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Format instruments data
   * 
   * @private
   */
  _formatInstruments(data) {
    const instruments = (data.instruments || []).map(inst => ({
      symbol: inst.symbol,
      type: inst.type,
      underlying: inst.underlying,
      tickSize: parseFloat(inst.tickSize || 0),
      contractSize: parseFloat(inst.contractValueTradePrecision || 1),
      marginCurrency: inst.marginCurrency,
      fundingPremiumIndex: inst.fundingPremiumIndex,
      fundingRateCoefficient: parseFloat(inst.fundingRateCoefficient || 0),
      maxPositionSize: parseFloat(inst.maxPositionSize || 0),
      tradeable: inst.tradeable
    }));
    
    return {
      instruments,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get funding rates history
   * 
   * @param {string} symbol - Symbol in Kraken Futures format
   * @param {Object} options - Options
   * @param {number} [options.limit=100] - Number of records
   * @returns {Promise<Object>} Funding rates data
   */
  async getFundingRates(symbol, options = {}) {
    try {
      this.log('info', `Fetching funding rates for ${symbol}`);
      
      const params = {
        symbol: symbol
      };
      
      const response = await this._publicRequest('/historical-funding-rates', params);
      
      return this._formatFundingRates(response, symbol);
    } catch (error) {
      this.log('error', `Failed to fetch funding rates: ${error.message}`, { symbol });
      throw error;
    }
  }
  
  /**
   * Format funding rates data
   * 
   * @private
   */
  _formatFundingRates(data, symbol) {
    const rates = (data.rates || []).map(rate => ({
      symbol,
      rate: parseFloat(rate.fundingRate),
      relativeFundingRate: parseFloat(rate.relativeFundingRate),
      timestamp: new Date(rate.timestamp).getTime()
    }));
    
    return {
      symbol,
      rates,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get mark price history
   * 
   * @param {string} symbol - Symbol in Kraken Futures format
   * @param {Object} options - Options
   * @param {number} [options.from] - Start timestamp
   * @param {number} [options.to] - End timestamp
   * @param {string} [options.resolution='1m'] - Time resolution
   * @returns {Promise<Object>} Mark price data
   */
  async getMarkPrice(symbol, options = {}) {
    try {
      this.log('info', `Fetching mark price for ${symbol}`);
      
      const params = {
        symbol: symbol,
        resolution: options.resolution || '1m'
      };
      
      if (options.from) {
        params.from = Math.floor(options.from / 1000);
      }
      
      if (options.to) {
        params.to = Math.floor(options.to / 1000);
      }
      
      const response = await this._publicRequest('/charts/v1/mark', params);
      
      return this._formatMarkPrice(response, symbol);
    } catch (error) {
      this.log('error', `Failed to fetch mark price: ${error.message}`, { symbol });
      throw error;
    }
  }
  
  /**
   * Format mark price data
   * 
   * @private
   */
  _formatMarkPrice(data, symbol) {
    const prices = (data.candles || []).map(candle => ({
      timestamp: candle.time * 1000,
      price: parseFloat(candle.close)
    }));
    
    return {
      symbol,
      prices,
      timestamp: Date.now()
    };
  }
  
  /**
   * Get open interest history
   * 
   * @param {string} symbol - Symbol in Kraken Futures format
   * @param {Object} options - Options
   * @param {number} [options.limit=100] - Number of records
   * @returns {Promise<Object>} Open interest data
   */
  async getOpenInterest(symbol, options = {}) {
    try {
      this.log('info', `Fetching open interest for ${symbol}`);
      
      // Note: This endpoint might need adjustment based on actual Kraken Futures API
      const ticker = await this.getTicker(symbol);
      
      return {
        symbol,
        openInterest: ticker.openInterest,
        timestamp: Date.now()
      };
    } catch (error) {
      this.log('error', `Failed to fetch open interest: ${error.message}`, { symbol });
      throw error;
    }
  }
  
  // ============================================
  // Fee Information Endpoints
  // ============================================
  
  /**
   * Get fee schedules (public)
   * @returns {Promise<Object>} Fee schedule information
   */
  async getFeeSchedules() {
    try {
      this.log('info', 'Fetching fee schedules');
      
      const response = await this._publicRequest('/feeschedules');
      
      return {
        feeSchedules: (response.feeSchedules || []).map(schedule => ({
          uid: schedule.uid,
          name: schedule.name,
          tiers: schedule.tiers.map(tier => ({
            volumeUSD: tier.usdVolume,
            makerFee: tier.makerFee / 100, // Convert to decimal
            takerFee: tier.takerFee / 100, // Convert to decimal
            makerFeePercent: tier.makerFee,
            takerFeePercent: tier.takerFee
          }))
        }))
      };
    } catch (error) {
      this.log('error', `Failed to fetch fee schedules: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get your 30-day fee schedule volumes (private)
   * @returns {Promise<Object>} Your volume by fee schedule
   */
  async getFeeScheduleVolumes() {
    try {
      this.log('info', 'Fetching fee schedule volumes');
      
      const response = await this._privateRequest('/feeschedules/volumes');
      
      return {
        volumesBySchedule: response.volumesByFeeSchedule || {},
        totalVolume: Object.values(response.volumesByFeeSchedule || {})
          .reduce((sum, vol) => sum + vol, 0)
      };
    } catch (error) {
      this.log('error', `Failed to fetch fee schedule volumes: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get your current fee tier (combines both endpoints)
   * @returns {Promise<Object>} Current fee tier information
   */
  async getCurrentFeeTier() {
    try {
      this.log('info', 'Determining current fee tier');
      
      // Get fee schedules and your volumes
      const [schedules, volumes] = await Promise.all([
        this.getFeeSchedules(),
        this.getFeeScheduleVolumes()
      ]);
      
      // Find your active schedule
      const yourScheduleId = Object.keys(volumes.volumesBySchedule)[0];
      const yourVolume = volumes.volumesBySchedule[yourScheduleId] || 0;
      const yourSchedule = schedules.feeSchedules.find(s => s.uid === yourScheduleId);
      
      if (!yourSchedule) {
        throw new Error('Could not find your fee schedule');
      }
      
      // Find your tier
      let yourTier = yourSchedule.tiers[0]; // Default tier
      
      for (const tier of yourSchedule.tiers) {
        if (yourVolume >= tier.volumeUSD) {
          yourTier = tier;
        } else {
          break; // Tiers are ordered, so we can stop
        }
      }
      
      return {
        schedule: yourSchedule.name,
        scheduleId: yourScheduleId,
        volume30Day: yourVolume,
        currentTier: {
          volumeThreshold: yourTier.volumeUSD,
          makerFee: yourTier.makerFee,
          takerFee: yourTier.takerFee,
          makerFeePercent: yourTier.makerFeePercent,
          takerFeePercent: yourTier.takerFeePercent
        },
        nextTier: this._findNextTier(yourSchedule.tiers, yourVolume)
      };
      
    } catch (error) {
      this.log('error', `Failed to determine fee tier: ${error.message}`);
      throw error;
    }
  }

  /**
   * Find next fee tier
   * @private
   */
  _findNextTier(tiers, currentVolume) {
    for (const tier of tiers) {
      if (currentVolume < tier.volumeUSD) {
        return {
          volumeThreshold: tier.volumeUSD,
          volumeNeeded: tier.volumeUSD - currentVolume,
          makerFee: tier.makerFee,
          takerFee: tier.takerFee,
          makerFeePercent: tier.makerFeePercent,
          takerFeePercent: tier.takerFeePercent
        };
      }
    }
    return null; // Already at highest tier
  }

  // ============================================
  // Trading Endpoints (Private)
  // ============================================
  
  /**
   * Send a new order
   * 
   * @param {Object} orderParams - Order parameters
   * @param {string} orderParams.orderType - Order type (lmt, post, ioc, mkt, stp, take_profit, trailing_stop, fok)
   * @param {string} orderParams.symbol - Futures contract symbol
   * @param {string} orderParams.side - Order direction (buy or sell)
   * @param {number} orderParams.size - Order size/quantity
   * @param {number} [orderParams.limitPrice] - Limit price for limit orders
   * @param {number} [orderParams.stopPrice] - Stop price for stop/take profit orders
   * @param {string} [orderParams.cliOrdId] - Client order ID (max 100 characters)
   * @param {string} [orderParams.triggerSignal] - Trigger signal (mark, index, or last)
   * @param {boolean} [orderParams.reduceOnly] - Only reduce positions
   * @param {number} [orderParams.trailingStopMaxDeviation] - Max deviation for trailing stops (0.1%-50%)
   * @param {string} [orderParams.trailingStopDeviationUnit] - PERCENT or QUOTE_CURRENCY
   * @returns {Promise<Object>} Order confirmation
   */
  async sendOrder(orderParams) {
    try {
      this.log('info', 'Sending order', orderParams);
      
      const response = await this._privateRequest('/sendorder', orderParams, 'POST');
      
      if (response.result !== 'success') {
        throw new Error(`Order failed: ${response.sendStatus?.status || 'Unknown error'}`);
      }
      
      return response;
    } catch (error) {
      this.log('error', `Failed to send order: ${error.message}`, orderParams);
      throw error;
    }
  }
  
  /**
   * Cancel an order
   * 
   * @param {Object} params - Cancellation parameters
   * @param {string} [params.order_id] - Order ID
   * @param {string} [params.cliOrdId] - Client order ID
   * @returns {Promise<Object>} Cancellation status
   */
  async cancelOrder(params) {
    try {
      if (!params.order_id && !params.cliOrdId) {
        throw new Error('Either order_id or cliOrdId must be provided');
      }
      
      this.log('info', 'Cancelling order', params);
      
      const response = await this._privateRequest('/cancelorder', params, 'POST');
      
      if (response.result !== 'success') {
        throw new Error(`Cancel failed: ${response.cancelStatus?.status || 'Unknown error'}`);
      }
      
      return response;
    } catch (error) {
      this.log('error', `Failed to cancel order: ${error.message}`, params);
      throw error;
    }
  }
  
  /**
   * Cancel all orders
   * 
   * @param {string} [symbol] - Cancel orders only for this symbol
   * @returns {Promise<Object>} Cancellation status
   */
  async cancelAllOrders(symbol) {
    try {
      const params = symbol ? { symbol } : {};
      
      this.log('info', 'Cancelling all orders', params);
      
      const response = await this._privateRequest('/cancelallorders', params, 'POST');
      
      if (response.result !== 'success') {
        throw new Error(`Cancel all failed: ${response.cancelStatus?.status || 'Unknown error'}`);
      }
      
      return response;
    } catch (error) {
      this.log('error', `Failed to cancel all orders: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Edit an existing order
   * 
   * @param {Object} params - Edit parameters
   * @param {string} [params.orderId] - Order ID
   * @param {string} [params.cliOrdId] - Client order ID
   * @param {number} [params.size] - New order size
   * @param {number} [params.limitPrice] - New limit price
   * @returns {Promise<Object>} Edit confirmation
   */
  async editOrder(params) {
    try {
      if (!params.orderId && !params.cliOrdId) {
        throw new Error('Either orderId or cliOrdId must be provided');
      }
      
      this.log('info', 'Editing order', params);
      
      const response = await this._privateRequest('/editorder', params, 'POST');
      
      if (response.result !== 'success') {
        throw new Error(`Edit failed: ${response.editStatus?.status || 'Unknown error'}`);
      }
      
      return response;
    } catch (error) {
      this.log('error', `Failed to edit order: ${error.message}`, params);
      throw error;
    }
  }
  
  /**
   * Get open orders
   * 
   * @returns {Promise<Object>} Open orders
   */
  async getOpenOrders() {
    try {
      this.log('info', 'Fetching open orders');
      
      const response = await this._privateRequest('/openorders');
      
      return this._formatOpenOrders(response);
    } catch (error) {
      this.log('error', `Failed to fetch open orders: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get open positions
   * 
   * @returns {Promise<Object>} Open positions
   */
  async getOpenPositions() {
    try {
      this.log('info', 'Fetching open positions');
      
      const response = await this._privateRequest('/openpositions');
      
      return this._formatOpenPositions(response);
    } catch (error) {
      this.log('error', `Failed to fetch open positions: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get fills
   * 
   * @param {Object} [options] - Options
   * @param {string} [options.lastFillTime] - Get fills after this timestamp
   * @returns {Promise<Object>} Fill history
   */
  async getFills(options = {}) {
    try {
      this.log('info', 'Fetching fills', options);
      
      const response = await this._privateRequest('/fills', options);
      
      return this._formatFills(response);
    } catch (error) {
      this.log('error', `Failed to fetch fills: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get account information
   * 
   * @returns {Promise<Object>} Account details
   */
  async getAccounts() {
    try {
      this.log('info', 'Fetching account information');
      
      const response = await this._privateRequest('/accounts');
      
      return this._formatAccounts(response);
    } catch (error) {
      this.log('error', `Failed to fetch accounts: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Batch order operations
   * 
   * @param {Object} batch - Batch operations
   * @param {Array} [batch.placeOrders] - Orders to place
   * @param {Array} [batch.cancelOrders] - Orders to cancel
   * @param {Array} [batch.editOrders] - Orders to edit
   * @returns {Promise<Object>} Batch operation results
   */
  async batchOrder(batch) {
    try {
      this.log('info', 'Processing batch order', {
        placeCount: batch.placeOrders?.length || 0,
        cancelCount: batch.cancelOrders?.length || 0,
        editCount: batch.editOrders?.length || 0
      });
      
      const response = await this._privateRequest('/batchorder', batch, 'POST');
      
      return response;
    } catch (error) {
      this.log('error', `Failed to process batch order: ${error.message}`);
      throw error;
    }
  }
  
  // ============================================
  // Formatting Methods
  // ============================================
  
  /**
   * Format open orders response
   * 
   * @private
   */
  _formatOpenOrders(response) {
    const orders = response.openOrders || [];
    
    return {
      orders: orders.map(order => ({
        orderId: order.order_id,
        cliOrdId: order.cliOrdId,
        symbol: order.symbol,
        side: order.side,
        orderType: order.orderType,
        size: parseFloat(order.filled) + parseFloat(order.unfilledSize),
        filled: parseFloat(order.filled),
        unfilled: parseFloat(order.unfilledSize),
        limitPrice: order.limitPrice ? parseFloat(order.limitPrice) : null,
        stopPrice: order.stopPrice ? parseFloat(order.stopPrice) : null,
        timestamp: new Date(order.receivedTime).getTime()
      })),
      timestamp: Date.now()
    };
  }
  
  /**
   * Format open positions response
   * 
   * @private
   */
  _formatOpenPositions(response) {
    const positions = response.openPositions || [];
    
    return {
      positions: positions.map(pos => ({
        symbol: pos.symbol,
        side: pos.side,
        size: parseFloat(pos.size),
        price: parseFloat(pos.price),
        pnl: parseFloat(pos.pnl || 0),
        unrealizedFunding: parseFloat(pos.unrealizedFunding || 0),
        timestamp: Date.now()
      })),
      timestamp: Date.now()
    };
  }
  
  /**
   * Format fills response
   * 
   * @private
   */
  _formatFills(response) {
    const fills = response.fills || [];
    
    return {
      fills: fills.map(fill => ({
        fillId: fill.fill_id,
        orderId: fill.order_id,
        cliOrdId: fill.cliOrdId,
        symbol: fill.symbol,
        side: fill.side,
        size: parseFloat(fill.size),
        price: parseFloat(fill.price),
        fillType: fill.fillType,
        timestamp: new Date(fill.fillTime).getTime()
      })),
      timestamp: Date.now()
    };
  }
  
  /**
   * Format accounts response
   * 
   * @private
   */
  _formatAccounts(response) {
    const accounts = response.accounts || {};
    
    return {
      accounts: Object.entries(accounts).map(([currency, data]) => ({
        currency,
        balance: parseFloat(data.balance || 0),
        availableBalance: parseFloat(data.availableBalance || 0),
        initialMargin: parseFloat(data.initialMargin || 0),
        maintenanceMargin: parseFloat(data.maintenanceMargin || 0),
        pnl: parseFloat(data.pnl || 0),
        unrealizedFunding: parseFloat(data.unrealizedFunding || 0)
      })),
      timestamp: Date.now()
    };
  }

  /**
   * Get fee schedules (global fee tiers)
   * 
   * Returns all fee schedules defining maker and taker fees across 30-day volume tiers
   * 
   * @returns {Promise<Object>} Fee schedules data
   */
  async getFeeSchedules() {
    try {
      this.log('info', 'Fetching fee schedules');
      
      const response = await this._publicRequest('/feeschedules');
      
      return this._formatFeeSchedules(response);
    } catch (error) {
      this.log('error', `Failed to fetch fee schedules: ${error.message}`);
      throw error;
    }
  }

  /**
   * Format fee schedules data
   * 
   * @private
   */
  _formatFeeSchedules(data) {
    return {
      feeSchedules: (data.feeSchedules || []).map(schedule => ({
        name: schedule.name,
        uid: schedule.uid,
        tiers: (schedule.tiers || []).map(tier => ({
          usdVolume: tier.usdVolume,
          makerFee: tier.makerFee / 100, // Convert to percentage (0.02 = 2%)
          takerFee: tier.takerFee / 100
        }))
      })),
      timestamp: Date.now()
    };
  }

  /**
   * Get user's 30-day fee schedule volumes
   * 
   * Retrieves account's 30-day USD volume for each fee schedule to determine applicable tier
   * Requires authentication
   * 
   * @returns {Promise<Object>} User fee volumes data
   */
  async getUserFeeVolumes() {
    try {
      this.log('info', 'Fetching user fee volumes');
      
      const response = await this._privateRequest('/feeschedules/volumes');
      
      return this._formatUserFeeVolumes(response);
    } catch (error) {
      this.log('error', `Failed to fetch user fee volumes: ${error.message}`);
      throw error;
    }
  }

  /**
   * Format user fee volumes data
   * 
   * @private
   */
  _formatUserFeeVolumes(data) {
    return {
      volumesByFeeSchedule: data.volumesByFeeSchedule || {},
      timestamp: Date.now()
    };
  }

  /**
   * Get current maker/taker fees for the account
   * 
   * Combines fee schedules and user volumes to determine current fee rates
   * 
   * @returns {Promise<Object>} Current fee rates
   */
  async getCurrentFees() {
    try {
      this.log('info', 'Calculating current fees');
      
      // Fetch both fee schedules and user volumes
      const [schedulesData, volumesData] = await Promise.all([
        this.getFeeSchedules(),
        this.getUserFeeVolumes()
      ]);
      
      const feeSchedules = schedulesData.feeSchedules;
      const userVolumes = volumesData.volumesByFeeSchedule;
      
      // Find applicable fee rates for each schedule
      const feeRates = {};
      
      for (const schedule of feeSchedules) {
        const userVolume = userVolumes[schedule.uid] || 0;
        
        // Find the highest tier where user volume >= tier volume
        let applicableTier = schedule.tiers[0]; // Default to first tier
        
        for (const tier of schedule.tiers) {
          if (userVolume >= tier.usdVolume) {
            applicableTier = tier;
          } else {
            break; // Tiers are ordered by volume
          }
        }
        
        feeRates[schedule.name] = {
          scheduleUid: schedule.uid,
          volume30d: userVolume,
          makerFee: applicableTier.makerFee,
          takerFee: applicableTier.takerFee,
          tier: {
            minVolume: applicableTier.usdVolume,
            nextTierVolume: this._getNextTierVolume(schedule.tiers, applicableTier)
          }
        };
      }
      
      return {
        feeRates,
        timestamp: Date.now()
      };
      
    } catch (error) {
      this.log('error', `Failed to calculate current fees: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get next tier volume threshold
   * 
   * @private
   */
  _getNextTierVolume(tiers, currentTier) {
    const currentIndex = tiers.findIndex(t => t.usdVolume === currentTier.usdVolume);
    if (currentIndex < tiers.length - 1) {
      return tiers[currentIndex + 1].usdVolume;
    }
    return null; // Already at highest tier
  }
  
}