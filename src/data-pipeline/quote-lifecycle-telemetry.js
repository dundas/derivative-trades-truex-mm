/**
 * Append-only quote lifecycle telemetry.  This deliberately does not reuse
 * mutable order/fill records: one quote action becomes one immutable event.
 */
export class QuoteLifecycleTelemetry {
  constructor({ writer = null, logger = console, policyId = 'default', now = () => Date.now(), maxDedupeEventIds = 10_000 } = {}) {
    this.writer = writer;
    this.logger = logger;
    this.policyId = policyId;
    this.now = now;
    this.recordedEventIds = new Set();
    this.dedupeOrder = [];
    this.maxDedupeEventIds = Math.max(1, Number(maxDedupeEventIds) || 10_000);
    this.eventSequence = 0;
  }

  async record(input = {}) {
    const timestamp = Number(input.timestamp) || this.now();
    const eventId = input.eventId || `${input.quoteId || 'unknown'}:${input.eventType || 'unknown'}:${input.executionId || input.orderId || 'local'}:${timestamp}:${++this.eventSequence}`;
    if (this.recordedEventIds.has(eventId)) return null;
    const event = this._normalize({ ...input, eventId, timestamp });
    this._rememberEventId(eventId);
    try {
      if (this.writer?.recordQuoteLifecycleEvent) await this.writer.recordQuoteLifecycleEvent(event);
      return event;
    } catch (error) {
      this._forgetEventId(eventId);
      this.logger.warn?.(`[QuoteLifecycleTelemetry] persistence failed for ${eventId}: ${error.message}`);
      return null;
    }
  }

  _rememberEventId(eventId) {
    this.recordedEventIds.add(eventId);
    this.dedupeOrder.push(eventId);
    while (this.dedupeOrder.length > this.maxDedupeEventIds) {
      this.recordedEventIds.delete(this.dedupeOrder.shift());
    }
  }

  _forgetEventId(eventId) {
    this.recordedEventIds.delete(eventId);
    const index = this.dedupeOrder.indexOf(eventId);
    if (index >= 0) this.dedupeOrder.splice(index, 1);
  }

  _normalize(input) {
    const numberOrNull = value =>
      value === null || value === undefined || value === '' ? null :
        Number.isFinite(Number(value)) ? Number(value) : null;
    const allowBook = book => book ? {
      bestBid: numberOrNull(book.bestBid), bestAsk: numberOrNull(book.bestAsk),
      bestBidSize: numberOrNull(book.bestBidSize ?? book.bestBidQty),
      bestAskSize: numberOrNull(book.bestAskSize ?? book.bestAskQty),
      timestamp: numberOrNull(book.timestamp),
      receivedTimestamp: numberOrNull(book.receivedTimestamp),
    } : null;
    const allowMakerPresence = value => {
      if (!value || typeof value !== 'object') return null;
      const levels = value.activeLevels && typeof value.activeLevels === 'object'
        ? {
          buy: numberOrNull(value.activeLevels.buy),
          sell: numberOrNull(value.activeLevels.sell),
        }
        : null;
      const sampleIntervalMs = numberOrNull(value.sampleIntervalMs);
      return {
        executionState: ['normal', 'degraded', 'unsafe'].includes(value.executionState)
          ? value.executionState : null,
        twoSided: typeof value.twoSided === 'boolean' ? value.twoSided : null,
        buy: typeof value.buy === 'boolean' ? value.buy : null,
        sell: typeof value.sell === 'boolean' ? value.sell : null,
        activeLevels: levels,
        sampleIntervalMs: Number.isSafeInteger(sampleIntervalMs) ? sampleIntervalMs : null,
      };
    };
    return {
      schemaVersion: '1.0', eventId: input.eventId, eventType: input.eventType,
      timestamp: input.timestamp, decisionTimestamp: numberOrNull(input.decisionTimestamp) ?? input.timestamp,
      sessionId: input.sessionId || null, quoteId: input.quoteId || null,
      orderId: input.orderId || input.quoteId || null, replacesQuoteId: input.replacesQuoteId || null,
      executionId: input.executionId || null, symbol: input.symbol || null, side: input.side || null,
      price: numberOrNull(input.price), size: numberOrNull(input.size), level: numberOrNull(input.level),
      action: input.action || input.eventType || null, reason: input.reason || null,
      policyId: input.policyId || this.policyId,
      policyVector: this._normalizePolicyVector(input.policyVector),
      targetInventoryBTC: numberOrNull(input.targetInventoryBTC),
      inventoryDeviationBTC: numberOrNull(input.inventoryDeviationBTC),
      committedExposureBTC: numberOrNull(input.committedExposureBTC),
      context: {
        coinbase: allowBook(input.context?.coinbase), truexEbbo: allowBook(input.context?.truexEbbo),
        fairValue: numberOrNull(input.context?.fairValue), feedAgeMs: numberOrNull(input.context?.feedAgeMs),
        volatility: numberOrNull(input.context?.volatility), marketState: input.context?.marketState || null,
        makerPresence: allowMakerPresence(input.context?.makerPresence),
      },
    };
  }

  _normalizePolicyVector(vector) {
    const keys = ['targetInventoryBTC', 'maxSkewTicks', 'anchorBufferTicks', 'baseSpreadBps', 'levelSpacingTicks', 'baseSizeBTC', 'sizeDecayFactor', 'repriceThresholdTicks'];
    if (!vector || typeof vector !== 'object') return null;
    const normalized = {};
    for (const key of keys) {
      if (!Number.isFinite(Number(vector[key]))) return null;
      normalized[key] = Number(vector[key]);
    }
    return normalized;
  }
}
