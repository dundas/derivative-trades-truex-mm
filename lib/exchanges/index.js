/**
 * Kraken Exchange Modules
 * 
 * This file exports all Kraken exchange modules for easier importing.
 */

// Export the KrakenClientAdapter which uses KrakenClientV2 under the hood
export { KrakenClientAdapter as KrakenWebSocketClient } from './KrakenClientAdapter.js';
export { OrderBookProcessor } from './OrderBookProcessor.js';
export { UpstashRedisAdapter } from './UpstashRedisAdapter.js';
export { KrakenMarketDataService } from './KrakenMarketDataService.js';
