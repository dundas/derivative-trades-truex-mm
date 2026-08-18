import { describe, expect, it, jest } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildApiStatusSnapshot } from './status-snapshot.js';

describe('authenticated /api/status snapshot', () => {
  it('reports disabled reference collection as null', () => {
    const orchestrator = {
      getHealthStatus: jest.fn(() => ({ status: 'healthy', quoting: true, referenceMarkouts: null })),
    };

    expect(buildApiStatusSnapshot(orchestrator)).toEqual({
      status: 'healthy', quoting: true, referenceMarkouts: null,
    });
  });

  it('reports zero-observation idle collection as healthy when no horizon window is open', () => {
    const snapshot = buildApiStatusSnapshot({ getHealthStatus: () => ({
      status: 'healthy', quoting: true,
      referenceMarkouts: {
        running: true, openWindow: false, samplingState: 'idle-no-open-window',
        marketObservationsRecorded: 0, lastMarketObservationAt: null, persistenceErrors: 0,
      },
    }) });
    expect(snapshot.status).toBe('healthy');
    expect(snapshot.referenceMarkouts).toMatchObject({
      openWindow: false, samplingState: 'idle-no-open-window',
      marketObservationsRecorded: 0, lastMarketObservationAt: null,
    });
  });

  it('keeps persistence failures visible without changing health or execution', () => {
    const sendMessage = jest.fn();
    const onPriceUpdate = jest.fn();
    const orchestrator = {
      fixOE: { sendMessage }, quoteEngine: { onPriceUpdate },
      getHealthStatus: jest.fn(() => ({
        status: 'healthy', quoting: true,
        referenceMarkouts: {
          running: true, decisionsRecorded: 11, fillsScheduled: 3,
          observationsCompleted: 2, persistenceErrors: 4,
          processCycles: 20, marketObservationsRecorded: 18,
          lastCycleAt: 123_000, lastMarketObservationAt: 122_000,
          lastErrorReason: 'due processing failed', lastErrorAt: 121_000,
          config: {
            product: 'BTC-USD', quoteCurrency: 'USD', sourceExchange: 'coinbase',
            sourceType: 'top-of-book', horizonsMs: [60_000, 300_000, 3_600_000],
          },
        },
      })),
    };

    const snapshot = buildApiStatusSnapshot(orchestrator);

    expect(snapshot.status).toBe('healthy');
    expect(snapshot.referenceMarkouts).toMatchObject({
      running: true, decisionsRecorded: 11, fillsScheduled: 3,
      observationsCompleted: 2, persistenceErrors: 4,
      processCycles: 20, marketObservationsRecorded: 18,
      lastCycleAt: 123_000, lastMarketObservationAt: 122_000,
      lastErrorReason: 'due processing failed', lastErrorAt: 121_000,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onPriceUpdate).not.toHaveBeenCalled();
  });

  it('keeps /api/status behind the existing admin-token gate', () => {
    const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
    const authGate = source.indexOf("if (!requireAdminToken(req)) return jsonError('Unauthorized', 401)");
    const statusRoute = source.indexOf("if (path === '/api/status')");
    expect(authGate).toBeGreaterThan(-1);
    expect(statusRoute).toBeGreaterThan(authGate);
  });
});
