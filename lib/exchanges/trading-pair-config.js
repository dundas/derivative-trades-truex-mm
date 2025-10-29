/**
 * Trading Pair Configuration for Kraken
 * 
 * Contains pair-specific settings like minimum order sizes, precision, etc.
 * Values obtained from Kraken API: https://api.kraken.com/0/public/AssetPairs
 */

export const TRADING_PAIR_CONFIG = {
  // Bitcoin/USD pair
  'BTC/USD': {
    minOrderSize: 0.00005,  // Minimum order size in BTC
    minOrderCost: 0.5,      // Minimum order cost in USD
    pairDecimals: 1,        // Price precision (decimal places)
    lotDecimals: 8,         // Amount precision (decimal places)
    costDecimals: 5,        // Cost precision (decimal places)
    baseCurrency: 'BTC',    
    quoteCurrency: 'USD'
  },
  
  // Ethereum/USD pair
  'ETH/USD': {
    minOrderSize: 0.002,    // Minimum order size in ETH
    minOrderCost: 0.5,      // Minimum order cost in USD
    pairDecimals: 2,        // Price precision (decimal places)
    lotDecimals: 8,         // Amount precision (decimal places)
    costDecimals: 5,        // Cost precision (decimal places)
    baseCurrency: 'ETH',    
    quoteCurrency: 'USD'
  }
};

/**
 * Get config for a specific trading pair
 * 
 * @param {string} symbol - Trading pair in format 'BTC/USD'
 * @returns {Object} - Configuration for the specified pair, or default values
 */
export function getTradingPairConfig(symbol) {
  // Return the pair-specific config if it exists
  if (TRADING_PAIR_CONFIG[symbol]) {
    return TRADING_PAIR_CONFIG[symbol];
  }
  
  // If there's no config for this pair, return default values
  // and log a warning
  console.warn(`No specific config found for ${symbol}, using default values`);
  return {
    minOrderSize: 0.001,
    minOrderCost: 0.5,
    pairDecimals: 1,
    lotDecimals: 8,
    costDecimals: 5,
    baseCurrency: symbol.split('/')[0],
    quoteCurrency: symbol.split('/')[1]
  };
}

/**
 * Fetch the latest trading pair configurations from Kraken API
 * 
 * @returns {Promise<Object>} - Updated trading pair configurations
 */
export async function fetchTradingPairConfigs() {
  try {
    // Fetch the trading pair info from Kraken API
    const response = await fetch('https://api.kraken.com/0/public/AssetPairs');
    const data = await response.json();
    
    if (data.error && data.error.length > 0) {
      console.error('Error fetching trading pair configs:', data.error);
      return TRADING_PAIR_CONFIG;
    }
    
    const result = data.result;
    const updatedConfig = { ...TRADING_PAIR_CONFIG };
    
    // Map Kraken's internal pair names to standard format
    const pairMappings = {
      'XXBTZUSD': 'BTC/USD',
      'XETHZUSD': 'ETH/USD'
    };
    
    // Update the configs for each pair we're interested in
    Object.entries(pairMappings).forEach(([krakenPair, standardPair]) => {
      if (result[krakenPair]) {
        const pairInfo = result[krakenPair];
        
        // Only update the config if we support this pair
        if (updatedConfig[standardPair]) {
          updatedConfig[standardPair] = {
            ...updatedConfig[standardPair],
            minOrderSize: parseFloat(pairInfo.ordermin) || updatedConfig[standardPair].minOrderSize,
            minOrderCost: parseFloat(pairInfo.costmin) || updatedConfig[standardPair].minOrderCost,
            pairDecimals: pairInfo.pair_decimals || updatedConfig[standardPair].pairDecimals,
            lotDecimals: pairInfo.lot_decimals || updatedConfig[standardPair].lotDecimals,
            costDecimals: pairInfo.cost_decimals || updatedConfig[standardPair].costDecimals
          };
        }
      }
    });
    
    console.log('Updated trading pair configurations:', updatedConfig);
    return updatedConfig;
  } catch (error) {
    console.error('Failed to fetch trading pair configs:', error);
    return TRADING_PAIR_CONFIG;
  }
}
