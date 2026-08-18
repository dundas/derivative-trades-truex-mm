import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { CryptoComReferenceBookFeed } from './CryptoComReferenceBookFeed.js';

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  readyState = 0;
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit('close'); }
  open() { this.readyState = 1; this.emit('open'); }
  message(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

const update = (overrides = {}) => ({
  id: -1, method: 'subscribe', code: 0,
  result: { instrument_name: 'BTC_PYUSD', subscription: 'book.BTC_PYUSD.10',
    channel: 'book', depth: 10, data: [{
    t: 9_950, tt: 9_000, u: 41, bids: [['99', '2', '1']], asks: [['101', '3', '1']],
    ...overrides,
  }] },
});
const ack = id => ({ id, method: 'subscribe', code: 0, channel: 'book.BTC_PYUSD.10' });

describe('CryptoComReferenceBookFeed', () => {
  test('stamps receipt locally and exposes strict full-book provenance', async () => {
    const socket = new FakeSocket();
    const feed = new CryptoComReferenceBookFeed({
      url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD', depth: 10,
      now: () => 10_000, webSocketFactory: () => socket, reconnectDelayMs: 100,
      subscribeDelayMs: 0, heartbeatTimeoutMs: 0,
    });
    feed.start(); socket.open(); socket.message(ack(1)); socket.message(update());
    expect(socket.sent[0]).toMatchObject({ method: 'subscribe', params: { channels: ['book.BTC_PYUSD.10'] } });
    expect(feed.getBook()).toEqual({
      exchange: 'cryptocom', sourceType: 'public-ws-book', instrument: 'BTC_PYUSD',
      channel: 'book.BTC_PYUSD.10', bid: 99, ask: 101, sourceTimestamp: 9950,
      bidQty: 2, askQty: 3, bidCount: 1, askCount: 1, depth: 10,
      bookUpdateTimestamp: 9000, receivedTimestamp: 10000, sequence: 41, generation: 1,
      sourceSessionId: expect.any(String),
      sourceEndpoint: 'wss://stream.crypto.com/exchange/v1/market', sourceBookHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(feed.getStats()).toMatchObject({ running: true, eligible: true, generation: 1,
      lastSourceTimestamp: 9950, config: { endpoint: 'wss://stream.crypto.com/exchange/v1/market',
        instrument: 'BTC_PYUSD', channel: 'book.BTC_PYUSD.10', depth: 10,
        maxAgeMs: 5000, reconnectDelayMs: 100, subscribeDelayMs: 0,
        heartbeatTimeoutMs: 0, reconnectJitterMs: 0 } });
    expect(Object.isFrozen(feed.getStats().config)).toBe(true);
    feed.stop();
  });

  test('fails closed and reconnects on malformed, crossed, stale, or sequence-gap books', () => {
    const tooDeep = Array.from({ length: 11 }, (_, index) =>
      [String(99 - index / 100), '1', '1']);
    for (const bad of [
      { bids: [['bad', '2', '1']] }, { bids: [['102', '2', '1']] },
      { t: 8_000 }, { u: 41, asks: [['102', '3', '1']] },
      { bids: [['99', '2', '1', 'extra']] }, { bids: [[true, '2', '1']] },
      { bids: tooDeep },
    ]) {
      let now = 10_000;
      const sockets = [new FakeSocket(), new FakeSocket()];
      const scheduled = [];
      const feed = new CryptoComReferenceBookFeed({
        url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD', depth: 10,
        maxAgeMs: 500, now: () => now, webSocketFactory: () => sockets.shift(),
        reconnectDelayMs: 100, subscribeDelayMs: 0, heartbeatTimeoutMs: 0,
        setTimeoutFn: fn => { scheduled.push(fn); return 1; },
        clearTimeoutFn: () => {},
      });
      feed.start(); const socket = feed.socket; socket.open(); socket.message(ack(1));
      if (bad.u === 41) socket.message(update());
      socket.message(update(bad));
      expect(feed.getBook()).toBeNull();
      expect(scheduled.length).toBe(1);
      feed.stop();
    }
  });

  test('fences stale generations and answers public heartbeat without accepting it as a book', () => {
    const sockets = [new FakeSocket(), new FakeSocket()];
    const scheduled = [];
    const feed = new CryptoComReferenceBookFeed({
      url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD', depth: 10,
      now: () => 10_000, webSocketFactory: () => sockets.shift(), reconnectDelayMs: 100,
      subscribeDelayMs: 0, heartbeatTimeoutMs: 0,
      setTimeoutFn: fn => { scheduled.push(fn); return 1; }, clearTimeoutFn: () => {},
    });
    feed.start(); const old = feed.socket; old.open(); old.emit('close'); scheduled.shift()();
    const current = feed.socket; current.open(); current.message(ack(2));
    old.message(update());
    expect(feed.getBook()).toBeNull();
    current.message({ id: 7, method: 'public/heartbeat' });
    expect(current.sent.at(-1)).toEqual({ id: 7, method: 'public/respond-heartbeat' });
    current.message(update({ u: 1 }));
    expect(feed.getBook()).toMatchObject({ generation: 2, sequence: 1 });
    feed.stop();
  });

  test('accepts only identical same-u snapshots with a strictly newer publication time', () => {
    const socket = new FakeSocket(); let now = 10_000;
    const feed = new CryptoComReferenceBookFeed({ url: 'wss://stream.crypto.com/exchange/v1/market',
      instrument: 'BTC_PYUSD', depth: 10, maxAgeMs: 500, reconnectDelayMs: 100,
      subscribeDelayMs: 0, heartbeatTimeoutMs: 0,
      now: () => now, webSocketFactory: () => socket });
    feed.start(); socket.open(); socket.message(ack(1)); socket.message(update());
    now = 10_100; socket.message(update({ t: 10_050 }));
    expect(feed.getBook()).toMatchObject({ sequence: 41, sourceTimestamp: 10_050,
      receivedTimestamp: 10_100 });
    socket.message(update({ t: 10_050 }));
    expect(feed.getBook()).toBeNull();
    feed.stop();
  });

  test('delays subscription and clears eligibility on a generation-fenced watchdog timeout', () => {
    const socket = new FakeSocket(); const timers = [];
    const setTimeoutFn = (fn, delay) => { const token = { fn, delay, cleared: false };
      timers.push(token); return token; };
    const feed = new CryptoComReferenceBookFeed({
      url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD', depth: 10,
      maxAgeMs: 500, reconnectDelayMs: 100, subscribeDelayMs: 1_000,
      heartbeatTimeoutMs: 5_000, reconnectJitterMs: 0, now: () => 10_000,
      webSocketFactory: () => socket, setTimeoutFn,
      clearTimeoutFn: token => { token.cleared = true; }, random: () => 0,
    });
    feed.start(); socket.open();
    expect(socket.sent).toEqual([]);
    timers.find(timer => timer.delay === 1_000).fn();
    expect(socket.sent[0]).toMatchObject({ method: 'subscribe' });
    socket.message(ack(1)); socket.message(update());
    expect(feed.getBook()).not.toBeNull();
    const watchdog = timers.filter(timer => timer.delay === 5_000 && !timer.cleared).at(-1);
    watchdog.fn();
    expect(feed.getBook()).toBeNull();
    expect(timers.some(timer => timer.delay === 100 && !timer.cleared)).toBe(true);
    feed.stop();
  });

  test('rejects wrong channel/depth and same-u quantity/count changes', () => {
    for (const message of [
      { ...update(), id: 999, method: 'evil', code: 123 },
      { ...update(), result: { ...update().result, channel: 'ticker' } },
      { ...update(), result: { ...update().result, channel: 'book', depth: 50 } },
      { ...update(), result: { ...update().result, channel: undefined } },
      { ...update(), result: { ...update().result, depth: undefined } },
    ]) {
      const socket = new FakeSocket();
      const feed = new CryptoComReferenceBookFeed({
        url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD', depth: 10,
        reconnectDelayMs: 100, subscribeDelayMs: 0, heartbeatTimeoutMs: 0,
        now: () => 10_000, webSocketFactory: () => socket,
      });
      feed.start(); socket.open(); socket.message(ack(1)); socket.message(message);
      expect(feed.getBook()).toBeNull(); feed.stop();
    }
    const socket = new FakeSocket(); let now = 10_000;
    const feed = new CryptoComReferenceBookFeed({
      url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD', depth: 10,
      reconnectDelayMs: 100, subscribeDelayMs: 0, heartbeatTimeoutMs: 0,
      now: () => now, webSocketFactory: () => socket,
    });
    feed.start(); socket.open(); socket.message(ack(1)); socket.message(update());
    now = 10_100;
    socket.message(update({ t: 10_050, bids: [['99', '4', '2']] }));
    expect(feed.getBook()).toBeNull(); feed.stop();
  });

  test('requires the exact subscription acknowledgement and official endpoint identity', () => {
    for (const url of [
      'wss://evil.example/exchange/v1/market',
      'wss://stream.crypto.com/exchange/v1/market?redirect=evil',
      'wss://user@stream.crypto.com/exchange/v1/market',
      'wss://stream.crypto.com:444/exchange/v1/market',
    ]) {
      expect(() => new CryptoComReferenceBookFeed({ url, instrument: 'BTC_PYUSD', depth: 10,
        reconnectDelayMs: 100 })).toThrow('exact official public market endpoint');
    }
    for (const badAck of [
      { ...ack(2), id: 9 },
      { ...ack(2), code: 1 },
      { ...ack(2), channel: undefined },
      { ...ack(2), channel: 'book.ETH_USD.10' },
      { ...ack(2), result: { channel: 'book.ETH_USD.10' } },
    ]) {
      const socket = new FakeSocket();
      const feed = new CryptoComReferenceBookFeed({
        url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD', depth: 10,
        reconnectDelayMs: 100, subscribeDelayMs: 0, heartbeatTimeoutMs: 0,
        now: () => 10_000, webSocketFactory: () => socket,
      });
      feed.start(); socket.open(); socket.message(badAck);
      expect(feed.getBook()).toBeNull(); expect(feed.socket).toBeNull(); feed.stop();
    }
  });

  test('accepts the captured live top-level subscribe acknowledgement without a result object', () => {
    const socket = new FakeSocket();
    const feed = new CryptoComReferenceBookFeed({
      url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD', depth: 10,
      reconnectDelayMs: 100, subscribeDelayMs: 0, heartbeatTimeoutMs: 0,
      now: () => 10_000, webSocketFactory: () => socket,
    });
    feed.start(); socket.open();
    socket.message({ id: 1, method: 'subscribe', code: 0, channel: 'book.BTC_PYUSD.10' });
    // Captured live snapshots reuse method=subscribe with id=-1 and put identity/data in result.
    socket.message(update());
    expect(feed.getBook()).toMatchObject({ bid: 99, ask: 101, generation: 1 });
    feed.stop();
  });

  test('expires a locally stale snapshot and reconnects without waiting for a collector poll', () => {
    let now = 10_000; const socket = new FakeSocket(); const timers = [];
    const feed = new CryptoComReferenceBookFeed({
      url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD', depth: 10,
      maxAgeMs: 500, reconnectDelayMs: 100, subscribeDelayMs: 0, heartbeatTimeoutMs: 0,
      now: () => now, webSocketFactory: () => socket,
      setTimeoutFn: (fn, delay) => { const token = { fn, delay, cleared: false }; timers.push(token); return token; },
      clearTimeoutFn: token => { token.cleared = true; },
    });
    feed.start(); socket.open(); socket.message(ack(1)); socket.message(update());
    expect(feed.getBook()).not.toBeNull(); now = 10_501;
    expect(feed.getBook()).toBeNull();
    expect(timers.filter(timer => timer.delay === 100 && !timer.cleared)).toHaveLength(1);
    feed.stop();
  });

  test('cancels delayed subscribe on stop and schedules only one reconnect per failed generation', () => {
    const socket = new FakeSocket(); const timers = [];
    const setTimeoutFn = (fn, delay) => { const token = { fn, delay, cleared: false };
      timers.push(token); return token; };
    const feed = new CryptoComReferenceBookFeed({
      url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD', depth: 10,
      maxAgeMs: 500, reconnectDelayMs: 100, subscribeDelayMs: 1_000,
      heartbeatTimeoutMs: 5_000, now: () => 10_000, webSocketFactory: () => socket,
      setTimeoutFn, clearTimeoutFn: token => { token.cleared = true; },
    });
    feed.start(); socket.open(); const delayed = timers.find(timer => timer.delay === 1_000);
    feed.stop(); delayed.fn(); expect(socket.sent).toEqual([]);

    const failing = new FakeSocket(); const reconnectTimers = [];
    const retrying = new CryptoComReferenceBookFeed({
      url: 'wss://stream.crypto.com/exchange/v1/market', instrument: 'BTC_PYUSD', depth: 10,
      maxAgeMs: 500, reconnectDelayMs: 100, subscribeDelayMs: 0, heartbeatTimeoutMs: 0,
      now: () => 10_000, webSocketFactory: () => failing,
      setTimeoutFn: (fn, delay) => { const token = { fn, delay, cleared: false }; reconnectTimers.push(token); return token; },
      clearTimeoutFn: token => { token.cleared = true; },
    });
    retrying.start(); failing.open(); failing.emit('error', new Error('down')); failing.emit('close');
    expect(reconnectTimers.filter(timer => timer.delay === 100 && !timer.cleared)).toHaveLength(1);
    retrying.stop();
  });
});
