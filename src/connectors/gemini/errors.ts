/**
 * Gemini Connector Error Types
 *
 * Defines error classes for different failure scenarios in the Gemini connector.
 * Errors include contextual information for debugging and monitoring.
 */

/**
 * Base error class for all Gemini connector errors
 */
export class GeminiConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
    public readonly context?: Record<string, any>
  ) {
    super(message);
    this.name = 'GeminiConnectorError';
    Object.setPrototypeOf(this, GeminiConnectorError.prototype);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      recoverable: this.recoverable,
      context: this.context,
      stack: this.stack,
    };
  }
}

/**
 * Error thrown when WebSocket connection fails
 */
export class ConnectionError extends GeminiConnectorError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'CONNECTION_ERROR', true, context);
    this.name = 'ConnectionError';
  }
}

/**
 * Error thrown when authentication fails
 */
export class AuthenticationError extends GeminiConnectorError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'AUTH_ERROR', false, context);
    this.name = 'AuthenticationError';
  }
}

/**
 * Error thrown when message parsing fails
 */
export class ParseError extends GeminiConnectorError {
  constructor(message: string, rawData: string, parseError: Error) {
    super(
      message,
      'PARSE_ERROR',
      true, // Recoverable - skip this message and continue
      {
        rawData: rawData.substring(0, 500), // Limit size
        parseError: parseError.message,
      }
    );
    this.name = 'ParseError';
  }
}

/**
 * Error thrown when message validation fails
 */
export class ValidationError extends GeminiConnectorError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'VALIDATION_ERROR', true, context);
    this.name = 'ValidationError';
  }
}

/**
 * Error thrown when symbol format is invalid
 */
export class InvalidSymbolError extends GeminiConnectorError {
  constructor(symbol: unknown, reason: string) {
    super(
      `Invalid symbol: ${reason}`,
      'INVALID_SYMBOL',
      false, // Not recoverable - programmer error
      { symbol, reason }
    );
    this.name = 'InvalidSymbolError';
  }
}

/**
 * Error thrown when subscription fails
 */
export class SubscriptionError extends GeminiConnectorError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 'SUBSCRIPTION_ERROR', true, context);
    this.name = 'SubscriptionError';
  }
}

/**
 * Error thrown when an operation times out
 */
export class TimeoutError extends GeminiConnectorError {
  constructor(operation: string, timeoutMs: number) {
    super(
      `Operation '${operation}' timed out after ${timeoutMs}ms`,
      'TIMEOUT_ERROR',
      true,
      { operation, timeoutMs }
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Error callback type for Gemini connector config
 */
export type ErrorCallback = (error: GeminiConnectorError) => void;
