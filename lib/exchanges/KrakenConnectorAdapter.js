/**
 * Kraken Connector Adapter
 * 
 * This adapter bridges the gap between the LiveTradingExecutionService's
 * expected connector interface and the KrakenRESTClient's actual methods.
 * It translates method calls and data formats between the two interfaces.
 */

import { KrakenRESTClient } from '../KrakenRESTClient.js';
import { TradingLogger } from '../../../utils/trading-logger.js';

/**
 * Adapter for Kraken REST API that conforms to the execution service's expected interface
 */
export class KrakenConnectorAdapter {
  /**
   * Create a new Kraken connector adapter
   * 
   * @param {Object} config - Configuration options
   * @param {string} [config.apiKey] - Kraken API key
   * @param {string} [config.apiSecret] - Kraken API secret
   * @param {boolean} [config.testMode] - Whether to use test mode
   * @param {Object} [config.logger] - Logger instance
   */
  constructor(config = {}) {
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.testMode = config.testMode || false;
    
    // Initialize logger
    this.logger = config.logger || new TradingLogger({
      sessionId: config.sessionId || 'kraken-connector',
      component: 'KrakenConnector'
    });
    
    // Create the REST client
    this.client = new KrakenRESTClient({
      apiKey: this.apiKey,
      apiSecret: this.apiSecret
    });
    
    this.logger.info(`Initialized KrakenConnectorAdapter${this.testMode ? ' in TEST MODE' : ''}`);
  }
  
  /**
   * Place an order on the exchange
   * 
   * @param {Object} params - Order parameters
   * @param {string} params.symbol - Trading pair
   * @param {string} params.side - Order side (buy/sell)
   * @param {string} params.type - Order type (limit/market)
   * @param {number} params.amount - Order amount
   * @param {number} [params.price] - Order price (for limit orders)
   * @param {string} [params.clientOrderId] - Client order ID
   * @returns {Promise<Object>} Order information
   */
  async placeOrder(params) {
    try {
      this.logger.info(`Placing ${params.side} ${params.type} order for ${params.amount} ${params.symbol}`, { price: params.price });
      
      if (this.testMode) {
        // Generate mock order in test mode
        const mockOrderId = `mock-exchange-order-${Date.now()}`;
        this.logger.info(`[MOCK] Placing order: ${params.side} ${params.amount} ${params.symbol} @ ${params.price || 'market'}`);
        
        return {
          id: mockOrderId,
          clientId: params.clientOrderId,
          symbol: params.symbol,
          side: params.side,
          type: params.type,
          amount: params.amount,
          price: params.price || 0,
          status: 'open',
          timestamp: Date.now()
        };
      }
      
      // Translate parameters to Kraken format
      const krakenParams = {
        pair: params.symbol,
        type: params.side,                      // buy or sell
        ordertype: params.type === 'market' ? 'market' : 'limit',
        volume: params.amount.toString(),       // Order volume in base currency
        oflags: 'fciq'                          // Fee in quote currency
      };
      
      // Add price for limit orders
      if (params.type === 'limit' && params.price) {
        krakenParams.price = params.price.toString();
      }
      
      // Add client order ID if provided
      if (params.clientOrderId) {
        krakenParams.userref = params.clientOrderId;
      }
      
      // Call Kraken API
      const response = await this.client.addOrder(
        params.symbol,
        params.side,
        krakenParams.ordertype,
        params.amount.toString(),
        params.price ? params.price.toString() : undefined,
        { userref: params.clientOrderId }
      );
      
      // Map response to our format
      return {
        id: response.txid?.[0] || 'unknown',
        clientId: params.clientOrderId,
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        amount: params.amount,
        price: params.price || 0,
        status: 'open',  // Kraken doesn't return status in add order response
        timestamp: Date.now()
      };
    } catch (error) {
      this.logger.error(`Error placing order: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Cancel an order on the exchange
   * 
   * @param {string} orderId - Exchange order ID to cancel
   * @returns {Promise<Object>} Cancellation response
   */
  async cancelOrder(orderId) {
    try {
      this.logger.info(`Cancelling order: ${orderId}`);
      
      if (this.testMode) {
        this.logger.info(`[MOCK] Cancelling order: ${orderId}`);
        return { success: true, id: orderId };
      }
      
      // Call Kraken API
      const response = await this.client.cancelOrder(orderId);
      
      return {
        success: response.count > 0,
        id: orderId
      };
    } catch (error) {
      this.logger.error(`Error cancelling order: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get a specific order by ID
   * 
   * @param {string} orderId - Exchange order ID
   * @returns {Promise<Object>} Order information
   */
  async getOrder(orderId) {
    try {
      this.logger.info(`Getting order: ${orderId}`);
      
      if (this.testMode) {
        this.logger.info(`[MOCK] Getting order: ${orderId}`);
        return {
          id: orderId,
          status: 'open',
          amount: 0.01,
          filled: 0,
          remaining: 0.01,
          price: 50000,
          timestamp: Date.now()
        };
      }
      
      // TODO: Implement real getOrder call - Kraken has a QueryOrders endpoint
      throw new Error('getOrder not implemented for non-test mode');
    } catch (error) {
      this.logger.error(`Error getting order: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get orders based on filters
   * 
   * @param {Object} filters - Filters to apply
   * @returns {Promise<Array<Object>>} Orders
   */
  async getOrders(filters = {}) {
    try {
      this.logger.info(`Getting orders with filters`, filters);
      
      if (this.testMode) {
        this.logger.info(`[MOCK] Getting orders`);
        // Return mock orders based on filters
        return [];
      }
      
      // TODO: Implement real getOrders call - Kraken has OpenOrders and ClosedOrders endpoints
      throw new Error('getOrders not implemented for non-test mode');
    } catch (error) {
      this.logger.error(`Error getting orders: ${error.message}`);
      return []; // Return empty array to avoid breaking caller
    }
  }
  
  /**
   * Get WebSocket token for authenticated connections
   * 
   * @returns {Promise<Object>} WebSocket token
   */
  async getWebSocketToken() {
    try {
      if (this.testMode) {
        const mockToken = {
          token: `mock-token-${Date.now()}`,
          expires: Date.now() + 900000 // 15 minutes
        };
        this.logger.info(`[MOCK] Generated WebSocket token`);
        return mockToken;
      }
      
      const response = await this.client.getWebSocketToken();
      return response;
    } catch (error) {
      this.logger.error(`Error getting WebSocket token: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get recent trades for a given trading pair
   * 
   * @param {string} pair - Trading pair to get trades for
   * @param {string|number} [since] - Return trade data since given timestamp
   * @returns {Promise<Object>} Recent trades data
   */
  async getRecentTrades(pair, since) {
    try {
      if (this.testMode) {
        this.logger.info(`[MOCK] Getting recent trades for ${pair}`);
        // Generate mock trades in the same format as the real API
        const mockTrades = [];
        const now = Date.now() / 1000;
        
        for (let i = 0; i < 10; i++) {
          const price = (Math.random() * 1000 + 50000).toFixed(2);
          const volume = (Math.random() * 0.1).toFixed(8);
          const timestamp = now - i * 10; // 10 seconds between trades
          const side = Math.random() > 0.5 ? 'b' : 's';
          const orderType = Math.random() > 0.5 ? 'm' : 'l';
          
          mockTrades.push([price, volume, timestamp, side, orderType, '', i]);
        }
        
        return {
          result: {
            [pair.replace('/', '')]: mockTrades
          },
          last: now.toString()
        };
      }
      
      // Use the underlying client to get recent trades
      if (!this.client || typeof this.client.getRecentTrades !== 'function') {
        throw new Error('KrakenRESTClient does not support getRecentTrades');
      }
      
      this.logger.info(`Getting recent trades for ${pair}${since ? ` since ${since}` : ''}`);
      const response = await this.client.getRecentTrades(pair, since);
      return response;
    } catch (error) {
      this.logger.error(`Error getting recent trades for ${pair}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Clean up any resources
   */
  async disconnect() {
    this.logger.info(`[${this.testMode ? 'MOCK' : 'LIVE'}] Disconnecting`);
    // Nothing to clean up with REST API
    return true;
  }
}

export default KrakenConnectorAdapter;
