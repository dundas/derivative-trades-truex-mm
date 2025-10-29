"use strict";
/**
 * Cloudflare Workers Compatibility Utilities
 *
 * This module provides utility functions to replace Node.js-specific APIs
 * with Web API equivalents for Cloudflare Workers environment.
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
exports.createHash = createHash;
exports.createHmac = createHmac;
exports.arrayBufferToBase64 = arrayBufferToBase64;
exports.base64ToArrayBuffer = base64ToArrayBuffer;
exports.concatArrayBuffers = concatArrayBuffers;
exports.stringToArrayBuffer = stringToArrayBuffer;
exports.arrayBufferToString = arrayBufferToString;
var logger_js_1 = require("./logger.js");
var logger = new logger_js_1.Logger('CloudflareCompat');
/**
 * Creates a hash using the Web Crypto API
 * Replacement for Node.js crypto.createHash
 */
function createHash(algorithm, data) {
    return __awaiter(this, void 0, void 0, function () {
        var webCryptoAlgorithm, encoder, dataBuffer, hashBuffer, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    webCryptoAlgorithm = algorithm === 'sha256' ? 'SHA-256' :
                        algorithm === 'sha512' ? 'SHA-512' :
                            algorithm;
                    encoder = new TextEncoder();
                    dataBuffer = encoder.encode(data);
                    return [4 /*yield*/, crypto.subtle.digest(webCryptoAlgorithm, dataBuffer)];
                case 1:
                    hashBuffer = _a.sent();
                    return [2 /*return*/, hashBuffer];
                case 2:
                    error_1 = _a.sent();
                    logger.error('Error in createHash', { error: error_1, algorithm: algorithm });
                    throw error_1;
                case 3: return [2 /*return*/];
            }
        });
    });
}
/**
 * Creates an HMAC signature using the Web Crypto API
 * Replacement for Node.js crypto.createHmac
 */
function createHmac(algorithm, key, data) {
    return __awaiter(this, void 0, void 0, function () {
        var webCryptoAlgorithm, cryptoKey, signature, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    webCryptoAlgorithm = algorithm === 'sha256' ? 'SHA-256' :
                        algorithm === 'sha512' ? 'SHA-512' :
                            algorithm;
                    return [4 /*yield*/, crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: { name: webCryptoAlgorithm } }, false, ['sign'])];
                case 1:
                    cryptoKey = _a.sent();
                    return [4 /*yield*/, crypto.subtle.sign('HMAC', cryptoKey, data)];
                case 2:
                    signature = _a.sent();
                    return [2 /*return*/, signature];
                case 3:
                    error_2 = _a.sent();
                    logger.error('Error in createHmac', { error: error_2, algorithm: algorithm });
                    throw error_2;
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Encodes an ArrayBuffer to a base64 string
 * Replacement for Buffer.from(...).toString('base64')
 */
function arrayBufferToBase64(buffer) {
    return btoa(String.fromCharCode.apply(String, new Uint8Array(buffer)));
}
/**
 * Decodes a base64 string to an ArrayBuffer
 * Replacement for Buffer.from(string, 'base64')
 */
function base64ToArrayBuffer(base64) {
    var binaryString = atob(base64);
    var bytes = new Uint8Array(binaryString.length);
    for (var i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}
/**
 * Concatenates multiple ArrayBuffers
 * Replacement for Buffer.concat
 */
function concatArrayBuffers(buffers) {
    // Calculate the total length
    var totalLength = buffers.reduce(function (acc, buf) { return acc + buf.byteLength; }, 0);
    // Create a new buffer with the total length
    var result = new Uint8Array(totalLength);
    // Copy each buffer into the result
    var offset = 0;
    for (var _i = 0, buffers_1 = buffers; _i < buffers_1.length; _i++) {
        var buffer = buffers_1[_i];
        result.set(new Uint8Array(buffer), offset);
        offset += buffer.byteLength;
    }
    return result.buffer;
}
/**
 * Converts a string to an ArrayBuffer
 * Replacement for Buffer.from(string)
 */
function stringToArrayBuffer(str) {
    var encoder = new TextEncoder();
    return encoder.encode(str).buffer;
}
/**
 * Converts an ArrayBuffer to a string
 * Replacement for buffer.toString()
 */
function arrayBufferToString(buffer) {
    var decoder = new TextDecoder();
    return decoder.decode(buffer);
}
