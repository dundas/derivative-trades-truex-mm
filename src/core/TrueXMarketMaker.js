import { EventEmitter } from 'events';
import { TrueXWebSocketAdapter } from '../utils/exchange/TrueXWebSocketAdapter.js';
import { TrueXRESTAdapter } from './TrueXRESTAdapter.js';
import { getQuoteTick } from './utils/pricing.js';
// Simple logger implementation for TrueX
function createLogger(config = {}) {
    const prefix = `[${config.component || 'TrueXMarketMaker'}${config.symbol ? ':' + config.symbol : ''}]`;
    
    return {
        info: (message, meta) => console.log(`${prefix} INFO:`, message, meta ? JSON.stringify(meta) : ''),
        error: (message, meta) => console.error(`${prefix} ERROR:`, message, meta ? JSON.stringify(meta) : ''),
        warn: (message, meta) => console.warn(`${prefix} WARN:`, message, meta ? JSON.stringify(meta) : ''),
        debug: (message, meta) => console.log(`${prefix} DEBUG:`, message, meta ? JSON.stringify(meta) : '')
    };
}

/**
 * TrueX Market Maker
 * 
 * JavaScript implementation of a market maker for TrueX exchange
 * Based on the Python reference implementation
 */
export class TrueXMarketMaker extends EventEmitter {
    constructor(config = {}) {
        super();
        
        // Configuration with defaults
        this.config = {
            // Exchange configuration
            symbol: config.symbol || 'BTC-PYUSD',
            apiKey: config.apiKey || process.env.TRUEX_API_KEY,
            apiSecret: config.apiSecret || process.env.TRUEX_API_SECRET,
            organizationId: config.organizationId || process.env.TRUEX_ORGANIZATION_ID,
            environment: config.environment || 'uat',
            
            // Order configuration
            orderPairs: config.orderPairs || 6,
            orderStartSize: config.orderStartSize || 0.1,
            orderStepSize: config.orderStepSize || 0.1,
            interval: config.interval || 0.01, // 1%
            minSpread: config.minSpread || 0.005, // 0.5%
            maintainSpreads: config.maintainSpreads !== undefined ? config.maintainSpreads : true,
            relistInterval: config.relistInterval || 0.01, // 1%
            
            // Position limits
            checkPositionLimits: config.checkPositionLimits || false,
            minPosition: config.minPosition || -10000,
            maxPosition: config.maxPosition || 10000,
            
            // Trading behavior
            postOnly: config.postOnly || false,
            cancelOrdersOnStart: config.cancelOrdersOnStart || false,
            cancelOrdersOnExit: config.cancelOrdersOnExit !== undefined ? config.cancelOrdersOnExit : true,
            
            // Operational
            loopInterval: config.loopInterval || 5000, // 5 seconds
            randomOrderSize: config.randomOrderSize || false,
            minOrderSize: config.minOrderSize || 0.05,
            maxOrderSize: config.maxOrderSize || 0.5,
            
            // Tick sizes
            tickSize: config.tickSize || 0.50,
            quoteSize: config.quoteSize || 0.0001,
            
            ...config
        };
        
        // Logger
        this.logger = config.logger || createLogger({
            component: 'TrueXMarketMaker',
            symbol: this.config.symbol
        });
        
        // State
        this.running = false;
        this.quoting = false;
        this.loopTimer = null;
        this.activeOrders = new Map();
        this.instrumentId = null;
        this.clientId = null;
        
        // Position tracking
        this.startPositionBuy = null;
        this.startPositionSell = null;
        this.startPositionMid = null;
        
        // Exchange adapters
        this.wsAdapter = null;
        this.restAdapter = null;
        
        // Market data
        this.marketData = {
            ticker: null,
            orderBook: null,
            position: { qty: 0 },
            lastUpdate: 0
        };
        
        this.logger.info('TrueXMarketMaker initialized', {
            symbol: this.config.symbol,
            environment: this.config.environment
        });
    }
    
    /**
     * Start the market maker
     */
    async start() {
        try {
            this.logger.info('Starting TrueX Market Maker');
            
            // Initialize adapters
            await this._initializeAdapters();
            
            // Get client and instrument info
            await this._initializeSession();
            
            // Cancel existing orders if configured
            if (this.config.cancelOrdersOnStart) {
                await this.cancelAllOrders();
            }
            
            // Set up exit handlers
            this._setupExitHandlers();
            
            // Start the main loop
            this.running = true;
            await this._runLoop();
            
            this.logger.info('Market maker started successfully');
            
        } catch (error) {
            this.logger.error('Failed to start market maker', {
                error: error.message,
                stack: error.stack
            });
            throw error;
        }
    }
    
    /**
     * Stop the market maker
     */
    async stop() {
        try {
            this.logger.info('Stopping market maker');
            this.running = false;
            
            if (this.loopTimer) {
                clearTimeout(this.loopTimer);
                this.loopTimer = null;
            }
            
            if (this.config.cancelOrdersOnExit) {
                await this.cancelAllOrders();
            }
            
            // Cleanup adapters
            if (this.wsAdapter) {
                await this.wsAdapter.cleanup();
            }
            if (this.restAdapter) {
                await this.restAdapter.cleanup();
            }
            
            this.logger.info('Market maker stopped');
            
        } catch (error) {
            this.logger.error('Error stopping market maker', {
                error: error.message
            });
        }
    }
    
    /**
     * Initialize exchange adapters
     */
    async _initializeAdapters() {
        // Initialize WebSocket adapter for real-time data
        this.wsAdapter = new TrueXWebSocketAdapter({
            symbol: this.config.symbol,
            apiKey: this.config.apiKey,
            apiSecret: this.config.apiSecret,
            organizationId: this.config.organizationId,
            environment: this.config.environment,
            logger: this.logger
        });
        
        // Initialize REST adapter for order management
        this.restAdapter = new TrueXRESTAdapter({
            apiKey: this.config.apiKey,
            apiSecret: this.config.apiSecret,
            organizationId: this.config.organizationId,
            environment: this.config.environment,
            logger: this.logger
        });
        
        // Set up event listeners
        this._setupEventListeners();
        
        // Connect WebSocket
        await this.wsAdapter.connect();
        await this._waitForConnection();
    }
    
    /**
     * Initialize session data
     */
    async _initializeSession() {
        try {
            // Get client ID
            this.clientId = await this.restAdapter.getClient(this.config.apiKey);
            this.logger.info('Retrieved client ID', { clientId: this.clientId });
            
            // Get instrument data
            const instruments = await this.restAdapter.getInstruments();
            const instrument = instruments.find(i => i.symbol === this.config.symbol);
            
            if (!instrument) {
                throw new Error(`Instrument ${this.config.symbol} not found`);
            }
            
            this.instrumentId = instrument.id;
            this.logger.info('Retrieved instrument ID', {
                symbol: this.config.symbol,
                instrumentId: this.instrumentId
            });
            
            // Subscribe to market data
            await this.wsAdapter.subscribe(
                ['INSTRUMENT', 'EBBO', 'TRADE'],
                [this.config.symbol]
            );
            
        } catch (error) {
            this.logger.error('Failed to initialize session', {
                error: error.message
            });
            throw error;
        }
    }
    
    /**
     * Set up WebSocket event listeners
     */
    _setupEventListeners() {
        this.wsAdapter.on('ticker', (ticker) => {
            this.marketData.ticker = ticker;
            this.marketData.lastUpdate = Date.now();
        });
        
        this.wsAdapter.on('orderbook', (orderbook) => {
            this.marketData.orderBook = orderbook;
        });
        
        this.wsAdapter.on('trade', (trade) => {
            // Update last trade price
            if (this.marketData.ticker) {
                this.marketData.ticker.last = trade.price;
            }
        });
        
        this.wsAdapter.on('error', (error) => {
            this.logger.error('WebSocket error', { error: error.message });
        });
        
        this.wsAdapter.on('disconnect', () => {
            this.logger.warn('WebSocket disconnected');
            this.quoting = false;
        });
        
        this.wsAdapter.on('connect', () => {
            this.logger.info('WebSocket connected');
        });
    }
    
    /**
     * Set up exit handlers
     */
    _setupExitHandlers() {
        const exitHandler = async () => {
            await this.stop();
            process.exit(0);
        };
        
        process.on('SIGINT', exitHandler);
        process.on('SIGTERM', exitHandler);
    }
    
    /**
     * Wait for WebSocket connection
     */
    async _waitForConnection() {
        const maxWaitTime = 30000; // 30 seconds
        const startTime = Date.now();
        
        while (!this.wsAdapter.isConnected && Date.now() - startTime < maxWaitTime) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (!this.wsAdapter.isConnected) {
            throw new Error('Failed to establish WebSocket connection');
        }
    }
    
    /**
     * Main trading loop
     */
    async _runLoop() {
        while (this.running) {
            try {
                // Check market status
                await this._checkMarket();
                
                // Only quote if market is open
                if (this.quoting) {
                    // Perform sanity checks
                    await this._checkSanity();
                    
                    // Place orders
                    await this._placeOrders();
                    
                    // Print status
                    this._printStatus();
                }
                
            } catch (error) {
                this.logger.error('Error in main loop', {
                    error: error.message,
                    stack: error.stack
                });
            }
            
            // Wait for next iteration
            if (this.running) {
                await new Promise(resolve => {
                    this.loopTimer = setTimeout(resolve, this.config.loopInterval);
                });
            }
        }
    }
    
    /**
     * Check if market is open
     */
    async _checkMarket() {
        try {
            const isOpen = await this.restAdapter.isMarketOpen(this.config.symbol);
            
            if (!isOpen) {
                if (this.quoting) {
                    this.logger.warn('Market is closed, stopping quotes');
                    this.quoting = false;
                }
            } else if (!this.quoting) {
                this.logger.info('Market is open, starting quotes');
                this.quoting = true;
                
                // Subscribe to market data if needed
                if (this.wsAdapter.subscriptions.channels.size === 0) {
                    await this.wsAdapter.subscribe(
                        ['INSTRUMENT', 'EBBO', 'TRADE'],
                        [this.config.symbol]
                    );
                }
            }
        } catch (error) {
            this.logger.error('Error checking market status', {
                error: error.message
            });
        }
    }
    
    /**
     * Perform sanity checks
     */
    async _checkSanity() {
        try {
            // Get current ticker
            const ticker = await this._getTicker();
            
            if (!ticker || !ticker.bid || !ticker.ask) {
                throw new Error('Invalid ticker data');
            }
            
            // Set up start positions
            this.startPositionBuy = ticker.bid + getQuoteTick(ticker.bid, this.config.tickSize);
            this.startPositionSell = ticker.ask - getQuoteTick(ticker.ask, this.config.tickSize);
            
            // Maintain spreads if configured
            if (this.config.maintainSpreads) {
                const highestBuy = await this._getHighestBuy();
                const lowestSell = await this._getLowestSell();
                
                if (highestBuy && ticker.bid === highestBuy.price) {
                    this.startPositionBuy = ticker.bid;
                }
                if (lowestSell && ticker.ask === lowestSell.price) {
                    this.startPositionSell = ticker.ask;
                }
            }
            
            // Back off if spread is too small
            if (this.startPositionBuy * (1.00 + this.config.minSpread) > this.startPositionSell) {
                this.startPositionBuy *= (1.00 - (this.config.minSpread / 2));
                this.startPositionBuy = this._toNearest(this.startPositionBuy, getQuoteTick(this.startPositionBuy, this.config.tickSize));
                this.startPositionSell *= (1.00 + (this.config.minSpread / 2));
                this.startPositionSell = this._toNearest(this.startPositionSell, getQuoteTick(this.startPositionSell, this.config.tickSize));
            }
            
            // Midpoint
            this.startPositionMid = (ticker.bid + ticker.ask) / 2;
            
            this.logger.debug('Start positions', {
                buy: this.startPositionBuy,
                sell: this.startPositionSell,
                mid: this.startPositionMid
            });
            
            // Check position limits
            if (this.config.checkPositionLimits) {
                await this._checkPositionLimits();
            }
            
        } catch (error) {
            this.logger.error('Sanity check failed', {
                error: error.message
            });
            throw error;
        }
    }
    
    /**
     * Get current ticker
     */
    async _getTicker() {
        // Try WebSocket data first
        if (this.marketData.ticker && Date.now() - this.marketData.lastUpdate < 5000) {
            return this.marketData.ticker;
        }
        
        // Fallback to REST API
        return await this.restAdapter.getTicker(this.config.symbol);
    }
    
    /**
     * Get position
     */
    async _getPosition() {
        try {
            const position = await this.restAdapter.getPosition(this.config.symbol);
            this.marketData.position = position || { qty: 0 };
            return this.marketData.position;
        } catch (error) {
            this.logger.error('Error getting position', { error: error.message });
            return { qty: 0 };
        }
    }
    
    /**
     * Get all orders
     */
    async _getOrders() {
        const orders = await this.restAdapter.getOpenOrders();
        return orders.filter(o => o.instrument_id === this.instrumentId);
    }
    
    /**
     * Get highest buy order
     */
    async _getHighestBuy() {
        const orders = await this._getOrders();
        const buys = orders.filter(o => o.side === 'BUY' || o.side === 'buy');
        
        if (buys.length === 0) {
            return null;
        }
        
        return buys.reduce((highest, order) => {
            const price = parseFloat(order.price);
            return price > parseFloat(highest.price) ? order : highest;
        });
    }
    
    /**
     * Get lowest sell order
     */
    async _getLowestSell() {
        const orders = await this._getOrders();
        const sells = orders.filter(o => o.side === 'SELL' || o.side === 'sell');
        
        if (sells.length === 0) {
            return null;
        }
        
        return sells.reduce((lowest, order) => {
            const price = parseFloat(order.price);
            return price < parseFloat(lowest.price) ? order : lowest;
        });
    }
    
    /**
     * Check position limits
     */
    async _checkPositionLimits() {
        const position = await this._getPosition();
        const currentQty = position.qty || 0;
        
        if (currentQty >= this.config.maxPosition) {
            this.logger.warn('Long position limit exceeded', {
                current: currentQty,
                max: this.config.maxPosition
            });
        }
        
        if (currentQty <= this.config.minPosition) {
            this.logger.warn('Short position limit exceeded', {
                current: currentQty,
                min: this.config.minPosition
            });
        }
    }
    
    /**
     * Place orders
     */
    async _placeOrders() {
        try {
            const buyOrders = [];
            const sellOrders = [];
            
            // Get current position for limit checking
            const position = await this._getPosition();
            const currentQty = position.qty || 0;
            
            // Create orders from outside in
            for (let i = this.config.orderPairs; i >= 1; i--) {
                // Check position limits
                if (!this._longPositionLimitExceeded(currentQty)) {
                    buyOrders.push(this._prepareOrder(-i));
                }
                
                if (!this._shortPositionLimitExceeded(currentQty)) {
                    sellOrders.push(this._prepareOrder(i));
                }
            }
            
            // Converge orders
            await this._convergeOrders(buyOrders, sellOrders);
            
        } catch (error) {
            this.logger.error('Error placing orders', {
                error: error.message
            });
        }
    }
    
    /**
     * Prepare an order
     */
    _prepareOrder(index) {
        let quantity;
        
        if (this.config.randomOrderSize) {
            quantity = Math.random() * (this.config.maxOrderSize - this.config.minOrderSize) + this.config.minOrderSize;
            quantity = Math.round(quantity / this.config.orderStepSize) * this.config.orderStepSize;
        } else {
            quantity = this.config.orderStartSize + ((Math.abs(index) - 1) * this.config.orderStepSize);
        }
        
        // Round to quote size
        quantity = this._toNearest(quantity, this.config.quoteSize);
        
        const price = this._getPriceOffset(index);
        
        return {
            client_id: this.clientId,
            symbol: this.config.symbol,
            price: price.toString(),
            qty: quantity.toString(),
            side: index < 0 ? 'BUY' : 'SELL'
        };
    }
    
    /**
     * Get price for order at index
     */
    _getPriceOffset(index) {
        let startPosition;
        
        if (this.config.maintainSpreads) {
            startPosition = index < 0 ? this.startPositionBuy : this.startPositionSell;
            // Adjust index for maintain spreads mode
            index = index < 0 ? index + 1 : index - 1;
        } else {
            startPosition = index < 0 ? this.startPositionBuy : this.startPositionSell;
        }
        
        const price = startPosition * Math.pow(1 + this.config.interval, Math.abs(index));
        const tickSize = getQuoteTick(price, this.config.tickSize);
        
        return this._toNearest(price, tickSize);
    }
    
    /**
     * Converge orders
     */
    async _convergeOrders(buyOrders, sellOrders) {
        const toAmend = [];
        const toCreate = [];
        const toCancel = [];
        
        let buysMatched = 0;
        let sellsMatched = 0;
        
        const existingOrders = await this._getOrders();
        
        // Match existing orders with desired orders
        for (const order of existingOrders) {
            try {
                let desiredOrder;
                
                if (order.side === 'BUY' || order.side === 'buy') {
                    if (buysMatched < buyOrders.length) {
                        desiredOrder = buyOrders[buysMatched];
                        buysMatched++;
                    }
                } else {
                    if (sellsMatched < sellOrders.length) {
                        desiredOrder = sellOrders[sellsMatched];
                        sellsMatched++;
                    }
                }
                
                if (!desiredOrder) {
                    toCancel.push(order);
                    continue;
                }
                
                // Check if we need to amend
                const priceDiff = Math.abs((parseFloat(desiredOrder.price) / parseFloat(order.price)) - 1);
                const qtyDiff = desiredOrder.qty !== order.leaves_qty;
                
                if (qtyDiff || priceDiff > this.config.relistInterval) {
                    toAmend.push({
                        id: order.id,
                        price: desiredOrder.price,
                        qty: desiredOrder.qty,
                        side: order.side
                    });
                }
                
            } catch (error) {
                this.logger.error('Error matching order', {
                    order: order.id,
                    error: error.message
                });
                toCancel.push(order);
            }
        }
        
        // Create new orders for unmatched desired orders
        while (buysMatched < buyOrders.length) {
            toCreate.push(buyOrders[buysMatched]);
            buysMatched++;
        }
        
        while (sellsMatched < sellOrders.length) {
            toCreate.push(sellOrders[sellsMatched]);
            sellsMatched++;
        }
        
        // Execute amendments
        if (toAmend.length > 0) {
            for (const amendment of toAmend) {
                try {
                    await this.restAdapter.amendOrder(amendment);
                    this.logger.info('Amended order', amendment);
                } catch (error) {
                    this.logger.error('Failed to amend order', {
                        order: amendment,
                        error: error.message
                    });
                }
            }
        }
        
        // Execute creations
        if (toCreate.length > 0) {
            for (const order of toCreate) {
                try {
                    const created = await this.restAdapter.createOrder(order);
                    this.activeOrders.set(created.id, created);
                    this.logger.info('Created order', {
                        side: order.side,
                        qty: order.qty,
                        price: order.price
                    });
                } catch (error) {
                    this.logger.error('Failed to create order', {
                        order,
                        error: error.message
                    });
                }
            }
        }
        
        // Execute cancellations
        if (toCancel.length > 0) {
            for (const order of toCancel) {
                try {
                    await this.restAdapter.cancelOrder(order.id);
                    this.activeOrders.delete(order.id);
                    this.logger.info('Cancelled order', { id: order.id });
                } catch (error) {
                    this.logger.error('Failed to cancel order', {
                        order: order.id,
                        error: error.message
                    });
                }
            }
        }
    }
    
    /**
     * Cancel all orders
     */
    async cancelAllOrders() {
        try {
            const orders = await this._getOrders();
            this.logger.info(`Cancelling ${orders.length} orders`);
            
            for (const order of orders) {
                try {
                    await this.restAdapter.cancelOrder(order.id);
                    this.activeOrders.delete(order.id);
                } catch (error) {
                    this.logger.error('Failed to cancel order', {
                        order: order.id,
                        error: error.message
                    });
                }
            }
            
        } catch (error) {
            this.logger.error('Error cancelling all orders', {
                error: error.message
            });
        }
    }
    
    /**
     * Check if long position limit exceeded
     */
    _longPositionLimitExceeded(currentQty) {
        return this.config.checkPositionLimits && currentQty >= this.config.maxPosition;
    }
    
    /**
     * Check if short position limit exceeded
     */
    _shortPositionLimitExceeded(currentQty) {
        return this.config.checkPositionLimits && currentQty <= this.config.minPosition;
    }
    
    /**
     * Round to nearest multiple
     */
    _toNearest(value, multiple) {
        return Math.round(value / multiple) * multiple;
    }
    
    /**
     * Print current status
     */
    _printStatus() {
        const position = this.marketData.position;
        const orders = Array.from(this.activeOrders.values());
        
        this.logger.info('Market maker status', {
            symbol: this.config.symbol,
            position: position.qty,
            activeOrders: orders.length,
            ticker: {
                bid: this.marketData.ticker?.bid,
                ask: this.marketData.ticker?.ask,
                last: this.marketData.ticker?.last
            }
        });
    }
}

export default TrueXMarketMaker;