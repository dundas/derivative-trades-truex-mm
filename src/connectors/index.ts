/**
 * Exchange Connectors
 *
 * Unified interface and implementations for multiple exchange feeds.
 * Used for reference pricing in TrueX market making.
 */

// Interface
export * from "./IExchangeConnector";

// Aggregator
export * from "./aggregator/PriceAggregator";

// Coinbase
export * from "./coinbase/CoinbaseRestClient";

// Kraken
export * from "./kraken/KrakenRestClient";
export * from "./kraken/KrakenSpotTickerWsClient";
export * from "./kraken/KrakenSpotTradesWsClient";
export * from "./kraken/KrakenPrivateWsClient";

// Gemini
export * from "./gemini/GeminiConnector";
export * from "./gemini/GeminiRestClient";
export * from "./gemini/GeminiWebSocketClient";
export * from "./gemini/GeminiSymbolMapper";
export * from "./gemini/types";
export * from "./gemini/errors";
