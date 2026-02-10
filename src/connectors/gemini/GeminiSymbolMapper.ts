/**
 * Gemini Symbol Normalization Utility
 *
 * Converts between standard format (BTC/USD) and Gemini format (btcusd).
 * Provides a single source of truth for symbol mappings across the codebase.
 *
 * Standard format: BASE/QUOTE (e.g., "BTC/USD", "ETH/BTC")
 * Gemini format: basequote (e.g., "btcusd", "ethbtc")
 */

import { InvalidSymbolError } from './errors';

export class GeminiSymbolMapper {
  /**
   * Known base currencies (lowercase)
   * Extend this list as needed for new trading pairs
   */
  private static readonly BASE_CURRENCIES = [
    'btc', 'eth', 'sol', 'xrp', 'ada', 'dot', 'link', 'avax',
    'atom', 'doge', 'uni', 'ltc', 'bch', 'xlm', 'matic', 'algo',
    'near', 'fil', 'ape', 'sand', 'mana', 'gala', 'axs', 'shib',
    'crv', 'comp', 'mkr', 'snx', 'aave', 'yfi', '1inch', 'bat',
    'enj', 'zrx', 'knc', 'ren', 'storj', 'grt', 'bal', 'uma',
  ];

  /**
   * Known quote currencies in order of likelihood
   * Ordering matters for parsing: try most common first
   */
  private static readonly QUOTE_CURRENCIES = [
    'usd', 'usdt', 'usdc', 'eur', 'gbp', 'btc', 'eth', 'dai', 'gusd',
  ];

  /**
   * Static mapping for well-known pairs (optimization)
   * Avoids parsing logic for common cases
   */
  private static readonly KNOWN_PAIRS: Record<string, string> = {
    // USD pairs
    'btcusd': 'BTC/USD',
    'ethusd': 'ETH/USD',
    'solusd': 'SOL/USD',
    'xrpusd': 'XRP/USD',
    'adausd': 'ADA/USD',
    'dotusd': 'DOT/USD',
    'linkusd': 'LINK/USD',
    'avaxusd': 'AVAX/USD',
    'atomusd': 'ATOM/USD',
    'dogeusd': 'DOGE/USD',
    'uniusd': 'UNI/USD',
    'ltcusd': 'LTC/USD',
    'bchusd': 'BCH/USD',
    'xlmusd': 'XLM/USD',

    // BTC pairs
    'ethbtc': 'ETH/BTC',
    'solbtc': 'SOL/BTC',
    'xrpbtc': 'XRP/BTC',
    'adabtc': 'ADA/BTC',

    // ETH pairs
    'btceth': 'BTC/ETH',
    'soleth': 'SOL/ETH',

    // USDT pairs
    'btcusdt': 'BTC/USDT',
    'ethusdt': 'ETH/USDT',

    // EUR pairs
    'btceur': 'BTC/EUR',
    'etheur': 'ETH/EUR',

    // GUSD pairs (Gemini's stablecoin)
    'btcgusd': 'BTC/GUSD',
    'ethgusd': 'ETH/GUSD',
  };

  /**
   * Convert Gemini format (btcusd) to standard format (BTC/USD)
   *
   * @param geminiSymbol - Symbol in Gemini format (e.g., "btcusd")
   * @returns Symbol in standard format (e.g., "BTC/USD")
   * @throws InvalidSymbolError if symbol cannot be parsed
   */
  static toStandard(geminiSymbol: string): string {
    if (typeof geminiSymbol !== 'string' || !geminiSymbol) {
      throw new InvalidSymbolError(geminiSymbol, 'Must be a non-empty string');
    }

    const lower = geminiSymbol.toLowerCase().trim();

    // Check known pairs first (fast path)
    if (this.KNOWN_PAIRS[lower]) {
      return this.KNOWN_PAIRS[lower];
    }

    // Try to parse by matching quote currencies
    for (const quote of this.QUOTE_CURRENCIES) {
      if (lower.endsWith(quote)) {
        const baseStr = lower.slice(0, -quote.length);

        // Validate that base is a known currency
        if (this.BASE_CURRENCIES.includes(baseStr)) {
          const base = baseStr.toUpperCase();
          const quoteUpper = quote.toUpperCase();
          return `${base}/${quoteUpper}`;
        }
      }
    }

    // Couldn't parse - throw error with helpful message
    throw new InvalidSymbolError(
      geminiSymbol,
      `Unknown Gemini symbol format. Expected format like "btcusd", "ethbtc", etc.`
    );
  }

  /**
   * Convert standard format (BTC/USD) to Gemini format (btcusd)
   *
   * @param standardSymbol - Symbol in standard format (e.g., "BTC/USD")
   * @returns Symbol in Gemini format (e.g., "btcusd")
   * @throws InvalidSymbolError if symbol format is invalid
   */
  static toGemini(standardSymbol: string): string {
    if (typeof standardSymbol !== 'string' || !standardSymbol) {
      throw new InvalidSymbolError(standardSymbol, 'Must be a non-empty string');
    }

    if (!standardSymbol.includes('/')) {
      throw new InvalidSymbolError(
        standardSymbol,
        'Expected format "BASE/QUOTE" (e.g., "BTC/USD")'
      );
    }

    const [base, quote] = standardSymbol.split('/');

    if (!base || !quote) {
      throw new InvalidSymbolError(
        standardSymbol,
        'Invalid format: missing base or quote currency'
      );
    }

    // Simple conversion: remove slash and lowercase
    return `${base}${quote}`.toLowerCase();
  }

  /**
   * Register a custom symbol mapping
   * Useful for adding new pairs without modifying the class
   *
   * @param geminiFormat - Symbol in Gemini format (e.g., "newcoinusd")
   * @param standardFormat - Symbol in standard format (e.g., "NEWCOIN/USD")
   */
  static registerPair(geminiFormat: string, standardFormat: string): void {
    const lower = geminiFormat.toLowerCase();
    this.KNOWN_PAIRS[lower] = standardFormat;
  }

  /**
   * Validate symbol format without converting
   *
   * @param symbol - Symbol to validate
   * @param format - Expected format ('gemini' or 'standard')
   * @returns true if valid, false otherwise
   */
  static isValid(symbol: string, format: 'gemini' | 'standard'): boolean {
    try {
      if (format === 'standard') {
        // Standard format must have a slash
        if (!symbol.includes('/')) {
          return false;
        }
        const [base, quote] = symbol.split('/');
        return !!base && !!quote;
      } else {
        // Gemini format: try to convert to standard
        this.toStandard(symbol);
        return true;
      }
    } catch {
      return false;
    }
  }
}
