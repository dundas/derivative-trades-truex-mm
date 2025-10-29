import axios from 'axios';
import crypto from 'crypto';

const DEFAULT_TRUEX_UAT_REST_URL = 'https://uat.truex.co/api/v1';
const DEFAULT_TRUEX_PROD_REST_URL = 'https://prod.truex.co/api/v1';

/**
 * TrueX REST API Adapter
 * 
 * Handles REST API interactions with TrueX exchange
 * for order management and account operations
 */
export class TrueXRESTAdapter {
    constructor(config = {}) {
        this.apiKey = config.apiKey;
        this.apiSecret = config.apiSecret;
        this.organizationId = config.organizationId;
        this.environment = config.environment || 'uat';
        this.baseUrl = config.baseUrl || (this.environment === 'production' ? DEFAULT_TRUEX_PROD_REST_URL : DEFAULT_TRUEX_UAT_REST_URL);
        this.logger = config.logger || console;
        this.timeout = config.timeout || 10000;
        
        // Order ID prefix for tracking
        this.orderIdPrefix = config.orderIdPrefix || 'mm-trx-';
        this.orderNode = 0;
        
        // Create axios instance
        this.client = axios.create({
            baseURL: this.baseUrl,
            timeout: this.timeout,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        // Add request interceptor for authentication
        this.client.interceptors.request.use(
            (config) => this._addAuthentication(config),
            (error) => Promise.reject(error)
        );
        
        // Add response interceptor for error handling
        this.client.interceptors.response.use(
            (response) => response,
            (error) => this._handleError(error)
        );
        
        this.logger.info('TrueXRESTAdapter initialized', {
            environment: this.environment,
            baseUrl: this.baseUrl
        });
    }
    
    /**
     * Add authentication to request
     */
    _addAuthentication(config) {
        if (!this.apiKey || !this.apiSecret) {
            return config;
        }
        
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const method = config.method.toUpperCase();
        const path = config.url;
        
        // Create signature payload
        const payload = `${timestamp}${method}${path}`;
        if (config.data) {
            payload += JSON.stringify(config.data);
        }
        
        // Generate HMAC signature
        const signature = crypto
            .createHmac('sha256', this.apiSecret)
            .update(payload)
            .digest('base64');
        
        // Add authentication headers
        config.headers['X-API-KEY'] = this.apiKey;
        config.headers['X-API-SIGNATURE'] = signature;
        config.headers['X-API-TIMESTAMP'] = timestamp;
        config.headers['X-ORGANIZATION-ID'] = this.organizationId;
        
        return config;
    }
    
    /**
     * Handle API errors
     */
    _handleError(error) {
        if (error.response) {
            this.logger.error('API error', {
                status: error.response.status,
                data: error.response.data,
                headers: error.response.headers
            });
            
            const apiError = new Error(error.response.data?.message || `API error: ${error.response.status}`);
            apiError.status = error.response.status;
            apiError.data = error.response.data;
            throw apiError;
        } else if (error.request) {
            this.logger.error('Network error', { error: error.message });
            throw new Error(`Network error: ${error.message}`);
        } else {
            this.logger.error('Request error', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Get client information
     */
    async getClient(apiKey) {
        try {
            const response = await this.client.get('/clients');
            const clients = response.data;
            
            // Find matching client by API key
            for (const client of clients) {
                if (client.info?.mnemonic === apiKey || client.id === apiKey) {
                    return client.id;
                }
            }
            
            throw new Error('No matching client found');
            
        } catch (error) {
            this.logger.error('Failed to get client', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Get instruments
     */
    async getInstruments() {
        try {
            const response = await this.client.get('/instruments');
            return response.data;
        } catch (error) {
            this.logger.error('Failed to get instruments', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Check if market is open
     */
    async isMarketOpen(symbol) {
        try {
            const response = await this.client.get(`/market-status/${symbol}`);
            return response.data.isOpen;
        } catch (error) {
            // Default to open if endpoint doesn't exist
            this.logger.warn('Failed to check market status, assuming open', { error: error.message });
            return true;
        }
    }
    
    /**
     * Get ticker
     */
    async getTicker(symbol) {
        try {
            const response = await this.client.get(`/ticker/${symbol}`);
            const data = response.data;
            
            return {
                symbol,
                bid: parseFloat(data.bid),
                ask: parseFloat(data.ask),
                last: parseFloat(data.last),
                volume: parseFloat(data.volume)
            };
        } catch (error) {
            this.logger.error('Failed to get ticker', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Get position
     */
    async getPosition(symbol) {
        try {
            const response = await this.client.get(`/positions/${symbol}`);
            return response.data;
        } catch (error) {
            this.logger.error('Failed to get position', { error: error.message });
            return { symbol, qty: 0 };
        }
    }
    
    /**
     * Get balances
     */
    async getBalances() {
        try {
            const response = await this.client.get('/balances');
            return response.data;
        } catch (error) {
            this.logger.error('Failed to get balances', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Get open orders
     */
    async getOpenOrders() {
        try {
            const response = await this.client.get('/orders/open');
            return response.data;
        } catch (error) {
            this.logger.error('Failed to get open orders', { error: error.message });
            throw error;
        }
    }
    
    /**
     * Create order
     */
    async createOrder(orderDetails) {
        const orderId = this._generateOrderId();
        
        try {
            const orderPayload = {
                client_id: orderDetails.client_id,
                instrument_id: orderDetails.instrument_id || orderDetails.symbol,
                side: orderDetails.side,
                order_type: 'LIMIT',
                price: orderDetails.price,
                qty: orderDetails.qty,
                external_id: orderId,
                time_in_force: 'GTC'
            };
            
            if (this.config.postOnly) {
                orderPayload.exec_inst = 'POST_ONLY';
            }
            
            const response = await this.client.post('/orders', orderPayload);
            const order = response.data;
            
            this.logger.info('Created order', {
                id: order.id,
                side: order.side,
                price: order.price,
                qty: order.qty
            });
            
            return order;
            
        } catch (error) {
            this.logger.error('Failed to create order', {
                error: error.message,
                orderDetails
            });
            throw error;
        }
    }
    
    /**
     * Amend order
     */
    async amendOrder(amendment) {
        try {
            const response = await this.client.put(`/orders/${amendment.id}`, {
                price: amendment.price,
                qty: amendment.qty
            });
            
            this.logger.info('Amended order', {
                id: amendment.id,
                price: amendment.price,
                qty: amendment.qty
            });
            
            return response.data;
            
        } catch (error) {
            this.logger.error('Failed to amend order', {
                error: error.message,
                amendment
            });
            throw error;
        }
    }
    
    /**
     * Cancel order
     */
    async cancelOrder(orderId) {
        try {
            const response = await this.client.delete(`/orders/${orderId}`);
            
            this.logger.info('Cancelled order', { id: orderId });
            
            return response.data;
            
        } catch (error) {
            this.logger.error('Failed to cancel order', {
                error: error.message,
                orderId
            });
            throw error;
        }
    }
    
    /**
     * Create multiple orders
     */
    async createOrders(orders) {
        const results = [];
        
        for (const order of orders) {
            try {
                const result = await this.createOrder(order);
                results.push(result);
            } catch (error) {
                this.logger.error('Failed to create order in batch', {
                    error: error.message,
                    order
                });
            }
        }
        
        return results;
    }
    
    /**
     * Amend multiple orders
     */
    async amendOrders(amendments) {
        const results = [];
        
        for (const amendment of amendments) {
            try {
                const result = await this.amendOrder(amendment);
                results.push(result);
            } catch (error) {
                this.logger.error('Failed to amend order in batch', {
                    error: error.message,
                    amendment
                });
            }
        }
        
        return results;
    }
    
    /**
     * Generate unique order ID
     */
    _generateOrderId() {
        const timestamp = Date.now();
        const node = this.orderNode++;
        return `${this.orderIdPrefix}${timestamp}-${node}`;
    }
    
    /**
     * Clean up resources
     */
    async cleanup() {
        // No cleanup needed for real API
    }
}

export default TrueXRESTAdapter;