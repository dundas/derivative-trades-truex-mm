/**
 * Redis Key Formatter
 * 
 * A utility for generating consistent Redis keys across the application.
 * This enforces a standardized format to prevent format mismatches.
 */

/**
 * Format a trading symbol to lowercase with dash
 * 
 * @param {string} symbol - The trading symbol (e.g., 'BTC/USD')
 * @returns {string} Formatted symbol (e.g., 'btc-usd')
 */
export function formatSymbol(symbol) {
  if (!symbol) return '';
  
  // Remove any spaces
  const trimmedSymbol = symbol.trim();
  
  // Convert 'BTC/USD' to 'btc-usd'
  return trimmedSymbol.toLowerCase().replace('/', '-');
}

/**
 * Format a key name to snake_case
 * 
 * @param {string} keyName - The key name (e.g., 'orderHistory')
 * @returns {string} Formatted key name (e.g., 'order_history')
 */
export function formatKeyName(keyName) {
  if (!keyName) return '';
  
  // Convert 'orderHistory' to 'order_history'
  return keyName.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}

/**
 * Format exchange name to lowercase
 * 
 * @param {string} exchange - The exchange name (e.g., 'Kraken')
 * @returns {string} Formatted exchange name (e.g., 'kraken')
 */
export function formatExchange(exchange) {
  if (!exchange) return '';
  
  // Convert to lowercase and trim
  return exchange.trim().toLowerCase();
}

/**
 * Generate a standardized Redis key
 * 
 * @param {Object} config - Key generation configuration
 * @param {string} config.strategy - Strategy name (e.g., 'traditional')
 * @param {string} [config.exchange] - Exchange name (e.g., 'kraken')
 * @param {string} config.symbol - Trading symbol (e.g., 'BTC/USD')
 * @param {string} config.sessionId - Session ID
 * @param {string} config.keyName - Key name (e.g., 'orderHistory' or 'positions')
 * @returns {string} Standardized Redis key
 */
export function generateRedisKey(config) {
  const {
    strategy,
    exchange,
    symbol,
    sessionId,
    keyName
  } = config;
  
  // Check all required parameters and provide a detailed error message
  const missingParams = [];
  if (!strategy) missingParams.push('strategy');
  if (!symbol) missingParams.push('symbol');
  if (!sessionId) missingParams.push('sessionId');
  if (!keyName) missingParams.push('keyName');
  
  if (missingParams.length > 0) {
    throw new Error(`Missing required parameters for Redis key generation: ${missingParams.join(', ')}. Received: ${JSON.stringify(config)}`);
  }
  
  // Format the symbol to lowercase with dash
  const formattedSymbol = formatSymbol(symbol);
  
  // Format the key name to snake_case
  const formattedKeyName = formatKeyName(keyName);
  
  // Format the exchange name - Default to 'kraken' if not provided
  const formattedExchange = exchange ? formatExchange(exchange) : 'kraken';
  
  // Always generate the key in the format strategy:exchange:symbol:sessionId:keyName
  return `${strategy}:${formattedExchange}:${formattedSymbol}:${sessionId}:${formattedKeyName}`;
}
