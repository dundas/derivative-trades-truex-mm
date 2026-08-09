import { describe, expect, test, jest } from 'bun:test';
import { QuoteLifecycleTelemetry } from './quote-lifecycle-telemetry.js';

describe('QuoteLifecycleTelemetry', () => {
  test('writes an immutable versioned event and drops disallowed data', async () => {
    const writer = { recordQuoteLifecycleEvent: jest.fn(async event => event) };
    const telemetry = new QuoteLifecycleTelemetry({ writer, now: () => 1000, policyId: 'maker-v1' });
    const event = await telemetry.record({
      eventType: 'create', quoteId: 'Q-1', sessionId: 's-1', side: 'buy', price: 100,
      size: 0.1, level: 1, action: 'place', targetInventoryBTC: 1, inventoryDeviationBTC: -0.2,
      committedExposureBTC: 0.3, context: { coinbase: { bestBid: 99, bestAsk: 101 }, accountId: 'do-not-store' },
      apiKey: 'secret',
    });

    expect(event.schemaVersion).toBe('1.0');
    expect(event.policyId).toBe('maker-v1');
    expect(event.eventId).toBe('Q-1:create:local:1000:1');
    expect(event.context.coinbase).toMatchObject({ bestBid: 99, bestAsk: 101 });
    expect(JSON.stringify(event)).not.toContain('secret');
    expect(JSON.stringify(event)).not.toContain('accountId');
    expect(writer.recordQuoteLifecycleEvent).toHaveBeenCalledWith(event);
  });

  test('links lifecycle events and ignores duplicate event ids', async () => {
    const writer = { recordQuoteLifecycleEvent: jest.fn(async event => event) };
    const telemetry = new QuoteLifecycleTelemetry({ writer, now: () => 2000 });
    await telemetry.record({ eventType: 'replace', quoteId: 'Q-2', replacesQuoteId: 'Q-1', eventId: 'event-2' });
    const duplicate = await telemetry.record({ eventType: 'replace', quoteId: 'Q-2', replacesQuoteId: 'Q-1', eventId: 'event-2' });
    expect(writer.recordQuoteLifecycleEvent).toHaveBeenCalledTimes(1);
    expect(duplicate).toBeNull();
  });

  test('keeps unavailable market values explicit', async () => {
    const telemetry = new QuoteLifecycleTelemetry({ now: () => 3000 });
    const event = await telemetry.record({ eventType: 'cancel', quoteId: 'Q-3', context: { fairValue: undefined, truexEbbo: null } });
    expect(event.context.fairValue).toBeNull();
    expect(event.context.truexEbbo).toBeNull();
  });

  test('generates distinct ids for legitimate events in the same millisecond', async () => {
    const writer = { recordQuoteLifecycleEvent: jest.fn(async event => event) };
    const telemetry = new QuoteLifecycleTelemetry({ writer, now: () => 4000 });
    const first = await telemetry.record({ eventType: 'create', quoteId: 'Q-4' });
    const second = await telemetry.record({ eventType: 'cancel', quoteId: 'Q-4' });
    expect(first.eventId).not.toBe(second.eventId);
    expect(writer.recordQuoteLifecycleEvent).toHaveBeenCalledTimes(2);
  });

  test('persists only a complete finite allowlisted policy vector', async () => {
    const telemetry = new QuoteLifecycleTelemetry({ now: () => 1 });
    const good = { targetInventoryBTC: 0, maxSkewTicks: 3, anchorBufferTicks: 1, baseSpreadBps: 50, levelSpacingTicks: 1, baseSizeBTC: 0.01, sizeDecayFactor: 0.8, repriceThresholdTicks: 1, secret: 'nope' };
    expect((await telemetry.record({ eventType: 'create', quoteId: 'policy', policyVector: good })).policyVector).toEqual(expect.objectContaining({ baseSpreadBps: 50 }));
    expect((await telemetry.record({ eventType: 'create', quoteId: 'bad', policyVector: { ...good, baseSizeBTC: 'bad' } })).policyVector).toBeNull();
  });

  test('bounds in-process duplicate tracking for long-running sessions', async () => {
    const telemetry = new QuoteLifecycleTelemetry({ now: () => 5000, maxDedupeEventIds: 2 });
    await telemetry.record({ eventType: 'create', quoteId: 'Q-5', eventId: 'event-1' });
    await telemetry.record({ eventType: 'create', quoteId: 'Q-6', eventId: 'event-2' });
    await telemetry.record({ eventType: 'create', quoteId: 'Q-7', eventId: 'event-3' });
    expect(telemetry.recordedEventIds.size).toBe(2);
    expect(telemetry.recordedEventIds.has('event-1')).toBe(false);
  });
});
