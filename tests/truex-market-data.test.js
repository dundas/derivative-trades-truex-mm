import { describe, it, expect, beforeEach, jest } from 'bun:test';
import { TrueXMarketDataFeed } from '../src/core/truex-market-data.js';

/**
 * Helper: create a mock FIXConnection for dependency injection.
 */
function createMockFix() {
  const listeners = {};
  return {
    on: jest.fn((event, handler) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
    }),
    emit: jest.fn((event, ...args) => {
      for (const h of (listeners[event] || [])) h(...args);
    }),
    connect: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue({}),
    disconnect: jest.fn().mockResolvedValue(undefined),
    removeListener: jest.fn((event, handler) => {
      if (listeners[event]) {
        listeners[event] = listeners[event].filter(h => h !== handler);
      }
    }),
    isLoggedOn: true,
    senderCompID: 'CLI_CLIENT',
    targetCompID: 'TRUEX_UAT_MD',
    msgSeqNum: 1,
    beginString: 'FIXT.1.1',
    sentMessages: new Map(),
    socket: null, // null so _sendMDRequest takes the mock sendMessage path
    getUTCTimestamp: () => '20260206-12:00:00.000',
    _listeners: listeners, // expose for test triggering
  };
}

/**
 * Helper: simulate a FIX message arriving on the mock connection.
 * Triggers the 'message' handler that TrueXMarketDataFeed registered.
 */
function simulateMessage(mockFix, fields, raw) {
  const message = { fields, raw: raw || '' };
  // Call registered 'message' listeners directly
  for (const handler of (mockFix._listeners['message'] || [])) {
    handler(message);
  }
}

/**
 * Helper: build a snapshot message with indexed fields (test format).
 */
function buildSnapshotFields(entries) {
  const fields = {
    '35': 'W',
    '55': 'BTC-PYUSD',
    '262': 'MDR_TEST',
    '268': String(entries.length),
  };
  entries.forEach((entry, idx) => {
    const i = idx + 1;
    fields[`269.${i}`] = entry.type;
    fields[`270.${i}`] = String(entry.price);
    fields[`271.${i}`] = String(entry.size);
  });
  return fields;
}

/**
 * Helper: build an incremental refresh message with indexed fields.
 */
function buildIncrementalFields(entries) {
  const fields = {
    '35': 'X',
    '55': 'BTC-PYUSD',
    '262': 'MDR_TEST',
    '268': String(entries.length),
  };
  entries.forEach((entry, idx) => {
    const i = idx + 1;
    fields[`269.${i}`] = entry.type;
    fields[`270.${i}`] = String(entry.price);
    fields[`271.${i}`] = String(entry.size);
    fields[`279.${i}`] = entry.action || '0';
  });
  return fields;
}

// =============================================================================
// Tests
// =============================================================================

describe('TrueXMarketDataFeed', () => {
  let feed;
  let mockFix;

  beforeEach(() => {
    mockFix = createMockFix();
    feed = new TrueXMarketDataFeed({
      fixConnection: mockFix,
      symbol: 'BTC-PYUSD',
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    });
  });

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------
  describe('constructor', () => {
    it('should use injected fixConnection', () => {
      expect(feed.fix).toBe(mockFix);
    });

    it('should default symbol to BTC-PYUSD', () => {
      const f = new TrueXMarketDataFeed({ fixConnection: mockFix });
      expect(f.symbol).toBe('BTC-PYUSD');
    });

    it('should initialize empty orderbook', () => {
      expect(feed.bids.size).toBe(0);
      expect(feed.asks.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------
  describe('connect()', () => {
    it('should call fix.connect and emit connected', async () => {
      const events = [];
      feed.on('connected', () => events.push('connected'));

      await feed.connect();

      expect(mockFix.connect).toHaveBeenCalledTimes(1);
      expect(events).toContain('connected');
    });

    it('should register message and disconnect handlers on fix', async () => {
      await feed.connect();
      expect(mockFix.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockFix.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
    });
  });

  // ---------------------------------------------------------------------------
  // Subscribe
  // ---------------------------------------------------------------------------
  describe('subscribe()', () => {
    beforeEach(async () => {
      await feed.connect();
    });

    it('should call sendMessage with MsgType V', async () => {
      await feed.subscribe('BTC-PYUSD');

      expect(mockFix.sendMessage).toHaveBeenCalledTimes(1);
      const sentFields = mockFix.sendMessage.mock.calls[0][0];
      expect(sentFields['35']).toBe('V');
      expect(sentFields['263']).toBe('1'); // Snapshot + Updates
      expect(sentFields['264']).toBe('0'); // Full book
      expect(sentFields['55']).toBe('BTC-PYUSD');
      expect(sentFields['267']).toBe('2'); // NoMDEntryTypes = 2
    });

    it('should set isSubscribed to true', async () => {
      expect(feed.isSubscribed).toBe(false);
      await feed.subscribe();
      expect(feed.isSubscribed).toBe(true);
    });

    it('should use default symbol if none provided', async () => {
      await feed.subscribe();
      const sentFields = mockFix.sendMessage.mock.calls[0][0];
      expect(sentFields['55']).toBe('BTC-PYUSD');
    });
  });

  // ---------------------------------------------------------------------------
  // Unsubscribe
  // ---------------------------------------------------------------------------
  describe('unsubscribe()', () => {
    beforeEach(async () => {
      await feed.connect();
      await feed.subscribe();
    });

    it('should send unsubscribe request (263=2)', async () => {
      await feed.unsubscribe();
      // The second sendMessage call is the unsubscribe
      const sentFields = mockFix.sendMessage.mock.calls[1][0];
      expect(sentFields['35']).toBe('V');
      expect(sentFields['263']).toBe('2'); // Unsubscribe
    });

    it('should set isSubscribed to false', async () => {
      expect(feed.isSubscribed).toBe(true);
      await feed.unsubscribe();
      expect(feed.isSubscribed).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Snapshot parsing (35=W)
  // ---------------------------------------------------------------------------
  describe('snapshot parsing (35=W)', () => {
    beforeEach(async () => {
      await feed.connect();
    });

    it('should parse bids and asks from snapshot', () => {
      const fields = buildSnapshotFields([
        { type: '0', price: 100000, size: 1.5 },  // Bid
        { type: '0', price: 99500, size: 2.0 },    // Bid
        { type: '1', price: 100500, size: 1.0 },   // Ask
        { type: '1', price: 101000, size: 0.5 },   // Ask
      ]);

      simulateMessage(mockFix, fields);

      expect(feed.bids.size).toBe(2);
      expect(feed.asks.size).toBe(2);
      expect(feed.bids.get(100000)).toBe(1.5);
      expect(feed.bids.get(99500)).toBe(2.0);
      expect(feed.asks.get(100500)).toBe(1.0);
      expect(feed.asks.get(101000)).toBe(0.5);
    });

    it('should clear previous book on new snapshot', () => {
      // First snapshot
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 50000, size: 1.0 },
        { type: '1', price: 50500, size: 1.0 },
      ]));
      expect(feed.bids.size).toBe(1);

      // Second snapshot replaces first
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 60000, size: 2.0 },
      ]));
      expect(feed.bids.size).toBe(1);
      expect(feed.bids.get(60000)).toBe(2.0);
      expect(feed.bids.has(50000)).toBe(false);
      expect(feed.asks.size).toBe(0);
    });

    it('should emit snapshot event with book data', () => {
      let emitted = null;
      feed.on('snapshot', (data) => { emitted = data; });

      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 100000, size: 1.0 },
        { type: '1', price: 100500, size: 1.0 },
      ]));

      expect(emitted).not.toBeNull();
      expect(emitted.bids).toHaveLength(1);
      expect(emitted.asks).toHaveLength(1);
    });

    it('should emit book-change event on snapshot', () => {
      let emitted = false;
      feed.on('book-change', () => { emitted = true; });

      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 100000, size: 1.0 },
      ]));

      expect(emitted).toBe(true);
    });

    it('should skip entries with zero size', () => {
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 100000, size: 0 },
        { type: '0', price: 99500, size: 1.0 },
      ]));

      expect(feed.bids.size).toBe(1);
      expect(feed.bids.has(100000)).toBe(false);
    });

    it('should handle underscore-separated indexed keys', () => {
      const fields = {
        '35': 'W',
        '268': '2',
        '269_1': '0', '270_1': '100000', '271_1': '1.5',
        '269_2': '1', '270_2': '100500', '271_2': '0.8',
      };

      simulateMessage(mockFix, fields);

      expect(feed.bids.get(100000)).toBe(1.5);
      expect(feed.asks.get(100500)).toBe(0.8);
    });
  });

  // ---------------------------------------------------------------------------
  // Incremental refresh parsing (35=X)
  // ---------------------------------------------------------------------------
  describe('incremental refresh (35=X)', () => {
    beforeEach(async () => {
      await feed.connect();

      // Load initial book
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 100000, size: 1.0 },
        { type: '0', price: 99500, size: 2.0 },
        { type: '1', price: 100500, size: 1.5 },
        { type: '1', price: 101000, size: 0.5 },
      ]));
    });

    it('should add a new bid level (action=0)', () => {
      simulateMessage(mockFix, buildIncrementalFields([
        { type: '0', price: 99000, size: 3.0, action: '0' },
      ]));

      expect(feed.bids.size).toBe(3);
      expect(feed.bids.get(99000)).toBe(3.0);
    });

    it('should change an existing bid level (action=1)', () => {
      simulateMessage(mockFix, buildIncrementalFields([
        { type: '0', price: 100000, size: 5.0, action: '1' },
      ]));

      expect(feed.bids.get(100000)).toBe(5.0);
      expect(feed.bids.size).toBe(2); // No new levels
    });

    it('should delete a bid level (action=2)', () => {
      simulateMessage(mockFix, buildIncrementalFields([
        { type: '0', price: 99500, size: 0, action: '2' },
      ]));

      expect(feed.bids.has(99500)).toBe(false);
      expect(feed.bids.size).toBe(1);
    });

    it('should delete a level when size is 0 regardless of action', () => {
      simulateMessage(mockFix, buildIncrementalFields([
        { type: '1', price: 100500, size: 0, action: '0' },
      ]));

      expect(feed.asks.has(100500)).toBe(false);
    });

    it('should add a new ask level', () => {
      simulateMessage(mockFix, buildIncrementalFields([
        { type: '1', price: 102000, size: 2.0, action: '0' },
      ]));

      expect(feed.asks.size).toBe(3);
      expect(feed.asks.get(102000)).toBe(2.0);
    });

    it('should emit update and book-change events', () => {
      const events = [];
      feed.on('update', () => events.push('update'));
      feed.on('book-change', () => events.push('book-change'));

      simulateMessage(mockFix, buildIncrementalFields([
        { type: '0', price: 98000, size: 1.0, action: '0' },
      ]));

      expect(events).toContain('update');
      expect(events).toContain('book-change');
    });

    it('should handle multiple updates in one message', () => {
      simulateMessage(mockFix, buildIncrementalFields([
        { type: '0', price: 98000, size: 1.0, action: '0' },   // New bid
        { type: '1', price: 102000, size: 2.0, action: '0' },  // New ask
        { type: '0', price: 100000, size: 0, action: '2' },    // Delete bid
      ]));

      expect(feed.bids.size).toBe(2); // 99500 + 98000 (100000 deleted)
      expect(feed.asks.size).toBe(3); // 100500 + 101000 + 102000
      expect(feed.bids.has(100000)).toBe(false);
      expect(feed.bids.get(98000)).toBe(1.0);
      expect(feed.asks.get(102000)).toBe(2.0);
    });
  });

  // ---------------------------------------------------------------------------
  // Book ordering
  // ---------------------------------------------------------------------------
  describe('getOrderBook() - ordering', () => {
    beforeEach(async () => {
      await feed.connect();
    });

    it('should return bids sorted descending by price', () => {
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 99000, size: 1.0 },
        { type: '0', price: 101000, size: 1.0 },
        { type: '0', price: 100000, size: 1.0 },
      ]));

      const book = feed.getOrderBook();
      expect(book.bids[0].price).toBe(101000);
      expect(book.bids[1].price).toBe(100000);
      expect(book.bids[2].price).toBe(99000);
    });

    it('should return asks sorted ascending by price', () => {
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '1', price: 103000, size: 1.0 },
        { type: '1', price: 101000, size: 1.0 },
        { type: '1', price: 102000, size: 1.0 },
      ]));

      const book = feed.getOrderBook();
      expect(book.asks[0].price).toBe(101000);
      expect(book.asks[1].price).toBe(102000);
      expect(book.asks[2].price).toBe(103000);
    });

    it('should include timestamp', () => {
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 100000, size: 1.0 },
      ]));

      const book = feed.getOrderBook();
      expect(book.timestamp).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // getBestBidAsk
  // ---------------------------------------------------------------------------
  describe('getBestBidAsk()', () => {
    beforeEach(async () => {
      await feed.connect();
    });

    it('should return correct top-of-book values', () => {
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 100000, size: 1.5 },
        { type: '0', price: 99500, size: 2.0 },
        { type: '1', price: 100500, size: 1.0 },
        { type: '1', price: 101000, size: 0.5 },
      ]));

      const bba = feed.getBestBidAsk();
      expect(bba.bestBid).toBe(100000);
      expect(bba.bestBidSize).toBe(1.5);
      expect(bba.bestAsk).toBe(100500);
      expect(bba.bestAskSize).toBe(1.0);
      expect(bba.spread).toBe(500);
      expect(bba.mid).toBe(100250);
    });

    it('should return nulls when book is empty', () => {
      const bba = feed.getBestBidAsk();
      expect(bba.bestBid).toBeNull();
      expect(bba.bestBidSize).toBeNull();
      expect(bba.bestAsk).toBeNull();
      expect(bba.bestAskSize).toBeNull();
      expect(bba.spread).toBeNull();
      expect(bba.mid).toBeNull();
    });

    it('should handle single-sided book (bids only)', () => {
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 100000, size: 1.0 },
      ]));

      const bba = feed.getBestBidAsk();
      expect(bba.bestBid).toBe(100000);
      expect(bba.bestBidSize).toBe(1.0);
      expect(bba.bestAsk).toBeNull();
      expect(bba.spread).toBeNull();
      expect(bba.mid).toBeNull();
    });

    it('should handle single-sided book (asks only)', () => {
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '1', price: 100500, size: 2.0 },
      ]));

      const bba = feed.getBestBidAsk();
      expect(bba.bestBid).toBeNull();
      expect(bba.bestAsk).toBe(100500);
      expect(bba.bestAskSize).toBe(2.0);
      expect(bba.spread).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getSpread
  // ---------------------------------------------------------------------------
  describe('getSpread()', () => {
    beforeEach(async () => {
      await feed.connect();
    });

    it('should calculate spread in dollars and bps', () => {
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 100000, size: 1.0 },
        { type: '1', price: 100100, size: 1.0 },
      ]));

      const spread = feed.getSpread();
      expect(spread.spreadDollars).toBe(100);
      // mid = 100050, spreadBps = (100 / 100050) * 10000 ~ 9.995
      expect(spread.spreadBps).toBeCloseTo(9.995, 1);
    });

    it('should return nulls for empty book', () => {
      const spread = feed.getSpread();
      expect(spread.spreadDollars).toBeNull();
      expect(spread.spreadBps).toBeNull();
    });

    it('should return nulls for single-sided book', () => {
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 100000, size: 1.0 },
      ]));

      const spread = feed.getSpread();
      expect(spread.spreadDollars).toBeNull();
      expect(spread.spreadBps).toBeNull();
    });

    it('should handle tight spread correctly', () => {
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 100000, size: 1.0 },
        { type: '1', price: 100000.50, size: 1.0 },
      ]));

      const spread = feed.getSpread();
      expect(spread.spreadDollars).toBeCloseTo(0.50, 2);
    });
  });

  // ---------------------------------------------------------------------------
  // Empty book
  // ---------------------------------------------------------------------------
  describe('empty book', () => {
    it('should return empty arrays from getOrderBook', () => {
      const book = feed.getOrderBook();
      expect(book.bids).toEqual([]);
      expect(book.asks).toEqual([]);
      expect(book.timestamp).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Disconnect
  // ---------------------------------------------------------------------------
  describe('disconnect()', () => {
    beforeEach(async () => {
      await feed.connect();
    });

    it('should call fix.disconnect', async () => {
      await feed.disconnect();
      expect(mockFix.disconnect).toHaveBeenCalledTimes(1);
    });

    it('should emit disconnected event', async () => {
      let emitted = false;
      feed.on('disconnected', () => { emitted = true; });

      await feed.disconnect();
      expect(emitted).toBe(true);
    });

    it('should remove listeners from fix connection', async () => {
      await feed.disconnect();
      expect(mockFix.removeListener).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockFix.removeListener).toHaveBeenCalledWith('disconnect', expect.any(Function));
    });

    it('should try to unsubscribe if subscribed', async () => {
      await feed.subscribe();
      const callsBefore = mockFix.sendMessage.mock.calls.length;

      await feed.disconnect();

      // Should have made an additional sendMessage call for unsubscribe
      expect(mockFix.sendMessage.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // FIX disconnect event
  // ---------------------------------------------------------------------------
  describe('FIX disconnect event', () => {
    it('should emit disconnected and reset isSubscribed on FIX disconnect', async () => {
      await feed.connect();
      await feed.subscribe();
      expect(feed.isSubscribed).toBe(true);

      let emitted = false;
      feed.on('disconnected', () => { emitted = true; });

      // Simulate FIX disconnect
      for (const handler of (mockFix._listeners['disconnect'] || [])) {
        handler();
      }

      expect(feed.isSubscribed).toBe(false);
      expect(emitted).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------
  describe('error handling', () => {
    beforeEach(async () => {
      await feed.connect();
    });

    it('should emit error on malformed snapshot', () => {
      let errorEmitted = null;
      feed.on('error', (err) => { errorEmitted = err; });

      // Force an error by passing fields with NaN-producing values
      // that cause issues in the parser. Actually the parser is resilient,
      // so let's mock _parseRepeatingGroup to throw
      const origParse = feed._parseRepeatingGroup.bind(feed);
      feed._parseRepeatingGroup = () => { throw new Error('parse failure'); };

      simulateMessage(mockFix, { '35': 'W', '268': '1' });

      expect(errorEmitted).not.toBeNull();
      expect(errorEmitted.message).toBe('parse failure');

      // Restore
      feed._parseRepeatingGroup = origParse;
    });
  });

  // ---------------------------------------------------------------------------
  // Raw FIX message parsing (SOH delimited)
  // ---------------------------------------------------------------------------
  describe('raw FIX message parsing', () => {
    beforeEach(async () => {
      await feed.connect();
    });

    it('should parse repeating group from raw SOH-delimited message', () => {
      const SOH = '\x01';
      const raw = [
        '8=FIXT.1.1', '9=200', '35=W', '49=TRUEX', '56=CLIENT',
        '34=5', '52=20260206-12:00:00.000', '55=BTC-PYUSD',
        '262=MDR_1', '268=3',
        '269=0', '270=100000', '271=1.5',
        '269=0', '270=99500', '271=2.0',
        '269=1', '270=100500', '271=1.0',
        '10=123',
      ].join(SOH) + SOH;

      const fields = { '35': 'W', '268': '3', '55': 'BTC-PYUSD', '262': 'MDR_1' };
      simulateMessage(mockFix, fields, raw);

      expect(feed.bids.size).toBe(2);
      expect(feed.asks.size).toBe(1);
      expect(feed.bids.get(100000)).toBe(1.5);
      expect(feed.bids.get(99500)).toBe(2.0);
      expect(feed.asks.get(100500)).toBe(1.0);
    });

    it('should parse incremental refresh from raw message', () => {
      // Load initial book first
      simulateMessage(mockFix, buildSnapshotFields([
        { type: '0', price: 100000, size: 1.0 },
        { type: '1', price: 100500, size: 1.0 },
      ]));

      const SOH = '\x01';
      const raw = [
        '8=FIXT.1.1', '9=150', '35=X', '49=TRUEX', '56=CLIENT',
        '34=6', '52=20260206-12:00:01.000',
        '262=MDR_1', '268=2',
        '279=0', '269=0', '270=99000', '271=3.0',  // New bid
        '279=2', '269=0', '270=100000', '271=0',    // Delete bid
        '10=456',
      ].join(SOH) + SOH;

      const fields = { '35': 'X', '268': '2' };
      simulateMessage(mockFix, fields, raw);

      expect(feed.bids.has(99000)).toBe(true);
      expect(feed.bids.get(99000)).toBe(3.0);
      expect(feed.bids.has(100000)).toBe(false);
    });
  });
});
