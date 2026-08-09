/**
 * Append-only quote lifecycle telemetry.  This deliberately does not reuse
 * mutable order/fill records: one quote action becomes one immutable event.
 */
export class QuoteLifecycleTelemetry {
  constructor({ writer = null, logger = console, policyId = 'default', now = () => Date.now() } = {}) {
    this.writer = writer;
    this.logger = logger;
    this.policyId = policyId;
    this.now = now;
    this.recordedEventIds = new Set();
    this.eventSequence = 0;
  }

  async record(input = {}) {
    const timestamp = Number(input.timestamp) || this.now();
    const eventId = input.eventId || `${input.quoteId || 'unknown'}:${input.eventType || 'unknown'}:${input.executionId || input.orderId || 'local'}:${timestamp}:${++this.eventSequence}`;
    if (this.recordedEventIds.has(eventId)) return null;
    const event = this._normalize({ ...input, eventId, timestamp });
    this.recordedEventIds.add(eventId);
    try {
      if (this.writer?.recordQuoteLifecycleEvent) await this.writer.recordQuoteLifecycleEvent(event);
      return event;
    } catch (error) {
      this.recordedEventIds.delete(eventId);
      this.logger.warn?.(`[QuoteLifecycleTelemetry] persistence failed for ${eventId}: ${error.message}`);
      return null;
    }
  }

  _normalize(input) {
    const numberOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
    const allowBook = book => book ? {
      bestBid: numberOrNull(book.bestBid), bestAsk: numberOrNull(book.bestAsk),
      bestBidSize: numberOrNull(book.bestBidSize ?? book.bestBidQty),
      bestAskSize: numberOrNull(book.bestAskSize ?? book.bestAskQty),
      timestamp: numberOrNull(book.timestamp),
    } : null;
    return {
      schemaVersion: '1.0', eventId: input.eventId, eventType: input.eventType,
      timestamp: input.timestamp, decisionTimestamp: numberOrNull(input.decisionTimestamp) ?? input.timestamp,
      sessionId: input.sessionId || null, quoteId: input.quoteId || null,
      orderId: input.orderId || input.quoteId || null, replacesQuoteId: input.replacesQuoteId || null,
      executionId: input.executionId || null, symbol: input.symbol || null, side: input.side || null,
      price: numberOrNull(input.price), size: numberOrNull(input.size), level: numberOrNull(input.level),
      action: input.action || input.eventType || null, reason: input.reason || null,
      policyId: input.policyId || this.policyId,
      targetInventoryBTC: numberOrNull(input.targetInventoryBTC),
      inventoryDeviationBTC: numberOrNull(input.inventoryDeviationBTC),
      committedExposureBTC: numberOrNull(input.committedExposureBTC),
      context: {
        coinbase: allowBook(input.context?.coinbase), truexEbbo: allowBook(input.context?.truexEbbo),
        fairValue: numberOrNull(input.context?.fairValue), feedAgeMs: numberOrNull(input.context?.feedAgeMs),
        volatility: numberOrNull(input.context?.volatility), marketState: input.context?.marketState || null,
      },
    };
  }
}
