import { AdaptiveMarketMakerExchangeAdapter } from './AdaptiveMarketMakerExchangeAdapter.js';
import WebSocket from 'ws';
import { KrakenRESTClient } from '../../../../lib/exchanges/KrakenRESTClient.js';
import fs from 'fs'; // Import fs for file logging

const DEFAULT_KRAKEN_PRIVATE_WS_URL = 'wss://ws-auth.kraken.com/v2';
const DEFAULT_KRAKEN_PUBLIC_WS_URL = 'wss://ws.kraken.com/v2'; // For public v2 endpoint
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_ORDER_BOOK_DEPTH = 10;
const DEFAULT_TOKEN_RENEWAL_BUFFER_SECONDS = 300; // 5 minutes before expiry
const DEFAULT_TOKEN_RETRY_DELAY_SECONDS = 60; // 1 minute
const DEBUG_LOG_FILE = '/tmp/jest_api_key_debug.log'; // Define log file path

/**
 * Kraken WebSocket V2 Exchange Adapter with dual connection support
 * 
 * This adapter manages two separate WebSocket connections:
 * 1. Private/Auth connection (ws-auth.kraken.com/v2) for order operations and private data
 * 2. Public connection (ws.kraken.com/v2) for market data (order books, tickers)
 */
export class KrakenWebSocketV2ExchangeAdapter extends AdaptiveMarketMakerExchangeAdapter {
    /**
     * Creates an instance of KrakenWebSocketV2ExchangeAdapter.
     * @param {object} config Configuration object
     * @param {string} config.symbol Trading symbol (e.g., "BTC/USD")
     * @param {string} config.sessionId Current session ID
     * @param {object} config.logger Logger instance
     * @param {object} config.redisOrderManager Instance of RedisOrderManager
     * @param {object} config.redisFillManager Instance of RedisFillManager
     * @param {string} [config.apiKey] Kraken API key for authentication
     * @param {string} [config.apiSecret] Kraken API secret for authentication
     * @param {string} [config.apiUrl] Kraken WebSocket API URL for private connection
     * @param {string} [config.publicApiUrl] Kraken WebSocket API URL for public data
     * @param {string} [config.restApiUrl] Kraken REST API URL
     * @param {number} [config.tokenRenewalBufferSeconds=300] Buffer time before token renewal
     * @param {number} [config.tokenRetryDelaySeconds=60] Delay between token fetch retries
     * @param {number} [config.maxReconnectAttempts=5] Maximum number of reconnection attempts
     * @param {number} [config.initialReconnectDelayMs=1000] Initial delay for reconnection in milliseconds
     * @param {number} [config.maxReconnectDelayMs=30000] Maximum delay for reconnection in milliseconds
     * @param {number} [config.orderBookDepth=10] Depth of order book to maintain and emit
     * @param {number} [config.orderBookPollIntervalMs=5000] Interval for REST order book polling (fallback)
     */
    constructor(config) {
        // Create a mock client for paper mode or use real client for live mode
        const mockClient = {
            // Support both direct parameter list and object format
            createOrder: async (symbolOrOrderObject, type, side, amount, price, params = {}) => {
                // Handle both formats - object as first param or individual parameters
                let symbol, orderType, orderSide, orderSize, orderPrice, orderParams;
                
                if (typeof symbolOrOrderObject === 'object') {
                    // Object format
                    symbol = symbolOrOrderObject.symbol;
                    orderType = symbolOrOrderObject.type;
                    orderSide = symbolOrOrderObject.side;
                    // CRITICAL FIX: Handle both size and amount fields for backward compatibility
                    orderSize = symbolOrOrderObject.size || symbolOrOrderObject.amount;
                    orderPrice = symbolOrOrderObject.price;
                    orderParams = symbolOrOrderObject.params || {};
                    // Extract parentOrderId, purpose, and sessionId from the order object
                    if (symbolOrOrderObject.parentOrderId) {
                        orderParams.parentOrderId = symbolOrOrderObject.parentOrderId;
                    }
                    if (symbolOrOrderObject.purpose) {
                        orderParams.purpose = symbolOrOrderObject.purpose;
                    }
                    if (symbolOrOrderObject.sessionId) {
                        orderParams.sessionId = symbolOrOrderObject.sessionId;
                    }
                    if (symbolOrOrderObject.clientOrderId) {
                        orderParams.clientOrderId = symbolOrOrderObject.clientOrderId;
                    }
                    if (symbolOrOrderObject.pricingMetadata) {
                        orderParams.pricingMetadata = symbolOrOrderObject.pricingMetadata;
                    }
                } else {
                    // Individual parameters format
                    symbol = symbolOrOrderObject;
                    orderType = type;
                    orderSide = side;
                    orderSize = amount; // Parameter is still called 'amount' but we treat it as size internally
                    orderPrice = price;
                    orderParams = params;
                }
                
                const clientOrderId = orderParams.clientOrderId || `paper-${Date.now()}`;
                const now = Date.now();
                const paperOrder = {
                    id: clientOrderId,  // Use clientOrderId as primary ID
                    clientOrderId,
                    symbol,
                    type: orderType,
                    side: orderSide,
                    price: orderPrice,
                    size: orderSize, // Only use size
                    status: 'OPEN',
                    timestamp: now, // Timestamp in milliseconds since epoch
                    // Remove datetime ISO string - standardize on numeric timestamps only
                    filled: 0,
                    remaining: orderSize, // Only use size
                    sessionId: orderParams.sessionId || config.sessionId, // Use from params or config
                    parentOrderId: orderParams.parentOrderId || null, // Preserve parentOrderId
                    purpose: orderParams.purpose || null, // Preserve purpose
                    pricingMetadata: orderParams.pricingMetadata || null // Include pricing metadata
                };
                
                this.logger.info(`[KWSA Paper DEBUG] Preparing to add paper order ${paperOrder.id} to RedisOrderManager.`);
                // In paper mode, add the order to RedisOrderManager
                if (config.paperMode && config.redisOrderManager && typeof config.redisOrderManager.add === 'function') {
                    // Add order to Redis for persistence
                    try {
                        this.logger.info(`[KWSA Paper DEBUG] CALLING redisOrderManager.add for ${paperOrder.id}`);
                        await config.redisOrderManager.add(paperOrder);
                        this.logger.info(`[KWSA Paper DEBUG] FINISHED redisOrderManager.add for ${paperOrder.id}`);
                    } catch (err) {
                        this.logger.debug('[KWSA Paper DEBUG] Error calling redisOrderManager.add:', err);
                    }
                }
                
                // In paper mode, we need to simulate order status update separately
                // This would normally come from the exchange via WebSocket
                if (config.paperMode) {
                    // Schedule an 'orderUpdate' event to simulate the exchange acknowledging the order
                    setTimeout(async () => {
                        const orderUpdate = {
                            id: paperOrder.id,
                            clientOrderId: paperOrder.clientOrderId,
                            symbol: paperOrder.symbol,
                            side: paperOrder.side.toLowerCase(), // Ensure side is lowercase
                            type: paperOrder.type,
                            price: paperOrder.price,
                            size: paperOrder.size, // Only use size
                            amount: paperOrder.size, // Include amount for compatibility
                            status: 'OPEN', // Updated status from NEW to OPEN
                            timestamp: Date.now(), // Timestamp in milliseconds since epoch
                            filled: 0,
                            remaining: paperOrder.size, // Only use size
                            sessionId: paperOrder.sessionId,
                            parentOrderId: paperOrder.parentOrderId, // Preserve parentOrderId
                            purpose: paperOrder.purpose, // Preserve purpose
                            pricingMetadata: paperOrder.pricingMetadata // Preserve pricing metadata
                        };
                        
                        // Store in paperOrders Map for later reference
                        if (this.paperOrders) {
                            this.paperOrders.set(paperOrder.id, {
                                order_id: paperOrder.id,
                                cl_ord_id: paperOrder.clientOrderId,
                                order_qty: paperOrder.size, // Standardize on size
                                filled_qty: 0,
                                limit_price: paperOrder.price,
                                status: 'open',
                                symbol: paperOrder.symbol,
                                side: paperOrder.side,
                                parentOrderId: paperOrder.parentOrderId, // Preserve parentOrderId
                                purpose: paperOrder.purpose, // Preserve purpose
                                pricingMetadata: paperOrder.pricingMetadata // Preserve pricing metadata
                            });
                        }
                        
                        // Update order in RedisOrderManager
                        if (config.redisOrderManager && typeof config.redisOrderManager.update === 'function') {
                            // Update order to Redis with new status
                            try {
                                this.logger.info(`[KWSA Paper DEBUG] CALLING redisOrderManager.update for ${orderUpdate.id}`);
                                await config.redisOrderManager.update(orderUpdate);
                                this.logger.info(`[KWSA Paper DEBUG] FINISHED redisOrderManager.update for ${orderUpdate.id}`);
                            } catch (err) {
                                this.logger.debug('[KWSA Paper DEBUG] Error calling redisOrderManager.update:', err);
                            }
                        }
                        
                        // Emit the update event
                        if (typeof this.emit === 'function') {
                            this.emit('orderUpdate', orderUpdate);
                        }
                    }, 10); // Small delay to simulate network latency
                }
                
                return paperOrder;
            },
            // Add other required methods for the mock client
            cancelOrder: async (orderId) => ({ id: orderId, status: 'CANCELED' }),
            getOrderStatus: async (orderId) => ({ id: orderId, status: 'OPEN' }),
            getOpenOrders: async () => ([]),
            getBalances: async () => ({}),
            getPositions: async () => ([]),
            getOrderBook: async () => ({ bids: [], asks: [] }),
            getTicker: async () => ({}),
            getTrades: async () => ([]),
            getOHLC: async () => ([])
        };
        
        // Create REST client for live trading or mock client for paper trading
        let exchangeClient = null;
        if (config.paperMode) {
            exchangeClient = mockClient;
        } else {
            // Initialize REST client for live trading
            exchangeClient = new KrakenRESTClient({
                apiKey: config.apiKey,
                apiSecret: config.apiSecret,
                baseUrl: config.restApiUrl || 'https://api.kraken.com'
            });
        }

        super(exchangeClient, config);

        this.symbol = config.symbol;
        this.sessionId = config.sessionId;
        this.logger = config.logger.createChild ? config.logger.createChild('KrakenWSv2Adapter') : config.logger;
        this.redisOrderManager = config.redisOrderManager;
        this.redisFillManager = config.redisFillManager;
        
        // Store budget configuration for paper trading balance initialization
        this.budget = config.budget;
        this.initialBudget = config.initialBudget;
        
        // DEBUG: Log budget configuration
        this.logger.debug('[KWSA Constructor DEBUG] Budget configuration:', {
            configBudget: config.budget,
            configInitialBudget: config.initialBudget,
            thisBudget: this.budget,
            thisInitialBudget: this.initialBudget,
            paperMode: config.paperMode,
            tradingMode: config.tradingMode
        });
        
        // Store base currency balance configuration for paper trading
        // This allows explicit control over starting base currency (ETH, BTC, etc.) amounts
        // Default to undefined, which will result in 0 balance (appropriate for BUY-ONLY strategies)
        this.initialBaseCurrencyBalance = config.initialBaseCurrencyBalance;
        
        // Set exchange name for consistency
        this.exchangeName = 'kraken';
        
        // API authentication credentials
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.restApiUrl = config.restApiUrl || 'https://api.kraken.com';
        
        // Paper Trading Mode
        this.paperMode = config.paperMode || false;
        // Ensure consistent naming - add tradingMode property for compatibility
        this.tradingMode = this.paperMode ? 'paper' : 'live';
        
        // Orderbook subscription control (for settlement service optimization)
        this.subscribeToOrderbook = config.subscribeToOrderbook !== false; // Default to true unless explicitly disabled
        this.disableOrderbook = config.disableOrderbook || false;
        
        if (this.paperMode) {
            this.logger.info('[KrakenWebSocketV2ExchangeAdapter] Paper trading mode is ENABLED.');
            // Set the paper trading fill simulation interval to 100ms for faster testing
            this.paperFillSimulationInterval = 100; // Hardcoded to 100ms for quick testing
            this.logger.info(`[KrakenWebSocketV2ExchangeAdapter] Paper fill simulation interval set to ${this.paperFillSimulationInterval}ms for accelerated testing`);
        }
        
        // For Redis Backend API components needed by AdaptiveMarketMakerV2
        this.keyGenerator = config.keyGenerator;
        this.validationUtils = config.validationUtils;

        // Store Redis adapter for use by other components like SessionManager
        this.redisAdapter = config.redis || (this.redisOrderManager && this.redisOrderManager.redis);
        
        // Flag to track if Redis components are initialized
        this._redisComponentsInitialized = !!(this.keyGenerator && this.validationUtils);
        
        // Initialize fee caching system
        this.feeCache = {
            makerFee: null,
            takerFee: null,
            lastUpdated: null,
            volume: null,
            currency: null,
            pairSpecificFees: new Map() // Cache pair-specific fees
        };
        this.feeRefreshIntervalMs = config.feeRefreshIntervalMs || 300000; // 5 minutes default
        this.fallbackFees = {
            maker: 0.0025, // Kraken standard maker fee
            taker: 0.004   // Kraken standard taker fee
        };
        this._feeRefreshTimer = null;
        
        // WebSocket token management
        this.token = null;
        this.tokenExpiresAt = 0;
        this.tokenRenewalBufferSeconds = config.tokenRenewalBufferSeconds || DEFAULT_TOKEN_RENEWAL_BUFFER_SECONDS;
        this.tokenRetryDelaySeconds = config.tokenRetryDelaySeconds || DEFAULT_TOKEN_RETRY_DELAY_SECONDS;
        this.tokenRenewalTimer = null;
        
        // Store for paper trading orders
        if (this.paperMode) {
            this.paperOrders = new Map();
            // Store budget for paper trading balance simulation
            this.budget = config.budget || null;
            this.initialBudget = config.initialBudget || config.budget || null;
            this.logger.info('[KrakenWSv2Adapter] Paper mode initialized with budget', {
                budget: this.budget,
                initialBudget: this.initialBudget
            });
        }
        
        // Store for live trading orders to handle race conditions
        // This prevents fills from being lost when they arrive before order creation responses
        this.liveOrders = new Map();
        
        // Map exchange order IDs to internal order IDs for reconciliation
        this.exchangeOrderIdMap = new Map();
        
        // UPDATED LOGGING BLOCK
        fs.appendFileSync(DEBUG_LOG_FILE, `[ADAPTER_CONSTRUCTOR] ApiKey from config: ${config.apiKey ? config.apiKey.substring(0, 5) + '...' : 'Not in config'}\n`);
        fs.appendFileSync(DEBUG_LOG_FILE, `[ADAPTER_CONSTRUCTOR] ApiSecret from config: ${config.apiSecret ? config.apiSecret.substring(0, 5) + '...' : 'Not in config'}\n`);
        // END LOGGING BLOCK

        // Create REST client for token fetching and fallback operations
        this._restClient = new KrakenRESTClient({
            apiKey: this.apiKey, // this.apiKey is config.apiKey from constructor
            apiSecret: this.apiSecret, // this.apiSecret is config.apiSecret
            baseUrl: this.restApiUrl
        });

        // Private (Authenticated) WebSocket Configuration
        this.apiUrl = config.apiUrl || DEFAULT_KRAKEN_PRIVATE_WS_URL;
        this.requestTimeoutMs = config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
        this.ws = null;
        this.subscriptions = new Map(); // For tracking req_id responses
        this.activeChannels = new Set(); // For tracking active channel subscriptions
        this._pendingSubscriptions = new Set(); // For tracking subscriptions in progress
        this._nextReqId = 1;
        
        // Connection state for private WebSocket
        this.connectionState = 'disconnected'; // disconnected, connecting, connected, disconnecting, reconnecting
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = config.maxReconnectAttempts || 999999; // Effectively infinite reconnection attempts
        this.initialReconnectDelayMs = config.initialReconnectDelayMs || 1000;
        this.currentReconnectDelayMs = this.initialReconnectDelayMs; // Reset reconnect delay
        this.maxReconnectDelayMs = config.maxReconnectDelayMs || 60000; // Increased to 60 seconds max delay
        this.reconnectTimer = null;
        this._isManualDisconnect = false;
        this._connectPromise = null;
        this._initialConnectResolve = null;
        this._initialConnectReject = null;
        this.lastMessageTimestamp = 0;

        // Public WebSocket Configuration
        this.publicApiUrl = config.publicApiUrl || DEFAULT_KRAKEN_PUBLIC_WS_URL;
        this.wsPublic = null;
        this.publicSubscriptions = new Map();
        this.publicActiveChannels = new Set();
        this.publicPendingSubscriptions = new Set();
        this._publicNextReqId = 1;
        
        // Connection state for public WebSocket
        this.publicConnectionState = 'disconnected';
        this.publicReconnectAttempts = 0;
        this.publicMaxReconnectAttempts = config.maxReconnectAttempts || 5;
        this.publicInitialReconnectDelayMs = config.initialReconnectDelayMs || 1000;
        this.publicCurrentReconnectDelayMs = this.publicInitialReconnectDelayMs;
        this.publicMaxReconnectDelayMs = config.maxReconnectDelayMs || 30000;
        this.publicReconnectTimer = null;
        this._isPublicManualDisconnect = false;
        this._publicConnectPromise = null;
        this._publicInitialConnectResolve = null;
        this._publicInitialConnectReject = null;
        this.lastPublicMessageTimestamp = 0;
        this.publicWsLivenessCheckInterval = null; // Added for liveness check
        this.publicWsLivenessCheckTimer = null; // Timer for scheduling liveness check start

        // Order book/Market data state
        this.orderBookDepth = config.orderBookDepth || DEFAULT_ORDER_BOOK_DEPTH;
        this.orderBook = {
            bids: new Map(), // Map for quick price lookups/updates
            asks: new Map()
        };

        // Track emitted orderFilled events to prevent duplicates
        this.emittedOrderFilledEvents = new Set();

        // Validate requirements
        if (!this.redisOrderManager) {
            const errMsg = 'RedisOrderManager is required but not provided in config.';
            this.logger.error(errMsg);
            throw new Error(errMsg);
        }
        if (!this.redisFillManager) {
            const errMsg = 'RedisFillManager is required but not provided in config.';
            this.logger.error(errMsg);
            throw new Error(errMsg);
        }

        if (!this.apiKey || !this.apiSecret) {
            this.logger.warn('[KrakenWebSocketV2ExchangeAdapter] API key and/or secret not provided. Authentication will fail.');
        }

        this.logger.info(`KrakenWebSocketV2ExchangeAdapter initialized for symbol ${this.symbol}. Session: ${this.sessionId}. Private URL: ${this.apiUrl}, Public URL: ${this.publicApiUrl}`);
    }

    // Add a utility to format pairs for public WS subscriptions if needed
    // For now, assume "BTC/USD" is acceptable by Kraken v2 public "instrument"
    _formatSymbolForPublicWsInstrument(symbol) {
        // Example: Kraken might expect "XBT/USD" for "BTC/USD" on some feeds
        // For v2 public book/trade, we are now testing if "BTC/USD" is fine with param "symbol"
        return symbol; 
    }

    /**
     * Safely emit orderFilled event with deduplication to prevent take-profit duplicates
     * @private
     * @param {string} orderId - The order ID that was filled
     * @param {Object} fillPayload - The fill event payload
     */
    _safeEmitOrderFilled(orderId, fillPayload) {
        // Create a unique key for this fill event
        const fillKey = `${orderId}-${fillPayload.timestamp || Date.now()}`;
        
        // Check if we've already emitted this fill event
        if (this.emittedOrderFilledEvents.has(fillKey)) {
            this.logger.warn(`[FILL_DEDUP] Skipping duplicate orderFilled event for order ${orderId}`, {
                orderId,
                fillKey,
                alreadyEmitted: true
            });
            return false;
        }
        
        // Add to our tracking set
        this.emittedOrderFilledEvents.add(fillKey);
        
        // Emit the event
        this.emit('orderFilled', fillPayload);
        
        this.logger.info(`[FILL_DEDUP] Successfully emitted orderFilled event for order ${orderId}`, {
            orderId,
            fillKey,
            isNewEvent: true
        });
        
        // Clean up old events to prevent memory leaks (keep last 1000)
        if (this.emittedOrderFilledEvents.size > 1000) {
            const eventsArray = Array.from(this.emittedOrderFilledEvents);
            const toDelete = eventsArray.slice(0, eventsArray.length - 500); // Keep newest 500
            toDelete.forEach(key => this.emittedOrderFilledEvents.delete(key));
            this.logger.debug(`[FILL_DEDUP] Cleaned up ${toDelete.length} old fill event keys`);
        }
        
        return true;
    }

    /**
     * Subscribes to order book data for the given symbols via Public WebSocket.
     * @param {string[]} symbols Array of trading symbols (e.g., ["BTC/USD"])
     * @public
     * @async
     */
    async subscribeToOrderBook(symbols) {
        if (!Array.isArray(symbols) || symbols.length === 0) {
            const errMsg = 'subscribeToOrderBook requires an array of symbols.';
            this.logger.error(errMsg);
            throw new Error(errMsg);
        }
        this.logger.info(`[Public WS] subscribeToOrderBook called for symbols: ${symbols.join(', ')}`);
        const subscriptions = symbols.map(symbol => {
            const formattedSymbol = this._formatSymbolForPublicWsInstrument(symbol);
            // Kraken public book channel seems to use "symbol" not "instrument"
            return this._subscribeToPublicChannel('book', {
                symbol: [formattedSymbol], 
                depth: this.orderBookDepth 
            }, symbol); 
        });
        await Promise.all(subscriptions);
    }

    /**
     * Subscribes to trade data for the given symbols via Public WebSocket.
     * @param {string[]} symbols Array of trading symbols (e.g., ["BTC/USD"])
     * @public
     * @async
     */
    async subscribeToTrades(symbols) {
        if (!Array.isArray(symbols) || symbols.length === 0) {
            const errMsg = 'subscribeToTrades requires an array of symbols.';
            this.logger.error(errMsg);
            throw new Error(errMsg);
        }
        this.logger.info(`[Public WS] subscribeToTrades called for symbols: ${symbols.join(', ')}`);
        const subscriptions = symbols.map(symbol => {
            const formattedSymbol = this._formatSymbolForPublicWsInstrument(symbol);
            // Corrected to use "symbol" as per Kraken v2 public API documentation for 'trade' channel
            return this._subscribeToPublicChannel('trade', {
                symbol: [formattedSymbol] 
            }, symbol); 
        });
        await Promise.all(subscriptions);
    }

    /**
     * Fetches a new WebSocket token from Kraken REST API
     * @private
     * @async
     * @returns {Promise<string>} The fetched token
     * @throws {Error} If API credentials are missing or the token fetch fails
     */
    async _fetchToken() {
        if (!this.apiKey || !this.apiSecret) {
            throw new Error('API key and secret are required to fetch WebSocket token');
        }

        if (this.paperMode) {
            this.logger.info('Paper Mode: Simulating WebSocket token fetch.');
            this.token = 'mock-paper-mode-token-xxxxxxxxxxxx';
            this.tokenExpiresAt = Date.now() + (3600 * 1000); // Mock token expires in 1 hour
            this.logger.info(`Paper Mode: Mock WebSocket token obtained. Expires in: 3600s (at ${new Date(this.tokenExpiresAt).toISOString()})`);
            this._scheduleTokenRenewal(); // Schedule renewal for the mock token
            return this.token;
        }

        try {
            this.logger.debug('Fetching new WebSocket token...');
            const response = await this._restClient.getWebSocketToken();
            
            if (!response || (!response.token && !response.result?.token)) {
                throw new Error(`Invalid token response: ${JSON.stringify(response)}`);
            }
            
            // Handle different response formats
            let token, expiresInSeconds;
            
            if (response.token && response.expires) {
                // Direct token/expires format
                token = response.token;
                expiresInSeconds = response.expires;
            } else if (response.result?.token && response.result?.expires_in) {
                // Nested result format
                token = response.result.token;
                expiresInSeconds = response.result.expires_in;
            } else {
                throw new Error(`Unrecognized token response format: ${JSON.stringify(response)}`);
            }
            
            this.token = token;
            this.tokenExpiresAt = Date.now() + (expiresInSeconds * 1000);
            
            this.logger.info(`[EXECUTIONS_DEBUG] Successfully obtained WebSocket token: ${token.substring(0, 10)}... Expires in: ${expiresInSeconds}s (at ${new Date(this.tokenExpiresAt).toISOString()})`);
            
            // Schedule token renewal
            this._scheduleTokenRenewal();
            
            return token;
        } catch (error) {
            this.logger.error('Error fetching WebSocket token:', error);
            this._scheduleTokenRenewal(true); // Schedule retry
            throw error;
        }
    }
    
    /**
     * Schedules a timer to renew the WebSocket token before it expires
     * @private
     * @param {boolean} [isRetry=false] Whether this is a retry attempt after failure
     */
    _scheduleTokenRenewal(isRetry = false) {
        // Clear any existing timer
        if (this.tokenRenewalTimer) {
            clearTimeout(this.tokenRenewalTimer);
            this.tokenRenewalTimer = null;
        }
        
        let delayMs;
        if (isRetry) {
            // Use retry delay for failed token fetch
            delayMs = this.tokenRetryDelaySeconds * 1000;
            this.logger.info(`Scheduling token fetch retry in ${this.tokenRetryDelaySeconds}s`);
        } else {
            // Schedule renewal before token expires
            const renewalTime = this.tokenExpiresAt - (this.tokenRenewalBufferSeconds * 1000);
            delayMs = Math.max(0, renewalTime - Date.now());
            this.logger.info(`Scheduling token renewal at ${new Date(renewalTime).toISOString()} (in ${Math.round(delayMs / 1000 / 60)} minutes)`);
        }
        
        this.tokenRenewalTimer = setTimeout(async () => {
            try {
                await this._fetchToken();
            } catch (error) {
                // Error handling is done in _fetchToken
            }
        }, delayMs);
    }

    /**
     * Updates the WebSocket API token with a new value
     * @public
     * @param {string} newToken The new token to use for WebSocket authentication
     * @returns {boolean} True if the token was updated, false otherwise
     */
    updateToken(newToken) {
        this.token = newToken;
        this.tokenExpiresAt = Date.now() + (3600 * 1000); // Update expiration time to 1 hour from now
        return true;
    }

    /**
     * Initializes Redis Backend API components needed by AdaptiveMarketMakerV2
     * @public
     * @async
     * @returns {Promise<boolean>} Resolves to true if initialization succeeds
     */
    async initializeRedisComponents() {
        if (this._redisComponentsInitialized) {
            this.logger.info('[KrakenWSv2Adapter] Redis components already initialized');
            return true;
        }

        this.logger.info('[KrakenWSv2Adapter] Initializing Redis components...');
        
        try {
            // Import KeyGenerator if not already available
            if (!this.keyGenerator) {
                const keyGenModule = await import('../../../../lib/redis-backend-api/utils/key-generator.js');
                const KeyGenerator = keyGenModule.KeyGenerator;
                this.keyGenerator = new KeyGenerator({
                    strategy: 'adaptive', // Default strategy
                    exchange: 'kraken',
                    symbol: this.symbol || 'BTC/USD', // Default if not provided
                    sessionId: this.sessionId
                });
                this.logger.info('[KrakenWSv2Adapter] Created new KeyGenerator internally');
            }
            
            // Import ValidationUtils if not already available
            if (!this.validationUtils) {
                const valUtilsModule = await import('../../../../lib/redis-backend-api/utils/validation-utils.js');
                const ValidationUtils = valUtilsModule.ValidationUtils;
                this.validationUtils = new ValidationUtils();
                this.logger.info('[KrakenWSv2Adapter] Created new ValidationUtils internally');
            }
            
            this._redisComponentsInitialized = true;
            this.logger.info('[KrakenWSv2Adapter] Redis components initialized successfully');
            return true;
        } catch (error) {
            this.logger.error('[KrakenWSv2Adapter] Failed to initialize Redis components:', error);
            return false;
        }
    }

    /**
     * Initiates connection to both private and public WebSocket endpoints
     * @public
     * @async
     * @returns {Promise<void>} Resolves when both connections are established
     * @throws {Error} If connection fails
     */
    async connect() {
        this.logger.info('[CONNECT_TRACE] connect() method entered.');
        
        // Initialize Redis components if needed
        await this.initializeRedisComponents();
        
        // Fetch initial token before connecting
        if (this.apiKey && this.apiSecret) {
            try {
                this.logger.info('[CONNECT_TRACE] Fetching initial WebSocket token...');
                await this._fetchToken();
            } catch (error) {
                this.logger.error('[CONNECT_TRACE] Failed to fetch initial token:', error);
                throw new Error(`Unable to fetch initial authentication token: ${error.message}`);
            }
        } else {
            this.logger.warn('[CONNECT_TRACE] No API credentials. Authentication will fail.');
        }
        
        // Start both connections in parallel
        const privatePromise = this._connectPrivate();
        const publicPromise = this._connectPublic();
        
        // Wait for both to connect or either to fail
        try {
            await Promise.all([privatePromise, publicPromise]);
            this.logger.info('Both private and public WebSocket connections established successfully.');
            
            // Emit 'connected' event once both WebSockets are connected
            this.emit('connected');
            this.logger.info('Emitted "connected" event after all connections established.');
            
            // Start monitoring connection
            this._monitorWebSocketConnection();
            
            return true;
        } catch (error) {
            this.logger.error('Failed to establish one or both WebSocket connections:', error);
            // If either fails, try to clean up both
            try {
                if (this.ws) {
                    this._isManualDisconnect = true;
                    this.ws.close();
                    this.ws = null;
                }
            } catch (e) {
                this.logger.error('Error cleaning up private WebSocket after connection failure:', e);
            }
            
            try {
                if (this.wsPublic) {
                    this._isPublicManualDisconnect = true;
                    this.wsPublic.close();
                    this.wsPublic = null;
                }
            } catch (e) {
                this.logger.error('Error cleaning up public WebSocket after connection failure:', e);
            }
            
            throw error;
        }
    }
    
    /**
     * Fetches balances from the exchange
     * @public
     * @async
     * @returns {Promise<Object>} Current balances
     */
    async fetchBalances() {
        this.logger.debug('[KrakenWSv2Adapter] fetchBalances called');
        
        if (this.paperMode) {
            // In paper mode, return simulated balances based on the symbol
            // Ensure symbol is defined before trying to split it
            let baseCurrency = 'BTC';
            let quoteCurrency = 'USD';
            
            if (this.symbol && typeof this.symbol === 'string' && this.symbol.includes('/')) {
                [baseCurrency, quoteCurrency] = this.symbol.split('/');
            } else {
                this.logger.warn('[KrakenWSv2Adapter] Symbol not defined or invalid:', this.symbol);
                // Fallback to default values
            }
            
            // CRITICAL: No hardcoded balances allowed - must use explicit budget
            let quoteCurrencyBalance = null;
            
            // DEBUG: Log budget values before checking
            this.logger.debug('[KWSA fetchBalances DEBUG] Budget check:', {
                thisInitialBudget: this.initialBudget,
                thisBudget: this.budget,
                parsedInitialBudget: this.initialBudget ? parseFloat(this.initialBudget) : null,
                parsedBudget: this.budget ? parseFloat(this.budget) : null,
                paperMode: this.paperMode,
                tradingMode: this.tradingMode
            });
            
            // Try to get budget from instance properties (stored from constructor config)
            if (this.initialBudget && parseFloat(this.initialBudget) > 0) {
                quoteCurrencyBalance = parseFloat(this.initialBudget);
                this.logger.info('[KrakenWSv2Adapter] Using explicit initial budget for paper trading', {
                    initialBudget: quoteCurrencyBalance,
                    source: 'this.initialBudget'
                });
            } else if (this.budget && parseFloat(this.budget) > 0) {
                quoteCurrencyBalance = parseFloat(this.budget);
                this.logger.info('[KrakenWSv2Adapter] Using explicit budget for paper trading', {
                    budget: quoteCurrencyBalance,
                    source: 'this.budget'
                });
            }
            
            // CRITICAL: Exit if no valid budget found - no defaults allowed
            if (!quoteCurrencyBalance || quoteCurrencyBalance <= 0) {
                const errorMessage = '[KrakenWSv2Adapter] CRITICAL: No valid budget found for paper trading balances. Cannot proceed without explicit budget.';
                this.logger.error(errorMessage, {
                    initialBudget: this.initialBudget,
                    budget: this.budget,
                    paperMode: this.paperMode,
                    symbol: this.symbol
                });
                console.error(errorMessage);
                process.exit(1); // Exit immediately - no trading without explicit budget
            }
            
            // CRITICAL FIX: Base currency balance must also be explicit, not hardcoded
            // For BUY-ONLY strategies, we don't need base currency - set to 0
            // For other strategies, this should come from configuration
            let baseCurrencyBalance = 0; // Default to 0 for BUY-ONLY strategies
            
            // Check if we have an explicit base currency balance configuration
            if (this.initialBaseCurrencyBalance && parseFloat(this.initialBaseCurrencyBalance) >= 0) {
                baseCurrencyBalance = parseFloat(this.initialBaseCurrencyBalance);
                this.logger.info('[KrakenWSv2Adapter] Using explicit base currency balance for paper trading', {
                    baseCurrency,
                    balance: baseCurrencyBalance,
                    source: 'this.initialBaseCurrencyBalance'
                });
            } else {
                this.logger.info('[KrakenWSv2Adapter] No base currency balance configured, using 0 (BUY-ONLY strategy)', {
                    baseCurrency,
                    balance: baseCurrencyBalance
                });
            }
            
            const paperBalances = {
                [baseCurrency]: { total: baseCurrencyBalance, available: baseCurrencyBalance, reserved: 0.0 },
                [quoteCurrency]: { total: quoteCurrencyBalance, available: quoteCurrencyBalance, reserved: 0.0 },
                timestamp: Date.now(), // Timestamp in milliseconds since epoch
                // Remove datetime field - standardize on numeric timestamps only
            };
            
            this.logger.info('[KrakenWSv2Adapter] Returning paper trading balances (NO HARDCODED DEFAULTS)', {
                paperBalances,
                budgetSource: this.initialBudget ? 'initialBudget' : 'budget',
                baseCurrencySource: this.initialBaseCurrencyBalance ? 'explicit' : 'default_zero_for_buy_only'
            });
            
            return paperBalances;
        } else {
            // Live trading: prioritize WebSocket balance data over REST API
            
            // 1. Check if we have recent WebSocket balance data (BEST OPTION - No rate limits!)
            const wsDataAge = Date.now() - this.wsBalanceLastUpdate;
            // Remove staleness check - balance data is valid until updated
            const WS_DATA_MAX_AGE = Infinity; // No expiration for WebSocket balance data
            
            if (this.wsBalanceCache && Object.keys(this.wsBalanceCache).length > 0 && wsDataAge < WS_DATA_MAX_AGE) {
                this.logger.info(`[BALANCE_WS] ✅ Using WebSocket balance data (age: ${Math.round(wsDataAge/1000)}s, currencies: ${Object.keys(this.wsBalanceCache).length}) - ZERO RATE LIMIT IMPACT`);
                
                // Convert WebSocket cache to standard format
                const standardizedBalances = {
                    timestamp: this.wsBalanceLastUpdate
                };
                
                Object.keys(this.wsBalanceCache).forEach(currency => {
                    // Clean up currency code (remove X/Z prefixes Kraken uses)
                    let cleanCurrency = currency;
                    if (currency.startsWith('X') || currency.startsWith('Z')) {
                        cleanCurrency = currency.substring(1);
                    }
                    // Convert XBT to BTC for consistency
                    if (cleanCurrency === 'XBT') {
                        cleanCurrency = 'BTC';
                    }
                    
                    standardizedBalances[cleanCurrency] = {
                        total: this.wsBalanceCache[currency].total,
                        available: this.wsBalanceCache[currency].available,
                        reserved: this.wsBalanceCache[currency].reserved,
                        source: 'websocket'
                    };
                });
                
                this.logger.debug('[BALANCE_WS] Returning WebSocket balance data:', {
                    currencies: Object.keys(standardizedBalances).filter(k => k !== 'timestamp').length,
                    dataAge: `${Math.round(wsDataAge/1000)}s`,
                    advantage: 'Zero rate limit impact!'
                });
                
                return standardizedBalances;
            }
            
            // In live mode, use balance ledger if available, otherwise fetch from Kraken REST API
            try {
                // 2. TRY BALANCE LEDGER SECOND (Rate Limit Optimization)
                if (this.balanceLedgerManager && this.balanceLedgerManager.isEnabled()) {
                    this.logger.debug('[KrakenWSv2Adapter] WebSocket data unavailable/stale, trying balance ledger for rate limit optimization');
                    
                    try {
                        const ledgerBalances = await this.balanceLedgerManager.getCurrentBalances();
                        
                        // Check if we have valid balance data from ledger
                        if (ledgerBalances && Object.keys(ledgerBalances).length > 0) {
                            // Transform ledger balances to our standardized format
                            const standardizedBalances = {};
                            
                            for (const [currency, amount] of Object.entries(ledgerBalances)) {
                                standardizedBalances[currency] = {
                                    total: parseFloat(amount),
                                    available: parseFloat(amount),
                                    reserved: 0,
                                    source: 'balance-ledger' // Indicate this came from ledger
                                };
                            }
                            
                            // Add timestamp
                            standardizedBalances.timestamp = Date.now();
                            
                            this.logger.info('[KrakenWSv2Adapter] ✅ Using cached balances from balance ledger (RATE LIMIT BYPASS)', {
                                currencies: Object.keys(standardizedBalances).filter(k => k !== 'timestamp').length,
                                performance: '~2ms vs 200ms API call'
                            });
                            
                            return standardizedBalances;
                        } else {
                            this.logger.warn('[KrakenWSv2Adapter] Balance ledger returned empty data, falling back to API');
                        }
                    } catch (ledgerError) {
                        this.logger.warn('[KrakenWSv2Adapter] Balance ledger failed, falling back to API:', ledgerError.message);
                    }
                }
                
                // 3. NO REST API FALLBACK - Return empty balance to prevent rate limits
                this.logger.warn('[KrakenWSv2Adapter] ⚠️  WebSocket and ledger unavailable - returning empty balance (REST API fallback disabled)');
                
                // Return empty balance structure
                const emptyBalances = {
                    timestamp: Date.now(),
                    source: 'unavailable'
                };
                
                this.logger.debug('[KrakenWSv2Adapter] Returning empty balance - WebSocket and ledger both unavailable', {
                    wsDataAge: wsDataAge ? `${Math.round(wsDataAge/1000)}s` : 'N/A',
                    note: 'REST API fallback disabled to prevent rate limits'
                });
                
                return emptyBalances;
            } catch (error) {
                this.logger.error('[KrakenWSv2Adapter] Error fetching balances', error);
                
                // LAST RESORT: Try balance ledger even on API error
                if (this.balanceLedgerManager && this.balanceLedgerManager.isEnabled()) {
                    try {
                        this.logger.warn('[KrakenWSv2Adapter] API failed, attempting balance ledger as last resort');
                        const ledgerBalances = await this.balanceLedgerManager.getCurrentBalances();
                        
                        if (ledgerBalances && Object.keys(ledgerBalances).length > 0) {
                            const standardizedBalances = {};
                            
                            for (const [currency, amount] of Object.entries(ledgerBalances)) {
                                standardizedBalances[currency] = {
                                    total: parseFloat(amount),
                                    available: parseFloat(amount),
                                    reserved: 0,
                                    source: 'balance-ledger-fallback'
                                };
                            }
                            
                            standardizedBalances.timestamp = Date.now();
                            
                            this.logger.warn('[KrakenWSv2Adapter] Using balance ledger as fallback after API error');
                            return standardizedBalances;
                        }
                    } catch (fallbackError) {
                        this.logger.error('[KrakenWSv2Adapter] Balance ledger fallback also failed:', fallbackError.message);
                    }
                }
                
                // Throw the error instead of returning empty balances
                // This allows the caller to handle the error appropriately
                throw error;
            }
        }
    }
    
    /**
     * Fetches positions from the exchange
     * @public
     * @async
     * @returns {Promise<Array>} Current positions
     */
    async fetchPositions() {
        this.logger.debug('[KrakenWSv2Adapter] fetchPositions called');
        
        // For spot trading, we typically don't have "positions" in the same way as futures
        // Return an empty array for both paper and live modes
        return [];
    }
    
    /**
     * Compatibility alias for fetchBalances()
     * @public
     * @async
     * @returns {Promise<Object>} Current balances
     */
    async getBalances() {
        return this.fetchBalances();
    }
    
    /**
     * Compatibility alias for fetchPositions()
     * @public
     * @async
     * @param {string} [symbol] - Optional symbol parameter (ignored for spot trading)
     * @returns {Promise<Array>} Current positions
     */
    async getPositions(symbol = null) {
        // Symbol parameter is ignored for spot trading compatibility
        return this.fetchPositions();
    }
    
    /**
     * Get current fee rates for the specified trading pair
     * @public
     * @async
     * @param {string} [pair] - Trading pair to get fees for (defaults to this.symbol)
     * @param {boolean} [forceRefresh=false] - Force refresh even if cache is valid
     * @returns {Promise<Object>} Fee rates object with maker and taker fees
     */
    async getCurrentFees(pair = null, forceRefresh = false) {
        const targetPair = pair || this.symbol;
        
        this.logger.debug('[KrakenWSv2Adapter] getCurrentFees called', { 
            pair: targetPair, 
            forceRefresh,
            paperMode: this.paperMode 
        });
        
        // In paper mode, return simulated fees
        if (this.paperMode) {
            const paperFees = {
                makerFee: 0.0025,  // 0.25% maker fee
                takerFee: 0.004,   // 0.4% taker fee
                volume: 0,         // No volume in paper mode
                currency: 'USD',
                pair: targetPair,
                source: 'paper_simulation',
                lastUpdated: Date.now()
            };
            
            this.logger.info('[KrakenWSv2Adapter] Returning simulated paper trading fees', paperFees);
            return paperFees;
        }
        
        // Check if we have valid cached fees
        const now = Date.now();
        const cacheAge = this.feeCache.lastUpdated ? now - this.feeCache.lastUpdated : Infinity;
        const cacheValid = cacheAge < this.feeRefreshIntervalMs;
        
        if (!forceRefresh && cacheValid && this.feeCache.makerFee !== null) {
            this.logger.debug('[KrakenWSv2Adapter] Returning cached fees', {
                cacheAge: Math.round(cacheAge / 1000),
                maxAge: Math.round(this.feeRefreshIntervalMs / 1000)
            });
            
            return {
                makerFee: this.feeCache.makerFee,
                takerFee: this.feeCache.takerFee,
                volume: this.feeCache.volume,
                currency: this.feeCache.currency,
                pair: targetPair,
                source: 'cache',
                lastUpdated: this.feeCache.lastUpdated
            };
        }
        
        // Fetch fresh fees from API
        try {
            this.logger.info('[KrakenWSv2Adapter] Fetching fresh fees from Kraken API');
            return await this.refreshFees(targetPair);
        } catch (error) {
            this.logger.error('[KrakenWSv2Adapter] Error fetching current fees, using fallback', {
                error: error.message,
                fallback: this.fallbackFees
            });
            
            // Return fallback fees
            return {
                makerFee: this.fallbackFees.maker,
                takerFee: this.fallbackFees.taker,
                volume: 0,
                currency: 'USD',
                pair: targetPair,
                source: 'fallback',
                lastUpdated: now
            };
        }
    }
    
    /**
     * Refresh fee rates by calling Kraken's getTradeVolume API
     * @private
     * @async
     * @param {string} [pair] - Trading pair to get fees for
     * @returns {Promise<Object>} Fresh fee rates
     */
    async refreshFees(pair = null) {
        const targetPair = pair || this.symbol;
        
        try {
            // Format pair for Kraken API (e.g., "BTC/USD" -> "XBTUSD")
            const krakenPair = this._formatPairForKraken(targetPair);
            
            this.logger.debug('[KrakenWSv2Adapter] Calling getTradeVolume API', {
                originalPair: targetPair,
                krakenPair: krakenPair
            });
            
            // Call Kraken's getTradeVolume endpoint
            const tradeVolumeResponse = await this._restClient.getTradeVolume({
                pair: krakenPair
            });
            
            if (!tradeVolumeResponse) {
                throw new Error('Empty response from getTradeVolume API');
            }
            
            this.logger.debug('[KrakenWSv2Adapter] Trade volume response received', {
                volume: tradeVolumeResponse.volume,
                currency: tradeVolumeResponse.currency,
                hasFees: !!tradeVolumeResponse.fees,
                hasFeesMaker: !!tradeVolumeResponse.fees_maker
            });
            
            // Extract fee rates
            let makerFee = null;
            let takerFee = null;
            
            // First check for pair-specific fees
            if (tradeVolumeResponse.fees && tradeVolumeResponse.fees[krakenPair]) {
                const pairFees = tradeVolumeResponse.fees[krakenPair];
                takerFee = parseFloat(pairFees.fee) / 100; // Convert percentage to decimal
                
                // Check for maker-specific fees
                if (tradeVolumeResponse.fees_maker && tradeVolumeResponse.fees_maker[krakenPair]) {
                    makerFee = parseFloat(tradeVolumeResponse.fees_maker[krakenPair].fee) / 100;
                } else {
                    // Use taker fee as fallback for maker fee
                    makerFee = takerFee;
                }
                
                this.logger.info('[KrakenWSv2Adapter] Found pair-specific fee rates', {
                    pair: krakenPair,
                    makerFee: makerFee,
                    takerFee: takerFee
                });
            }
            // Fallback to base tier fees if no pair-specific fees
            else if (tradeVolumeResponse.fees && Object.keys(tradeVolumeResponse.fees).length > 0) {
                const firstPair = Object.keys(tradeVolumeResponse.fees)[0];
                const baseFees = tradeVolumeResponse.fees[firstPair];
                takerFee = parseFloat(baseFees.fee) / 100;
                
                if (tradeVolumeResponse.fees_maker && tradeVolumeResponse.fees_maker[firstPair]) {
                    makerFee = parseFloat(tradeVolumeResponse.fees_maker[firstPair].fee) / 100;
                } else {
                    makerFee = takerFee;
                }
                
                this.logger.info('[KrakenWSv2Adapter] Using base tier fee rates', {
                    basePair: firstPair,
                    makerFee: makerFee,
                    takerFee: takerFee
                });
            } else {
                throw new Error('No fee information found in trade volume response');
            }
            
            // Update cache
            const now = Date.now();
            this.feeCache = {
                makerFee: makerFee,
                takerFee: takerFee,
                lastUpdated: now,
                volume: parseFloat(tradeVolumeResponse.volume || '0'),
                currency: tradeVolumeResponse.currency || 'USD',
                pairSpecificFees: new Map() // Reset pair-specific cache
            };
            
            // Store pair-specific fees if available
            if (tradeVolumeResponse.fees[krakenPair]) {
                this.feeCache.pairSpecificFees.set(krakenPair, {
                    makerFee: makerFee,
                    takerFee: takerFee,
                    lastUpdated: now
                });
            }
            
            this.logger.info('[KrakenWSv2Adapter] Fee cache updated successfully', {
                makerFee: makerFee,
                takerFee: takerFee,
                volume: this.feeCache.volume,
                currency: this.feeCache.currency
            });
            
            // Schedule next refresh
            this._scheduleFeeRefresh();
            
            return {
                makerFee: makerFee,
                takerFee: takerFee,
                volume: this.feeCache.volume,
                currency: this.feeCache.currency,
                pair: targetPair,
                source: 'api',
                lastUpdated: now
            };
            
        } catch (error) {
            this.logger.error('[KrakenWSv2Adapter] Error refreshing fees', {
                error: error.message,
                pair: targetPair
            });
            throw error;
        }
    }
    
    /**
     * Schedule automatic fee refresh
     * @private
     */
    _scheduleFeeRefresh() {
        // Clear existing timer
        if (this._feeRefreshTimer) {
            clearTimeout(this._feeRefreshTimer);
            this._feeRefreshTimer = null;
        }
        
        // Don't schedule refresh in paper mode
        if (this.paperMode) {
            return;
        }
        
        this.logger.debug('[KrakenWSv2Adapter] Scheduling next fee refresh', {
            intervalMs: this.feeRefreshIntervalMs,
            nextRefreshAt: new Date(Date.now() + this.feeRefreshIntervalMs).toISOString()
        });
        
        this._feeRefreshTimer = setTimeout(async () => {
            try {
                await this.refreshFees();
                this.logger.info('[KrakenWSv2Adapter] Scheduled fee refresh completed');
            } catch (error) {
                this.logger.error('[KrakenWSv2Adapter] Scheduled fee refresh failed', {
                    error: error.message
                });
                // Schedule retry with backoff
                setTimeout(() => {
                    this._scheduleFeeRefresh();
                }, 60000); // Retry in 1 minute
            }
        }, this.feeRefreshIntervalMs);
    }
    
    /**
     * Format trading pair for Kraken API
     * @private
     * @param {string} pair - Trading pair (e.g., "BTC/USD")
     * @returns {string} Kraken-formatted pair (e.g., "XBTUSD")
     */
    _formatPairForKraken(pair) {
        if (!pair || typeof pair !== 'string') {
            this.logger.warn('[KrakenWSv2Adapter] Invalid pair input for formatting', { pair });
            return pair;
        }
        
        // For WebSocket v2 API, keep the slash format (e.g., "BTC/USD", "ETH/USD")
        // Only convert BTC to XBT if needed, but keep the slash
        let formatted = pair.toUpperCase();
        
        // Convert BTC to XBT for Kraken if needed (but this may not be necessary for WS v2)
        // For now, let's keep the original format as shown in Kraken's documentation
        // if (formatted.startsWith('BTC/')) {
        //     formatted = formatted.replace('BTC/', 'XBT/');
        // }
        
        this.logger.debug('[KrakenWSv2Adapter] Formatted pair for Kraken WebSocket v2 API', {
            original: pair,
            formatted: formatted
        });
        
        return formatted;
    }

    /**
     * Get trade history from Kraken API with pagination support
     * 
     * This method fetches completed trades/fills from Kraken's TradesHistory endpoint
     * and is optimized for TradeLedgerManager to cache trade data in Redis.
     * 
     * @public
     * @async
     * @param {Object} [params={}] - Parameters for trade history query
     * @param {number} [params.start] - Starting timestamp in seconds (Unix timestamp)
     * @param {number} [params.end] - Ending timestamp in seconds (Unix timestamp)
     * @param {number} [params.ofs=0] - Offset for pagination (number of results to skip)
     * @param {string} [params.type='all'] - Trade type filter ('all', 'buy', 'sell')
     * @param {boolean} [params.trades=true] - Include trade details
     * @returns {Promise<Object>} Trade history response from Kraken API
     * @throws {Error} If API call fails or in paper mode without mock data
     */
    async getTradeHistory(params = {}) {
        this.logger.debug('[KrakenWSv2Adapter] Getting trade history', {
            params,
            paperMode: this.paperMode
        });
        
        // In paper mode, return mock trade data for testing
        if (this.paperMode) {
            this.logger.info('[KrakenWSv2Adapter] Returning mock trade history for paper mode');
            
            const mockTrades = {};
            const batchSize = 50; // Standard Kraken API limit
            const startTime = params.start || (Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60)); // Default to 7 days ago
            
            // Generate mock trades for TradeLedgerManager testing
            for (let i = 0; i < batchSize; i++) {
                const tradeId = `MOCK-TRADE-${startTime}-${i}`;
                const time = startTime + (i * 3600); // One hour between trades
                
                mockTrades[tradeId] = {
                    pair: this.symbol.replace('/', ''), // Format as ETHUSD, BTCUSD, etc.
                    time: time,
                    type: i % 2 === 0 ? 'buy' : 'sell',
                    ordertype: 'limit',
                    price: (2500 + (i * 10)).toFixed(2), // Mock price progression
                    cost: (25 + i).toFixed(2),
                    fee: '0.05',
                    vol: '0.01',
                    margin: '0.00',
                    misc: '',
                    trade_id: tradeId
                };
            }
            
            return {
                result: {
                    trades: mockTrades,
                    count: Object.keys(mockTrades).length
                }
            };
        }
        
        // Live mode - use Kraken REST API
        try {
            if (!this._restClient) {
                throw new Error('REST client not initialized for trade history fetching');
            }
            
            // Prepare API parameters according to Kraken TradesHistory API specification
            const apiParams = {
                type: params.type || 'all', // 'all', 'buy', 'sell', 'margin'
                trades: params.trades !== false, // Include trade details by default
            };
            
            // Add timestamp parameters if provided
            if (params.start) {
                apiParams.start = params.start;
            }
            if (params.end) {
                apiParams.end = params.end;
            }
            if (params.ofs) {
                apiParams.ofs = params.ofs;
            }
            
            this.logger.info('[KrakenWSv2Adapter] Calling Kraken TradesHistory API', {
                apiParams,
                expectedBatchSize: 50 // Kraken returns max 50 trades per call
            });
            
            // Call Kraken's TradesHistory endpoint
            const response = await this._restClient.getTradeHistory(apiParams);
            
            if (!response || !response.result) {
                throw new Error('Invalid response from Kraken TradesHistory API');
            }
            
            const trades = response.result.trades || {};
            const tradeCount = Object.keys(trades).length;
            
            this.logger.info('[KrakenWSv2Adapter] Trade history fetched successfully', {
                tradeCount,
                hasMore: tradeCount >= 50, // Kraken returns 50 max, so if we got 50, there might be more
                params: apiParams
            });
            
            return response;
            
        } catch (error) {
            this.logger.error('[KrakenWSv2Adapter] Failed to fetch trade history', {
                error: error.message,
                params,
                paperMode: this.paperMode
            });
            throw new Error(`Trade history fetch failed: ${error.message}`);
        }
    }
    
    /**
     * Disconnects from both private and public WebSocket endpoints
     * @public
     * @returns {void}
     */
    disconnect() {
        this.logger.info('Disconnecting both private and public WebSocket connections...');
        
        // Note: Paper trading fill simulation is now stopped by AdaptiveMarketMakerV2._cleanup()
        // This maintains separation of concerns where AMM manages high-level resources
        
        // Clear token renewal timer
        if (this.tokenRenewalTimer) {
            clearTimeout(this.tokenRenewalTimer);
            this.tokenRenewalTimer = null;
        }
        
        // Clear fee refresh timer
        if (this._feeRefreshTimer) {
            clearTimeout(this._feeRefreshTimer);
            this._feeRefreshTimer = null;
            this.logger.debug('[KrakenWSv2Adapter] Fee refresh timer cleared');
        }
        
        // Disconnect private connection
        this._disconnectPrivate();
        
        // Disconnect public connection
        this._disconnectPublic();
        
        // Clear liveness check interval
        if (this.publicWsLivenessCheckInterval) {
            clearInterval(this.publicWsLivenessCheckInterval);
            this.publicWsLivenessCheckInterval = null;
        }
    }
    
    /**
     * Stops the paper trading fill simulation if it's running
     * This method is called by AdaptiveMarketMakerV2._cleanup()
     * @public
     * @returns {void}
     */
    stopPaperTradingFillSimulation() {
        if (this.paperMode) {
            this._stopPaperTradingFillSimulation();
            this.logger.info('Paper trading fill simulation stopped by external caller');
        }
    }

    /**
     * Establishes connection to the private/authenticated WebSocket endpoint
     * @private
     * @async
     * @returns {Promise<void>} Resolves when connection is established
     * @throws {Error} If connection fails
     */
    async _connectPrivate() {
        this.logger.info(`[EXECUTIONS_DEBUG] _connectPrivate called. Current state: ${this.connectionState}`);
        
        if (this.connectionState === 'connected' || this.connectionState === 'connecting') {
            this.logger.info(`Private WebSocket connection attempt skipped, already ${this.connectionState}.`);
            return this._connectPromise || Promise.resolve();
        }

        this.connectionState = 'connecting';
        this.logger.info(`[EXECUTIONS_DEBUG] Private WebSocket connecting to ${this.apiUrl}... Paper mode: ${this.paperMode}`);

        this._connectPromise = new Promise((resolve, reject) => {
            this._initialConnectResolve = resolve;
            this._initialConnectReject = reject;

            if (this.paperMode) {
                this.logger.info('Paper Mode: Simulating private WebSocket connection.');
                // No actual WebSocket creation in paper mode
                // Directly call _onPrivateOpen to simulate connection and trigger subscriptions
                // _onPrivateOpen will set connectionState to 'connected' and resolve the promise.
                this._onPrivateOpen(); 
                return; // Important to return here to not execute real WebSocket logic
            }

            try {
                if (this.reconnectTimer) {
                    clearTimeout(this.reconnectTimer);
                    this.reconnectTimer = null;
                }

                this.logger.info(`[EXECUTIONS_DEBUG] Creating WebSocket to ${this.apiUrl}`);
                this.ws = new WebSocket(this.apiUrl);
                this.logger.info(`[EXECUTIONS_DEBUG] WebSocket created, setting up handlers`);
                
                // Set up event handlers
                this.ws.onopen = () => {
                    this.logger.info(`[EXECUTIONS_DEBUG] Private WebSocket onopen triggered`);
                    this._onPrivateOpen();
                };
                this.ws.onmessage = (event) => this._onPrivateMessage(event);
                this.ws.onerror = (error) => {
                    this.logger.error(`[EXECUTIONS_DEBUG] Private WebSocket error:`, error);
                    this._onPrivateError(error);
                };
                this.ws.onclose = (event) => {
                    this.logger.info(`[EXECUTIONS_DEBUG] Private WebSocket closed. Code: ${event.code}, Reason: ${event.reason}`);
                    this._onPrivateClose(event);
                };
                
            } catch (error) {
                this.logger.error('Private WebSocket connection instantiation failed:', error);
                this.connectionState = 'disconnected';
                if (this._initialConnectReject) {
                    this._initialConnectReject(error);
                    this._initialConnectResolve = null;
                    this._initialConnectReject = null;
                }
            }
        });
        
        return this._connectPromise;
    }
    
    /**
     * Establishes connection to the public WebSocket endpoint
     * @private
     * @async
     * @returns {Promise<void>} Resolves when connection is established
     * @throws {Error} If connection fails
     */
    async _connectPublic() {
        if (this.publicConnectionState === 'connected' || this.publicConnectionState === 'connecting') {
            this.logger.info(`Public WebSocket connection attempt skipped, already ${this.publicConnectionState}.`);
            return this._publicConnectPromise || Promise.resolve();
        }

        this.publicConnectionState = 'connecting';
        this.logger.info(`Public WebSocket connecting to ${this.publicApiUrl}... (PaperMode: ${this.paperMode})`); // Log paperMode status

        this._publicConnectPromise = new Promise((resolve, reject) => {
            this._publicInitialConnectResolve = resolve;
            this._publicInitialConnectReject = reject;

            try {
                if (this.publicReconnectTimer) {
                    clearTimeout(this.publicReconnectTimer);
                    this.publicReconnectTimer = null;
                }

                this.wsPublic = new WebSocket(this.publicApiUrl);
                
                // Set up event handlers
                this.wsPublic.onopen = () => this._onPublicOpen();
                this.wsPublic.onmessage = (event) => this._onPublicMessage(event);
                this.wsPublic.onerror = (error) => this._onPublicError(error);
                this.wsPublic.onclose = (event) => this._onPublicClose(event);
                
            } catch (error) {
                this.logger.error('Public WebSocket connection instantiation failed:', error);
                this.publicConnectionState = 'disconnected';
                if (this._publicInitialConnectReject) {
                    this._publicInitialConnectReject(error);
                    this._publicInitialConnectResolve = null;
                    this._publicInitialConnectReject = null;
                }
            }
        });
        
        return this._publicConnectPromise;
    }
    
    // Disconnect private WebSocket
    _disconnectPrivate() {
        this.logger.info('Private WebSocket disconnect requested.');
        this._isManualDisconnect = true;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        if (this.ws) {
            if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                this.connectionState = 'disconnecting';
                this.ws.close();
            } else {
                this.logger.info('Private WebSocket already closed or closing.');
                this._onPrivateClose({ code: 'MANUAL_DISCONNECT', reason: 'Disconnect called on non-open socket', wasClean: true });
            }
        } else {
            this.logger.info('No active private WebSocket instance to disconnect.');
            this.connectionState = 'disconnected';
            this._isManualDisconnect = false;
        }
    }
    
    // Disconnect public WebSocket
    _disconnectPublic() {
        this.logger.info('Public WebSocket disconnect requested.');
        this._isPublicManualDisconnect = true;

        if (this.publicReconnectTimer) {
            clearTimeout(this.publicReconnectTimer);
            this.publicReconnectTimer = null;
        }

        // Clear liveness check interval
        if (this.publicWsLivenessCheckInterval) {
            clearInterval(this.publicWsLivenessCheckInterval);
            this.publicWsLivenessCheckInterval = null;
        }
        
        if (this.wsPublic) {
            if (this.wsPublic.readyState === WebSocket.OPEN || this.wsPublic.readyState === WebSocket.CONNECTING) {
                this.publicConnectionState = 'disconnecting';
                this.wsPublic.close();
            } else {
                this.logger.info('Public WebSocket already closed or closing.');
                this._onPublicClose({ code: 'MANUAL_DISCONNECT', reason: 'Disconnect called on non-open socket', wasClean: true });
            }
        } else {
            this.logger.info('No active public WebSocket instance to disconnect.');
            this.publicConnectionState = 'disconnected';
            this._isPublicManualDisconnect = false;
        }
    }

    // Private WebSocket event handlers
    _onPrivateOpen() {
        this.logger.info('Private WebSocket connection opened. Authenticating and subscribing to channels...');
        this.logger.info(`[EXECUTIONS_DEBUG] Token available: ${!!this.token}, Paper mode: ${this.paperMode}`);

        // Set connection state to connected
        this.connectionState = 'connected';
        this.reconnectAttempts = 0; // Reset reconnect attempts on successful connection
        this.currentReconnectDelayMs = this.initialReconnectDelayMs; // Reset reconnect delay

        // Initialize WebSocket balance cache
        this.wsBalanceCache = {};
        this.wsBalanceLastUpdate = 0;

        // Resolve the initial connect promise
        if (this._initialConnectResolve) {
            this.logger.info('[CONNECT_TRACE] Resolving initial connect promise in _onPrivateOpen.');
            this._initialConnectResolve();
            this._initialConnectResolve = null;
            this._initialConnectReject = null;
        } else {
            this.logger.warn('[CONNECT_TRACE] _initialConnectResolve was null in _onPrivateOpen, could not resolve connect promise here.');
        }

        // Subscribe to essential private channels
        this.logger.info('Subscribing to essential channels...');
        (async () => {
            try {
                // Subscribe to executions channel
                const executionsChannel = 'executions';
                const executionsParams = { snap_trades: true, snap_orders: true, order_status: true };
                this.logger.info(`[EXECUTIONS_DEBUG] Attempting to subscribe to ${executionsChannel} with params:`, executionsParams);
                const executionsResult = await this._subscribeToChannel(executionsChannel, executionsParams, true); // Ensure auth for executions
                this.logger.info(`[EXECUTIONS_DEBUG] Subscription result for ${executionsChannel}:`, executionsResult);
                
                // Subscribe to balance channel to eliminate REST API calls
                if (!this.paperMode) {
                    this.logger.info('[BALANCE_WS] Subscribing to balance channel to eliminate REST API calls...');
                    try {
                        const balanceChannel = 'balances';
                        const balanceParams = { snapshot: true }; // Request initial snapshot
                        this.logger.info(`[BALANCE_WS] Attempting to subscribe to ${balanceChannel} with params:`, balanceParams);
                        const balanceResult = await this._subscribeToChannel(balanceChannel, balanceParams, true);
                        this.logger.info(`[BALANCE_WS] Successfully subscribed to balance channel:`, balanceResult);
                        this.logger.info('[BALANCE_WS] Balance updates will now be received via WebSocket, eliminating REST API rate limit issues');
                    } catch (balanceError) {
                        this.logger.warn('[BALANCE_WS] Failed to subscribe to balance channel, will fall back to REST API:', balanceError.message);
                        // Don't throw - balance subscription is optional, we can fall back to REST API
                    }
                } else {
                    this.logger.info('[BALANCE_WS] Paper mode - skipping balance channel subscription');
                }
                
                // Start the paper trading order fill simulator if in paper mode
                if (this.paperMode) {
                    this._startPaperTradingFillSimulation();
                    this.logger.info('[KrakenWSv2Adapter] Started paper trading fill simulation');
                }
            } catch (error) {
                this.logger.error(`[EXECUTIONS_DEBUG] Error subscribing to essential channels:`, error);
                this.logger.error(`[EXECUTIONS_DEBUG] Error stack:`, error.stack);
            }
        })();
    }
    
    /**
     * Starts the paper trading order fill simulation by periodically checking
     * for open orders and determining if they should be filled based on current market data
     * @private
     */
    _startPaperTradingFillSimulation() {
        // DISABLED: Legacy paper fill simulator is disabled in favor of centralized Paper Fill Simulator Service
        // The centralized service provides more accurate market-based fill logic
        this.logger.info('[Paper Fill Simulator] Legacy exchange adapter fill simulator is DISABLED');
        this.logger.info('[Paper Fill Simulator] Using centralized Paper Fill Simulator Service instead');
        return;
        
        // Original code commented out:
        /*
        if (!this.paperMode) {
            this.logger.info('[Paper Fill Simulator] Not in paper mode. Simulator not started.');
            return;
        }
        
        // Clear any existing fill simulation timer
        if (this._paperFillSimulationInterval) {
            clearInterval(this._paperFillSimulationInterval);
        }
        
        // Use custom interval from config if provided, otherwise default to 5000ms (5 seconds)
        const intervalMs = this.paperFillSimulationInterval || 5000;
        
        this.logger.info(`[Paper Fill Simulator] Starting order fill simulator for paper trading mode. Check interval: ${intervalMs}ms`);
        
        // Run the simulation checking at the configured interval
        this._paperFillSimulationInterval = setInterval(async () => {
            await this._simulatePaperTradingFills();
        }, intervalMs);
        */
    }
    
    /**
     * Stops the paper trading order fill simulation
     * @private
     */
    _stopPaperTradingFillSimulation() {
        if (this._paperFillSimulationInterval) {
            clearInterval(this._paperFillSimulationInterval);
            this._paperFillSimulationInterval = null;
            this.logger.info('[Paper Fill Simulator] Stopped order fill simulator for paper trading.');
        }
    }
    
    /**
     * Simulate a successful subscription for paper mode without requiring real authentication
     * @param {string} channelName - The channel name to simulate subscription for
     * @returns {Promise<object>} - A resolved promise with simulated subscription confirmation
     * @private
     */
    async _simulatePaperModeSubscription(channelName) {
        const reqId = this._nextReqId++;
        this.logger.info(`[Paper Mode] Simulating authenticated subscription to ${channelName} with req_id: ${reqId}`);
        
        // Create a simulated successful response
        const simulatedResponse = { 
            success: true, 
            channel: channelName, 
            req_id: reqId, 
            result: { 
                channel: channelName, 
                status: 'subscribed' 
            } 
        };
        
        // Add to active channels
        if (!this.activeChannels.has(channelName)) {
            this.activeChannels.add(channelName);
        }
        
        // Remove from pending subscriptions if it was there
        if (this._pendingSubscriptions && this._pendingSubscriptions.has(channelName)) {
            this._pendingSubscriptions.delete(channelName);
        }
        
        // Emit a simulated message for the message handler to process
        setTimeout(() => {
            this.emit('message', { data: JSON.stringify(simulatedResponse) });
        }, 50);
        
        return simulatedResponse.result;
    }
    
    /**
     * Simulates order fills for paper trading by checking current orders against market data
     * Only fills orders when they meet realistic market conditions
     * @private
     * @async
     */
    async _simulatePaperTradingFills() {
        if (!this.paperMode || !this.paperOrders || this.paperOrders.size === 0) {
            return;
        }

        this.logger.debug('[Paper Fill Simulator] Checking for orders to fill. Current open orders: ' + this.paperOrders.size);

        try {
            // Group orders by symbol
            const ordersBySymbol = new Map();

            // Group orders by symbol for batch processing
            for (const [orderId, paperOrder] of this.paperOrders.entries()) {
                // Normalize the status to lowercase for consistent comparison
                const orderStatus = (paperOrder.status || '').toLowerCase();

                // BUGFIX: Only process open orders - skip filled, cancelled, or any other status
                if (orderStatus !== 'open') {
                    this.logger.debug(`[Paper Fill Simulator] Skipping order ${orderId} with status: ${orderStatus}`);
                    continue;
                }
                
                // BUGFIX: Additional check - ensure order is not already fully filled
                const filledQty = parseFloat(paperOrder.filled_qty || 0);
                const orderQty = parseFloat(paperOrder.order_qty || 0);
                
                if (filledQty >= orderQty) {
                    this.logger.debug(`[Paper Fill Simulator] Skipping order ${orderId} - already fully filled (${filledQty}/${orderQty})`);
                    continue;
                }

                const symbol = paperOrder.symbol;
                if (!ordersBySymbol.has(symbol)) {
                    ordersBySymbol.set(symbol, []);
                }
                ordersBySymbol.get(symbol).push([orderId, paperOrder]);
            }
            
            // Process each symbol's orders
            for (const [symbol, orders] of ordersBySymbol.entries()) {
                // Get latest order book for this symbol
                let latestOrderBook = null;
                const orderBookForSymbol = this.orderBook[symbol];
                
                // Convert Map to arrays for easier use
                if (orderBookForSymbol) {
                    const bids = Array.from(orderBookForSymbol.bids.entries())
                        .map(([price, size]) => [parseFloat(price), size])
                        .sort((a, b) => b[0] - a[0]); // Bids sorted high to low
                    
                    const asks = Array.from(orderBookForSymbol.asks.entries())
                        .map(([price, size]) => [parseFloat(price), size])
                        .sort((a, b) => a[0] - b[0]); // Asks sorted low to high
                    
                    if (bids.length > 0 && asks.length > 0) {
                        latestOrderBook = {
                            bids,
                            asks,
                            timestamp: orderBookForSymbol.timestamp || Date.now()
                        };
                    }
                }
                
                // If we don't have a valid order book for this symbol, skip to next symbol
                if (!latestOrderBook || !latestOrderBook.bids || !latestOrderBook.asks || 
                    latestOrderBook.bids.length === 0 || latestOrderBook.asks.length === 0) {
                    this.logger.debug(`[Paper Fill Simulator] No valid order book data available for ${symbol}, skipping fill cycle`);
                    continue;
                }
                
                // Get best bid and ask prices
                const bestBid = parseFloat(latestOrderBook.bids[0][0]);
                const bestAsk = parseFloat(latestOrderBook.asks[0][0]);
                
                if (isNaN(bestBid) || isNaN(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
                    this.logger.debug(`[Paper Fill Simulator] Invalid bid/ask prices for ${symbol}, skipping fill cycle`);
                    continue;
                }
                
                this.logger.debug(`[Paper Fill Simulator] Current market prices for ${symbol}: bestBid=${bestBid}, bestAsk=${bestAsk}`);
                
                // Process all orders for this symbol
                for (const [orderId, paperOrder] of orders) {
                    const limitPrice = parseFloat(paperOrder.limit_price);
                    if (isNaN(limitPrice) || limitPrice <= 0) {
                        this.logger.warn(`[Paper Fill Simulator] Order ${orderId} has invalid limit price: ${paperOrder.limit_price}`);
                        continue;
                    }
                    
                    // Normalize side to lowercase for consistent comparison
                    const orderSide = paperOrder.side.toLowerCase();
                    
                    let shouldFill = false;
                    let fillPrice = 0;
                    
                    // Apply realistic fill conditions that match real market behavior
                    if (orderSide === 'buy') {
                        // For a buy limit order: Fill when the market ask price drops to or below the limit price
                        // This simulates the market moving favorably to the limit order
                        if (bestAsk <= limitPrice) {
                            shouldFill = true;
                            fillPrice = Math.min(limitPrice, bestAsk); // Fill at the better price
                            this.logger.info(`[Paper Fill Simulator] Buy order ${orderId} limit=${limitPrice} can fill because bestAsk=${bestAsk} dropped to/below limit price`);
                        }
                    } else if (orderSide === 'sell') {
                        // For a sell limit order: Fill when the market bid price rises to or above the limit price
                        // This simulates the market moving favorably to the limit order
                        if (bestBid >= limitPrice) {
                            shouldFill = true;
                            fillPrice = Math.max(limitPrice, bestBid); // Fill at the better price
                            this.logger.info(`[Paper Fill Simulator] Sell order ${orderId} limit=${limitPrice} can fill because bestBid=${bestBid} rose to/above limit price`);
                        }
                    }
                    
                    // If conditions are met, simulate a fill
                    if (shouldFill) {
                        this.logger.info(`[Paper Fill Simulator] Order ${orderId} (${orderSide}) meets market conditions for fill at ${fillPrice}. Will simulate fill.`);
                        await this._simulateOrderFill(orderId, paperOrder, fillPrice);
                    }
                }
            }
            
        } catch (error) {
            this.logger.error('[Paper Fill Simulator] Error in fill simulation:', error);
        }
    }
    
    /**
     * Simulates a fill for a paper trading order
     * @private
     * @async
     * @param {string} orderId - The ID of the order to fill
     * @param {Object} paperOrder - The paper order object
     * @param {number} fillPrice - The price at which to fill the order
     */
    async _simulateOrderFill(orderId, paperOrder, fillPrice) {
        try {
            // BUGFIX: Check if order is already filled to prevent duplicate fills
            const currentOrder = this.paperOrders.get(orderId);
            if (!currentOrder) {
                this.logger.warn(`[Paper Fill Simulator] Order ${orderId} not found in paperOrders - skipping fill`);
                return;
            }
            
            const orderStatus = (currentOrder.status || '').toLowerCase();
            if (orderStatus !== 'open') {
                this.logger.warn(`[Paper Fill Simulator] Order ${orderId} status is '${orderStatus}' - skipping fill to prevent duplicate`);
                return;
            }
            
            const filledQty = parseFloat(currentOrder.filled_qty || 0);
            const orderQty = parseFloat(currentOrder.order_qty || 0);
            
            if (filledQty >= orderQty) {
                this.logger.warn(`[Paper Fill Simulator] Order ${orderId} already fully filled (${filledQty}/${orderQty}) - skipping fill`);
                return;
            }
            
            // Generate a unique fill ID
            const fillId = `paper-fill-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
            
            // Create a fill size (we'll fill the entire order for simplicity)
            // In a more sophisticated simulation we could do partial fills
            const fillSize = paperOrder.order_qty - paperOrder.filled_qty;
            
            // Create timestamp for fill
            const fillTimestamp = Date.now(); // Timestamp in milliseconds since epoch
            
            // Create a fill object
            const fill = {
                id: fillId,
                orderId: orderId,
                clientOrderId: paperOrder.cl_ord_id,
                symbol: paperOrder.symbol,
                side: paperOrder.side,
                price: fillPrice,
                size: fillSize, // Standardize on size
                amount: fillSize, // Include amount for compatibility with different code paths
                timestamp: fillTimestamp, // Timestamp in milliseconds since epoch
                lastUpdated: fillTimestamp, // Add lastUpdated field to match backend API
                fee: { 
                    amount: fillSize * fillPrice * 0.0026, // Simulated 0.26% fee
                    currency: paperOrder.symbol.split('/')[1], // Fee in quote currency
                    rate: 0.0026 
                },
                sessionId: this.sessionId
            };
            
            // Update the paper order
            const updatedOrder = {
                ...paperOrder,
                filled_qty: paperOrder.order_qty,
                status: 'filled'
            };
            this.paperOrders.set(orderId, updatedOrder);
            
            // Standardized order object for the system
            const standardizedOrder = {
                id: orderId,
                clientOrderId: paperOrder.cl_ord_id,
                symbol: paperOrder.symbol,
                side: paperOrder.side.toLowerCase(), // Ensure side is lowercase
                type: 'limit',
                price: paperOrder.limit_price,
                size: paperOrder.order_qty, // Standardize on size
                amount: paperOrder.order_qty, // Include amount for compatibility
                filled: paperOrder.order_qty, // Fully filled
                remaining: 0,
                status: 'FILLED', // Use uppercase status to match AMM expectations
                timestamp: fillTimestamp, // Same timestamp as fill
                lastUpdated: fillTimestamp, // Add lastUpdated field to match backend API
                lastFillTimestamp: fillTimestamp, // Timestamp in milliseconds since epoch
                sessionId: this.sessionId,
                parentOrderId: paperOrder.parentOrderId, // Preserve parentOrderId
                purpose: paperOrder.purpose, // Preserve purpose
                pricingMetadata: paperOrder.pricingMetadata // Preserve pricing metadata
            };
            
            // Save fill to Redis
            if (this.redisFillManager && typeof this.redisFillManager.add === 'function') {
                await this.redisFillManager.add(fill);
                this.logger.info(`[Paper Fill Simulator] Fill ${fillId} for order ${orderId} saved to RedisFillManager`);
            }
            
            // Update order in Redis
            if (this.redisOrderManager && typeof this.redisOrderManager.update === 'function') {
                await this.redisOrderManager.update(standardizedOrder);
                this.logger.info(`[Paper Fill Simulator] Order ${orderId} updated to filled status in RedisOrderManager`);
            }
            
            // Emit filled event with both fill data and updated order in the expected format
            // This is the format expected by AdaptiveMarketMakerV2._handleOrderFilled
            this.emit('orderFilled', {
                fillData: fill,
                updatedOrder: standardizedOrder
            });
            
            // Emit order status change
            this.emit('orderUpdate', standardizedOrder);
            
            // Emit individual fill event
            this.emit('fill', fill);
            
            this.logger.info(`[Paper Fill Simulator] Successfully simulated fill for order ${orderId} at price ${fillPrice}`);
            
        } catch (error) {
            this.logger.error(`[Paper Fill Simulator] Error simulating fill for order ${orderId}:`, error);
        }
    }

    _onPrivateMessage(event) {
        try {
            // Update last message timestamp for liveness check
            this.lastPrivateMessageTimestamp = Date.now();
            
            // ADD WEBSOCKET MESSAGE TRACKING
            if (typeof event.data === 'string' && event.data.includes('executions')) {
                const currentTime = new Date().toISOString();
                this.logger.info(`[WEBSOCKET_MONITOR] [${currentTime}] Received private executions channel message`);
            }

            // Process the message
            const message = JSON.parse(event.data);
            
            // For executions channel - add improved logging
            if (message.channel === 'executions') {
                const currentTime = new Date().toISOString();
                this.logger.info(`[WEBSOCKET_MONITOR] [${currentTime}] Processing executions channel message`);
            }
            
            this._handlePrivateMessage(message);
        } catch (error) {
            this.logger.error('Error handling private message:', error, event.data);
        }
    }

    _handlePrivateMessage(message) {
        this.logger.debug(`[EXECUTIONS_DEBUG] _handlePrivateMessage received:`, JSON.stringify(message));
        
        // Emit raw message for monitoring purposes
        this.emit('message', message);
        
        // 1. Handle direct responses to requests via req_id
        if (message.req_id && this.subscriptions.has(message.req_id)) {
            const sub = this.subscriptions.get(message.req_id);
            clearTimeout(sub.timeout); // Clear the timeout associated with this request

            // Check for success:
            // - Explicit `success: true` (common for subscriptions)
            // - `status: 'ok'` (common for action acknowledgements like add_order, cancel_order in paper mode and potentially real API)
            if (message.success === true || message.status === 'ok') {
                this.logger.debug(`Request successful (req_id: ${message.req_id}, method: ${sub.payload.method || message.method}):`, message.result || message);
                sub.resolve(message.result || message); // Resolve with result or full message if no result field
            } else {
                const errorMsg = `Request failed (req_id: ${message.req_id}, method: ${sub.payload.method || message.method}): ${message.error || message.message || 'Unknown error'}`;
                this.logger.error(errorMsg, message);
                sub.reject(new Error(errorMsg));
            }
            this.subscriptions.delete(message.req_id);
            return; // Handled as a direct response
        }
        
        // Also emit response event for methods that use _waitForResponse (like cancelOrder)
        if (message.req_id) {
            this.emit('response', message);
        }

        // 2. Handle subscription status updates
        if (message.method === 'subscribe' && message.success === true && message.result && message.result.channel) {
            const channelName = message.result.channel;
            if (!this.activeChannels.has(channelName)) {
                this.activeChannels.add(channelName);
                this.logger.info(`Successfully subscribed to channel: ${channelName}. Total active: ${this.activeChannels.size}`);
            }
            
            // Remove from pending subscriptions
            if (this._pendingSubscriptions.has(channelName)) {
                this.logger.info(`[SUB_DEBUG] Removed ${channelName} from _pendingSubscriptions. Current: ${[...this._pendingSubscriptions]}`);
                this._pendingSubscriptions.delete(channelName);
            }
            return;
        }

        if (message.method === 'unsubscribe' && message.success === true && message.result && message.result.channel) {
            const channelName = message.result.channel;
            if (this.activeChannels.has(channelName)) {
                this.activeChannels.delete(channelName);
                this.logger.info(`Successfully unsubscribed from channel: ${channelName}. Active channels:`, Array.from(this.activeChannels));
            }
            return;
        }
        
        // 3. Handle channel data (e.g., executions, balances)
        if (message.channel) {
            switch (message.channel) {
                case 'executions':
                    this._handleExecutionReport(message);
                    break;
                case 'balances':
                    this._handleBalanceUpdate(message);
                    break;
                case 'status': // Handle system status messages
                    if (message.data && Array.isArray(message.data) && message.data.length > 0) {
                        const statusUpdate = message.data[0];
                        this.logger.info('Received Kraken system status update:', statusUpdate);
                        this.emit('statusUpdate', statusUpdate); // Emit for external listeners
                        // Example: { api_version: 'v2', connection_id: ..., system: 'online', version: '...' }
                        if (statusUpdate.system !== 'online') {
                            this.logger.warn(`Kraken system status is NOT online: ${statusUpdate.system}`);
                        }
                    }
                    break;
                default:
                    this.logger.warn(`Received message for unhandled data channel: ${message.channel}`, message);
            }
            return;
        }

        // 4. Handle other message types (e.g., heartbeats, system status)
        if (message.method === 'heartbeat') {
            // Respond with heartbeat response if needed
            return;
        }
        
        if (message.method === 'ping') {
            this.logger.debug('Received ping from Kraken (v2 format). Sending pong...');
            try {
                this.ws.send(JSON.stringify({ method: 'pong', req_id: message.req_id }));
            } catch (err) {
                this.logger.error('Failed to send pong (v2 format):', err);
            }
            return;
        }

        this.logger.warn('Received unhandled Private WebSocket message:', message);
    }

    _handleBalanceUpdate(message) {
        this.logger.debug(`[BALANCE_WS] Received balance update:`, message);
        
        if (!message.data || !Array.isArray(message.data)) {
            this.logger.warn('[BALANCE_WS] Invalid balance update message format:', message);
            return;
        }

        try {
            // Handle both snapshot and update types
            const updateType = message.type || 'unknown';
            this.logger.info(`[BALANCE_WS] Processing balance ${updateType} with ${message.data.length} entries`);

            // Update our WebSocket balance cache
            message.data.forEach(balanceData => {
                if (updateType === 'snapshot') {
                    // Snapshot: full balance data with wallets array
                    const asset = balanceData.asset;
                    const totalBalance = parseFloat(balanceData.balance || 0);
                    
                    // For snapshot, we get wallet details - calculate available balance
                    let availableBalance = 0;
                    if (balanceData.wallets && Array.isArray(balanceData.wallets)) {
                        // Sum up spot main wallet balances (available for trading)
                        availableBalance = balanceData.wallets
                            .filter(wallet => wallet.type === 'spot' && wallet.id === 'main')
                            .reduce((sum, wallet) => sum + parseFloat(wallet.balance || 0), 0);
                    } else {
                        // Fallback: assume total balance is available
                        availableBalance = totalBalance;
                    }

                    this.wsBalanceCache[asset] = {
                        total: totalBalance,
                        available: availableBalance,
                        reserved: Math.max(0, totalBalance - availableBalance),
                        source: 'websocket-snapshot',
                        lastUpdate: Date.now()
                    };
                    
                    this.logger.debug(`[BALANCE_WS] Updated ${asset} balance from snapshot:`, this.wsBalanceCache[asset]);
                } else if (updateType === 'update') {
                    // Update: incremental balance change from transaction
                    const asset = balanceData.asset;
                    const newBalance = parseFloat(balanceData.balance || 0);
                    const amount = parseFloat(balanceData.amount || 0);
                    
                    // Update the cached balance
                    if (!this.wsBalanceCache[asset]) {
                        this.wsBalanceCache[asset] = {
                            total: newBalance,
                            available: newBalance, // Assume available until we get more specific data
                            reserved: 0,
                            source: 'websocket-update',
                            lastUpdate: Date.now()
                        };
                    } else {
                        this.wsBalanceCache[asset].total = newBalance;
                        this.wsBalanceCache[asset].available = newBalance; // Update assumption
                        this.wsBalanceCache[asset].lastUpdate = Date.now();
                    }
                    
                    this.logger.info(`[BALANCE_WS] ${asset} balance updated: ${amount >= 0 ? '+' : ''}${amount} → ${newBalance} (${balanceData.type})`);
                }
            });

            // Update the global timestamp
            this.wsBalanceLastUpdate = Date.now();
            
            // Update balance ledger if available
            if (this.balanceLedger) {
                try {
                    // Convert our WebSocket cache to the format expected by balance ledger
                    const ledgerUpdate = {
                        timestamp: this.wsBalanceLastUpdate,
                        balances: {},
                        source: 'websocket'
                    };
                    
                    Object.keys(this.wsBalanceCache).forEach(currency => {
                        const wsBalance = this.wsBalanceCache[currency];
                        ledgerUpdate.balances[currency] = {
                            total: wsBalance.total,
                            available: wsBalance.available,
                            reserved: wsBalance.reserved
                        };
                    });
                    
                    // Update the ledger asynchronously (don't wait for it)
                    this.balanceLedger.updateFromWebSocket(ledgerUpdate).catch(error => {
                        this.logger.warn('[BALANCE_WS] Failed to update balance ledger from WebSocket:', error.message);
                    });
                    
                } catch (ledgerError) {
                    this.logger.warn('[BALANCE_WS] Error updating balance ledger:', ledgerError.message);
                }
            }

            this.logger.info(`[BALANCE_WS] Balance cache updated successfully. Cached currencies: ${Object.keys(this.wsBalanceCache).join(', ')}`);
            
            // CRITICAL FIX: Emit balancesUpdated event to notify AdaptiveMarketMakerV2
            // Convert WebSocket cache to standardized format expected by AMM
            const standardizedBalances = {};
            Object.keys(this.wsBalanceCache).forEach(currency => {
                const wsBalance = this.wsBalanceCache[currency];
                standardizedBalances[currency] = {
                    total: wsBalance.total,
                    available: wsBalance.available,
                    reserved: wsBalance.reserved
                };
            });
            
            // Add timestamp for tracking
            standardizedBalances.timestamp = this.wsBalanceLastUpdate;
            
            this.logger.info(`[BALANCE_WS] Emitting balancesUpdated event with ${Object.keys(standardizedBalances).length - 1} currencies`);
            this.emit('balancesUpdated', standardizedBalances);
            
        } catch (error) {
            this.logger.error('[BALANCE_WS] Error processing balance update:', error);
        }
    }

    _handleExecutionReport(message) {
        this.logger.info(`[EXECUTIONS_DEBUG] _handleExecutionReport called with message:`, JSON.stringify(message));
        this.logger.debug(`Received executions channel data. Count: ${message.data ? message.data.length : 0}`);
        
        // ADD ENHANCED WEBSOCKET TRADE MONITORING
        const currentTime = new Date().toISOString();
        this.logger.info(`[WEBSOCKET_MONITOR] [${currentTime}] Received WebSocket execution report with ${message.data ? message.data.length : 0} items.`);
        
        if (Array.isArray(message.data)) {
            message.data.forEach(async (executionReport) => {
                // ADD DETAILED EXECUTION REPORT LOGGING
                const execType = executionReport.exec_type || 'unknown';
                const orderId = executionReport.order_id || 'unknown';
                const symbol = executionReport.symbol || 'unknown';
                const tradeId = executionReport.trade_id || 'none';
                
                this.logger.info(`[WEBSOCKET_MONITOR] [${currentTime}] Execution report: type=${execType}, orderId=${orderId}, symbol=${symbol}, tradeId=${tradeId}`);
                
                if (execType === 'trade') {
                    this.logger.info(`[WEBSOCKET_FILL] [${currentTime}] 💰 TRADE FILL NOTIFICATION RECEIVED for order ${orderId}`, {
                        symbol: symbol,
                        tradeId: tradeId,
                        price: executionReport.price,
                        quantity: executionReport.qty,
                        side: executionReport.side,
                        timestamp: executionReport.timestamp || currentTime
                    });
                }
                
                this.logger.info(`[EXECUTIONS_DEBUG] Processing execution report:`, JSON.stringify(executionReport));
                try {
                    let standardizedItem; 
                    let isFill = false;

                    // LIVE FILL DETECTION FIX - Process trade executions immediately
                // Process 'trade' exec_type as immediate fills (this is the actual fill notification)
                if (executionReport.exec_type === 'trade') {
                    this.logger.info(`[LIVE_FILL_FIX] Processing immediate trade execution for ${executionReport.symbol} order ${executionReport.order_id}`);
                    
                    // Only process fills for our trading symbol
                    if (executionReport.symbol && executionReport.symbol !== this.symbol) {
                        this.logger.debug(`[LIVE_FILL_FIX] Skipping fill for different symbol: ${executionReport.symbol} (our symbol: ${this.symbol})`);
                        return;
                    }
                    
                    // Transform the trade execution into a fill record immediately
                    standardizedItem = await this._transformKrakenFill(executionReport);
                    isFill = true;
                    
                    if (!standardizedItem) {
                        this.logger.warn('[LIVE_FILL_FIX] Failed to transform Kraken trade execution, skipping.', executionReport);
                        return; 
                    }
                    
                    this.logger.info(`[LIVE_FILL_FIX] Successfully created fill record from trade execution: ${standardizedItem.id}`);
                } 
                // Process 'filled' exec_type as order status updates (final status notification)
                else if (executionReport.exec_type === 'filled') {
                    this.logger.info(`[LIVE_FILL_FIX] Processing filled status update for ${executionReport.symbol} order ${executionReport.order_id}`);
                    
                    // For filled status updates, we still need to update order status but fills should already exist
                    standardizedItem = await this._transformKrakenOrder(executionReport);
                    if (!standardizedItem) {
                        this.logger.warn('[LIVE_FILL_FIX] Failed to transform Kraken filled status update, skipping.', executionReport);
                        return; 
                    }
                    
                    // Force status to FILLED for filled exec_type
                    standardizedItem.status = 'FILLED';
                    this.logger.info(`[LIVE_FILL_FIX] Order status updated to FILLED: ${standardizedItem.id}`);
                    
                    // Mark this as an order update that needs orderFilled event emission
                    isFilledStatusUpdate = true;
                }
                // Legacy handling for any other exec_types that might contain fill information
                else if (executionReport.exec_type === 'trade' || executionReport.exec_type === 'filled') {
                        this.logger.info(`[EXECUTIONS_DEBUG] Processing ${executionReport.exec_type} execution for ${executionReport.symbol} order ${executionReport.order_id}`);
                        
                        // Only process fills for our trading symbol
                        if (executionReport.symbol && executionReport.symbol !== this.symbol) {
                            this.logger.debug(`[EXECUTIONS_DEBUG] Skipping fill for different symbol: ${executionReport.symbol} (our symbol: ${this.symbol})`);
                            return;
                        }
                        
                        // For 'filled' exec_type reports, we need to get the side from the original order
                        if (executionReport.exec_type === 'filled' && !executionReport.side) {
                            this.logger.info(`[EXECUTIONS_DEBUG] 'filled' exec_type without side field, looking up original order`);
                            
                            // Try to get the original order to get the side
                            let originalOrder = null;
                            if (this.redisOrderManager && executionReport.cl_ord_id) {
                                try {
                                    originalOrder = await this.redisOrderManager.getById(executionReport.cl_ord_id);
                                    if (originalOrder) {
                                        this.logger.info(`[EXECUTIONS_DEBUG] Found original order with side: ${originalOrder.side}`);
                                        executionReport.side = originalOrder.side; // Add side to the execution report
                                    }
                                } catch (error) {
                                    this.logger.error(`[EXECUTIONS_DEBUG] Error looking up original order ${executionReport.cl_ord_id}:`, error);
                                }
                            }
                            
                            // If we still don't have side, try to look up the original order from in-memory storage first, then Redis
                            if (!executionReport.side && this.redisOrderManager && executionReport.order_id) {
                                try {
                                    const clientOrderId = await this.redisOrderManager.getClientOrderIdByExchange(executionReport.order_id);
                                    if (clientOrderId) {
                                        originalOrder = await this.redisOrderManager.getById(clientOrderId);
                                        if (originalOrder) {
                                            this.logger.info(`[EXECUTIONS_DEBUG] Found original order via exchange mapping with side: ${originalOrder.side}`);
                                            executionReport.side = originalOrder.side;
                                        }
                                    }
                                } catch (error) {
                                    this.logger.error(`[EXECUTIONS_DEBUG] Error looking up order via exchange mapping:`, error);
                                }
                            }
                        }
                        
                        standardizedItem = await this._transformKrakenFill(executionReport);
                        isFill = true;
                        if (!standardizedItem) {
                            this.logger.warn('[_handleExecutionReport] Failed to transform Kraken fill, skipping.', executionReport);
                            return; 
                        }
                    } 
                    // Process 'canceled', 'new', 'pending_new', etc. as order status updates
                    else if (executionReport.exec_type === 'canceled' || executionReport.exec_type === 'new' || 
                             executionReport.exec_type === 'pending_new' || executionReport.exec_type === 'replaced' ||
                             executionReport.exec_type === 'rejected') {
                        this.logger.info(`[EXECUTIONS_DEBUG] Processing ${executionReport.exec_type} execution for order ${executionReport.order_id}`);
                        
                        standardizedItem = await this._transformKrakenOrder(executionReport);
                        if (!standardizedItem) {
                            this.logger.warn('[_handleExecutionReport] Failed to transform Kraken order update, skipping.', executionReport);
                            return; 
                        }
                    }
                    // Skip unknown exec_types
                    else {
                        this.logger.debug(`[EXECUTIONS_DEBUG] Skipping unknown exec_type: ${executionReport.exec_type}`);
                        return;
                    }

                    if (isFill) {
                        const fillData = standardizedItem;
                        
                        // ROBUST ORDER LOOKUP: Try multiple strategies to find the order
                        let associatedOrderInCurrentSession = null;
                        const exchangeOrderId = fillData.orderId;
                        const clientOrderId = executionReport.cl_ord_id;
                        
                        this.logger.info(`[EXECUTIONS_DEBUG] Looking up order for fill. Exchange ID: ${exchangeOrderId}, Client ID: ${clientOrderId}, Symbol: ${executionReport.symbol}, Session: ${this.sessionId}`);
                        
                        if (this.redisOrderManager) {
                            // STRATEGY 1: Direct lookup by client order ID (our internal ID)
                            if (clientOrderId) {
                                this.logger.info(`[EXECUTIONS_DEBUG] Strategy 1: Direct client ID lookup: ${clientOrderId}`);
                                try {
                                    associatedOrderInCurrentSession = await this.redisOrderManager.getById(clientOrderId);
                                    this.logger.info(`[EXECUTIONS_DEBUG] Strategy 1 result:`, {
                                        clientId: clientOrderId,
                                        orderFound: !!associatedOrderInCurrentSession,
                                        orderSessionId: associatedOrderInCurrentSession?.sessionId,
                                        currentSessionId: this.sessionId
                                    });
                                } catch (error) {
                                    this.logger.warn(`[EXECUTIONS_DEBUG] Strategy 1 failed: ${error.message}`);
                                }
                            }
                            
                            // STRATEGY 2: Fallback to exchange order ID lookup for reconciliation
                            if (!associatedOrderInCurrentSession && exchangeOrderId) {
                                this.logger.info(`[EXECUTIONS_DEBUG] Strategy 2: Exchange ID lookup for reconciliation: ${exchangeOrderId}`);
                                try {
                                    // Use exchange order ID mapping if available
                                    const mappedClientOrderId = this.exchangeOrderIdMap?.get(exchangeOrderId);
                                    if (mappedClientOrderId) {
                                        associatedOrderInCurrentSession = await this.redisOrderManager.getById(mappedClientOrderId);
                                        this.logger.info(`[EXECUTIONS_DEBUG] Strategy 2 result via mapping:`, {
                                            exchangeId: exchangeOrderId,
                                            mappedClientId: mappedClientOrderId,
                                            orderFound: !!associatedOrderInCurrentSession
                                        });
                                    }
                                } catch (error) {
                                    this.logger.warn(`[EXECUTIONS_DEBUG] Strategy 2 failed: ${error.message}`);
                                }
                            }
                            
                            // STRATEGY 2: Exchange mapping lookup (fallback for client ID based orders)
                            if (!associatedOrderInCurrentSession && typeof this.redisOrderManager.getClientOrderIdByExchange === 'function') {
                                this.logger.info(`[EXECUTIONS_DEBUG] Strategy 2: Exchange mapping lookup for: ${exchangeOrderId}`);
                                try {
                                    const clientOrderId = await this.redisOrderManager.getClientOrderIdByExchange(exchangeOrderId);
                                    this.logger.info(`[EXECUTIONS_DEBUG] Strategy 2 mapping result: ${exchangeOrderId} -> ${clientOrderId || 'NOT FOUND'}`);
                                    
                                    if (clientOrderId) {
                                        associatedOrderInCurrentSession = await this.redisOrderManager.getById(clientOrderId);
                                        this.logger.info(`[EXECUTIONS_DEBUG] Strategy 2 order lookup result:`, {
                                            clientOrderId,
                                            orderFound: !!associatedOrderInCurrentSession,
                                            orderSessionId: associatedOrderInCurrentSession?.sessionId,
                                            currentSessionId: this.sessionId
                                        });
                                    }
                                } catch (error) {
                                    this.logger.warn(`[EXECUTIONS_DEBUG] Strategy 2 failed: ${error.message}`);
                                }
                            }
                            
                            // STRATEGY 3: Search all orders by exchangeOrderId field (comprehensive fallback)
                            if (!associatedOrderInCurrentSession && typeof this.redisOrderManager.getAll === 'function') {
                                this.logger.info(`[EXECUTIONS_DEBUG] Strategy 3: Searching all orders for exchangeOrderId: ${exchangeOrderId}`);
                                try {
                                    const allOrders = await this.redisOrderManager.getAll();
                                    associatedOrderInCurrentSession = allOrders.find(order => 
                                        order.exchangeOrderId === exchangeOrderId && 
                                        order.sessionId === this.sessionId
                                    );
                                    this.logger.info(`[EXECUTIONS_DEBUG] Strategy 3 result:`, {
                                        totalOrders: allOrders.length,
                                        orderFound: !!associatedOrderInCurrentSession,
                                        foundOrderId: associatedOrderInCurrentSession?.id,
                                        foundSessionId: associatedOrderInCurrentSession?.sessionId
                                    });
                                } catch (error) {
                                    this.logger.warn(`[EXECUTIONS_DEBUG] Strategy 3 failed: ${error.message}`);
                                }
                            }
                            
                            // STRATEGY 4: Memory lookup as final fallback
                            if (!associatedOrderInCurrentSession) {
                                this.logger.info(`[EXECUTIONS_DEBUG] Strategy 4: Memory lookup for exchangeOrderId: ${exchangeOrderId}`);
                                for (const [orderId, order] of this.liveOrders.entries()) {
                                    if (order.exchangeOrderId === exchangeOrderId && order.sessionId === this.sessionId) {
                                        associatedOrderInCurrentSession = order;
                                        this.logger.info(`[EXECUTIONS_DEBUG] Strategy 4 found order in memory:`, {
                                            memoryOrderId: orderId,
                                            orderSessionId: order.sessionId
                                        });
                                        break;
                                    }
                                }
                            }
                        }

                        if (associatedOrderInCurrentSession && associatedOrderInCurrentSession.sessionId === this.sessionId) {
                            this.logger.info('[_handleExecutionReport] Processing fill for current session order:', fillData);
                            
                            // Use internal ID as primary identifier for fills
                            const orderId = associatedOrderInCurrentSession.id; // This is now our internal ID
                            const clientOrderId = associatedOrderInCurrentSession.clientOrderId || associatedOrderInCurrentSession.id;
                            
                            // Create comprehensive fill record
                            const fillRecord = {
                                id: fillData.id,
                                orderId: orderId, // Use our internal ID as primary reference
                                clientOrderId: clientOrderId, // Our internal ID
                                exchangeOrderId: exchangeOrderId, // Store exchange order ID for reconciliation
                                symbol: fillData.symbol,
                                side: fillData.side,
                                quantity: fillData.size || fillData.fillQuantity,
                                price: fillData.price || fillData.fillPrice,
                                cost: fillData.cost || (fillData.size * fillData.price),
                                fees: fillData.fees || [],
                                feeAmount: fillData.fee?.amount || 0,
                                timestamp: fillData.timestamp || fillData.fillTimestamp,
                                execId: executionReport.exec_id,
                                tradeId: executionReport.trade_id,
                                liquidityInd: executionReport.liquidity_ind,
                                sessionId: this.sessionId
                            };
                            
                            // Store fill record in Redis
                            if (this.redisFillManager && typeof this.redisFillManager.add === 'function') {
                                await this.redisFillManager.add(fillRecord); 
                                this.logger.info(`[FILL_PROCESSING] Fill ${fillRecord.id} persisted for order ${orderId} (internal: ${internalOrderId}) in session ${this.sessionId}`);
                            }
                            
                            // Update order status to FILLED in Redis
                            const updatedOrderData = {
                                ...associatedOrderInCurrentSession,
                                status: 'FILLED',
                                filled: fillRecord.quantity,
                                remaining: 0,
                                avgPrice: fillRecord.price,
                                fees: fillRecord.fees,
                                lastUpdated: Date.now()
                            };
                            
                            await this.redisOrderManager.update(updatedOrderData);
                            this.logger.info(`[FILL_PROCESSING] Order ${orderId} status updated to FILLED in Redis`);
                            
                            // Emit events
                            this.emit('fill', fillRecord);
                            this.emit('orderUpdate', updatedOrderData);
                            
                            // Emit orderFilled event that AdaptiveMarketMakerV2 expects for take-profit creation
                            // Use internal order ID for backward compatibility with AdaptiveMarketMakerV2
                            this._safeEmitOrderFilled(internalOrderId, {
                                orderId: orderId, // Primary order ID (whatever was found)
                                internalOrderId: internalOrderId, // Our internal ID
                                exchangeOrderId: exchangeOrderId, // Exchange order ID
                                symbol: fillRecord.symbol,
                                side: fillRecord.side,
                                quantity: fillRecord.quantity,
                                price: fillRecord.price,
                                fees: fillRecord.fees,
                                fillRecord: fillRecord,
                                updatedOrder: updatedOrderData,
                                timestamp: fillRecord.timestamp
                            });
                            
                            this.logger.info(`[FILL_COMPLETE] Order ${orderId} (internal: ${internalOrderId}, exchange: ${exchangeOrderId}) filled and take-profit event emitted`, {
                                orderId: orderId,
                                internalOrderId: internalOrderId,
                                exchangeOrderId: exchangeOrderId,
                                quantity: fillRecord.quantity,
                                price: fillRecord.price,
                                fillRecorded: true,
                                orderStatusUpdated: true
                            });
                            
                            // Clean up from memory since order is now filled
                            // Check both IDs for backward compatibility
                            if (this.liveOrders.has(orderId)) {
                                this.liveOrders.delete(orderId);
                                this.logger.info(`[MEMORY_CLEANUP] Removed filled order ${orderId} from memory`);
                            }
                            if (this.liveOrders.has(internalOrderId)) {
                                this.liveOrders.delete(internalOrderId);
                                this.logger.info(`[MEMORY_CLEANUP] Removed filled order ${internalOrderId} from memory`);
                            }
                            if (this.liveOrders.has(exchangeOrderId)) {
                                this.liveOrders.delete(exchangeOrderId);
                                this.logger.info(`[MEMORY_CLEANUP] Removed filled order ${exchangeOrderId} from memory`);
                            }
                            
                        } else {
                            this.logger.info(`[_handleExecutionReport] Fill ${fillData.id} (for order ${exchangeOrderId}) does not belong to current session ${this.sessionId}. Tried all lookup strategies.`);
                            this.emit('unreconciledExchangeUpdate', { type: 'fill', data: fillData, originalReport: executionReport });
                        }
                    } else { // This is an Order update (not a fill)
                        const orderUpdate = standardizedItem;
                        
                        // For live trading, orders are stored with internal ID as primary key
                        let existingOrderInCurrentSession = null;
                        
                        // Direct lookup by internal ID (which is our primary ID for live trading)
                        try {
                            existingOrderInCurrentSession = await this.redisOrderManager.getById(orderUpdate.id);
                            this.logger.info(`[_handleExecutionReport] Order lookup by internal ID ${orderUpdate.id}: ${existingOrderInCurrentSession ? 'FOUND' : 'NOT FOUND'}`);
                        } catch (error) {
                            this.logger.warn(`[_handleExecutionReport] Error looking up order ${orderUpdate.id}: ${error.message}`);
                        }

                        if (existingOrderInCurrentSession && existingOrderInCurrentSession.sessionId === this.sessionId) {
                            this.logger.info(`[_handleExecutionReport] Processing order update for current session order ${orderUpdate.id}:`, orderUpdate);
                            await this.redisOrderManager.update(orderUpdate); 
                            this.logger.info(`Order ${orderUpdate.id} updated in RedisOrderManager for session ${this.sessionId}.`);
                            
                            // Emit general order update
                            this.emit('orderUpdate', orderUpdate);
                            
                            // Emit specific events for order status changes
                            // LIVE FILL DETECTION FIX - Check if order was already filled before cancelling
                const existingOrder = await this.redisOrderManager.getById(orderUpdate.id);
                if (existingOrder && existingOrder.status === 'FILLED') {
                    this.logger.warn(`[LIVE_FILL_FIX] Ignoring cancellation for already FILLED order ${orderUpdate.id}`);
                    return; // Don't process cancellation for filled orders
                }
                
                this.logger.info(`[LIVE_FILL_FIX] Processing cancellation for order ${orderUpdate.id}`);
                
                if (orderUpdate.status === 'CANCELLED' || orderUpdate.status === 'cancelled') {
                                this.logger.info(`[_handleExecutionReport] Order ${orderUpdate.id} was cancelled`);
                                this.emit('orderCancelled', {
                                    orderId: orderUpdate.id,
                                    clientOrderId: orderUpdate.clientOrderId,
                                    order: orderUpdate,
                                    timestamp: Date.now(),
                                    reason: orderUpdate.cancelReason || 'EXCHANGE_CANCELLED'
                                });
                                
                                // Clean up from memory since order is now cancelled
                                if (this.liveOrders.has(orderUpdate.id)) {
                                    this.liveOrders.delete(orderUpdate.id);
                                    this.logger.info(`[MEMORY_CLEANUP] Removed cancelled order ${orderUpdate.id} from memory`);
                                }
                                
                            } else if (orderUpdate.status === 'FILLED' || orderUpdate.status === 'filled') {
                                this.logger.info(`[_handleExecutionReport] Order ${orderUpdate.id} was filled via status update`);
                                
                                // Handle case where fill is detected through order status update
                                // Extract fill information from the execution report if available
                                if (executionReport.exec_type === 'filled' && executionReport.cum_qty && executionReport.avg_price) {
                                    const fillRecord = {
                                        id: `${orderUpdate.id}-${Date.now()}`, // Generate fill ID if not provided
                                        orderId: orderUpdate.id,
                                        exchangeOrderId: executionReport.order_id,
                                        symbol: executionReport.symbol || orderUpdate.symbol,
                                        side: executionReport.side || orderUpdate.side,
                                        quantity: executionReport.cum_qty,
                                        price: executionReport.avg_price,
                                        cost: executionReport.cum_cost || (executionReport.cum_qty * executionReport.avg_price),
                                        fees: executionReport.fees || [],
                                        feeAmount: executionReport.fee_usd_equiv || 0,
                                        timestamp: executionReport.timestamp || new Date().toISOString(),
                                        sessionId: this.sessionId
                                    };
                                    
                                    // Store fill record if we have FillManager
                                    if (this.redisFillManager && typeof this.redisFillManager.add === 'function') {
                                        await this.redisFillManager.add(fillRecord);
                                        this.logger.info(`[FILL_PROCESSING] Fill record created from status update for order ${orderUpdate.id}`);
                                    }
                                    
                                    // Emit orderFilled with fill data
                                    this._safeEmitOrderFilled(orderUpdate.id, {
                                        orderId: orderUpdate.id,
                                        symbol: fillRecord.symbol,
                                        side: fillRecord.side,
                                        quantity: fillRecord.quantity,
                                        price: fillRecord.price,
                                        fees: fillRecord.fees,
                                        fillRecord: fillRecord,
                                        updatedOrder: orderUpdate,
                                        timestamp: fillRecord.timestamp
                                    });
                                    
                                    this.logger.info(`[FILL_COMPLETE] Order ${orderUpdate.id} filled via status update, take-profit event emitted`);
                                } else {
                                    // Fallback for status updates without detailed fill info
                                    this._safeEmitOrderFilled(orderUpdate.id, {
                                        orderId: orderUpdate.id,
                                        updatedOrder: orderUpdate,
                                        fillData: null, // No detailed fill data available
                                        timestamp: Date.now() // Add timestamp for deduplication
                                    });
                                    this.logger.warn(`[_handleExecutionReport] Order ${orderUpdate.id} marked as filled but no detailed fill data available`);
                                }
                                
                                // Clean up from memory since order is now filled
                                if (this.liveOrders.has(orderUpdate.id)) {
                                    this.liveOrders.delete(orderUpdate.id);
                                    this.logger.info(`[MEMORY_CLEANUP] Removed filled order ${orderUpdate.id} from memory`);
                                }
                            }
                      
                        } else {
                            this.logger.info(`[_handleExecutionReport] Order update for ${orderUpdate.id} (status: ${orderUpdate.status}) does not match an order in current session ${this.sessionId}.`);
                            this.emit('unreconciledExchangeUpdate', { type: 'order', data: orderUpdate, originalReport: executionReport });
                            
                            // Enhanced logging for reconciliation service debugging
                            this.logger.debug('[RECONCILIATION_DEBUG] Unreconciled order update details', {
                                sessionId: this.sessionId,
                                exchangeOrderId: orderUpdate.id,
                                clientOrderId: orderUpdate.clientOrderId,
                                status: orderUpdate.status,
                                execType: executionReport.exec_type,
                                symbol: executionReport.symbol,
                                timestamp: Date.now()
                            });
                        }
                    }
                } catch (transformError) {
                    this.logger.error('Error processing execution report:', executionReport, transformError);
                }
            });
        }
    }

    _onPrivateError(error) {
        this.logger.error('Private WebSocket error:', error);
        // If we're still connecting, reject the connection promise
        if (this.connectionState === 'connecting' && this._initialConnectReject) {
            this._initialConnectReject(error);
            this._initialConnectResolve = null;
            this._initialConnectReject = null;
        }
        // Emit the error event for external listeners
        this.emit('error', error);
    }

    _onPrivateClose(event) {
        const reason = event.reason || 'No reason provided';
        const code = event.code || 'No code provided';
        
        this.logger.info(`Private WebSocket connection closed. Code: ${code}, Reason: ${reason}, Clean: ${event.wasClean}`);
        
        // Update connection state
        this.connectionState = 'disconnected';
        
        // Clean up
        this.ws = null;
        
        // Emit disconnected event
        this.emit('disconnected');
        
        // If not a manual disconnect, attempt to reconnect
        if (!this._isManualDisconnect) {
            this._schedulePrivateReconnect();
        } else {
            this._isManualDisconnect = false; // Reset the flag
        }
    }

    _schedulePrivateReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            this.logger.error(`Maximum reconnection attempts (${this.maxReconnectAttempts}) reached for private WebSocket. Giving up.`);
            this.emit('reconnectFailed');
            return;
        }
        
        this.reconnectAttempts++;
        
        // Exponential backoff with jitter
        const jitter = Math.random() * 0.3 + 0.85; // Random between 0.85 and 1.15
        const delay = Math.min(this.currentReconnectDelayMs * jitter, this.maxReconnectDelayMs);
        
        this.logger.info(`Scheduling private WebSocket reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
        
        this.reconnectTimer = setTimeout(() => {
            this.logger.info(`Attempting private WebSocket reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
            this._connectPrivate().catch(error => {
                this.logger.error(`Reconnection attempt ${this.reconnectAttempts} failed:`, error);
            });
        }, delay);
        
        // Update the delay for the next attempt (exponential backoff)
        this.currentReconnectDelayMs = Math.min(this.currentReconnectDelayMs * 2, this.maxReconnectDelayMs);
    }

    // Public WebSocket event handlers
    _onPublicOpen() {
        this.logger.info('Public WebSocket connection opened. Subscribing to market data channels...');
        
        this.publicConnectionState = 'connected';
        this.publicReconnectAttempts = 0;
        this.publicCurrentReconnectDelayMs = this.publicInitialReconnectDelayMs;
        this.lastPublicMessageTimestamp = Date.now();

        this.logger.info('[Public WS Liveness] Scheduling liveness check to start in 10 seconds.');
        this.publicWsLivenessCheckTimer = setTimeout(() => {
            this.logger.info('[Public WS Liveness] 10-second delay complete. Starting liveness check now.');
            this._startPublicWsLivenessCheck();
            this.publicWsLivenessCheckTimer = null; // Clear the timer reference
        }, 10000);

        if (this._publicInitialConnectResolve) {
            this.logger.info('[CONNECT_TRACE] Resolving initial connect promise in _onPublicOpen.');
            this._publicInitialConnectResolve();
            this._publicInitialConnectResolve = null;
            this._publicInitialConnectReject = null;
        }

        if (this.symbol) {
            // Only subscribe to orderbook if not explicitly disabled (for settlement service optimization)
            if (this.subscribeToOrderbook && !this.disableOrderbook) {
                this.logger.info(`[Default Subscription] Attempting to subscribe to book for ${this.symbol} with params: ${{symbol: [this.symbol], depth: this.orderBookDepth}}`);
                this.subscribeToOrderBook([this.symbol])
                    .catch(err => this.logger.error(`[Default Subscription] Error subscribing to default order book for ${this.symbol}:`, err));
            } else {
                this.logger.info(`[Default Subscription] Orderbook subscription disabled for ${this.symbol} (settlement service optimization)`);
            }
            
            this.logger.info(`[Default Subscription] Attempting to subscribe to trades for ${this.symbol} with params: ${{symbol: [this.symbol]}}`);
            this.subscribeToTrades([this.symbol])
                .catch(err => this.logger.error(`[Default Subscription] Error subscribing to default trades for ${this.symbol}:`, err));
        }
    }

    _startPublicWsLivenessCheck() {
        // Liveness check will now run after the initial 10s delay, regardless of paperMode.
        if (this.publicWsLivenessCheckInterval) {
            clearInterval(this.publicWsLivenessCheckInterval);
            this.publicWsLivenessCheckInterval = null;
        }
        const LIVENESS_CHECK_INTERVAL_MS = 1000; // Check every second
        const LIVENESS_TIMEOUT_MS = 15000; // Consider connection lost if no message for 15 seconds

        this.logger.info(`[Public WS Liveness] Starting liveness check. Interval: ${LIVENESS_CHECK_INTERVAL_MS}ms, Timeout: ${LIVENESS_TIMEOUT_MS}ms`);

        this.publicWsLivenessCheckInterval = setInterval(() => {
            if (this.publicConnectionState === 'connected' && (Date.now() - this.lastPublicMessageTimestamp > LIVENESS_TIMEOUT_MS)) {
                this.logger.error(`CRITICAL: Public WebSocket connection deemed lost (no message for > ${LIVENESS_TIMEOUT_MS / 1000} seconds). Exiting process.`);
                setTimeout(() => process.exit(1), 100); 
            }
        }, LIVENESS_CHECK_INTERVAL_MS); // Check every second
    }

    _onPublicMessage(event) {
        this.lastPublicMessageTimestamp = Date.now();
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (error) {
            this.logger.error('Failed to parse Public WebSocket message:', event.data);
            return;
        }

        this.logger.debug('Received Public WebSocket message:', message);

        // Handle error messages (especially applicable to subscription requests)
        if (message.error) {
            this.logger.error('Error message from WebSocket:', message.error);
            if (message.req_id) {
                // If there's a req_id, try to find and reject the corresponding promise
                const sub = this.publicSubscriptions.get(message.req_id);
                if (sub) {
                    clearTimeout(sub.timeout);
                    sub.reject(new Error(`WebSocket error: "${message.error}"`));
                    this.publicSubscriptions.delete(message.req_id);
                } else {
                    throw new Error(`WebSocket error: "${message.error}"`);
                }
            } else {
                throw new Error(`WebSocket error: "${message.error}"`);
            }
            return;
        }

        this._handlePublicMessage(message);
    }

    _handlePublicMessage(message) {
        // 1. Handle direct responses to requests via req_id
        if (message.req_id && this.publicSubscriptions.has(message.req_id)) {
            const sub = this.publicSubscriptions.get(message.req_id);
            clearTimeout(sub.timeout); // Clear the timeout associated with this request

            if (message.success === true || message.status === 'ok') {
                this.logger.debug(`Request successful (req_id: ${message.req_id}, method: ${sub.payload.method || message.method}):`, message.result || message);
                sub.resolve(message.result || message);
            } else {
                const errorMsg = `Request failed (req_id: ${message.req_id}, method: ${sub.payload.method || message.method}): ${message.error || message.message || 'Unknown error'}`;
                this.logger.error(errorMsg, message);
                sub.reject(new Error(errorMsg));
            }
            this.publicSubscriptions.delete(message.req_id);
            return;
        }

        // 2. Handle subscription status updates (e.g., from a subscribe or unsubscribe method call)
        if (message.method === 'subscribe' && message.result && message.result.channel) {
            if (message.success === true) {
                const channelName = message.result.channel;
                // For public channels, symbol is often part of the result. Use it to create a more specific key.
                const fullChannelKey = message.result.symbol ? `${channelName}:${message.result.symbol}` : channelName;
                if (!this.publicActiveChannels.has(fullChannelKey)) {
                    this.publicActiveChannels.add(fullChannelKey);
                    this.logger.info(`Successfully subscribed to public channel: ${fullChannelKey}. Total active: ${this.publicActiveChannels.size}`);
                }
                if (this.publicPendingSubscriptions.has(fullChannelKey)) {
                    this.publicPendingSubscriptions.delete(fullChannelKey);
                }
            } else {
                 this.logger.error(`Subscription to ${message.result.channel} failed:`, message);
                 // Potentially reject a promise if one was stored for this subscription confirmation
            }
            return;
        }
        
        if (message.method === 'unsubscribe' && message.result && message.result.channel) {
            if (message.success === true) {
                const channelName = message.result.channel;
                const fullChannelKey = message.result.symbol ? `${channelName}:${message.result.symbol}` : channelName;
                if (this.publicActiveChannels.has(fullChannelKey)) {
                    this.publicActiveChannels.delete(fullChannelKey);
                    this.logger.info(`Successfully unsubscribed from public channel: ${fullChannelKey}. Active channels:`, Array.from(this.publicActiveChannels));
                }
            } else {
                this.logger.error(`Unsubscribe from ${message.result.channel} failed:`, message);
            }
            return;
        }

        // 3. Handle channel data (book, trade, status)
        if (message.channel) {
            switch (message.channel) {
                case 'book':
                    if (message.data && Array.isArray(message.data)) {
                        message.data.forEach(bookEntry => {
                            // Log orderbook update (essential info only)
                            this.logger.debug('[KrakenWSv2Adapter:_handlePublicMessage] Book entry received:', { 
                                symbol: bookEntry.symbol,
                                hasBids: !!(bookEntry.bids && bookEntry.bids.length > 0),
                                hasAsks: !!(bookEntry.asks && bookEntry.asks.length > 0),
                                bidCount: bookEntry.bids?.length || 0,
                                askCount: bookEntry.asks?.length || 0,
                                timestamp: bookEntry.timestamp
                            });

                            const symbol = bookEntry.symbol;
                            if (!symbol) {
                                this.logger.warn(`[Public WS Book] Received 'book' data entry without symbol.`, bookEntry);
                                return; // Skip this entry
                            }
                            if (bookEntry.bids || bookEntry.asks) {
                                this.logger.debug(`[Public WS Book] Received book data for ${symbol}`, bookEntry);
                                
                                // Ensure this.orderBook has Maps for the current symbol
                                if (!this.orderBook[symbol]) {
                                    this.orderBook[symbol] = {
                                        bids: new Map(),
                                        asks: new Map(),
                                        timestamp: 0
                                    };
                                }
                                const currentSymbolBook = this.orderBook[symbol];

                                // Process bid updates
                                if (bookEntry.bids) {
                                    bookEntry.bids.forEach(level => {
                                        const price = parseFloat(level.price);
                                        const qty = parseFloat(level.qty);
                                        if (qty === 0) {
                                            currentSymbolBook.bids.delete(price);
                                        } else {
                                            currentSymbolBook.bids.set(price, qty);
                                        }
                                    });
                                }
                                // Process ask updates
                                if (bookEntry.asks) {
                                    bookEntry.asks.forEach(level => {
                                        const price = parseFloat(level.price);
                                        const qty = parseFloat(level.qty);
                                        if (qty === 0) {
                                            currentSymbolBook.asks.delete(price);
                                        } else {
                                            currentSymbolBook.asks.set(price, qty);
                                        }
                                    });
                                }
                                
                                // Update timestamp
                                currentSymbolBook.timestamp = bookEntry.timestamp ? new Date(bookEntry.timestamp).getTime() : Date.now();

                                // Only proceed if this update is for the symbol this adapter instance is for
                                if (this.symbol === symbol) {
                                    // Convert current full book state to arrays for emission
                                    // Bids should be sorted descending, Asks ascending
                                    const formattedBids = Array.from(currentSymbolBook.bids.entries())
                                        .map(([price, size]) => [price, size])
                                        .sort((a, b) => b[0] - a[0]); 
                                    
                                    const formattedAsks = Array.from(currentSymbolBook.asks.entries())
                                        .map(([price, size]) => [price, size])
                                        .sort((a, b) => a[0] - b[0]);

                                    this.emit('orderBookUpdate', {
                                        symbol: symbol,
                                        bids: formattedBids,
                                        asks: formattedAsks,
                                        timestamp: currentSymbolBook.timestamp 
                                    });
                                    this.logger.info(`[Public WS Book] Emitted 'orderBookUpdate' for ${symbol}. Bids: ${formattedBids.length}, Asks: ${formattedAsks.length}. Type: ${message.type || 'delta'}`);
                                } else {
                                    this.logger.debug(`[Public WS Book] Processed book data for ${symbol}, but adapter is for ${this.symbol}. Internal book for ${symbol} updated.`);
                                }
                            } else {
                                this.logger.warn(`[Public WS Book] Received 'book' message for ${symbol} without bids/asks data inside data entry.`, bookEntry);
                            }
                        });
                    } else {
                        this.logger.warn(`[Public WS Book] Received 'book' message without data array or empty data.`, message);
                    }
                    break;
                case 'trade':
                    if (message.data && Array.isArray(message.data)) {
                        message.data.forEach(tradeEntry => {
                            const symbol = tradeEntry.symbol; // Kraken v2 puts symbol inside each trade object in data array
                            if (!symbol) {
                                this.logger.warn(`[Public WS Trade] Received 'trade' data entry without symbol.`, tradeEntry);
                                return; // Skip this entry
                            }
                            // Kraken v2 trade item in data array: { symbol, ord_type, price, qty, side, trade_id, ts }
                            const standardizedTrade = {
                                symbol: symbol,
                                price: parseFloat(tradeEntry.price),
                                size: parseFloat(tradeEntry.qty),
                                side: tradeEntry.side,
                                tradeId: String(tradeEntry.trade_id),
                                timestamp: Math.floor(parseFloat(tradeEntry.ts) * 1000) // ts is in seconds with decimals
                            };
                            this.emit('trade', standardizedTrade);
                            this.logger.info(`[Public WS Trade] Emitted 'trade' for ${symbol}: ${standardizedTrade.tradeId}`);
                        });
                    } else {
                         this.logger.warn(`[Public WS Trade] Received 'trade' message without data array or empty data.`, message);
                    }
                    break;
                case 'status': // System status messages
                    // Kraken system status messages usually don't have a symbol directly under message.symbol
                    // They are general status updates.
                    this.logger.info('Received Kraken system status update:', message);
                    this.emit('statusUpdate', message); // Emit the whole message or a processed part
                    if (message.system !== 'online' && message.status !== 'online') { // Check common fields for online status
                        this.logger.warn(`Kraken system status might NOT be online:`, message);
                    }
                    break;
                case 'heartbeat': // Handle heartbeats like { "channel": "heartbeat" }
                    this.logger.debug('Received public heartbeat from Kraken (channel type).');
                    // No action needed other than updating lastPublicMessageTimestamp, which is done at the start of _onPublicMessage
                    break;
                default:
                    this.logger.warn(`Received message for unhandled public data channel: ${message.channel}`, message);
            }
            return;
        }

        // 4. Handle other message types (e.g., heartbeats by method, pings)
        //Kraken v2 might also send heartbeats as { "method": "heartbeat" }
        if (message.method === 'heartbeat') {
            this.logger.debug('Received public heartbeat from Kraken (method type).');
            return;
        }
        
        if (message.method === 'ping') { 
            this.logger.debug('Received ping from Kraken (public v2). Sending pong...');
            try {
                const pongPayload = message.req_id ? { method: 'pong', req_id: message.req_id } : { method: 'pong' };
                this.wsPublic.send(JSON.stringify(pongPayload));
            } catch (err) {
                this.logger.error('Failed to send pong (public v2):', err);
            }
            return;
        }

        this.logger.warn('Received unhandled Public WebSocket message (unknown structure):', message);
    }

    _onPublicError(error) {
        this.logger.error('Public WebSocket error:', error);
        // If we're still connecting, reject the connection promise
        if (this.publicConnectionState === 'connecting' && this._publicInitialConnectReject) {
            this._publicInitialConnectReject(error);
            this._publicInitialConnectResolve = null;
            this._publicInitialConnectReject = null;
        }
        // Emit the error event for external listeners
        this.emit('error', error);
    }

    _onPublicClose(event) {
        const reason = event.reason || 'No reason provided';
        const code = event.code || 'No code provided';
        
        this.logger.info(`Public WebSocket connection closed. Code: ${code}, Reason: ${reason}, Clean: ${event.wasClean}`);
        
        // Update connection state
        this.publicConnectionState = 'disconnected';
        
        // Clean up
        this.wsPublic = null;
        
        // Emit disconnected event
        this.emit('disconnected');
        
        // If not a manual disconnect, attempt to reconnect
        if (!this._isPublicManualDisconnect) {
            this._schedulePublicReconnect();
        } else {
            this._isPublicManualDisconnect = false; // Reset the flag
        }
    }

    _schedulePublicReconnect() {
        if (this.publicReconnectAttempts >= this.publicMaxReconnectAttempts) {
            this.logger.error(`Maximum reconnection attempts (${this.publicMaxReconnectAttempts}) reached for public WebSocket. Giving up.`);
            this.emit('reconnectFailed');
            return;
        }
        
        this.publicReconnectAttempts++;
        
        // Exponential backoff with jitter
        const jitter = Math.random() * 0.3 + 0.85; // Random between 0.85 and 1.15
        const delay = Math.min(this.publicCurrentReconnectDelayMs * jitter, this.publicMaxReconnectDelayMs);
        
        this.logger.info(`Scheduling public WebSocket reconnection attempt ${this.publicReconnectAttempts}/${this.publicMaxReconnectAttempts} in ${delay}ms`);
        
        this.publicReconnectTimer = setTimeout(() => {
            this.logger.info(`Attempting public WebSocket reconnection ${this.publicReconnectAttempts}/${this.publicMaxReconnectAttempts}`);
            this._connectPublic().catch(error => {
                this.logger.error(`Reconnection attempt ${this.publicReconnectAttempts} failed:`, error);
            });
        }, delay);
        
        // Update the delay for the next attempt (exponential backoff)
        this.publicCurrentReconnectDelayMs = Math.min(this.publicCurrentReconnectDelayMs * 2, this.publicMaxReconnectDelayMs);
    }

    /**
     * Sends a subscription message to a private WebSocket channel.
     * @private
     * @param {string} channelName The name of the channel to subscribe to (e.g., 'executions').
     * @param {object} params Additional parameters for the subscription.
     * @param {boolean} requiresAuth Whether authentication (token) is required for this channel.
     * @returns {Promise<object>} Resolves with the subscription confirmation or rejects on error/timeout.
     */
    async _subscribeToChannel(channelName, params = {}, requiresAuth = false) {
        // In paper mode, bypass authentication requirement completely
        const isPaperModeWithAuth = this.paperMode && requiresAuth;
        
        if (isPaperModeWithAuth) {
            this.logger.info(`[Private WS Subscribe - Paper Mode] Simulating authenticated subscription to ${channelName}`);
            // In paper mode, we don't need real authentication for private channels
            return this._simulatePaperModeSubscription(channelName);
        }
        
        // Continue with normal flow for non-paper mode or non-auth channels
        const reqId = this._nextReqId++;
        const payload = {
            method: 'subscribe',
            params: {
                channel: channelName,
                ...params
            },
            req_id: reqId
        };

        // Only check for auth token if not in paper mode and it requires auth
        if (requiresAuth && !this.paperMode) {
            if (!this.token) {
                const errMsg = `[Private WS Subscribe] Authentication token is required for channel ${channelName} but not available.`;
                this.logger.error(errMsg);
                return Promise.reject(new Error(errMsg));
            }
            payload.params.token = this.token;
        }

        return new Promise((resolve, reject) => {
            if (this.paperMode) {
                this.logger.info(`[Private WS Subscribe - Paper Mode] Simulating subscription to ${channelName} with req_id: ${reqId}`, payload);
                // Simulate immediate success for paper mode subscriptions
                const simulatedResponse = { success: true, channel: channelName, req_id: reqId, result: { channel: channelName, status: 'subscribed' } };
                
                // Add to active channels as if successful
                if (!this.activeChannels.has(channelName)) {
                    this.activeChannels.add(channelName);
                }
                if (this._pendingSubscriptions && this._pendingSubscriptions.has(channelName)) {
                    this._pendingSubscriptions.delete(channelName);
                }
                
                // Resolve promise with success response
                resolve(simulatedResponse.result);
                
                // Emit a simulated message for _handlePrivateMessage to process
                setTimeout(() => {
                    this.emit('message', { data: JSON.stringify(simulatedResponse) });
                }, 50);
                return;
            }

            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                const errMsg = `[Private WS Subscribe] WebSocket not connected. Cannot subscribe to ${channelName}. State: ${this.ws ? this.ws.readyState : 'null'}`;
                this.logger.error(errMsg);
                return reject(new Error(errMsg));
            }

            this.logger.info(`[Private WS Subscribe] Subscribing to channel: ${channelName} with req_id: ${reqId}`);
            this._pendingSubscriptions.add(channelName);

            this.subscriptions.set(reqId, {
                payload,
                resolve,
                reject,
                timeout: setTimeout(() => {
                    if (this.subscriptions.has(reqId)) {
                        this.logger.warn(`[Private WS Subscribe] Timeout for subscription to ${channelName} (req_id: ${reqId})`);
                        this._pendingSubscriptions.delete(channelName);
                        this.subscriptions.delete(reqId);
                        reject(new Error(`Subscription to ${channelName} timed out`));
                    }
                }, this.requestTimeoutMs)
            });

            try {
                this.ws.send(JSON.stringify(payload));
            } catch (error) {
                this.logger.error(`[Private WS Subscribe] Error sending subscription message for ${channelName}:`, error);
                this._pendingSubscriptions.delete(channelName);
                clearTimeout(this.subscriptions.get(reqId).timeout);
                this.subscriptions.delete(reqId);
                reject(error);
            }
        });
    }

    /**
     * Sends a subscription message to a public WebSocket channel.
     * @private
     * @param {string} channelName The name of the channel to subscribe to (e.g., 'book', 'trade').
     * @param {object} params Additional parameters for the subscription (e.g., symbol, depth).
     * @param {string} originalSymbol The original, unformatted symbol for logging/tracking.
     * @returns {Promise<object>} Resolves with the subscription confirmation or rejects on error/timeout.
     */
    async _subscribeToPublicChannel(channelName, params = {}, originalSymbol = '') {
        const reqId = this._publicNextReqId++;
        const finalPayload = {
            method: 'subscribe',
            params: {
                channel: channelName,
                ...params // e.g., { symbol: ["BTC/USD"], depth: 10 }
            },
            req_id: reqId
        };
        
        const logSymbol = originalSymbol || (params.symbol && Array.isArray(params.symbol) ? params.symbol.join(',') : 'unknown');

        return new Promise((resolve, reject) => {
            if (!this.wsPublic || this.wsPublic.readyState !== WebSocket.OPEN) {
                const errMsg = `[Public WS Subscribe] Public WebSocket not connected. Cannot subscribe to ${channelName} for ${logSymbol}. State: ${this.wsPublic ? this.wsPublic.readyState : 'null'} (PaperMode: ${this.paperMode})`;
                this.logger.error(errMsg);
                return reject(new Error(errMsg));
            }

            this.logger.info(`[Public WS Subscribe] Subscribing to ${channelName} for ${logSymbol} (req_id: ${reqId}) (PaperMode: ${this.paperMode})`);
            this.publicPendingSubscriptions.add(`${channelName}:${logSymbol}`);

            this.publicSubscriptions.set(reqId, {
                payload: finalPayload,
                resolve,
                reject,
                timeout: setTimeout(() => {
                    if (this.publicSubscriptions.has(reqId)) {
                        this.logger.warn(`[Public WS Subscribe] Timeout for subscription to ${channelName} for ${logSymbol} (req_id: ${reqId})`);
                        this.publicPendingSubscriptions.delete(`${channelName}:${logSymbol}`);
                        this.publicSubscriptions.delete(reqId);
                        reject(new Error(`Subscription to ${channelName} for ${logSymbol} timed out`));
                    }
                }, this.requestTimeoutMs)
            });
            
            try {
                this.wsPublic.send(JSON.stringify(finalPayload));
            } catch (error) {
                this.logger.error(`[Public WS Subscribe] Error sending subscription message for ${channelName} for ${logSymbol}:`, error);
                this.publicPendingSubscriptions.delete(`${channelName}:${logSymbol}`);
                clearTimeout(this.publicSubscriptions.get(reqId).timeout);
                this.publicSubscriptions.delete(reqId);
                reject(error);
            }
        });
    }

    // Update transform methods if they exist in the file
    async _transformKrakenFill(executionReport) {
        // Check if this is a fill execution
        // For 'trade' exec_type: must have trade_id and last_price
        // For 'filled' exec_type: must have cum_qty and avg_price (final fill summary)
        const isTradeExecution = executionReport.exec_type === 'trade' && executionReport.trade_id && executionReport.last_price;
        const isFilledExecution = executionReport.exec_type === 'filled' && executionReport.cum_qty && executionReport.avg_price;
        
        if (!isTradeExecution && !isFilledExecution) {
            return null;
        }
        
        try {
            // Handle missing side field (common in filled execution reports)
            let fillSide = executionReport.side ? executionReport.side.toLowerCase() : null;
            
            // If side is missing, try to look up the original order from in-memory storage first, then Redis
            if (!fillSide && (executionReport.cl_ord_id || executionReport.order_id)) {
                // First check in-memory storage (faster and handles race conditions)
                const clientOrderId = executionReport.cl_ord_id;
                const exchangeOrderId = executionReport.order_id;
                
                // Try to find by client order ID first
                if (clientOrderId && this.liveOrders.has(clientOrderId)) {
                    const memoryOrder = this.liveOrders.get(clientOrderId);
                    if (memoryOrder && memoryOrder.side) {
                        fillSide = memoryOrder.side.toLowerCase();
                        this.logger.info(`[FILL_SIDE_LOOKUP] Retrieved missing side '${fillSide}' from memory for fill ${clientOrderId}`);
                    }
                }
                
                // If not found by client ID, try to find by exchange ID
                if (!fillSide && exchangeOrderId) {
                    for (const [orderId, order] of this.liveOrders.entries()) {
                        if (order.exchangeOrderId === exchangeOrderId && order.side) {
                            fillSide = order.side.toLowerCase();
                            this.logger.info(`[FILL_SIDE_LOOKUP] Retrieved missing side '${fillSide}' from memory by exchange ID ${exchangeOrderId}`);
                            break;
                        }
                    }
                }
                
                // If still not found, fall back to Redis
                if (!fillSide && clientOrderId && this.redisOrderManager) {
                    try {
                        const existingOrder = await this.redisOrderManager.getById(clientOrderId);
                        if (existingOrder && existingOrder.side) {
                            fillSide = existingOrder.side.toLowerCase();
                            this.logger.info(`[FILL_SIDE_LOOKUP] Retrieved missing side '${fillSide}' from Redis for fill ${clientOrderId}`);
                        }
                    } catch (error) {
                        this.logger.warn(`[FILL_SIDE_LOOKUP] Could not retrieve order ${clientOrderId} from Redis:`, error.message);
                    }
                }
            }
            
            // Fallback to 'unknown' if still no side found
            if (!fillSide) {
                fillSide = 'unknown';
                this.logger.warn(`[FILL_SIDE_LOOKUP] No side found for fill ${executionReport.cl_ord_id || executionReport.order_id}, using 'unknown'`);
            }
            
            // Ensure timestamp is in milliseconds since epoch
            let timestamp;
            if (executionReport.timestamp) {
                // If timestamp is a string, convert to timestamp
                timestamp = typeof executionReport.timestamp === 'string' 
                    ? new Date(executionReport.timestamp).getTime()
                    : executionReport.timestamp;
            } else if (executionReport.trade_time) {
                // If trade_time is a string, convert to timestamp
                timestamp = typeof executionReport.trade_time === 'string' 
                    ? new Date(executionReport.trade_time).getTime()
                    : executionReport.trade_time;
            } else if (executionReport.fill_time) {
                // If fill_time is a string, convert to timestamp
                timestamp = typeof executionReport.fill_time === 'string'
                    ? new Date(executionReport.fill_time).getTime()
                    : executionReport.fill_time;
            } else if (executionReport.ts) {
                // If ts is in seconds, convert to milliseconds
                timestamp = typeof executionReport.ts === 'number' && executionReport.ts < 9999999999
                    ? executionReport.ts * 1000
                    : executionReport.ts;
            } else {
                // Fallback to current time
                timestamp = Date.now();
            }
            
            // ENHANCED FEE HANDLING: Extract fee data with multiple fallback strategies
            let feeData = null;
            
            // Strategy 1: Direct fee object (preferred)
            if (executionReport.fee && typeof executionReport.fee === 'object') {
                feeData = {
                    amount: parseFloat(executionReport.fee.amount || 0),
                    currency: executionReport.fee.currency || (executionReport.symbol ? executionReport.symbol.split('/')[1] : 'USD'),
                    rate: executionReport.fee.rate
                };
                this.logger.debug(`[FEE_CAPTURE] Captured fee from fee object:`, feeData);
            }
            // Strategy 2: USD equivalent amount
            else if (executionReport.fee_usd_equiv) {
                feeData = {
                    amount: parseFloat(executionReport.fee_usd_equiv),
                    currency: 'USD',
                    rate: null
                };
                this.logger.debug(`[FEE_CAPTURE] Captured fee from fee_usd_equiv:`, feeData);
            }
            // Strategy 3: Fees array
            else if (executionReport.fees && Array.isArray(executionReport.fees) && executionReport.fees.length > 0) {
                const firstFee = executionReport.fees[0];
                if (firstFee && firstFee.qty) {
                    feeData = {
                        amount: parseFloat(firstFee.qty),
                        currency: firstFee.asset || 'USD',
                        rate: null
                    };
                    this.logger.debug(`[FEE_CAPTURE] Captured fee from fees array:`, feeData);
                }
            }
            // Strategy 4: Fee reconstruction from liquidity and current rates (fallback)
            else {
                this.logger.warn(`[FEE_MISSING] No fee data in execution report, attempting reconstruction`);
                
                // Get cost and liquidity indicator for reconstruction
                const cost = parseFloat(executionReport.cost || (executionReport.last_price * executionReport.last_qty) || 0);
                const liquidityInd = executionReport.liquidity_ind;
                
                if (cost > 0 && liquidityInd) {
                    try {
                        // Get current fee rates
                        const currentFees = await this.getCurrentFees();
                        const feeRate = liquidityInd === 'm' ? currentFees.makerFee : currentFees.takerFee;
                        
                        if (feeRate && feeRate > 0) {
                            const reconstructedAmount = cost * feeRate;
                            feeData = {
                                amount: reconstructedAmount,
                                currency: 'USD',
                                rate: feeRate,
                                reconstructed: true // Flag to indicate this was reconstructed
                            };
                            this.logger.info(`[FEE_RECONSTRUCTED] Reconstructed fee:`, {
                                cost,
                                liquidityInd,
                                feeRate: (feeRate * 100).toFixed(2) + '%',
                                amount: reconstructedAmount.toFixed(6)
                            });
                        }
                    } catch (error) {
                        this.logger.warn(`[FEE_RECONSTRUCTION_FAILED] Could not reconstruct fee:`, error.message);
                    }
                }
                
                // If still no fee data, log warning for monitoring
                if (!feeData) {
                    this.logger.warn(`[FEE_CAPTURE_FAILED] No fee data captured for fill:`, {
                        tradeId: executionReport.trade_id,
                        orderId: executionReport.order_id,
                        cost: executionReport.cost,
                        liquidityInd: executionReport.liquidity_ind,
                        paperMode: this.paperMode
                    });
                }
            }
            
            // Create a standardized fill object
            const standardizedFill = {
                id: executionReport.trade_id || `fill-${executionReport.order_id}-${timestamp}`,
                orderId: executionReport.order_id,
                clientOrderId: executionReport.cl_ord_id,
                exchangeOrderId: executionReport.order_id, // Add explicit exchange order ID
                symbol: executionReport.symbol,
                side: fillSide, // Use the looked-up side
                price: parseFloat(executionReport.last_price || executionReport.avg_price || 0),
                size: parseFloat(executionReport.last_qty || executionReport.cum_qty || 0), // Standardize on size
                cost: parseFloat(executionReport.cost || 0), // Explicit cost field
                timestamp: timestamp, // Timestamp in milliseconds since epoch
                lastUpdated: Date.now(), // Add lastUpdated field with current timestamp
                fee: feeData, // Enhanced fee data with reconstruction
                liquidityInd: executionReport.liquidity_ind, // Preserve liquidity indicator for migration
                execId: executionReport.exec_id, // Execution ID for reference
                tradeId: executionReport.trade_id, // Trade ID for reference
                sessionId: this.sessionId,
                // Store raw execution report for debugging and migration
                rawExecutionReport: this.paperMode ? null : executionReport // Only store in live mode to avoid clutter
            };
            
            // Log fee capture status for monitoring
            if (feeData) {
                this.logger.info(`[FEE_SUCCESS] Fee captured for fill ${standardizedFill.id}:`, {
                    amount: feeData.amount,
                    currency: feeData.currency,
                    rate: feeData.rate,
                    reconstructed: feeData.reconstructed || false
                });
            }
            
            return standardizedFill;
        } catch (error) {
            this.logger.error('Error transforming Kraken fill:', error, executionReport);
            return null;
        }
    }

    async _transformKrakenOrder(executionReport) {
        // Must have order_id to be an order
        if (!executionReport.order_id) {
            return null;
        }
        
        try {
            // Get existing order data to preserve valid values when incoming data is undefined
            let existingOrder = null;
            const clientOrderId = executionReport.cl_ord_id;
            const exchangeOrderId = executionReport.order_id;
            
            // Try to get existing order from memory first (faster)
            if (clientOrderId && this.liveOrders.has(clientOrderId)) {
                existingOrder = this.liveOrders.get(clientOrderId);
            } else if (exchangeOrderId) {
                // Look for order by exchange ID mapping
                const mappedClientOrderId = this.exchangeOrderIdMap?.get(exchangeOrderId);
                if (mappedClientOrderId && this.liveOrders.has(mappedClientOrderId)) {
                    existingOrder = this.liveOrders.get(mappedClientOrderId);
                }
            }
            
            // Fallback to Redis if not found in memory
            if (!existingOrder && this.redisOrderManager) {
                try {
                    if (clientOrderId) {
                        existingOrder = await this.redisOrderManager.getById(clientOrderId);
                    } else if (exchangeOrderId) {
                        // Use exchange order ID mapping if available
                        const mappedClientOrderId = this.exchangeOrderIdMap?.get(exchangeOrderId);
                        if (mappedClientOrderId) {
                            existingOrder = await this.redisOrderManager.getById(mappedClientOrderId);
                        }
                    }
                } catch (error) {
                    this.logger.debug(`Could not retrieve existing order for preservation: ${error.message}`);
                }
            }
            
            // Map Kraken status to standardized status
            const statusMap = {
                'open': 'OPEN',
                'partially_filled': 'PARTIALLY_FILLED',
                'filled': 'FILLED',
                'canceled': 'CANCELLED',
                'closed': 'FILLED', // Kraken sometimes uses 'closed' for filled orders
                'expired': 'EXPIRED',
                'rejected': 'REJECTED'
            };
            
            // Determine final status
            const finalStatus = (executionReport.order_status || executionReport.status) ? 
                (statusMap[(executionReport.order_status || executionReport.status).toLowerCase()] || 'UNKNOWN') : 'UNKNOWN';
            
            // If status is UNKNOWN, ignore this update to prevent data corruption
            if (finalStatus === 'UNKNOWN') {
                this.logger.debug(`[DATA_PRESERVATION] Ignoring update with UNKNOWN status for order ${executionReport.cl_ord_id || executionReport.order_id} to prevent data corruption`);
                return null; // Return null to ignore this update completely
            }
            
            // Order size - use either order_qty or size or volume depending on what's available
            // Preserve existing value if incoming data is null/undefined/0
            let incomingOrderSize = null;
            if (executionReport.order_qty !== null && executionReport.order_qty !== undefined) {
                incomingOrderSize = parseFloat(executionReport.order_qty);
            } else if (executionReport.size !== null && executionReport.size !== undefined) {
                incomingOrderSize = parseFloat(executionReport.size);
            } else if (executionReport.volume !== null && executionReport.volume !== undefined) {
                incomingOrderSize = parseFloat(executionReport.volume);
            }
            
            let orderSize = 0;
            if (incomingOrderSize && incomingOrderSize > 0) {
                orderSize = incomingOrderSize;
            } else if (existingOrder && (existingOrder.size > 0 || existingOrder.amount > 0)) {
                // Preserve existing valid size/amount
                orderSize = existingOrder.size || existingOrder.amount;
                this.logger.debug(`[DATA_PRESERVATION] Preserved existing order size ${orderSize} for order ${clientOrderId || exchangeOrderId}`);
            } else {
                // CRITICAL: If we don't have a valid size, return null to prevent updating with 0
                // This prevents orders from being corrupted with 0 size when orderbook updates arrive
                this.logger.warn(`[DATA_PRESERVATION] No valid order size found for order ${clientOrderId || exchangeOrderId}, skipping update to prevent data corruption`);
                return null;
            }
            
            // Additional fallback for cancellations - try to get original size from Redis
            // This should rarely be needed now that we return null for 0 size
            if (executionReport.exec_type === 'canceled' && orderSize === 0 &&
                (executionReport.cl_ord_id || executionReport.order_id)) {
                try {
                    let originalOrder = null;
                    
                    // Try to get by client order ID first
                    if (executionReport.cl_ord_id && this.redisOrderManager) {
                        originalOrder = await this.redisOrderManager.getById(executionReport.cl_ord_id);
                    }
                    
                    // Fallback to exchange order ID lookup
                    if (!originalOrder && executionReport.order_id && this.redisOrderManager) {
                        const clientOrderId = await this.redisOrderManager.getClientOrderIdByExchange(executionReport.order_id);
                        if (clientOrderId) {
                            originalOrder = await this.redisOrderManager.getById(clientOrderId);
                        }
                    }
                    
                    if (originalOrder) {
                        // Try size field first, then amount field
                        const originalSize = originalOrder.size || originalOrder.amount;
                        if (originalSize && originalSize > 0) {
                            orderSize = parseFloat(originalSize);
                            this.logger.info(`[CANCELLATION_FIX] Preserved original order size ${orderSize} from ${originalOrder.size ? 'size' : 'amount'} field for cancelled order ${executionReport.cl_ord_id || executionReport.order_id}`);
                        }
                    }
                } catch (error) {
                    this.logger.warn(`[CANCELLATION_FIX] Could not retrieve original order size:`, error.message);
                }
            }
            
            // Filled size
            const filledSize = parseFloat(
                executionReport.filled_qty || 
                executionReport.executed_volume || 
                executionReport.executed_size || 
                '0'
            );
            
            // Calculate remaining size
            const remainingSize = Math.max(0, orderSize - filledSize);
            
            // Ensure timestamp is in milliseconds since epoch
            let timestamp;
            if (executionReport.time) {
                // If time is a string, convert to timestamp
                timestamp = typeof executionReport.time === 'string'
                    ? new Date(executionReport.time).getTime()
                    : executionReport.time;
            } else if (executionReport.ts) {
                // If ts is in seconds, convert to milliseconds
                timestamp = typeof executionReport.ts === 'number' && executionReport.ts < 9999999999
                    ? executionReport.ts * 1000
                    : executionReport.ts;
            } else {
                // Fallback to current time
                timestamp = Date.now();
            }
            
            // Ensure lastFillTimestamp is in milliseconds since epoch
            let lastFillTimestamp;
            if (executionReport.trade_time) {
                // If trade_time is a string, convert to timestamp
                lastFillTimestamp = typeof executionReport.trade_time === 'string'
                    ? new Date(executionReport.trade_time).getTime()
                    : executionReport.trade_time;
            } else {
                // Set to undefined if not available
                lastFillTimestamp = undefined;
            }
            
            // Handle missing side field (common in cancellation reports)
            let orderSide = executionReport.side ? executionReport.side.toLowerCase() : null;
            
            // If side is missing, try to look up the original order from in-memory storage first, then Redis
            if (!orderSide && (executionReport.cl_ord_id || executionReport.order_id)) {
                // First check in-memory storage (faster and handles race conditions)
                const clientOrderId = executionReport.cl_ord_id;
                const exchangeOrderId = executionReport.order_id;
                
                // Try to find by client order ID first
                if (clientOrderId && this.liveOrders.has(clientOrderId)) {
                    const memoryOrder = this.liveOrders.get(clientOrderId);
                    if (memoryOrder && memoryOrder.side) {
                        orderSide = memoryOrder.side.toLowerCase();
                        this.logger.info(`[RACE_CONDITION_FIX] Retrieved missing side '${orderSide}' from memory for order ${clientOrderId}`);
                    }
                }
                
                // If not found by client ID, try to find by exchange ID
                if (!orderSide && exchangeOrderId) {
                    for (const [orderId, order] of this.liveOrders.entries()) {
                        if (order.exchangeOrderId === exchangeOrderId && order.side) {
                            orderSide = order.side.toLowerCase();
                            this.logger.info(`[RACE_CONDITION_FIX] Retrieved missing side '${orderSide}' from memory by exchange ID ${exchangeOrderId}`);
                            break;
                        }
                    }
                }
                
                // If still not found, fall back to Redis
                if (!orderSide && clientOrderId && this.redisOrderManager) {
                    try {
                        const existingOrder = await this.redisOrderManager.getById(clientOrderId);
                        if (existingOrder && existingOrder.side) {
                            orderSide = existingOrder.side.toLowerCase();
                            this.logger.info(`[RACE_CONDITION_FIX] Retrieved missing side '${orderSide}' from Redis for order ${clientOrderId}`);
                        }
                    } catch (error) {
                        this.logger.warn(`[RACE_CONDITION_FIX] Could not retrieve order ${clientOrderId} from Redis:`, error.message);
                    }
                }
            }
            
            // Fallback to 'unknown' if still no side found
            if (!orderSide) {
                orderSide = 'unknown';
                this.logger.warn(`[CANCELLATION_FIX] No side found for order ${executionReport.cl_ord_id || executionReport.order_id}, using 'unknown'`);
            }
            
            // Order price - preserve existing price if incoming data is undefined/null/0
            let incomingOrderPrice = null;
            if (executionReport.limit_price !== null && executionReport.limit_price !== undefined) {
                incomingOrderPrice = parseFloat(executionReport.limit_price);
            } else if (executionReport.price !== null && executionReport.price !== undefined) {
                incomingOrderPrice = parseFloat(executionReport.price);
            }
            
            let orderPrice = 0;
            if (incomingOrderPrice && incomingOrderPrice > 0) {
                orderPrice = incomingOrderPrice;
            } else if (existingOrder && existingOrder.price > 0) {
                // Preserve existing valid price
                orderPrice = parseFloat(existingOrder.price);
                this.logger.debug(`[DATA_PRESERVATION] Preserved existing order price ${orderPrice} for order ${clientOrderId || exchangeOrderId}`);
            } else {
                orderPrice = 0;
            }
            
            // Special handling for cancellations - if still no price found, try harder to retrieve original
            if (orderPrice === 0 && executionReport.exec_type === 'canceled' && 
                (executionReport.cl_ord_id || executionReport.order_id)) {
                try {
                    let originalOrder = null;
                    
                    // Try to get by client order ID first
                    if (executionReport.cl_ord_id && this.redisOrderManager) {
                        originalOrder = await this.redisOrderManager.getById(executionReport.cl_ord_id);
                    }
                    
                    // Fallback to exchange order ID lookup
                    if (!originalOrder && executionReport.order_id && this.redisOrderManager) {
                        const mappedClientOrderId = await this.redisOrderManager.getClientOrderIdByExchange(executionReport.order_id);
                        if (mappedClientOrderId) {
                            originalOrder = await this.redisOrderManager.getById(mappedClientOrderId);
                        }
                    }
                    
                    if (originalOrder && originalOrder.price > 0) {
                        orderPrice = parseFloat(originalOrder.price);
                        this.logger.info(`[CANCELLATION_FIX] Preserved original order price ${orderPrice} for cancelled order ${executionReport.cl_ord_id || executionReport.order_id}`);
                    }
                } catch (error) {
                    this.logger.warn(`[CANCELLATION_FIX] Could not retrieve original order price:`, error.message);
                }
            }
            
            // Create a standardized order object with data preservation
            const standardizedOrder = {
                id: executionReport.cl_ord_id || (existingOrder ? existingOrder.id : executionReport.order_id),
                clientOrderId: executionReport.cl_ord_id || (existingOrder ? existingOrder.clientOrderId : null),
                exchangeOrderId: executionReport.order_id,
                symbol: executionReport.symbol || (existingOrder ? existingOrder.symbol : null),
                side: orderSide,
                type: executionReport.order_type ? executionReport.order_type.toLowerCase() : 
                      (executionReport.ord_type ? executionReport.ord_type.toLowerCase() : 
                       (existingOrder ? existingOrder.type : 'unknown')),
                price: orderPrice, // Use preserved or original price
                amount: orderSize, // Include amount field for compatibility
                size: orderSize, // Use preserved or original size for UI
                filled: filledSize,
                remaining: remainingSize,
                status: finalStatus, // Use the pre-validated status
                timestamp: timestamp, // Timestamp in milliseconds since epoch
                lastUpdated: Date.now(), // Add lastUpdated field with current timestamp
                lastFillTimestamp: lastFillTimestamp, // Timestamp in milliseconds since epoch or undefined
                sessionId: this.sessionId,
                parentOrderId: executionReport.parent_order_id || executionReport.parentOrderId || 
                             (existingOrder ? existingOrder.parentOrderId : null), // Preserve parentOrderId if provided
                purpose: executionReport.purpose || (existingOrder ? existingOrder.purpose : null), // Preserve purpose if provided
                cancelReason: executionReport.cancel_reason || executionReport.reason || null // Add cancel reason if available
            };
            
            // FINAL SAFETY CHECK: Never return an order with 0 size/amount
            if (standardizedOrder.size === 0 || standardizedOrder.amount === 0) {
                this.logger.error(`[DATA_PRESERVATION] CRITICAL: Attempted to return order with 0 size/amount. Blocking update.`, {
                    orderId: standardizedOrder.id,
                    clientOrderId: standardizedOrder.clientOrderId,
                    originalSize: orderSize,
                    finalSize: standardizedOrder.size,
                    executionReport: executionReport
                });
                return null;
            }
            
            return standardizedOrder;
        } catch (error) {
            this.logger.error('Error transforming Kraken order:', error, executionReport);
            return null;
        }
    }

    /**
     * Create an order on Kraken exchange using WebSocket v2 API for speed
     * Adapts the standard createOrder interface to Kraken's WebSocket add_order API
     */
    async createOrder(orderParams) {
        // Handle both object parameter and individual parameters for backward compatibility
        let symbol, type, side, amount, price, clientOrderId, parentOrderId, purpose, pricingMetadata, ttl;
        
        if (typeof orderParams === 'object' && orderParams.symbol) {
            // Object parameter format (used by AdaptiveMarketMakerV2)
            symbol = orderParams.symbol;
            type = orderParams.type;
            side = orderParams.side;
            amount = orderParams.amount;
            price = orderParams.price;
            clientOrderId = orderParams.clientOrderId;
            parentOrderId = orderParams.parentOrderId;
            purpose = orderParams.purpose;
            pricingMetadata = orderParams.pricingMetadata;
            ttl = orderParams.ttl; // Accept TTL in seconds
        } else {
            // Individual parameters format (legacy)
            symbol = arguments[0];
            type = arguments[1];
            side = arguments[2];
            amount = arguments[3];
            price = arguments[4];
            clientOrderId = arguments[5]?.clientOrderId;
            parentOrderId = null;
            purpose = null;
            ttl = null;
        }

        this.logger.info(`Creating order via WebSocket: ${side} ${amount} ${symbol} @ ${price || 'MARKET'} (type: ${type})`, { 
            clientOrderId,
            parentOrderId: parentOrderId || 'NOT_PROVIDED',
            purpose: purpose || 'NOT_PROVIDED',
            hasParentOrderId: !!parentOrderId,
            ttl: ttl,
            ttlType: typeof ttl,
            hasCustomTTL: !!ttl,
            orderParamsKeys: Object.keys(orderParams || {})
        });

        try {
            if (this.paperMode) {
                // In paper mode, use the mock client
                const paperOrder = await this.client.createOrder(symbol, type, side, amount, price, { 
                    clientOrderId,
                    parentOrderId,
                    purpose,
                    sessionId: this.sessionId,
                    pricingMetadata
                });
                
                // Add TTL fields to paper orders too
                const now = Date.now();
                // Use provided TTL or fall back to defaults
                const TTL_CONFIG = {
                    BUY_ORDERS_MS: 16000,   // 16 seconds for buy orders (default)
                    SELL_ORDERS_MS: 900000  // 15 minutes for sell orders (default)
                };
                
                // If TTL provided (in seconds), convert to milliseconds; otherwise use defaults
                const ttlMs = ttl ? 
                    ttl * 1000 : // Convert seconds to milliseconds
                    (side === 'buy' ? TTL_CONFIG.BUY_ORDERS_MS : TTL_CONFIG.SELL_ORDERS_MS);
                    
                const expiresAt = now + ttlMs;
                
                this.logger.info(`[TTL] Paper trading - Setting ${side} order TTL: ${Math.floor(ttlMs/1000)} seconds - Custom TTL: ${!!ttl}`);
                
                const enhancedPaperOrder = {
                    ...paperOrder,
                    ttlMs: ttlMs,
                    expiresAt: expiresAt,
                    createdAt: now,
                    // parentOrderId and purpose should already be set by the mock client
                    // but keep these as fallback
                    parentOrderId: paperOrder.parentOrderId || parentOrderId || null,
                    purpose: paperOrder.purpose || purpose || null,
                    // Pricing metadata from market maker
                    pricingMetadata: pricingMetadata || null
                };
                
                return enhancedPaperOrder;
            } else {
                // In live mode, use WebSocket v2 API for speed
                if (!this.ws || this.connectionState !== 'connected') {
                    throw new Error('Private WebSocket not connected');
                }
                
                if (!this.token) {
                    throw new Error('Authentication token is required for order creation but not available');
                }
                
                const krakenPair = this._formatPairForKraken(symbol);
                
                // Map our standard parameters to Kraken's WebSocket format
                const krakenType = side; // 'buy' or 'sell'
                const krakenOrderType = type; // 'limit' or 'market'
                const krakenVolume = parseFloat(amount); // Convert to number, not string
                const krakenPrice = price ? parseFloat(price) : undefined; // Convert to number, not string
                
                // Generate request ID for tracking
                const reqId = this._nextReqId++;
                
                // Create WebSocket add_order message
                const addOrderMessage = {
                    method: 'add_order',
                    params: {
                        order_type: krakenOrderType,
                        side: krakenType,
                        symbol: krakenPair,
                        order_qty: krakenVolume, // Now a number, not a string
                        cl_ord_id: clientOrderId, // Send our internal ID as client order ID
                        token: this.token
                    },
                    req_id: reqId
                };
                
                // Add price for limit orders
                if (krakenOrderType === 'limit' && krakenPrice) {
                    addOrderMessage.params.limit_price = krakenPrice; // Now a number, not a string
                }
                
                // Add client order ID if provided
                if (clientOrderId) {
                    addOrderMessage.params.cl_ord_id = clientOrderId;
                    this.logger.info(`Using clientOrderId as cl_ord_id: ${clientOrderId}`);
                }
                
                // ADD TTL PARAMETERS FOR KRAKEN EXCHANGE-LEVEL EXPIRATION
                // Use provided TTL or fall back to defaults
                const TTL_CONFIG = {
                    BUY_ORDERS_MS: 16000,   // 16 seconds for buy orders (default)
                    SELL_ORDERS_MS: 900000  // 15 minutes for sell orders (default)
                };
                
                // If TTL provided (in seconds), convert to milliseconds; otherwise use defaults
                const ttlMs = ttl ? 
                    ttl * 1000 : // Convert seconds to milliseconds
                    (side === 'buy' ? TTL_CONFIG.BUY_ORDERS_MS : TTL_CONFIG.SELL_ORDERS_MS);
                const ttlSeconds = Math.floor(ttlMs / 1000);
                
                addOrderMessage.params.time_in_force = 'GTD';
                // Kraken WebSocket API expects RFC3339 format for expire_time with GTD orders (precision to seconds)
                const expireDate = new Date(Date.now() + ttlMs);
                addOrderMessage.params.expire_time = expireDate.toISOString().replace(/\.\d{3}Z$/, 'Z');
                
                this.logger.info(`[TTL] Setting ${side} order TTL: ${ttlSeconds} seconds (expires at ${addOrderMessage.params.expire_time}) - Custom TTL: ${!!ttl}`);
                
                this.logger.info(`[ORDER_CREATE_DEBUG] Sending WebSocket add_order message:`, {
                    reqId,
                    symbol: krakenPair,
                    side: krakenType,
                    type: krakenOrderType,
                    amount: krakenVolume,
                    price: krakenPrice,
                    clientOrderId,
                    timeInForce: addOrderMessage.params.time_in_force,
                    expireTime: addOrderMessage.params.expire_time,
                    ttlSeconds: addOrderMessage.params.expire_time ? Math.floor((new Date(addOrderMessage.params.expire_time).getTime() - Date.now()) / 1000) : 'N/A'
                });
                
                // Send the order via WebSocket and wait for response
                const response = await new Promise((resolve, reject) => {
                    // Set up timeout
                    const timeout = setTimeout(() => {
                        if (this.subscriptions.has(reqId)) {
                            this.subscriptions.delete(reqId);
                            reject(new Error(`Order creation timeout after ${this.requestTimeoutMs}ms`));
                        }
                    }, this.requestTimeoutMs);
                    
                    // Store the promise handlers
                    this.subscriptions.set(reqId, {
                        payload: addOrderMessage,
                        resolve: (result) => {
                            clearTimeout(timeout);
                            resolve(result);
                        },
                        reject: (error) => {
                            clearTimeout(timeout);
                            reject(error);
                        },
                        timeout
                    });
                    
                    // Send the message
                    try {
                        this.ws.send(JSON.stringify(addOrderMessage));
                        this.logger.info(`[ORDER_CREATE_DEBUG] WebSocket add_order message sent with req_id: ${reqId}`);
                        
                        // Store order in memory immediately to handle race conditions
                        // This prevents fills from being lost when they arrive before order creation responses
                        const tempId = `temp-${reqId}`;  // Temporary ID until we get exchange order ID
                        const now = Date.now();
                        // Use provided TTL or fall back to defaults (same logic as paper trading)
                        const tempTtlMs = ttl ? 
                            ttl * 1000 : // Convert seconds to milliseconds
                            (side === 'buy' ? TTL_CONFIG.BUY_ORDERS_MS : TTL_CONFIG.SELL_ORDERS_MS);
                        const expiresAt = now + tempTtlMs;
                        
                        const pendingOrder = {
                            id: tempId,  // Temporary ID, will be updated to exchange order ID
                            internalId: clientOrderId,  // Our internal tracking ID
                            clientOrderId: clientOrderId,
                            exchangeOrderId: null, // Will be set when response arrives
                            symbol: symbol,
                            type: type,
                            side: side,
                            price: price,
                            amount: amount,
                            size: amount, // Map amount to size for UI compatibility
                            status: 'PENDING', // Mark as pending until response
                            timestamp: now,
                            filled: 0,
                            remaining: amount,
                            sessionId: this.sessionId,
                            parentOrderId: parentOrderId || null,
                            purpose: purpose || null,
                            exchange: 'kraken_ws_v2',
                            paperTrading: false,
                            ttlMs: tempTtlMs,
                            expiresAt: expiresAt,
                            createdAt: now,
                            reqId: reqId // Store req_id for matching with response
                        };
                        
                        // Store in memory with temporary ID
                        this.liveOrders.set(tempId, pendingOrder);
                        this.logger.info(`[ORDER_CREATE_DEBUG] Order stored in memory with temporary ID: ${tempId}`);
                        
                    } catch (error) {
                        clearTimeout(timeout);
                        this.subscriptions.delete(reqId);
                        reject(new Error(`Failed to send order message: ${error.message}`));
                    }
                });
                
                this.logger.info(`[ORDER_CREATE_DEBUG] WebSocket add_order response:`, {
                    responseKeys: Object.keys(response),
                    orderId: response.order_id,
                    fullResponse: response
                });
                
                // Transform WebSocket response to our standard format
                const exchangeOrderId = response.order_id; // WebSocket v2 API uses order_id
                const tempId = `temp-${reqId}`;
                const now = Date.now();
                
                this.logger.info(`[ORDER_CREATE_DEBUG] Extracted exchangeOrderId: ${exchangeOrderId} from WebSocket response`);
                
                // Update the order in memory with the internal ID as primary ID
                if (this.liveOrders.has(tempId)) {
                    const pendingOrder = this.liveOrders.get(tempId);
                    
                    // Remove from temporary ID
                    this.liveOrders.delete(tempId);
                    
                    // Update order with internal ID as primary ID
                    pendingOrder.id = clientOrderId;  // Internal ID becomes primary ID
                    pendingOrder.exchangeOrderId = exchangeOrderId;
                    pendingOrder.status = 'OPEN';
                    pendingOrder.rawOrderData = response;
                    
                    // Store with internal ID as primary key
                    this.liveOrders.set(clientOrderId, pendingOrder);
                    this.logger.info(`[ORDER_CREATE_DEBUG] Updated order in memory: ${tempId} -> ${clientOrderId} (primary), status: OPEN`);
                    
                    // Store exchange order ID mapping for reconciliation
                    this.exchangeOrderIdMap = this.exchangeOrderIdMap || new Map();
                    this.exchangeOrderIdMap.set(exchangeOrderId, clientOrderId);
                    this.logger.info(`[ORDER_CREATE_DEBUG] Created exchange ID mapping: ${exchangeOrderId} -> ${clientOrderId}`);
                } else {
                    this.logger.warn(`[ORDER_CREATE_DEBUG] Order ${tempId} not found in memory to update with exchange ID`);
                }
                
                // Set TTL based on provided value or defaults
                const finalTtlMs = ttl ? 
                    ttl * 1000 : // Convert seconds to milliseconds
                    (side === 'buy' ? TTL_CONFIG.BUY_ORDERS_MS : TTL_CONFIG.SELL_ORDERS_MS);
                const finalExpiresAt = now + finalTtlMs;
                
                const standardOrder = {
                    id: clientOrderId,  // Use our internal ID as primary identifier
                    clientOrderId: clientOrderId,  // Pass to exchange as cl_ord_id
                    exchangeOrderId: exchangeOrderId,  // Store exchange ID for reconciliation
                    symbol: symbol,
                    type: type,
                    side: side,
                    price: price,
                    amount: amount,
                    size: amount, // Map amount to size for UI compatibility
                    status: 'OPEN',
                    timestamp: now,
                    filled: 0,
                    remaining: amount,
                    sessionId: this.sessionId,
                    parentOrderId: parentOrderId || null,
                    purpose: purpose || null,
                    exchange: 'kraken_ws_v2',
                    paperTrading: false,
                    rawOrderData: response,
                    // TTL fields
                    ttlMs: finalTtlMs,
                    expiresAt: finalExpiresAt,
                    createdAt: now,
                    // Pricing metadata from market maker
                    pricingMetadata: pricingMetadata || null
                };
                
                // Add to Redis order manager if available
                if (this.redisOrderManager && typeof this.redisOrderManager.add === 'function') {
                    this.logger.info(`[ORDER_CREATE_DEBUG] Adding order to RedisOrderManager:`, {
                        orderId: standardOrder.id,
                        clientOrderId: standardOrder.clientOrderId,
                        exchangeOrderId: standardOrder.exchangeOrderId,
                        parentOrderId: standardOrder.parentOrderId || 'NOT_SET',
                        purpose: standardOrder.purpose || 'NOT_SET',
                        hasParentOrderId: !!standardOrder.parentOrderId,
                        hasPricingMetadata: !!standardOrder.pricingMetadata,
                        pricingMetadataKeys: standardOrder.pricingMetadata ? Object.keys(standardOrder.pricingMetadata) : 'NONE'
                    });
                    
                    // Debug: Log the complete pricing metadata being stored
                    if (standardOrder.pricingMetadata) {
                        this.logger.info(`[PRICING_METADATA_DEBUG] Storing pricing metadata with order ${standardOrder.id}:`, {
                            strategy: standardOrder.pricingMetadata.strategy,
                            marketConditions: standardOrder.pricingMetadata.marketConditions,
                            fees: standardOrder.pricingMetadata.fees,
                            calculation: standardOrder.pricingMetadata.calculation,
                            projections: standardOrder.pricingMetadata.projections
                        });
                    } else {
                        this.logger.warn(`[PRICING_METADATA_DEBUG] No pricing metadata found for order ${standardOrder.id}`);
                    }
                    
                    await this.redisOrderManager.add(standardOrder);
                    this.logger.info(`Order ${standardOrder.id} persisted to RedisOrderManager.`);
                    
                    // Verify the order was stored with pricing metadata by retrieving it
                    if (this.redisOrderManager.getById) {
                        try {
                            const retrievedOrder = await this.redisOrderManager.getById(standardOrder.id);
                            this.logger.info('[KrakenWSv2] PRICING_METADATA_VERIFICATION: Retrieved order from Redis', {
                                orderId: retrievedOrder?.id || 'NOT_FOUND',
                                hasPricingMetadata: !!retrievedOrder?.pricingMetadata,
                                pricingMetadataKeys: retrievedOrder?.pricingMetadata ? Object.keys(retrievedOrder.pricingMetadata) : 'NONE',
                                strategy: retrievedOrder?.pricingMetadata?.strategy?.name || 'N/A',
                                verificationResult: (!!standardOrder.pricingMetadata === !!retrievedOrder?.pricingMetadata) ? 'MATCH' : 'MISMATCH'
                            });
                        } catch (verifyError) {
                            this.logger.error('[KrakenWSv2] PRICING_METADATA_VERIFICATION: Failed to retrieve order for verification', {
                                orderId: standardOrder.id,
                                error: verifyError.message
                            });
                        }
                    }
                    
                    // Create exchange mapping: exchangeOrderId -> internalOrderId (clientOrderId)
                    // NOTE: Exchange mapping no longer needed since we use exchangeOrderId as primary ID
                    // The order is stored with exchangeOrderId as the key, so no mapping lookup is required
                    /* REMOVED: Exchange mapping causes circular lookup issues
                    if (exchangeOrderId && clientOrderId && this.redisOrderManager.setExchangeMapping) {
                        this.logger.info(`[ORDER_CREATE_DEBUG] About to create exchange mapping: ${exchangeOrderId} -> ${clientOrderId}`);
                        try {
                            await this.redisOrderManager.setExchangeMapping(exchangeOrderId, clientOrderId);
                            this.logger.info(`[ORDER_CREATE_DEBUG] Successfully created exchange mapping: ${exchangeOrderId} -> ${clientOrderId}`);
                            
                            // Verify the mapping was created
                            const verifyMapping = await this.redisOrderManager.getClientOrderIdByExchange(exchangeOrderId);
                            this.logger.info(`[ORDER_CREATE_DEBUG] Mapping verification: ${exchangeOrderId} -> ${verifyMapping || 'NOT FOUND'}`);
                        } catch (error) {
                            this.logger.error(`[ORDER_CREATE_DEBUG] Error creating exchange mapping:`, error);
                        }
                    } else {
                        this.logger.warn(`[ORDER_CREATE_DEBUG] Cannot create exchange mapping:`, {
                            hasExchangeOrderId: !!exchangeOrderId,
                            hasClientOrderId: !!clientOrderId,
                            hasSetExchangeMappingMethod: !!(this.redisOrderManager.setExchangeMapping),
                            exchangeOrderId,
                            clientOrderId
                        });
                    }
                    */
                    
                    this.logger.info(`[ORDER_CREATE_DEBUG] Order stored with exchange ID as primary key: ${standardOrder.id}`, {
                        primaryId: standardOrder.id,
                        internalId: standardOrder.internalId,
                        clientOrderId: standardOrder.clientOrderId,
                        exchangeOrderId: standardOrder.exchangeOrderId
                    });
                } else {
                    this.logger.warn(`[ORDER_CREATE_DEBUG] RedisOrderManager not available or add method missing`);
                }
                
                // Emit order update event
                this.emit('orderUpdate', standardOrder);
                
                return standardOrder;
            }
        } catch (error) {
            this.logger.error(`Failed to create order on Kraken WebSocket for ${symbol}:`, error.message);
            throw error;
        }
    }

    async cancelOrder(orderId, params = {}) {
        this.logger.info(`[${this.exchangeName}] Cancelling order ${orderId}`, { 
            tradingMode: this.tradingMode, 
            params 
        });

        try {
            if (this.tradingMode === 'paper') {
                // Paper trading - only update Redis, no exchange interaction
                this.logger.info(`[${this.exchangeName}] Paper trading: Cancelling order ${orderId} in Redis only`);
                
                // Get the order from Redis order manager (corrected property name)
                const order = await this.redisOrderManager.getById(orderId);
                
                if (!order) {
                    throw new Error(`Order ${orderId} not found`);
                }
                
                if (order.status !== 'OPEN' && order.status !== 'open') {
                    throw new Error(`Order ${orderId} is not open. Current status: ${order.status}`);
                }
                
                // Update order status in Redis
                const updatedOrder = {
                    ...order,
                    status: 'CANCELLED',
                    canceledAt: Date.now(),
                    lastUpdated: Date.now(),
                    cancelReason: params.reason || 'USER_REQUESTED'
                };
                
                // Save to Redis via order manager (corrected property name)
                await this.redisOrderManager.update(updatedOrder);
                
                // Emit order status changed event
                this.emit('orderStatusChanged', {
                    orderId: order.id,
                    clientOrderId: order.clientOrderId,
                    status: 'CANCELLED',
                    timestamp: Date.now(),
                    reason: params.reason
                });
                
                this.logger.info(`[${this.exchangeName}] Paper order ${orderId} cancelled successfully in Redis`);
                
                return {
                    id: orderId,
                    status: 'CANCELLED',
                    success: true,
                    order: updatedOrder
                };
                
            } else {
                // Live trading - send cancel request to exchange via WebSocket
                this.logger.info(`[${this.exchangeName}] Live trading: Sending cancel request to exchange for order ${orderId}`);
                
                if (!this.ws || this.connectionState !== 'connected') {
                    throw new Error('Private WebSocket not connected');
                }
                
                // Generate request ID for tracking
                const reqId = Date.now();
                
                // Check if we have a valid token
                if (!this.token) {
                    throw new Error('Authentication token is required for order cancellation but not available');
                }
                
                // Get the order from Redis to extract the real Kraken order ID
                const order = await this.redisOrderManager.getById(orderId);
                let krakenOrderId = orderId;
                
                if (order) {
                    // Prefer exchangeOrderId if available
                    if (order.exchangeOrderId) {
                        krakenOrderId = order.exchangeOrderId;
                        this.logger.info(`[${this.exchangeName}] Using exchange order ID ${krakenOrderId} for cancellation`);
                    } else if (order.rawOrderData && order.rawOrderData.result && order.rawOrderData.result.order_id) {
                        krakenOrderId = order.rawOrderData.result.order_id;
                        this.logger.info(`[${this.exchangeName}] Using Kraken order ID ${krakenOrderId} from rawOrderData (WebSocket v2 format)`);
                    } else {
                        this.logger.warn(`[${this.exchangeName}] Could not find exchange order ID for ${orderId}, will try with client order ID`);
                        // Try using cl_ord_id if we have clientOrderId
                        if (order.clientOrderId) {
                            krakenOrderId = order.clientOrderId;
                            this.logger.info(`[${this.exchangeName}] Using client order ID ${krakenOrderId} for cancellation`);
                        }
                    }
                } else {
                    this.logger.warn(`[${this.exchangeName}] Order ${orderId} not found in Redis`);
                }
                
                // Create cancel order message for Kraken v2
                const cancelMessage = {
                    method: 'cancel_order',
                    params: {
                        order_id: [krakenOrderId], // Use the real Kraken order ID
                        cl_ord_id: params.clientOrderId ? [params.clientOrderId] : undefined,
                        token: this.token // Add authentication token
                    },
                    req_id: reqId
                };
                
                // Send cancel request
                this.ws.send(JSON.stringify(cancelMessage));
                
                // Wait for response with timeout
                const response = await this._waitForResponse(reqId, 'cancel_order', 10000);
                
                if (response.error) {
                    throw new Error(`Exchange error: ${response.error_message || JSON.stringify(response.error)}`);
                }
                
                this.logger.info(`[${this.exchangeName}] Live order ${orderId} cancelled successfully on exchange`);
                
                // The order status update will come through the execution report
                // via the normal WebSocket message flow
                
                return {
                    id: orderId,
                    status: 'CANCELLED',
                    success: true,
                    response: response.result
                };
            }
        } catch (error) {
            this.logger.error(`[${this.exchangeName}] Error cancelling order ${orderId}:`, error);
            throw error;
        }
    }

    /**
     * Waits for a response to a specific request
     * @private
     * @param {Number} reqId - Request ID to wait for
     * @param {String} method - Method name for logging
     * @param {Number} timeout - Timeout in milliseconds
     * @returns {Promise<Object>} - Response message
     */
    async _waitForResponse(reqId, method, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeListener('response', responseHandler);
                reject(new Error(`Timeout waiting for ${method} response`));
            }, timeout);
            
            const responseHandler = (message) => {
                if (message.req_id === reqId) {
                    clearTimeout(timer);
                    this.removeListener('response', responseHandler);
                    resolve(message);
                }
            };
            
            this.on('response', responseHandler);
        });
    }

    /**
     * Cancels all open buy orders managed by this adapter
     * @param {String} reason - Reason for cancellation
     * @returns {Promise<Array<Object>>} - Array of canceled order results
     */
    async cancelOpenBuyOrders(reason = 'SESSION_CLEANUP') {
        this.logger.info(`[${this.exchangeName}] Cancelling all open buy orders. Reason: ${reason}`);
        
        try {
            // Get all orders from the Redis order manager and filter for open orders
            const allOrders = await this.redisOrderManager.getAll();
            const openOrders = allOrders.filter(order => 
                order.status === 'OPEN' || order.status === 'open'
            );
            
            // Filter for buy orders
            const openBuyOrders = openOrders.filter(order => 
                order.side === 'buy'
            );
            
            this.logger.info(`[${this.exchangeName}] Found ${openBuyOrders.length} open buy orders to cancel`);
            
            const results = [];
            
            if (openBuyOrders.length === 0) {
                return results;
            }
            
            // Handle paper trading - batch update in Redis
            if (this.tradingMode === 'paper') {
                this.logger.info(`[${this.exchangeName}] Paper trading: Batch cancelling ${openBuyOrders.length} orders in Redis`);
                
                const now = Date.now();
                const cancelPromises = openBuyOrders.map(async (order) => {
                    try {
                        const updatedOrder = {
                            ...order,
                            status: 'CANCELLED',
                            canceledAt: now,
                            lastUpdated: now,
                            cancelReason: reason
                        };
                        
                        await this.redisOrderManager.update(updatedOrder);
                        
                        // Emit order status changed event
                        this.emit('orderStatusChanged', {
                            orderId: order.id,
                            clientOrderId: order.clientOrderId,
                            status: 'CANCELLED',
                            timestamp: now,
                            reason: reason
                        });
                        
                        return {
                            orderId: order.id,
                            success: true,
                            result: { id: order.id, status: 'CANCELLED' }
                        };
                    } catch (error) {
                        this.logger.error(`[${this.exchangeName}] Failed to cancel paper order ${order.id}:`, error);
                        return {
                            orderId: order.id,
                            success: false,
                            error: error.message
                        };
                    }
                });
                
                const batchResults = await Promise.all(cancelPromises);
                return batchResults;
                
            } else {
                // Live trading - use batch cancellation if available
                if (this._restClient && typeof this._restClient.cancelOrderBatch === 'function') {
                    this.logger.info(`[${this.exchangeName}] Live trading: Using batch cancellation for ${openBuyOrders.length} orders`);
                    
                    // Extract Kraken order IDs
                    const krakenOrderIds = [];
                    const orderIdMap = new Map(); // Map Kraken IDs back to our internal IDs
                    
                    for (const order of openBuyOrders) {
                        let krakenOrderId = order.id;
                        if (order.rawOrderData && order.rawOrderData.result && order.rawOrderData.result.order_id) {
                            krakenOrderId = order.rawOrderData.result.order_id;
                        }
                        krakenOrderIds.push(krakenOrderId);
                        orderIdMap.set(krakenOrderId, order.id);
                    }
                    
                    // Cancel in batches of 50 (Kraken's limit)
                    const chunkSize = 50;
                    for (let i = 0; i < krakenOrderIds.length; i += chunkSize) {
                        const chunk = krakenOrderIds.slice(i, i + chunkSize);
                        
                        try {
                            const batchResponse = await this._restClient.cancelOrderBatch(chunk);
                            
                            if (batchResponse.result) {
                                for (let j = 0; j < batchResponse.result.length; j++) {
                                    const result = batchResponse.result[j];
                                    const krakenId = chunk[j];
                                    const internalId = orderIdMap.get(krakenId);
                                    
                                    if (result.success) {
                                        results.push({
                                            orderId: internalId,
                                            success: true,
                                            result: { id: internalId, status: 'CANCELLED' }
                                        });
                                        
                                        // Update order status in Redis
                                        try {
                                            const order = openBuyOrders.find(o => o.id === internalId);
                                            if (order) {
                                                const updatedOrder = {
                                                    ...order,
                                                    status: 'CANCELLED',
                                                    canceledAt: Date.now(),
                                                    lastUpdated: Date.now(),
                                                    cancelReason: reason
                                                };
                                                await this.redisOrderManager.update(updatedOrder);
                                                
                                                // Emit order status changed event
                                                this.emit('orderStatusChanged', {
                                                    orderId: order.id,
                                                    clientOrderId: order.clientOrderId,
                                                    status: 'CANCELLED',
                                                    timestamp: Date.now(),
                                                    reason: reason
                                                });
                                                
                                                this.logger.debug(`[${this.exchangeName}] Updated Redis order status for ${internalId}`);
                                            }
                                        } catch (updateError) {
                                            this.logger.error(`[${this.exchangeName}] Failed to update Redis for cancelled order ${internalId}:`, updateError);
                                        }
                                    } else {
                                        results.push({
                                            orderId: internalId,
                                            success: false,
                                            error: result.error || 'Unknown error'
                                        });
                                    }
                                }
                            }
                        } catch (batchError) {
                            this.logger.error(`[${this.exchangeName}] Batch cancellation failed:`, batchError);
                            
                            // Fall back to individual cancellation for this chunk
                            for (const krakenId of chunk) {
                                const internalId = orderIdMap.get(krakenId);
                                const order = openBuyOrders.find(o => o.id === internalId);
                                
                                try {
                                    const result = await this.cancelOrder(internalId, { reason });
                                    results.push({
                                        orderId: internalId,
                                        success: true,
                                        result
                                    });
                                } catch (error) {
                                    this.logger.error(`[${this.exchangeName}] Failed to cancel order ${internalId}:`, error);
                                    results.push({
                                        orderId: internalId,
                                        success: false,
                                        error: error.message
                                    });
                                }
                            }
                        }
                    }
                } else {
                    // Fallback to individual cancellation
                    this.logger.warn(`[${this.exchangeName}] Batch cancellation not available, falling back to individual cancellation`);
                    
                    for (const order of openBuyOrders) {
                        try {
                            const result = await this.cancelOrder(order.id, { reason });
                            results.push({
                                orderId: order.id,
                                success: true,
                                result
                            });
                        } catch (error) {
                            this.logger.error(`[${this.exchangeName}] Failed to cancel order ${order.id}:`, error);
                            results.push({
                                orderId: order.id,
                                success: false,
                                error: error.message
                            });
                        }
                    }
                }
            }
            
            this.logger.info(`[${this.exchangeName}] Buy order cancellation complete.`, {
                total: openBuyOrders.length,
                successful: results.filter(r => r.success).length,
                failed: results.filter(r => !r.success).length
            });
            
            return results;
        } catch (error) {
            this.logger.error(`[${this.exchangeName}] Error in cancelOpenBuyOrders:`, error);
            throw error;
        }
    }

    /**
     * Cancels all managed open orders on the exchange
     * @param {String} reason - The reason for cancelling all orders
     * @returns {Promise<Array<Object>>} - Array of cancellation results
     */
    async cancelAllManagedOrders(reason = 'SESSION_CLEANUP') {
        this.logger.info(`[${this.exchangeName}] Cancelling all open orders. Reason: ${reason}`);
        
        try {
            // Get all orders from the Redis order manager and filter for open orders
            const allOrders = await this.redisOrderManager.getAll();
            const openOrders = allOrders.filter(order => 
                order.status === 'OPEN' || order.status === 'open'
            );
            
            this.logger.info(`[${this.exchangeName}] Found ${openOrders.length} open orders to cancel`);
            
            const results = [];
            
            if (openOrders.length === 0) {
                return results;
            }
            
            // Handle paper trading - batch update in Redis
            if (this.tradingMode === 'paper') {
                this.logger.info(`[${this.exchangeName}] Paper trading: Batch cancelling ${openOrders.length} orders in Redis`);
                
                const now = Date.now();
                const cancelPromises = openOrders.map(async (order) => {
                    try {
                        const updatedOrder = {
                            ...order,
                            status: 'CANCELLED',
                            canceledAt: now,
                            lastUpdated: now,
                            cancelReason: reason
                        };
                        
                        await this.redisOrderManager.update(updatedOrder);
                        
                        // Emit order status changed event
                        this.emit('orderStatusChanged', {
                            orderId: order.id,
                            clientOrderId: order.clientOrderId,
                            status: 'CANCELLED',
                            timestamp: now,
                            reason: reason
                        });
                        
                        return {
                            orderId: order.id,
                            success: true,
                            result: { id: order.id, status: 'CANCELLED' }
                        };
                    } catch (error) {
                        this.logger.error(`[${this.exchangeName}] Failed to cancel paper order ${order.id}:`, error);
                        return {
                            orderId: order.id,
                            success: false,
                            error: error.message
                        };
                    }
                });
                
                const batchResults = await Promise.all(cancelPromises);
                return batchResults;
                
            } else {
                // Live trading - use batch cancellation if available
                if (this._restClient && typeof this._restClient.cancelOrderBatch === 'function') {
                    this.logger.info(`[${this.exchangeName}] Live trading: Using batch cancellation for ${openOrders.length} orders`);
                    
                    // Extract Kraken order IDs
                    const krakenOrderIds = [];
                    const orderIdMap = new Map(); // Map Kraken IDs back to our internal IDs
                    
                    for (const order of openOrders) {
                        let krakenOrderId = order.id;
                        if (order.rawOrderData && order.rawOrderData.result && order.rawOrderData.result.order_id) {
                            krakenOrderId = order.rawOrderData.result.order_id;
                        }
                        krakenOrderIds.push(krakenOrderId);
                        orderIdMap.set(krakenOrderId, order.id);
                    }
                    
                    // Cancel in batches of 50 (Kraken's limit)
                    const chunkSize = 50;
                    for (let i = 0; i < krakenOrderIds.length; i += chunkSize) {
                        const chunk = krakenOrderIds.slice(i, i + chunkSize);
                        
                        try {
                            const batchResponse = await this._restClient.cancelOrderBatch(chunk);
                            
                            if (batchResponse.result) {
                                for (let j = 0; j < batchResponse.result.length; j++) {
                                    const result = batchResponse.result[j];
                                    const krakenId = chunk[j];
                                    const internalId = orderIdMap.get(krakenId);
                                    
                                    if (result.success) {
                                        results.push({
                                            orderId: internalId,
                                            success: true,
                                            result: { id: internalId, status: 'CANCELLED' }
                                        });
                                        
                                        // Update order status in Redis
                                        try {
                                            const order = openOrders.find(o => o.id === internalId);
                                            if (order) {
                                                const updatedOrder = {
                                                    ...order,
                                                    status: 'CANCELLED',
                                                    canceledAt: Date.now(),
                                                    lastUpdated: Date.now(),
                                                    cancelReason: reason
                                                };
                                                await this.redisOrderManager.update(updatedOrder);
                                                
                                                // Emit order status changed event
                                                this.emit('orderStatusChanged', {
                                                    orderId: order.id,
                                                    clientOrderId: order.clientOrderId,
                                                    status: 'CANCELLED',
                                                    timestamp: Date.now(),
                                                    reason: reason
                                                });
                                                
                                                this.logger.debug(`[${this.exchangeName}] Updated Redis order status for ${internalId}`);
                                            }
                                        } catch (updateError) {
                                            this.logger.error(`[${this.exchangeName}] Failed to update Redis for cancelled order ${internalId}:`, updateError);
                                        }
                                    } else {
                                        results.push({
                                            orderId: internalId,
                                            success: false,
                                            error: result.error || 'Unknown error'
                                        });
                                    }
                                }
                            }
                        } catch (batchError) {
                            this.logger.error(`[${this.exchangeName}] Batch cancellation failed:`, batchError);
                            
                            // Fall back to individual cancellation for this chunk
                            for (const krakenId of chunk) {
                                const internalId = orderIdMap.get(krakenId);
                                
                                try {
                                    const result = await this.cancelOrder(internalId, { reason });
                                    results.push({
                                        orderId: internalId,
                                        success: true,
                                        result
                                    });
                                } catch (error) {
                                    this.logger.error(`[${this.exchangeName}] Failed to cancel order ${internalId}:`, error);
                                    results.push({
                                        orderId: internalId,
                                        success: false,
                                        error: error.message
                                    });
                                }
                            }
                        }
                    }
                } else {
                    // Fallback to individual cancellation
                    this.logger.warn(`[${this.exchangeName}] Batch cancellation not available, falling back to individual cancellation`);
                    
                    for (const order of openOrders) {
                        try {
                            const result = await this.cancelOrder(order.id, { reason });
                            results.push({
                                orderId: order.id,
                                success: true,
                                result
                            });
                        } catch (error) {
                            this.logger.error(`[${this.exchangeName}] Failed to cancel order ${order.id}:`, error);
                            results.push({
                                orderId: order.id,
                                success: false,
                                error: error.message
                            });
                        }
                    }
                }
            }
            
            this.logger.info(`[${this.exchangeName}] Order cancellation complete.`, {
                total: openOrders.length,
                successful: results.filter(r => r.success).length,
                failed: results.filter(r => !r.success).length
            });
            
            return results;
        } catch (error) {
            this.logger.error(`[${this.exchangeName}] Error in cancelAllManagedOrders:`, error);
            throw error;
        }
    }

    // Add new websocket connection monitoring method at the end of the file
    _monitorWebSocketConnection() {
        const LIVENESS_CHECK_INTERVAL_MS = 60000; // Check every minute
        
        setInterval(() => {
            const currentTime = new Date().toISOString();
            const privateConnected = this.connectionState === 'connected';
            const publicConnected = this.publicConnectionState === 'connected';
            const timeSinceLastPrivate = Date.now() - this.lastPrivateMessageTimestamp;
            const timeSinceLastPublic = Date.now() - this.lastPublicMessageTimestamp;
            
            this.logger.info(`[WEBSOCKET_MONITOR] [${currentTime}] WebSocket Connection Status:`, {
                privateConnected,
                publicConnected,
                timeSinceLastPrivateMsg: `${Math.round(timeSinceLastPrivate/1000)}s ago`,
                timeSinceLastPublicMsg: `${Math.round(timeSinceLastPublic/1000)}s ago`,
            });
        }, LIVENESS_CHECK_INTERVAL_MS);
    }
}