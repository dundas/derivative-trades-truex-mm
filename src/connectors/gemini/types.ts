/**
 * Gemini WebSocket Message Types and Schemas
 *
 * These types define the structure of messages received from Gemini Fast API WebSocket.
 * Zod schemas provide runtime validation to catch API changes early.
 *
 * @see https://docs.gemini.com/websocket/fast-api/introduction
 */

import { z } from 'zod';

/**
 * Trade message from Gemini
 * Stream: {symbol}@trade
 */
export const GeminiTradeMessageSchema = z.object({
  s: z.string(),           // symbol (e.g., "ethusd")
  E: z.number().optional(), // event time in nanoseconds
  t: z.number(),           // trade ID
  p: z.string(),           // price
  q: z.string(),           // quantity
  m: z.boolean(),          // is buyer maker (true = maker is buyer, taker is seller)
});

export type GeminiTradeMessage = z.infer<typeof GeminiTradeMessageSchema>;

/**
 * Depth/OrderBook message from Gemini
 * Stream: {symbol}@depth
 */
export const GeminiDepthMessageSchema = z.object({
  e: z.literal('depthUpdate').optional(),
  s: z.string(),           // symbol
  E: z.number().optional(), // event time in nanoseconds
  b: z.array(z.tuple([z.string(), z.string()])).optional(),   // bids [[price, size], ...]
  a: z.array(z.tuple([z.string(), z.string()])).optional(),   // asks [[price, size], ...]
  bids: z.array(z.tuple([z.string(), z.string()])).optional(), // alternative format
  asks: z.array(z.tuple([z.string(), z.string()])).optional(), // alternative format
});

export type GeminiDepthMessage = z.infer<typeof GeminiDepthMessageSchema>;

/**
 * BookTicker message from Gemini
 * Stream: {symbol}@bookTicker
 */
export const GeminiTickerMessageSchema = z.object({
  s: z.string(),    // symbol
  E: z.number().optional(), // event time in nanoseconds
  b: z.string(),    // best bid price
  B: z.string().optional(), // best bid size
  a: z.string(),    // best ask price
  A: z.string().optional(), // best ask size
});

export type GeminiTickerMessage = z.infer<typeof GeminiTickerMessageSchema>;

/**
 * Subscription request message
 */
export interface GeminiSubscribeMessage {
  id: string;
  method: 'subscribe' | 'unsubscribe';
  params: {
    streams: string[];
  };
}

/**
 * Error message from Gemini
 */
export const GeminiErrorMessageSchema = z.object({
  id: z.string().optional(),
  status: z.number(),
  error: z.object({
    code: z.number(),
    msg: z.string(),
  }),
});

export type GeminiErrorMessage = z.infer<typeof GeminiErrorMessageSchema>;

/**
 * Generic Gemini message (union of all possible message types)
 */
export type GeminiMessage =
  | GeminiTradeMessage
  | GeminiDepthMessage
  | GeminiTickerMessage
  | GeminiErrorMessage;

/**
 * Type guards for Gemini messages
 */
export function isTradeMessage(message: unknown): message is GeminiTradeMessage {
  const result = GeminiTradeMessageSchema.safeParse(message);
  return result.success;
}

export function isDepthMessage(message: unknown): message is GeminiDepthMessage {
  const result = GeminiDepthMessageSchema.safeParse(message);
  return result.success;
}

export function isTickerMessage(message: unknown): message is GeminiTickerMessage {
  const result = GeminiTickerMessageSchema.safeParse(message);
  return result.success;
}

export function isErrorMessage(message: unknown): message is GeminiErrorMessage {
  const result = GeminiErrorMessageSchema.safeParse(message);
  return result.success;
}

/**
 * Parse and validate a Gemini WebSocket message
 * @throws Error if message cannot be parsed or is invalid
 */
export function parseGeminiMessage(data: string): GeminiMessage {
  let parsed: unknown;

  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error(`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Try to parse as each message type
  if (isErrorMessage(parsed)) {
    return parsed;
  }

  if (isTradeMessage(parsed)) {
    return parsed;
  }

  if (isDepthMessage(parsed)) {
    return parsed;
  }

  if (isTickerMessage(parsed)) {
    return parsed;
  }

  throw new Error(`Unknown message type: ${JSON.stringify(parsed).substring(0, 100)}`);
}
