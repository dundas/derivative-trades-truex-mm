/**
 * Default configuration for TrueX Market Maker
 * 
 * This configuration is based on the Python reference implementation
 * and adapted for JavaScript/TypeScript
 */

export const defaultConfig = {
    // Trading symbols
    symbols: ['BTC-PYUSD', 'ETH-PYUSD'],
    
    // Order configuration
    orderPairs: 6,                    // Number of order pairs to maintain
    orderStartSize: 0.1,              // Size of first order
    orderStepSize: 0.1,               // Size increment per level
    interval: 0.01,                   // 1% interval between orders
    minSpread: 0.005,                 // 0.5% minimum spread
    maintainSpreads: true,            // Work orders from inside spread outward
    relistInterval: 0.01,             // 1% price change before relisting
    
    // Position limits
    checkPositionLimits: false,
    minPosition: -10000,              // Maximum short position
    maxPosition: 10000,               // Maximum long position
    
    // Trading behavior
    postOnly: false,                  // Use post-only orders
    cancelOrdersOnStart: false,       // Cancel existing orders on startup
    cancelOrdersOnExit: true,         // Cancel orders on shutdown
    
    // Random order sizing
    randomOrderSize: false,           // Use random order sizes
    minOrderSize: 0.05,               // Minimum order size (if random)
    maxOrderSize: 0.5,                // Maximum order size (if random)
    
    // Tick sizes
    tickSize: 0.50,                   // Default price tick size
    quoteSize: 0.0001,                // Quantity precision
    
    // Operational
    loopInterval: 5000,               // 5 seconds between updates
    apiRestInterval: 1000,            // 1 second between REST calls
    apiErrorInterval: 10000,          // 10 seconds after errors
    timeout: 7000,                    // API timeout
    
    // WebSocket subscriptions
    wsChannels: ['INSTRUMENT', 'EBBO', 'TRADE'],
    
    // Order ID prefix
    orderIdPrefix: 'mm-trx-',
    
    // Logging
    logLevel: 'info',
    
    // Environment
    environment: 'uat',               // 'uat' or 'production'
};

/**
 * Symbol-specific configurations
 * Override default settings for specific symbols
 */
export const symbolConfigs = {
    'BTC-PYUSD': {
        orderStartSize: 0.01,
        orderStepSize: 0.01,
        tickSize: 1.00,
        minSpread: 0.003,             // Tighter spread for BTC
    },
    'ETH-PYUSD': {
        orderStartSize: 0.1,
        orderStepSize: 0.1,
        tickSize: 0.50,
        minSpread: 0.005,
    }
};

/**
 * Environment-specific configurations
 */
export const environmentConfigs = {
    uat: {
        wsUrl: 'wss://uat.truex.co/api/v1',
        restUrl: 'https://uat.truex.co/api/v1',
    },
    production: {
        wsUrl: 'wss://prod.truex.co/api/v1',
        restUrl: 'https://prod.truex.co/api/v1',
    }
};

/**
 * Get configuration for a specific symbol
 * @param {string} symbol - Trading symbol
 * @param {object} overrides - Configuration overrides
 * @returns {object} - Merged configuration
 */
export function getConfig(symbol, overrides = {}) {
    const baseConfig = { ...defaultConfig };
    const symbolConfig = symbolConfigs[symbol] || {};
    const envConfig = environmentConfigs[baseConfig.environment] || {};
    
    return {
        ...baseConfig,
        ...envConfig,
        ...symbolConfig,
        ...overrides,
        symbol
    };
}

export default {
    defaultConfig,
    symbolConfigs,
    environmentConfigs,
    getConfig
};