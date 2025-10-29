"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KrakenWSV2BookData = exports.KrakenWSV2BookLevel = exports.KrakenWSV2SubscriptionRequest = exports.KrakenWSV2SystemStatus = exports.KrakenWSV2UnsubscribeRequest = exports.KrakenWSV2BookMessage = exports.KrakenWSV2SubscriptionParams = exports.KrakenWSV2AuthRequest = exports.KrakenWSV2Response = exports.KrakenWSV2Request = exports.KrakenWSV2Message = exports.KrakenWSV2BatchOrderResponse = exports.KrakenWSV2OrderResponse = exports.KrakenWSV2OrderRequest = exports.KrakenWSV2OrderUpdate = exports.KrakenWSV2Error = exports.KrakenWSV2BalanceUpdate = void 0;
// Re-export the types from kraken-ws-v2
// Import all types directly without destructuring to avoid missing exports
var KrakenTypes = require("./types/kraken-ws-v2.js");
// Re-export each type from the namespace
exports.KrakenWSV2BalanceUpdate = KrakenTypes.KrakenWSV2BalanceUpdate;
exports.KrakenWSV2Error = KrakenTypes.KrakenWSV2Error;
exports.KrakenWSV2OrderUpdate = KrakenTypes.KrakenWSV2OrderUpdate;
exports.KrakenWSV2OrderRequest = KrakenTypes.KrakenWSV2OrderRequest;
exports.KrakenWSV2OrderResponse = KrakenTypes.KrakenWSV2OrderResponse;
exports.KrakenWSV2BatchOrderResponse = KrakenTypes.KrakenWSV2BatchOrderResponse;
exports.KrakenWSV2Message = KrakenTypes.KrakenWSV2Message;
exports.KrakenWSV2Request = KrakenTypes.KrakenWSV2Request;
exports.KrakenWSV2Response = KrakenTypes.KrakenWSV2Response;
exports.KrakenWSV2AuthRequest = KrakenTypes.KrakenWSV2AuthRequest;
exports.KrakenWSV2SubscriptionParams = KrakenTypes.KrakenWSV2SubscriptionParams;
exports.KrakenWSV2BookMessage = KrakenTypes.KrakenWSV2BookMessage;
exports.KrakenWSV2UnsubscribeRequest = KrakenTypes.KrakenWSV2UnsubscribeRequest;
exports.KrakenWSV2SystemStatus = KrakenTypes.KrakenWSV2SystemStatus;
exports.KrakenWSV2SubscriptionRequest = KrakenTypes.KrakenWSV2SubscriptionRequest;
exports.KrakenWSV2BookLevel = KrakenTypes.KrakenWSV2BookLevel;
exports.KrakenWSV2BookData = KrakenTypes.KrakenWSV2BookData;
