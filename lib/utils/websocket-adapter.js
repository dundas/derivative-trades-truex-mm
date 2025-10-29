"use strict";
/**
 * WebSocket Adapter for Cloudflare Workers Environment
 *
 * This module provides a uniform WebSocket interface that works in both
 * Node.js and Cloudflare Workers environments.
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebSocketAdapter = exports.WebSocketReadyState = void 0;
var logger_js_1 = require("./logger.js");
var logger = new logger_js_1.Logger('WebSocketAdapter');
// Define constants that match Node.js WebSocket
exports.WebSocketReadyState = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3
};
/**
 * WebSocket Adapter that provides a consistent interface across environments
 */
var WebSocketAdapter = /** @class */ (function () {
    /**
     * Create a new WebSocket adapter
     */
    function WebSocketAdapter(url, options) {
        if (options === void 0) { options = {}; }
        this.ws = null;
        this.url = url;
        this.options = options;
        this.logger = new logger_js_1.Logger('WebSocketAdapter');
    }
    /**
     * Connect to the WebSocket server
     */
    WebSocketAdapter.prototype.connect = function () {
        return __awaiter(this, void 0, void 0, function () {
            var isCloudflareEnv, WebSocketModule, error_1, error_2;
            var _this = this;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 5, , 6]);
                        isCloudflareEnv = typeof process === 'undefined';
                        if (!isCloudflareEnv) return [3 /*break*/, 1];
                        // In Cloudflare Workers, use the built-in WebSocket
                        this.ws = new WebSocket(this.url);
                        return [3 /*break*/, 4];
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, Promise.resolve().then(function () { return require('ws'); })];
                    case 2:
                        WebSocketModule = _a.sent();
                        // @ts-ignore - Dynamic import
                        this.ws = new WebSocketModule.default(this.url);
                        return [3 /*break*/, 4];
                    case 3:
                        error_1 = _a.sent();
                        this.logger.error('Failed to import ws package', { error: error_1 });
                        throw new Error('WebSocket implementation not available');
                    case 4:
                        // Set up event handlers
                        this.setupEventHandlers();
                        // Return a promise that resolves when the connection is established
                        // or rejects if the connection fails
                        return [2 /*return*/, new Promise(function (resolve, reject) {
                                // Add temporary handlers for connection establishment
                                if (_this.ws) {
                                    var openHandler_1 = function (event) {
                                        _this.logger.info('WebSocket connected');
                                        if (_this.options.onOpen) {
                                            _this.options.onOpen(event);
                                        }
                                        resolve();
                                    };
                                    var errorHandler_1 = function (event) {
                                        var error = event instanceof Error ? event : new Error('WebSocket connection failed');
                                        _this.logger.error('WebSocket connection error', { error: error });
                                        reject(error);
                                    };
                                    _this.ws.addEventListener('open', openHandler_1);
                                    _this.ws.addEventListener('error', errorHandler_1);
                                    // Remove the temporary handlers after connection (success or failure)
                                    // to avoid duplicate event handling
                                    setTimeout(function () {
                                        if (_this.ws) {
                                            _this.ws.removeEventListener('open', openHandler_1);
                                            _this.ws.removeEventListener('error', errorHandler_1);
                                        }
                                    }, 5000);
                                }
                                else {
                                    reject(new Error('WebSocket not initialized'));
                                }
                            })];
                    case 5:
                        error_2 = _a.sent();
                        this.logger.error('Failed to connect to WebSocket', { error: error_2, url: this.url });
                        throw error_2;
                    case 6: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Set up the WebSocket event handlers
     */
    WebSocketAdapter.prototype.setupEventHandlers = function () {
        var _this = this;
        if (!this.ws)
            return;
        this.ws.addEventListener('message', function (event) {
            if (_this.options.onMessage) {
                var data = event.data;
                _this.options.onMessage(data);
            }
        });
        this.ws.addEventListener('close', function (event) {
            if (_this.options.onClose) {
                _this.options.onClose(event.code, event.reason);
            }
        });
        this.ws.addEventListener('error', function (event) {
            if (_this.options.onError) {
                var error = event instanceof Error ? event : new Error('WebSocket error');
                _this.options.onError(error);
            }
        });
        // Handle ping/pong events if available
        // These may not be directly accessible in all environments
        var wsAny = this.ws;
        if (typeof wsAny.on === 'function') {
            // Node.js ws package specific
            if (this.options.onPing) {
                wsAny.on('ping', this.options.onPing);
            }
            if (this.options.onPong) {
                wsAny.on('pong', this.options.onPong);
            }
        }
    };
    /**
     * Send data through the WebSocket
     */
    WebSocketAdapter.prototype.send = function (data) {
        if (!this.ws) {
            throw new Error('WebSocket not connected');
        }
        try {
            this.ws.send(data);
        }
        catch (error) {
            this.logger.error('Failed to send data', { error: error });
            throw error;
        }
    };
    /**
     * Close the WebSocket connection
     */
    WebSocketAdapter.prototype.close = function (code, reason) {
        if (!this.ws)
            return;
        try {
            this.ws.close(code, reason);
        }
        catch (error) {
            this.logger.error('Error closing WebSocket', { error: error });
        }
    };
    /**
     * Terminate the WebSocket connection (force close)
     */
    WebSocketAdapter.prototype.terminate = function () {
        if (!this.ws)
            return;
        try {
            // Use terminate if available (Node.js), otherwise use close
            if (typeof this.ws.terminate === 'function') {
                this.ws.terminate();
            }
            else {
                this.ws.close(1000, 'Terminated');
            }
        }
        catch (error) {
            this.logger.error('Error terminating WebSocket', { error: error });
        }
        finally {
            this.ws = null;
        }
    };
    /**
     * Send a ping frame
     */
    WebSocketAdapter.prototype.ping = function () {
        if (!this.ws)
            return;
        try {
            // Use ping if available (Node.js), otherwise not supported
            if (typeof this.ws.ping === 'function') {
                this.ws.ping();
            }
            else {
                this.logger.warn('Ping not supported in this environment');
            }
        }
        catch (error) {
            this.logger.error('Error sending ping', { error: error });
        }
    };
    Object.defineProperty(WebSocketAdapter.prototype, "readyState", {
        /**
         * Get the current ready state
         */
        get: function () {
            return this.ws ? this.ws.readyState : exports.WebSocketReadyState.CLOSED;
        },
        enumerable: false,
        configurable: true
    });
    /**
     * Check if the WebSocket is open
     */
    WebSocketAdapter.prototype.isOpen = function () {
        return this.ws !== null && this.ws.readyState === exports.WebSocketReadyState.OPEN;
    };
    return WebSocketAdapter;
}());
exports.WebSocketAdapter = WebSocketAdapter;
