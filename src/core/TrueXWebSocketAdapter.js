import { AdaptiveMarketMakerExchangeAdapter } from './AdaptiveMarketMakerExchangeAdapter.js';
import WebSocket from 'ws';
import crypto from 'crypto';
import { EventEmitter } from 'events';

const DEFAULT_TRUEX_UAT_WS_URL = 'wss://uat.truex.co/api/v1';
const DEFAULT_TRUEX_PROD_WS_URL = 'wss://prod.truex.co/api/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * TrueX WebSocket Exchange Adapter
 * 
 * This adapter manages WebSocket connections to TrueX exchange for:
 * - Real-time market data (instruments, trades, EBBO)
 * - Order management and execution
 * - Authentication via HMAC-SHA256
 */
export class TrueXWebSocketAdapter extends AdaptiveMarketMakerExchangeAdapter {
    /**
     * Creates an instance of TrueXWebSocketAdapter
     * @param {object} config Configuration object
     * @param {string} config.symbol Trading symbol (e.g., "BTC/USD")
     * @param {string} config.sessionId Current session ID
     * @param {object} config.logger Logger instance
     * @param {object} config.redisOrderManager Instance of RedisOrderManager
     * @param {object} config.redisFillManager Instance of RedisFillManager
     * @param {string} [config.apiKey] TrueX API key (UUID format)
     * @param {string} [config.apiSecret] TrueX API secret for HMAC signature
     * @param {string} [config.organizationId] TrueX organization ID (UUID format)
     * @param {string} [config.environment='uat'] Environment: 'uat' or 'production'
     * @param {string} [config.wsUrl] Override WebSocket URL
     * @param {number} [config.maxReconnectAttempts=5] Maximum reconnection attempts
     * @param {number} [config.reconnectDelayMs=5000] Delay between reconnection attempts
     */
    constructor(config) {
        super(config, config);
        
        // Configuration
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.organizationId = config.organizationId;
        this.environment = config.environment || 'uat';
        this.wsUrl = config.wsUrl || (this.environment === 'production' ? DEFAULT_TRUEX_PROD_WS_URL : DEFAULT_TRUEX_UAT_WS_URL);
        this.maxReconnectAttempts = config.maxReconnectAttempts || MAX_RECONNECT_ATTEMPTS;
        this.reconnectDelayMs = config.reconnectDelayMs || DEFAULT_RECONNECT_DELAY_MS;
        
        // WebSocket connection state
        this.ws = null;
        this.isConnected = false;
        this.isAuthenticated = false;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        
        // Request tracking for async responses
        this.pendingRequests = new Map();
        this.requestCounter = 0;
        
        // Subscription state
        this.subscriptions = {
            channels: new Set(),
            instruments: new Set()
        };
        
        // Market data cache
        this.marketData = {
            instruments: new Map(),
            orderBook: new Map(),
            trades: new Map(),
            lastUpdate: new Map()
        };
        
        // Order tracking
        this.activeOrders = new Map();
        this.orderSequence = 0;
        
        // Event emitter for internal events
        this.internalEvents = new EventEmitter();
        
        // Initialize connection
        this.connect();
        
        this.logger.info('TrueXWebSocketAdapter initialized', {
            symbol: this.symbol,
            environment: this.environment,
            wsUrl: this.wsUrl
        });
    }
    
    /**
     * Connect to TrueX WebSocket
     */
    async connect() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.logger.warn('WebSocket already connected');
            return;
        }
        
        try {
            this.logger.info('Connecting to TrueX WebSocket', { url: this.wsUrl });
            
            this.ws = new WebSocket(this.wsUrl);
            
            // Set up event handlers
            this.ws.on('open', this._handleOpen.bind(this));
            this.ws.on('message', this._handleMessage.bind(this));
            this.ws.on('close', this._handleClose.bind(this));
            this.ws.on('error', this._handleError.bind(this));
            
            // Set up ping/pong for connection health
            this.ws.on('ping', () => {
                this.logger.debug('Received ping from server');
                this.ws.pong();
            });
            
        } catch (error) {
            this.logger.error('Failed to connect to WebSocket', { error: error.message });
            this._scheduleReconnect();
        }
    }
    
    /**
     * Disconnect from WebSocket
     */
    async disconnect() {
        this.logger.info('Disconnecting from TrueX WebSocket');
        
        // Clear reconnection timer
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        // Close WebSocket connection
        if (this.ws) {
            this.ws.removeAllListeners();
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close(1000, 'Client disconnect');
            }
            this.ws = null;
        }
        
        this.isConnected = false;
        this.isAuthenticated = false;
        this.emit('disconnect');
    }
    
    /**
     * Generate HMAC-SHA256 signature for authentication
     * @param {string} timestamp - Unix timestamp in seconds
     * @param {string} path - API path (e.g., '/api/v1')
     * @returns {string} - Base64 encoded signature
     */
    _generateSignature(timestamp, path = '/api/v1') {
        const payload = `${timestamp}TRUEXWS${this.apiKey}${path}`;
        const signature = crypto
            .createHmac('sha256', this.apiSecret)
            .update(payload)
            .digest('base64');
        return signature;
    }
    
    /**
     * Send authenticated subscription request
     * @param {Array<string>} channels - Channels to subscribe to
     * @param {Array<string>} instruments - Instruments to subscribe to
     */
    async _sendAuthenticatedSubscription(channels = [], instruments = []) {
        if (!this.apiKey || !this.apiSecret) {
            throw new Error('API credentials required for authenticated subscription');
        }
        
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const signature = this._generateSignature(timestamp);
        
        const message = {
            type: 'SUBSCRIBE',
            channels: channels,
            item_names: instruments,
            timestamp: timestamp,
            organization_id: this.organizationId,
            key: this.apiKey,
            signature: signature
        };
        
        this._sendMessage(message);
    }
    
    /**
     * Send unauthenticated subscription request
     * @param {Array<string>} channels - Channels to subscribe to
     * @param {Array<string>} instruments - Instruments to subscribe to
     */
    async _sendUnauthenticatedSubscription(channels = [], instruments = []) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        
        const message = {
            type: 'SUBSCRIBE_NO_AUTH',
            channels: channels,
            item_names: instruments,
            timestamp: timestamp
        };
        
        this._sendMessage(message);
    }
    
    /**
     * Send message to WebSocket
     * @param {object} message - Message to send
     */
    _sendMessage(message) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }
        
        const jsonMessage = JSON.stringify(message);
        this.logger.debug('Sending message', { 
            type: message.type,
            channels: message.channels,
            instruments: message.item_names
        });
        
        this.ws.send(jsonMessage);
    }
    
    /**
     * Handle WebSocket open event
     */
    _handleOpen() {
        this.logger.info('WebSocket connection opened');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.emit('connect');
    }
    
    /**
     * Handle WebSocket message
     * @param {string} data - Raw message data
     */
    _handleMessage(data) {
        try {
            const message = JSON.parse(data);
            this.logger.debug('Received message', { 
                channel: message.channel,
                update: message.update,
                status: message.status
            });
            
            // Route message based on type
            switch (message.channel) {
                case 'WEBSOCKET':
                    this._handleWebSocketMessage(message);
                    break;
                case 'INSTRUMENT':
                    this._handleInstrumentMessage(message);
                    break;
                case 'TRADE':
                    this._handleTradeMessage(message);
                    break;
                case 'EBBO':
                    this._handleEBBOMessage(message);
                    break;
                default:
                    this.logger.warn('Unknown message channel', { channel: message.channel });
            }
            
        } catch (error) {
            this.logger.error('Failed to parse message', { error: error.message, data });
        }
    }
    
    /**
     * Handle WebSocket channel messages (welcome, confirmation)
     * @param {object} message - Parsed message
     */
    _handleWebSocketMessage(message) {
        switch (message.update) {
            case 'WELCOME':
                this.logger.info('Received welcome message', {
                    version: message.version,
                    connections: message.connections
                });
                // After welcome, send initial subscriptions
                this._sendInitialSubscriptions();
                break;
                
            case 'SNAPSHOT':
            case 'UPDATE':
                if (message.status) {
                    this.logger.info('Connection status update', {
                        status: message.status,
                        subscriptions: message.subscriptions
                    });
                    this.isAuthenticated = message.status === 'AUTHENTICATED';
                    this.emit('authenticated', this.isAuthenticated);
                }
                break;
        }
    }
    
    /**
     * Handle instrument data messages
     * @param {object} message - Parsed message
     */
    _handleInstrumentMessage(message) {
        if (!message.data) return;
        
        const instrument = message.data;
        this.marketData.instruments.set(instrument.id, instrument);
        
        // Emit instrument update
        this.emit('instrument', {
            id: instrument.id,
            symbol: instrument.info?.symbol,
            status: instrument.status,
            baseAsset: instrument.info?.base_asset_id,
            quoteAsset: instrument.info?.quote_asset_id,
            stats: instrument.stats,
            timestamp: Date.now()
        });
    }
    
    /**
     * Handle trade messages
     * @param {object} message - Parsed message
     */
    _handleTradeMessage(message) {
        if (!message.data) return;
        
        const trade = message.data;
        
        // Store latest trade
        const trades = this.marketData.trades.get(this.symbol) || [];
        trades.push({
            id: trade.match_id,
            price: parseFloat(trade.trade_price),
            quantity: parseFloat(trade.trade_qty),
            side: trade.liq_flag === 'TAKER' ? 'taker' : 'maker',
            timestamp: Date.now()
        });
        
        // Keep last 100 trades
        if (trades.length > 100) {
            trades.shift();
        }
        
        this.marketData.trades.set(this.symbol, trades);
        
        // Emit trade update
        this.emit('trade', {
            symbol: this.symbol,
            price: parseFloat(trade.trade_price),
            quantity: parseFloat(trade.trade_qty),
            side: trade.liq_flag,
            timestamp: Date.now()
        });
    }
    
    /**
     * Handle EBBO (Exchange Best Bid Offer) messages
     * @param {object} message - Parsed message
     */
    _handleEBBOMessage(message) {
        if (!message.data || !message.data.info) return;
        
        const ebbo = message.data.info;
        
        // Update order book
        const orderBook = {
            bids: [[parseFloat(ebbo.best_bid.price), parseFloat(ebbo.best_bid.qty)]],
            asks: [[parseFloat(ebbo.best_ask.price), parseFloat(ebbo.best_ask.qty)]],
            timestamp: parseInt(ebbo.last_update) / 1e6, // Convert nanoseconds to milliseconds
            symbol: this.symbol
        };
        
        this.marketData.orderBook.set(this.symbol, orderBook);
        this.marketData.lastUpdate.set(this.symbol, Date.now());
        
        // Emit orderbook update
        this.emit('orderbook', orderBook);
        
        // Emit ticker update
        this.emit('ticker', {
            symbol: this.symbol,
            bid: parseFloat(ebbo.best_bid.price),
            bidSize: parseFloat(ebbo.best_bid.qty),
            ask: parseFloat(ebbo.best_ask.price),
            askSize: parseFloat(ebbo.best_ask.qty),
            last: ebbo.last_trade ? parseFloat(ebbo.last_trade.price) : null,
            timestamp: Date.now()
        });
    }
    
    /**
     * Handle WebSocket close event
     * @param {number} code - Close code
     * @param {string} reason - Close reason
     */
    _handleClose(code, reason) {
        this.logger.warn('WebSocket connection closed', { code, reason });
        this.isConnected = false;
        this.isAuthenticated = false;
        this.emit('disconnect');
        
        // Attempt reconnection if not a normal closure
        if (code !== 1000) {
            this._scheduleReconnect();
        }
    }
    
    /**
     * Handle WebSocket error
     * @param {Error} error - Error object
     */
    _handleError(error) {
        this.logger.error('WebSocket error', { error: error.message });
        this.emit('error', error);
    }
    
    /**
     * Schedule reconnection attempt
     */
    _scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error('Max reconnection attempts reached');
            this.emit('maxReconnectAttemptsReached');
            return;
        }
        
        this.reconnectAttempts++;
        const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);
        
        this.logger.info('Scheduling reconnection', {
            attempt: this.reconnectAttempts,
            delayMs: delay
        });
        
        this.reconnectTimer = setTimeout(() => {
            this.connect();
        }, delay);
    }
    
    /**
     * Send initial subscriptions after connection
     */
    async _sendInitialSubscriptions() {
        try {
            // Subscribe to EBBO and TRADE channels for our symbol
            const channels = ['EBBO', 'TRADE'];
            const instruments = [this.symbol];
            
            if (this.apiKey && this.apiSecret) {
                await this._sendAuthenticatedSubscription(channels, instruments);
            } else {
                await this._sendUnauthenticatedSubscription(channels, instruments);
            }
            
            // Store subscriptions
            channels.forEach(ch => this.subscriptions.channels.add(ch));
            instruments.forEach(inst => this.subscriptions.instruments.add(inst));
            
        } catch (error) {
            this.logger.error('Failed to send initial subscriptions', { error: error.message });
        }
    }
    
    /**
     * Subscribe to additional channels/instruments
     * @param {Array<string>} channels - Additional channels
     * @param {Array<string>} instruments - Additional instruments
     */
    async subscribe(channels = [], instruments = []) {
        if (!this.isConnected) {
            throw new Error('WebSocket not connected');
        }
        
        try {
            if (this.apiKey && this.apiSecret) {
                await this._sendAuthenticatedSubscription(channels, instruments);
            } else {
                await this._sendUnauthenticatedSubscription(channels, instruments);
            }
            
            // Update subscription state
            channels.forEach(ch => this.subscriptions.channels.add(ch));
            instruments.forEach(inst => this.subscriptions.instruments.add(inst));
            
        } catch (error) {
            this.logger.error('Failed to subscribe', { error: error.message, channels, instruments });
            throw error;
        }
    }
    
    /**
     * Unsubscribe from channels/instruments
     * @param {Array<string>} channels - Channels to unsubscribe from
     * @param {Array<string>} instruments - Instruments to unsubscribe from
     */
    async unsubscribe(channels = [], instruments = []) {
        if (!this.isConnected) {
            throw new Error('WebSocket not connected');
        }
        
        try {
            const timestamp = Math.floor(Date.now() / 1000).toString();
            const message = {
                type: 'UNSUBSCRIBE',
                channels: channels,
                item_names: instruments,
                timestamp: timestamp
            };
            
            if (this.apiKey && this.apiSecret) {
                message.organization_id = this.organizationId;
                message.key = this.apiKey;
                message.signature = this._generateSignature(timestamp);
            }
            
            this._sendMessage(message);
            
            // Update subscription state
            channels.forEach(ch => this.subscriptions.channels.delete(ch));
            instruments.forEach(inst => this.subscriptions.instruments.delete(inst));
            
        } catch (error) {
            this.logger.error('Failed to unsubscribe', { error: error.message, channels, instruments });
            throw error;
        }
    }
    
    /**
     * Get current order book
     * @param {string} symbol - Trading symbol
     * @returns {object} - Order book data
     */
    async fetchOrderBook(symbol) {
        const orderBook = this.marketData.orderBook.get(symbol);
        if (!orderBook) {
            throw new Error(`No order book data for ${symbol}`);
        }
        return orderBook;
    }
    
    /**
     * Get current ticker
     * @param {string} symbol - Trading symbol
     * @returns {object} - Ticker data
     */
    async fetchTicker(symbol) {
        const orderBook = this.marketData.orderBook.get(symbol);
        if (!orderBook || !orderBook.bids.length || !orderBook.asks.length) {
            throw new Error(`No ticker data for ${symbol}`);
        }
        
        const trades = this.marketData.trades.get(symbol) || [];
        const lastTrade = trades[trades.length - 1];
        
        return {
            symbol: symbol,
            bid: orderBook.bids[0][0],
            bidVolume: orderBook.bids[0][1],
            ask: orderBook.asks[0][0],
            askVolume: orderBook.asks[0][1],
            last: lastTrade ? lastTrade.price : null,
            timestamp: orderBook.timestamp
        };
    }
    
    /**
     * Create order (placeholder - TrueX WebSocket doesn't support order placement)
     * NOTE: Order management would need to be implemented via REST API
     */
    async createOrder(orderDetails) {
        throw new Error('Order placement not supported via WebSocket. Use TrueX REST API for order management.');
    }
    
    /**
     * Cancel order (placeholder - TrueX WebSocket doesn't support order cancellation)
     */
    async cancelOrder(orderId) {
        throw new Error('Order cancellation not supported via WebSocket. Use TrueX REST API for order management.');
    }
    
    /**
     * Clean up resources
     */
    async cleanup() {
        await this.disconnect();
        this.removeAllListeners();
        this.internalEvents.removeAllListeners();
        this.pendingRequests.clear();
        this.marketData.instruments.clear();
        this.marketData.orderBook.clear();
        this.marketData.trades.clear();
        this.activeOrders.clear();
    }
}



export default TrueXWebSocketAdapter;