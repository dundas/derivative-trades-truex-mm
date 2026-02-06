import { describe, it, expect, beforeEach, jest } from 'bun:test';
import { InventoryManager } from '../src/core/inventory-manager.js';

describe('InventoryManager', () => {
  let im;
  let logger;

  beforeEach(() => {
    logger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    im = new InventoryManager({
      maxPositionBTC: 1.0,
      hedgeThresholdBTC: 0.5,
      maxSkewTicks: 5,
      skewExponent: 2,
      emergencyLimitBTC: 1.2,
      tickSize: 0.5,
      logger
    });
  });

  // ─── Position Tracking ───────────────────────────────────────────

  describe('position tracking', () => {
    it('should start with zero position', () => {
      expect(im.netPosition).toBe(0);
      expect(im.avgEntryPrice).toBe(0);
      expect(im.fillCount).toBe(0);
    });

    it('should increase net position on buy', () => {
      im.onFill({ side: 'buy', quantity: 1, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.netPosition).toBe(1);
      expect(im.totalBought).toBe(1);
    });

    it('should decrease net position on sell', () => {
      im.onFill({ side: 'buy', quantity: 1, price: 100000, venue: 'truex', execID: 'E1' });
      im.onFill({ side: 'sell', quantity: 0.5, price: 100100, venue: 'truex', execID: 'E2' });
      expect(im.netPosition).toBeCloseTo(0.5, 10);
      expect(im.totalBought).toBe(1);
      expect(im.totalSold).toBe(0.5);
    });

    it('should go net short on more sells than buys', () => {
      im.onFill({ side: 'sell', quantity: 0.8, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.netPosition).toBeCloseTo(-0.8, 10);
    });

    it('should track fill count', () => {
      im.onFill({ side: 'buy', quantity: 0.1, price: 100000, venue: 'truex', execID: 'E1' });
      im.onFill({ side: 'buy', quantity: 0.2, price: 100050, venue: 'truex', execID: 'E2' });
      im.onFill({ side: 'sell', quantity: 0.15, price: 100100, venue: 'truex', execID: 'E3' });
      expect(im.fillCount).toBe(3);
    });

    it('should handle case-insensitive side', () => {
      im.onFill({ side: 'BUY', quantity: 0.5, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.netPosition).toBe(0.5);
      im.onFill({ side: 'SELL', quantity: 0.5, price: 100100, venue: 'truex', execID: 'E2' });
      expect(im.netPosition).toBeCloseTo(0, 10);
    });
  });

  // ─── VWAP Entry Price ────────────────────────────────────────────

  describe('VWAP entry price', () => {
    it('should compute VWAP for single buy', () => {
      im.onFill({ side: 'buy', quantity: 1, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.avgEntryPrice).toBe(100000);
    });

    it('should compute VWAP for multiple buys', () => {
      im.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', execID: 'E1' });
      im.onFill({ side: 'buy', quantity: 1, price: 200, venue: 'truex', execID: 'E2' });
      expect(im.avgEntryPrice).toBe(150);
    });

    it('should compute weighted VWAP for unequal sizes', () => {
      im.onFill({ side: 'buy', quantity: 1, price: 100, venue: 'truex', execID: 'E1' });
      im.onFill({ side: 'buy', quantity: 3, price: 200, venue: 'truex', execID: 'E2' });
      // (1*100 + 3*200) / 4 = 700/4 = 175
      expect(im.avgEntryPrice).toBe(175);
    });

    it('should compute sell-side VWAP when net short', () => {
      im.onFill({ side: 'sell', quantity: 1, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.avgEntryPrice).toBe(100000);
    });

    it('should reset avg entry price when flat', () => {
      im.onFill({ side: 'buy', quantity: 1, price: 100000, venue: 'truex', execID: 'E1' });
      im.onFill({ side: 'sell', quantity: 1, price: 100100, venue: 'truex', execID: 'E2' });
      expect(im.netPosition).toBeCloseTo(0, 10);
      expect(im.avgEntryPrice).toBe(0);
    });
  });

  // ─── Skew Calculation ────────────────────────────────────────────

  describe('skew calculation', () => {
    it('should return zero skew at zero position', () => {
      const skew = im.getSkew();
      expect(skew.bidSkewTicks).toBe(0);
      expect(skew.askSkewTicks).toBe(0);
    });

    it('should return zero skew with maxPositionBTC of 0', () => {
      const im2 = new InventoryManager({ maxPositionBTC: 0, logger });
      const skew = im2.getSkew();
      expect(skew.bidSkewTicks).toBe(0);
      expect(skew.askSkewTicks).toBe(0);
    });

    it('should compute correct skew at 50% utilization (long)', () => {
      im.onFill({ side: 'buy', quantity: 0.5, price: 100000, venue: 'truex', execID: 'E1' });
      const skew = im.getSkew();
      // utilization = 0.5, rawSkew = (0.5)^2 * 5 = 1.25
      // long: ask positive, bid negative
      expect(skew.askSkewTicks).toBeCloseTo(1.25, 10);
      expect(skew.bidSkewTicks).toBeCloseTo(-1.25, 10);
    });

    it('should compute correct skew at 50% utilization (short)', () => {
      im.onFill({ side: 'sell', quantity: 0.5, price: 100000, venue: 'truex', execID: 'E1' });
      const skew = im.getSkew();
      // utilization = 0.5, rawSkew = (0.5)^2 * 5 = 1.25
      // short: bid positive, ask negative
      expect(skew.bidSkewTicks).toBeCloseTo(1.25, 10);
      expect(skew.askSkewTicks).toBeCloseTo(-1.25, 10);
    });

    it('should compute maxSkewTicks at 100% utilization', () => {
      im.onFill({ side: 'buy', quantity: 1.0, price: 100000, venue: 'truex', execID: 'E1' });
      const skew = im.getSkew();
      // utilization = 1.0, rawSkew = (1.0)^2 * 5 = 5
      expect(skew.askSkewTicks).toBeCloseTo(5, 10);
      expect(skew.bidSkewTicks).toBeCloseTo(-5, 10);
    });

    it('should scale quadratically with skewExponent=2', () => {
      // At 25% utilization: rawSkew = (0.25)^2 * 5 = 0.3125
      im.onFill({ side: 'buy', quantity: 0.25, price: 100000, venue: 'truex', execID: 'E1' });
      const skew = im.getSkew();
      expect(skew.askSkewTicks).toBeCloseTo(0.3125, 10);
      expect(skew.bidSkewTicks).toBeCloseTo(-0.3125, 10);
    });

    it('should respect custom skewExponent', () => {
      const im3 = new InventoryManager({
        maxPositionBTC: 1.0,
        maxSkewTicks: 10,
        skewExponent: 3,
        logger
      });
      im3.onFill({ side: 'buy', quantity: 0.5, price: 100000, venue: 'truex', execID: 'E1' });
      const skew = im3.getSkew();
      // rawSkew = (0.5)^3 * 10 = 1.25
      expect(skew.askSkewTicks).toBeCloseTo(1.25, 10);
    });
  });

  // ─── canQuote ────────────────────────────────────────────────────

  describe('canQuote', () => {
    it('should allow both sides when flat', () => {
      expect(im.canQuote('buy')).toBe(true);
      expect(im.canQuote('sell')).toBe(true);
    });

    it('should allow both sides below limit', () => {
      im.onFill({ side: 'buy', quantity: 0.5, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.canQuote('buy')).toBe(true);
      expect(im.canQuote('sell')).toBe(true);
    });

    it('should block buy when long at max', () => {
      im.onFill({ side: 'buy', quantity: 1.0, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.canQuote('buy')).toBe(false);
      expect(im.canQuote('sell')).toBe(true);
    });

    it('should block sell when short at max', () => {
      im.onFill({ side: 'sell', quantity: 1.0, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.canQuote('sell')).toBe(false);
      expect(im.canQuote('buy')).toBe(true);
    });

    it('should handle case-insensitive side for canQuote', () => {
      im.onFill({ side: 'buy', quantity: 1.0, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.canQuote('BUY')).toBe(false);
      expect(im.canQuote('SELL')).toBe(true);
    });

    it('should block buy when exactly at limit', () => {
      im.onFill({ side: 'buy', quantity: 1.0, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.canQuote('buy')).toBe(false);
    });
  });

  // ─── shouldHedge ─────────────────────────────────────────────────

  describe('shouldHedge', () => {
    it('should not hedge when below threshold', () => {
      im.onFill({ side: 'buy', quantity: 0.3, price: 100000, venue: 'truex', execID: 'E1' });
      const result = im.shouldHedge();
      expect(result.shouldHedge).toBe(false);
    });

    it('should hedge sell when long at threshold', () => {
      im.onFill({ side: 'buy', quantity: 0.5, price: 100000, venue: 'truex', execID: 'E1' });
      const result = im.shouldHedge();
      expect(result.shouldHedge).toBe(true);
      expect(result.side).toBe('sell');
      expect(result.size).toBe(0.5);
    });

    it('should hedge buy when short at threshold', () => {
      im.onFill({ side: 'sell', quantity: 0.5, price: 100000, venue: 'truex', execID: 'E1' });
      const result = im.shouldHedge();
      expect(result.shouldHedge).toBe(true);
      expect(result.side).toBe('buy');
      expect(result.size).toBe(0.5);
    });

    it('should hedge with correct size above threshold', () => {
      im.onFill({ side: 'buy', quantity: 0.8, price: 100000, venue: 'truex', execID: 'E1' });
      const result = im.shouldHedge();
      expect(result.shouldHedge).toBe(true);
      expect(result.side).toBe('sell');
      expect(result.size).toBeCloseTo(0.8, 10);
    });
  });

  // ─── Events ──────────────────────────────────────────────────────

  describe('events', () => {
    it('should emit fill event on each fill', () => {
      const fillHandler = jest.fn();
      im.on('fill', fillHandler);

      im.onFill({ side: 'buy', quantity: 0.1, price: 100000, venue: 'truex', execID: 'E1' });

      expect(fillHandler).toHaveBeenCalledTimes(1);
      const arg = fillHandler.mock.calls[0][0];
      expect(arg.side).toBe('buy');
      expect(arg.quantity).toBe(0.1);
      expect(arg.price).toBe(100000);
      expect(arg.netPosition).toBeCloseTo(0.1, 10);
      expect(arg.execID).toBe('E1');
    });

    it('should emit limit-warning at 80% utilization', () => {
      const warningHandler = jest.fn();
      im.on('limit-warning', warningHandler);

      im.onFill({ side: 'buy', quantity: 0.8, price: 100000, venue: 'truex', execID: 'E1' });

      expect(warningHandler).toHaveBeenCalledTimes(1);
      const arg = warningHandler.mock.calls[0][0];
      expect(arg.utilizationPct).toBeCloseTo(0.8, 10);
      expect(arg.side).toBe('long');
    });

    it('should not emit limit-warning below 80% utilization', () => {
      const warningHandler = jest.fn();
      im.on('limit-warning', warningHandler);

      im.onFill({ side: 'buy', quantity: 0.79, price: 100000, venue: 'truex', execID: 'E1' });

      expect(warningHandler).not.toHaveBeenCalled();
    });

    it('should emit emergency at emergency limit', () => {
      const emergencyHandler = jest.fn();
      im.on('emergency', emergencyHandler);

      // Emergency at 1.2 BTC
      im.onFill({ side: 'buy', quantity: 1.2, price: 100000, venue: 'truex', execID: 'E1' });

      expect(emergencyHandler).toHaveBeenCalledTimes(1);
      const arg = emergencyHandler.mock.calls[0][0];
      expect(arg.netPosition).toBeCloseTo(1.2, 10);
      expect(arg.reason).toContain('emergency limit');
    });

    it('should emit hedge-signal when crossing threshold', () => {
      const hedgeHandler = jest.fn();
      im.on('hedge-signal', hedgeHandler);

      im.onFill({ side: 'buy', quantity: 0.6, price: 100000, venue: 'truex', execID: 'E1' });

      expect(hedgeHandler).toHaveBeenCalledTimes(1);
      const arg = hedgeHandler.mock.calls[0][0];
      expect(arg.shouldHedge).toBe(true);
      expect(arg.side).toBe('sell');
    });

    it('should not emit hedge-signal when below threshold after emergency', () => {
      const hedgeHandler = jest.fn();
      im.on('hedge-signal', hedgeHandler);

      // Emergency fill triggers emergency event but returns early before hedge check
      im.onFill({ side: 'buy', quantity: 1.2, price: 100000, venue: 'truex', execID: 'E1' });

      expect(hedgeHandler).not.toHaveBeenCalled();
    });
  });

  // ─── getPositionSummary ──────────────────────────────────────────

  describe('getPositionSummary', () => {
    it('should return flat summary when no fills', () => {
      const summary = im.getPositionSummary();
      expect(summary.netPosition).toBe(0);
      expect(summary.side).toBe('flat');
      expect(summary.utilizationPct).toBe(0);
      expect(summary.canQuoteBuy).toBe(true);
      expect(summary.canQuoteSell).toBe(true);
      expect(summary.hedgeNeeded).toBe(false);
    });

    it('should return long summary with correct data', () => {
      im.onFill({ side: 'buy', quantity: 0.6, price: 100000, venue: 'truex', execID: 'E1' });
      const summary = im.getPositionSummary();
      expect(summary.netPosition).toBeCloseTo(0.6, 10);
      expect(summary.side).toBe('long');
      expect(summary.utilizationPct).toBeCloseTo(0.6, 10);
      expect(summary.avgEntryPrice).toBe(100000);
      expect(summary.fillCount).toBe(1);
      expect(summary.totalBought).toBe(0.6);
      expect(summary.hedgeNeeded).toBe(true);
    });

    it('should include skew in summary', () => {
      im.onFill({ side: 'buy', quantity: 0.5, price: 100000, venue: 'truex', execID: 'E1' });
      const summary = im.getPositionSummary();
      expect(summary.bidSkewTicks).toBeCloseTo(-1.25, 10);
      expect(summary.askSkewTicks).toBeCloseTo(1.25, 10);
    });
  });

  // ─── Reset ───────────────────────────────────────────────────────

  describe('reset', () => {
    it('should zero all state', () => {
      im.onFill({ side: 'buy', quantity: 0.5, price: 100000, venue: 'truex', execID: 'E1' });
      im.onFill({ side: 'sell', quantity: 0.2, price: 100100, venue: 'truex', execID: 'E2' });

      im.reset();

      expect(im.netPosition).toBe(0);
      expect(im.avgEntryPrice).toBe(0);
      expect(im.totalBought).toBe(0);
      expect(im.totalSold).toBe(0);
      expect(im.fillCount).toBe(0);
      expect(im.totalBuyCost).toBe(0);
      expect(im.totalBuyQty).toBe(0);
      expect(im.totalSellCost).toBe(0);
      expect(im.totalSellQty).toBe(0);
    });

    it('should allow normal operation after reset', () => {
      im.onFill({ side: 'buy', quantity: 1.0, price: 100000, venue: 'truex', execID: 'E1' });
      im.reset();

      im.onFill({ side: 'buy', quantity: 0.3, price: 99000, venue: 'truex', execID: 'E3' });
      expect(im.netPosition).toBeCloseTo(0.3, 10);
      expect(im.avgEntryPrice).toBe(99000);
      expect(im.fillCount).toBe(1);
    });

    it('should reset skew to zero', () => {
      im.onFill({ side: 'buy', quantity: 0.5, price: 100000, venue: 'truex', execID: 'E1' });
      im.reset();
      const skew = im.getSkew();
      expect(skew.bidSkewTicks).toBe(0);
      expect(skew.askSkewTicks).toBe(0);
    });
  });

  // ─── Edge Cases ──────────────────────────────────────────────────

  describe('edge cases', () => {
    it('should ignore fill with zero quantity', () => {
      im.onFill({ side: 'buy', quantity: 0, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.netPosition).toBe(0);
      expect(im.fillCount).toBe(0);
    });

    it('should ignore fill with negative quantity', () => {
      im.onFill({ side: 'buy', quantity: -1, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.netPosition).toBe(0);
      expect(im.fillCount).toBe(0);
    });

    it('should ignore fill with missing side', () => {
      im.onFill({ quantity: 1, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.netPosition).toBe(0);
    });

    it('should ignore fill with unknown side', () => {
      im.onFill({ side: 'foo', quantity: 1, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.netPosition).toBe(0);
    });

    it('should handle many small fills without drift', () => {
      for (let i = 0; i < 100; i++) {
        im.onFill({ side: 'buy', quantity: 0.001, price: 100000, venue: 'truex', execID: `E${i}` });
      }
      expect(im.netPosition).toBeCloseTo(0.1, 8);
      expect(im.fillCount).toBe(100);
    });

    it('should handle fill at exactly the position limit', () => {
      im.onFill({ side: 'buy', quantity: 1.0, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.netPosition).toBe(1.0);
      expect(im.canQuote('buy')).toBe(false);
      expect(im.canQuote('sell')).toBe(true);
    });

    it('should use default emergencyLimitBTC as 1.2x maxPositionBTC', () => {
      const im2 = new InventoryManager({ maxPositionBTC: 2.0, logger });
      expect(im2.emergencyLimitBTC).toBe(2.4);
    });

    it('should handle transitioning from long to short', () => {
      im.onFill({ side: 'buy', quantity: 0.5, price: 100000, venue: 'truex', execID: 'E1' });
      expect(im.netPosition).toBeCloseTo(0.5, 10);

      im.onFill({ side: 'sell', quantity: 1.0, price: 100200, venue: 'truex', execID: 'E2' });
      expect(im.netPosition).toBeCloseTo(-0.5, 10);

      // Should now reflect short side for skew
      const skew = im.getSkew();
      expect(skew.bidSkewTicks).toBeGreaterThan(0);
      expect(skew.askSkewTicks).toBeLessThan(0);
    });

    it('should emit limit-warning for short side at 80%', () => {
      const warningHandler = jest.fn();
      im.on('limit-warning', warningHandler);

      im.onFill({ side: 'sell', quantity: 0.8, price: 100000, venue: 'truex', execID: 'E1' });

      expect(warningHandler).toHaveBeenCalledTimes(1);
      expect(warningHandler.mock.calls[0][0].side).toBe('short');
    });
  });

  // ─── Constructor Defaults ────────────────────────────────────────

  describe('constructor defaults', () => {
    it('should use sensible defaults', () => {
      const im2 = new InventoryManager();
      expect(im2.maxPositionBTC).toBe(1.0);
      expect(im2.hedgeThresholdBTC).toBe(0.5);
      expect(im2.maxSkewTicks).toBe(5);
      expect(im2.skewExponent).toBe(2);
      expect(im2.tickSize).toBe(0.5);
      expect(im2.limitWarningPct).toBe(0.8);
    });

    it('should accept custom configuration', () => {
      const im2 = new InventoryManager({
        maxPositionBTC: 5.0,
        hedgeThresholdBTC: 2.0,
        maxSkewTicks: 10,
        skewExponent: 3,
        emergencyLimitBTC: 6.0,
        tickSize: 1.0,
        limitWarningPct: 0.9,
        logger
      });
      expect(im2.maxPositionBTC).toBe(5.0);
      expect(im2.hedgeThresholdBTC).toBe(2.0);
      expect(im2.maxSkewTicks).toBe(10);
      expect(im2.skewExponent).toBe(3);
      expect(im2.emergencyLimitBTC).toBe(6.0);
      expect(im2.tickSize).toBe(1.0);
      expect(im2.limitWarningPct).toBe(0.9);
    });
  });
});
