import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { PnLTracker } from '../src/core/pnl-tracker.js';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('PnLTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new PnLTracker({
      truexMakerFeeBps: 5,
      truexTakerFeeBps: 10,
      hedgeMakerFeeBps: 8,
      hedgeTakerFeeBps: 15,
      significantPnlChange: 100,
      logIntervalMs: 30000,
      logger: silentLogger
    });
  });

  afterEach(() => {
    tracker.stopPeriodicLogging();
  });

  describe('Simple Round Trip', () => {
    it('should compute realized PnL for buy then sell', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 105, venue: 'truex', isMaker: true, execID: 'e2' });

      const summary = tracker.getSummary();
      expect(summary.realizedPnL).toBe(5);
      expect(summary.netPosition).toBe(0);
      expect(summary.totalMatchedQuantity).toBe(1);
    });

    it('should compute realized PnL for sell then buy', () => {
      tracker.onFill({ side: 'sell', quantity: 1, price: 105, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e2' });

      const summary = tracker.getSummary();
      expect(summary.realizedPnL).toBe(5);
      expect(summary.netPosition).toBe(0);
    });

    it('should track negative PnL for losing round trip', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 105, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e2' });

      const summary = tracker.getSummary();
      expect(summary.realizedPnL).toBe(-5);
    });
  });

  describe('Partial Fills', () => {
    it('should realize partial and leave remainder as position', () => {
      tracker.onFill({ side: 'buy', quantity: 2, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 105, venue: 'truex', isMaker: true, execID: 'e2' });

      const summary = tracker.getSummary();
      expect(summary.realizedPnL).toBe(5);
      expect(summary.netPosition).toBe(1);
      expect(summary.totalMatchedQuantity).toBe(1);
    });

    it('should handle partial sell then full close', () => {
      tracker.onFill({ side: 'buy', quantity: 3, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 105, venue: 'truex', isMaker: true, execID: 'e2' });
      tracker.onFill({ side: 'sell', quantity: 2, price: 110, venue: 'truex', isMaker: true, execID: 'e3' });

      const summary = tracker.getSummary();
      // 1 * (105-100) + 2 * (110-100) = 5 + 20 = 25
      expect(summary.realizedPnL).toBe(25);
      expect(summary.netPosition).toBe(0);
      expect(summary.totalMatchedQuantity).toBe(3);
    });
  });

  describe('Multiple Fills (FIFO)', () => {
    it('should match multiple buys against sell using FIFO', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'buy', quantity: 1, price: 102, venue: 'truex', isMaker: true, execID: 'e2' });
      tracker.onFill({ side: 'sell', quantity: 2, price: 106, venue: 'truex', isMaker: true, execID: 'e3' });

      const summary = tracker.getSummary();
      // FIFO: 1*(106-100) + 1*(106-102) = 6 + 4 = 10
      expect(summary.realizedPnL).toBe(10);
      expect(summary.netPosition).toBe(0);
      expect(summary.totalMatchedQuantity).toBe(2);
    });

    it('should match multiple sells against buy using FIFO', () => {
      tracker.onFill({ side: 'sell', quantity: 1, price: 110, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 108, venue: 'truex', isMaker: true, execID: 'e2' });
      tracker.onFill({ side: 'buy', quantity: 2, price: 100, venue: 'truex', isMaker: true, execID: 'e3' });

      const summary = tracker.getSummary();
      // FIFO: 1*(110-100) + 1*(108-100) = 10 + 8 = 18
      expect(summary.realizedPnL).toBe(18);
      expect(summary.netPosition).toBe(0);
    });

    it('should handle many small fills correctly', () => {
      // 10 small buys
      for (let i = 0; i < 10; i++) {
        tracker.onFill({ side: 'buy', quantity: 0.1, price: 100 + i * 0.1, venue: 'truex', isMaker: true, execID: `b${i}` });
      }
      // Sell all at once
      tracker.onFill({ side: 'sell', quantity: 1, price: 105, venue: 'truex', isMaker: true, execID: 's1' });

      const summary = tracker.getSummary();
      expect(summary.netPosition).toBeCloseTo(0, 10);
      expect(summary.realizedPnL).toBeGreaterThan(0);
      expect(summary.totalMatchedQuantity).toBeCloseTo(1, 10);
    });
  });

  describe('Fee Calculation', () => {
    it('should compute taker fee correctly', () => {
      // 1 BTC at $100,000, 10 bps taker fee = 1 * 100000 * 10/10000 = $100
      tracker.onFill({ side: 'buy', quantity: 1, price: 100000, venue: 'truex', isMaker: false, execID: 'e1' });

      expect(tracker.totalFees).toBeCloseTo(100, 2);
      expect(tracker.takerFees).toBeCloseTo(100, 2);
      expect(tracker.makerFees).toBe(0);
    });

    it('should compute maker fee correctly', () => {
      // 1 BTC at $100,000, 5 bps maker fee = 1 * 100000 * 5/10000 = $50
      tracker.onFill({ side: 'buy', quantity: 1, price: 100000, venue: 'truex', isMaker: true, execID: 'e1' });

      expect(tracker.totalFees).toBeCloseTo(50, 2);
      expect(tracker.makerFees).toBeCloseTo(50, 2);
      expect(tracker.takerFees).toBe(0);
    });

    it('should track fees by venue for multi-venue fills', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100000, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 100050, venue: 'kraken', isMaker: false, execID: 'e2' });

      // truex maker: 100000 * 5/10000 = $50? No, 1 * 100000 * 5/10000 = $50
      // Wait: 5 bps = 0.05%, so 100000 * 0.0005 = $50
      // kraken taker: 1 * 100050 * 15/10000 = $150.075
      expect(tracker.feesByVenue['truex']).toBeCloseTo(50, 1);
      expect(tracker.feesByVenue['kraken']).toBeCloseTo(150.075, 1);
      expect(tracker.totalFees).toBeCloseTo(200.075, 1);
    });

    it('should deduct fees from total PnL', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: false, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 110, venue: 'truex', isMaker: false, execID: 'e2' });

      const summary = tracker.getSummary();
      // realized = 10, fees = 1*100*10/10000 + 1*110*10/10000 = 0.1 + 0.11 = 0.21
      expect(summary.realizedPnL).toBe(10);
      expect(summary.totalFees).toBeCloseTo(0.21, 4);
      expect(summary.totalPnL).toBeCloseTo(10 - 0.21, 4);
    });
  });

  describe('Mark to Market', () => {
    it('should compute unrealized PnL for long position', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.markToMarket(110);

      const summary = tracker.getSummary();
      expect(summary.unrealizedPnL).toBe(10);
      expect(summary.netPosition).toBe(1);
    });

    it('should compute unrealized PnL for short position', () => {
      tracker.onFill({ side: 'sell', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.markToMarket(90);

      const summary = tracker.getSummary();
      expect(summary.unrealizedPnL).toBe(10);
      expect(summary.netPosition).toBe(-1);
    });

    it('should compute negative unrealized PnL for losing long', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.markToMarket(90);

      const summary = tracker.getSummary();
      expect(summary.unrealizedPnL).toBe(-10);
    });

    it('should compute negative unrealized PnL for losing short', () => {
      tracker.onFill({ side: 'sell', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.markToMarket(110);

      const summary = tracker.getSummary();
      expect(summary.unrealizedPnL).toBe(-10);
    });

    it('should have zero unrealized when fully matched', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 105, venue: 'truex', isMaker: true, execID: 'e2' });
      tracker.markToMarket(200);

      const summary = tracker.getSummary();
      expect(summary.unrealizedPnL).toBe(0);
      expect(summary.netPosition).toBe(0);
    });

    it('should use weighted average cost for multi-fill position', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'buy', quantity: 1, price: 200, venue: 'truex', isMaker: true, execID: 'e2' });
      tracker.markToMarket(150);

      const summary = tracker.getSummary();
      // Avg cost = (100+200)/2 = 150, unrealized = 2 * (150 - 150) = 0
      expect(summary.unrealizedPnL).toBe(0);
      expect(summary.netPosition).toBe(2);
    });

    it('should auto mark-to-market on fill if lastMid is set', () => {
      tracker.markToMarket(110);
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });

      const summary = tracker.getSummary();
      // Should auto-recalculate unrealized using lastMid=110
      expect(summary.unrealizedPnL).toBe(10);
    });
  });

  describe('Net PnL', () => {
    it('should compute total PnL as realized + unrealized - fees', () => {
      tracker.onFill({ side: 'buy', quantity: 2, price: 100, venue: 'truex', isMaker: false, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 110, venue: 'truex', isMaker: false, execID: 'e2' });
      tracker.markToMarket(108);

      const summary = tracker.getSummary();
      // realized: 1*(110-100) = 10
      // unrealized: 1 BTC long at cost 100, mid 108 → 8
      // fees: 2*100*10/10000 + 1*110*10/10000 = 0.2 + 0.11 = 0.31
      expect(summary.realizedPnL).toBe(10);
      expect(summary.unrealizedPnL).toBe(8);
      expect(summary.totalFees).toBeCloseTo(0.31, 4);
      expect(summary.totalPnL).toBeCloseTo(10 + 8 - 0.31, 4);
    });
  });

  describe('Average Spread Capture', () => {
    it('should compute average profit per unit from round trips', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 105, venue: 'truex', isMaker: true, execID: 'e2' });

      const summary = tracker.getSummary();
      // realizedPnL=5, matchedQty=1 → avgSpreadCapture=5
      expect(summary.avgSpreadCapture).toBe(5);
    });

    it('should average over multiple round trips', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 106, venue: 'truex', isMaker: true, execID: 'e2' });
      tracker.onFill({ side: 'buy', quantity: 1, price: 200, venue: 'truex', isMaker: true, execID: 'e3' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 204, venue: 'truex', isMaker: true, execID: 'e4' });

      const summary = tracker.getSummary();
      // realized = 6+4 = 10, matched = 2 → avgSpreadCapture = 5
      expect(summary.avgSpreadCapture).toBe(5);
    });

    it('should return 0 when no matches yet', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });

      const summary = tracker.getSummary();
      expect(summary.avgSpreadCapture).toBe(0);
    });
  });

  describe('Session Report', () => {
    it('should return a string containing key metrics', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 110, venue: 'truex', isMaker: true, execID: 'e2' });
      tracker.markToMarket(105);

      const report = tracker.getSessionReport();
      expect(typeof report).toBe('string');
      expect(report).toContain('PnL Session Report');
      expect(report).toContain('Realized PnL');
      expect(report).toContain('Unrealized PnL');
      expect(report).toContain('Total Fees');
      expect(report).toContain('Net PnL');
      expect(report).toContain('Trades: 2');
      expect(report).toContain('Avg Spread Capture');
    });

    it('should include venue fee breakdown', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 100, venue: 'kraken', isMaker: false, execID: 'e2' });

      const report = tracker.getSessionReport();
      expect(report).toContain('truex');
      expect(report).toContain('kraken');
    });
  });

  describe('Significant Change Event', () => {
    it('should emit significantChange when PnL crosses threshold', () => {
      let emitted = null;
      tracker.on('significantChange', (data) => { emitted = data; });

      // Realized PnL of $150 should trigger (threshold = $100)
      tracker.onFill({ side: 'buy', quantity: 1, price: 1000, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 1150, venue: 'truex', isMaker: true, execID: 'e2' });

      expect(emitted).not.toBeNull();
      expect(emitted.delta).toBeGreaterThan(0);
      expect(Math.abs(emitted.totalPnL)).toBeGreaterThanOrEqual(100);
    });

    it('should NOT emit when change is below threshold', () => {
      let emitted = null;
      tracker.on('significantChange', (data) => { emitted = data; });

      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 105, venue: 'truex', isMaker: true, execID: 'e2' });

      // $5 PnL is below $100 threshold
      expect(emitted).toBeNull();
    });

    it('should emit on negative significant change', () => {
      let emitted = null;
      tracker.on('significantChange', (data) => { emitted = data; });

      tracker.onFill({ side: 'buy', quantity: 1, price: 1150, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 1000, venue: 'truex', isMaker: true, execID: 'e2' });

      expect(emitted).not.toBeNull();
      expect(emitted.delta).toBeLessThan(0);
    });
  });

  describe('Reset', () => {
    it('should zero all state', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 110, venue: 'truex', isMaker: true, execID: 'e2' });
      tracker.markToMarket(105);

      tracker.reset();

      const summary = tracker.getSummary();
      expect(summary.realizedPnL).toBe(0);
      expect(summary.unrealizedPnL).toBe(0);
      expect(summary.totalPnL).toBe(0);
      expect(summary.totalFees).toBe(0);
      expect(summary.numTrades).toBe(0);
      expect(summary.netPosition).toBe(0);
      expect(summary.avgSpreadCapture).toBe(0);
      expect(summary.totalMatchedQuantity).toBe(0);
      expect(summary.makerFees).toBe(0);
      expect(summary.takerFees).toBe(0);
      expect(Object.keys(summary.feesByVenue).length).toBe(0);
    });

    it('should allow fresh tracking after reset', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.reset();

      tracker.onFill({ side: 'buy', quantity: 1, price: 200, venue: 'truex', isMaker: true, execID: 'e3' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 210, venue: 'truex', isMaker: true, execID: 'e4' });

      const summary = tracker.getSummary();
      expect(summary.realizedPnL).toBe(10);
      expect(summary.numTrades).toBe(2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle same price buy and sell', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e2' });

      const summary = tracker.getSummary();
      expect(summary.realizedPnL).toBe(0);
      expect(summary.netPosition).toBe(0);
    });

    it('should ignore zero quantity fills', () => {
      tracker.onFill({ side: 'buy', quantity: 0, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      expect(tracker.numTrades).toBe(0);
    });

    it('should handle very small quantities', () => {
      tracker.onFill({ side: 'buy', quantity: 0.00001, price: 100000, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 0.00001, price: 100100, venue: 'truex', isMaker: true, execID: 'e2' });

      const summary = tracker.getSummary();
      expect(summary.realizedPnL).toBeCloseTo(0.001, 6);
      expect(summary.netPosition).toBeCloseTo(0, 10);
    });

    it('should default venue to truex', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, isMaker: false, execID: 'e1' });

      expect(tracker.feesByVenue['truex']).toBeCloseTo(0.1, 4);
    });

    it('should handle alternating buys and sells', () => {
      // buy 1@100, sell 1@102, buy 1@101, sell 1@103
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 102, venue: 'truex', isMaker: true, execID: 'e2' });
      tracker.onFill({ side: 'buy', quantity: 1, price: 101, venue: 'truex', isMaker: true, execID: 'e3' });
      tracker.onFill({ side: 'sell', quantity: 1, price: 103, venue: 'truex', isMaker: true, execID: 'e4' });

      const summary = tracker.getSummary();
      // Round trip 1: 102-100 = 2
      // Round trip 2: 103-101 = 2
      expect(summary.realizedPnL).toBe(4);
      expect(summary.netPosition).toBe(0);
    });

    it('should handle large number of small fills', () => {
      for (let i = 0; i < 100; i++) {
        tracker.onFill({ side: 'buy', quantity: 0.01, price: 100, venue: 'truex', isMaker: true, execID: `b${i}` });
      }
      for (let i = 0; i < 100; i++) {
        tracker.onFill({ side: 'sell', quantity: 0.01, price: 101, venue: 'truex', isMaker: true, execID: `s${i}` });
      }

      const summary = tracker.getSummary();
      // 100 * 0.01 * (101-100) = 1
      expect(summary.realizedPnL).toBeCloseTo(1, 6);
      expect(summary.netPosition).toBeCloseTo(0, 10);
      expect(summary.numTrades).toBe(200);
    });
  });

  describe('Periodic Logging', () => {
    it('should start and stop without error', () => {
      tracker.startPeriodicLogging();
      expect(tracker._logTimer).not.toBeNull();

      tracker.stopPeriodicLogging();
      expect(tracker._logTimer).toBeNull();
    });

    it('should not create duplicate timers', () => {
      tracker.startPeriodicLogging();
      const firstTimer = tracker._logTimer;
      tracker.startPeriodicLogging();
      expect(tracker._logTimer).toBe(firstTimer);

      tracker.stopPeriodicLogging();
    });
  });

  describe('Constructor Defaults', () => {
    it('should use default values when no options given', () => {
      const defaultTracker = new PnLTracker({ logger: silentLogger });

      expect(defaultTracker.truexMakerFeeBps).toBe(0);
      expect(defaultTracker.truexTakerFeeBps).toBe(0);
      expect(defaultTracker.hedgeMakerFeeBps).toBe(0);
      expect(defaultTracker.hedgeTakerFeeBps).toBe(0);
      expect(defaultTracker.logIntervalMs).toBe(30000);
      expect(defaultTracker.significantPnlChange).toBe(100);
    });
  });

  describe('Trade Count', () => {
    it('should count each fill as a trade', () => {
      tracker.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', isMaker: true, execID: 'e1' });
      tracker.onFill({ side: 'buy', quantity: 1, price: 101, venue: 'truex', isMaker: true, execID: 'e2' });
      tracker.onFill({ side: 'sell', quantity: 2, price: 105, venue: 'truex', isMaker: true, execID: 'e3' });

      expect(tracker.getSummary().numTrades).toBe(3);
    });
  });
});
