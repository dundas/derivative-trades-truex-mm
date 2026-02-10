/**
 * Logger Interface for Structured Logging
 *
 * Provides a consistent logging API across the application with:
 * - Log levels (debug, info, warn, error)
 * - Structured context data
 * - Environment-aware behavior
 */

export interface Logger {
  /**
   * Log debug-level message (development only)
   */
  debug(message: string, context?: Record<string, any>): void;

  /**
   * Log informational message
   */
  info(message: string, context?: Record<string, any>): void;

  /**
   * Log warning message
   */
  warn(message: string, context?: Record<string, any>): void;

  /**
   * Log error message with optional Error object
   */
  error(message: string, error?: Error, context?: Record<string, any>): void;
}

/**
 * Log level enumeration
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Console-based logger implementation
 * Outputs structured JSON logs suitable for production log aggregation
 */
export class ConsoleLogger implements Logger {
  private static readonly LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(
    private minLevel: LogLevel = "info",
    private component?: string
  ) {}

  debug(message: string, context?: Record<string, any>): void {
    this.log("debug", message, context);
  }

  info(message: string, context?: Record<string, any>): void {
    this.log("info", message, context);
  }

  warn(message: string, context?: Record<string, any>): void {
    this.log("warn", message, context);
  }

  error(message: string, error?: Error, context?: Record<string, any>): void {
    const errorContext = error
      ? {
          error: error.message,
          stack: error.stack,
          name: error.name,
        }
      : undefined;

    this.log("error", message, { ...context, ...errorContext });
  }

  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, any>
  ): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      component: this.component,
      message,
      ...this.sanitizeContext(context),
    };

    const output = JSON.stringify(logEntry);

    switch (level) {
      case "debug":
      case "info":
        console.log(output);
        break;
      case "warn":
        console.warn(output);
        break;
      case "error":
        console.error(output);
        break;
    }
  }

  /**
   * Sanitize sensitive data from log context
   * Redacts API keys, passwords, tokens, and other secrets
   */
  private sanitizeContext(
    context?: Record<string, any>
  ): Record<string, any> | undefined {
    if (!context) {
      return undefined;
    }

    const sensitiveKeys = [
      "password",
      "apikey",
      "api_key",
      "apisecret",
      "api_secret",
      "privatekey",
      "private_key",
      "token",
      "accesstoken",
      "access_token",
      "refreshtoken",
      "refresh_token",
      "secret",
      "authorization",
      "auth",
      "credentials",
    ];

    const sanitized: Record<string, any> = {};

    for (const [key, value] of Object.entries(context)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = sensitiveKeys.some((sk) => lowerKey.includes(sk));

      if (isSensitive && typeof value === "string") {
        // Redact but show first/last 4 chars for debugging
        if (value.length > 8) {
          sanitized[key] = `${value.substring(0, 4)}...${value.substring(value.length - 4)}`;
        } else {
          sanitized[key] = "***";
        }
      } else if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        // Recursively sanitize nested objects
        sanitized[key] = this.sanitizeContext(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  private shouldLog(level: LogLevel): boolean {
    return ConsoleLogger.LEVELS[level] >= ConsoleLogger.LEVELS[this.minLevel];
  }
}

/**
 * No-op logger for testing or when logging is disabled
 */
export class NoOpLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}
