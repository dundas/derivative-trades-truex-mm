const MODES = new Set(['live', 'observe']);

/**
 * Parse the deployment-time order-dispatch control.
 *
 * Observe mode is intentionally fail-closed for new order placement while
 * retaining the cancellation path needed to remove any venue-side exposure.
 */
export function buildQuoteDispatchMode(env) {
  const mode = String(env?.MM_QUOTE_DISPATCH_MODE ?? 'live').trim().toLowerCase();
  if (!MODES.has(mode)) {
    throw new Error('MM_QUOTE_DISPATCH_MODE must be live or observe');
  }
  return mode;
}
