import { describe, it, expect, afterEach, jest } from 'bun:test';
import { EventEmitter } from 'events';
import { CoinbaseWsIngest, mapToCoinbaseProductId, mapFromCoinbaseProductId } from './coinbase-ws-ingest.js';

// Minimal fake WebSocket using EventEmitter so .on()/.emit() work
class FakeWS extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.isClosed = false;
  }
  send(data) { this.sent.push(data); }
  close() {
    if (!this.isClosed) {
      this.isClosed = true;
      this.emit('close', 1000, '');
    }
  }
  removeAllListeners(event) { super.removeAllListeners(event); }
}

function makeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

// Build an ingest instance with a factory that always creates a new FakeWS,
// capturing a reference to the most recently created one.
function makeIngest(opts = {}) {
  let lastWs = null;
  const factory = class extends FakeWS {
    constructor() { super(); lastWs = this; }
  };
  const { _connectTimeoutMs, ...rest } = opts;
  const ingest = new CoinbaseWsIngest({
    symbols: ['BTC-PYUSD'],
    logger: makeLogger(),
    _wsFactory: factory,
    _connectTimeoutMs: _connectTimeoutMs ?? 5000,
    ...rest,
  });
  return { ingest, getWs: () => lastWs };
}

describe('mapToCoinbaseProductId / mapFromCoinbaseProductId', () => {
  it('maps BTC-PYUSD to BTC-USD', () => {
    expect(mapToCoinbaseProductId('BTC-PYUSD')).toBe('BTC-USD');
  });
  it('maps BTC/USD to BTC-USD', () => {
    expect(mapToCoinbaseProductId('BTC/USD')).toBe('BTC-USD');
  });
  it('maps BTC-USD back to BTC-PYUSD (hardcoded special case)', () => {
    expect(mapFromCoinbaseProductId('BTC-USD')).toBe('BTC-PYUSD');
  });
  it('maps ETH-USD back to ETH/USD', () => {
    expect(mapFromCoinbaseProductId('ETH-USD')).toBe('ETH/USD');
  });
  it('maps generic product id via - to / fallback', () => {
    expect(mapFromCoinbaseProductId('SOL-USD')).toBe('SOL/USD');
  });
});

describe('CoinbaseWsIngest reconnect logic', () => {
  let ingest;
  let getWs;

  afterEach(() => {
    if (ingest) ingest.stop();
    jest.clearAllMocks();
  });

  it('connects and sets connected=true on open', async () => {
    ({ ingest, getWs } = makeIngest());
    const p = ingest.start();
    getWs().emit('open');
    await p;
    expect(ingest.connected).toBe(true);
    expect(ingest._reconnectAttempt).toBe(0);
  });

  it('sends subscribe message after open', async () => {
    ({ ingest, getWs } = makeIngest());
    const p = ingest.start();
    getWs().emit('open');
    await p;
    expect(getWs().sent.length).toBeGreaterThan(0);
    const sub = JSON.parse(getWs().sent[0]);
    expect(sub.type).toBe('subscribe');
    expect(sub.product_ids).toContain('BTC-USD');
  });

  it('schedules reconnect when WS closes after open', async () => {
    ({ ingest, getWs } = makeIngest());
    const p = ingest.start();
    getWs().emit('open');
    await p;

    const spy = jest.spyOn(ingest, '_scheduleReconnect');
    getWs().emit('close', 1006, '');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT schedule reconnect when stop() is called before close', async () => {
    ({ ingest, getWs } = makeIngest());
    const p = ingest.start();
    getWs().emit('open');
    await p;

    const spy = jest.spyOn(ingest, '_scheduleReconnect');
    ingest.stop(); // sets _stopped=true and closes ws (emits close)
    expect(spy).not.toHaveBeenCalled();
  });

  it('stop() clears a pending reconnect timer', () => {
    ({ ingest } = makeIngest());
    const fakeTimer = setTimeout(() => {}, 99999);
    ingest._reconnectTimer = fakeTimer;
    ingest.stop();
    expect(ingest._reconnectTimer).toBeNull();
  });

  it('start() clears a pending reconnect timer before connecting', async () => {
    ({ ingest, getWs } = makeIngest());
    const fakeTimer = setTimeout(() => {}, 99999);
    ingest._reconnectTimer = fakeTimer;

    const p = ingest.start();
    // Timer must be cleared synchronously before _connect is awaited
    expect(ingest._reconnectTimer).toBeNull();
    getWs().emit('open');
    await p;
  });

  it('schedules reconnect when initial connect fails (error event)', async () => {
    ({ ingest, getWs } = makeIngest());
    const spy = jest.spyOn(ingest, '_scheduleReconnect');

    const p = ingest.start();
    getWs().emit('error', new Error('ECONNREFUSED'));
    await p; // start() catches the error internally — must not throw

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('schedules reconnect when WS closes before open', async () => {
    ({ ingest, getWs } = makeIngest());
    const spy = jest.spyOn(ingest, '_scheduleReconnect');

    const p = ingest.start();
    getWs().emit('close', 1006, ''); // closed before open
    await p;

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('resets _reconnectAttempt to 0 after successful reconnect', async () => {
    ({ ingest, getWs } = makeIngest());
    ingest._reconnectAttempt = 5;
    const p = ingest.start();
    getWs().emit('open');
    await p;
    expect(ingest._reconnectAttempt).toBe(0);
  });

  it('post-connection error logs at error level (no throw)', async () => {
    ({ ingest, getWs } = makeIngest());
    const p = ingest.start();
    getWs().emit('open');
    await p;

    const ws = getWs();
    expect(() => ws.emit('error', new Error('network blip'))).not.toThrow();
    expect(ingest.logger.error).toHaveBeenCalledWith(expect.stringContaining('network blip'));
  });

  it('schedules reconnect when connect timeout fires', async () => {
    ({ ingest, getWs } = makeIngest({ _connectTimeoutMs: 1 }));
    const spy = jest.spyOn(ingest, '_scheduleReconnect');

    // start() without emitting open — 1ms timeout fires, then start() returns
    await ingest.start();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('superseded socket is closed when second start() connects', async () => {
    ({ ingest, getWs } = makeIngest());

    // First connect
    const p1 = ingest.start();
    const ws1 = getWs();
    ws1.emit('open');
    await p1;

    // Spy BEFORE second start() so we capture the eviction close
    const closeSpy = jest.spyOn(ws1, 'close');

    // Second start() should immediately close ws1 and connect ws2
    const p2 = ingest.start();
    expect(closeSpy).toHaveBeenCalledTimes(1); // eviction fires synchronously at start of _connect()
    const ws2 = getWs();
    ws2.emit('open');
    await p2;
    expect(ingest.connected).toBe(true);
  });

  it('stale close handler does not trigger reconnect when a newer connection exists', async () => {
    ({ ingest, getWs } = makeIngest());

    // First connect
    const p1 = ingest.start();
    const ws1 = getWs();
    ws1.emit('open');
    await p1;

    // Second connect (supersedes first without stop())
    const p2 = ingest.start();
    const ws2 = getWs();
    ws2.emit('open');
    await p2;

    const spy = jest.spyOn(ingest, '_scheduleReconnect');
    // Old WS closes — stale handler should NOT trigger reconnect or corrupt connected state
    ws1.emit('close', 1001, '');
    expect(spy).not.toHaveBeenCalled();
    expect(ingest.connected).toBe(true);

    // But current WS closing SHOULD trigger reconnect
    ws2.emit('close', 1006, '');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stale open fires deferred close() to release the TCP connection', async () => {
    ({ ingest, getWs } = makeIngest({ _connectTimeoutMs: 99999 }));

    // Start first connect but don't emit open
    const p1 = ingest.start();
    const ws1 = getWs();

    // Second start supersedes the first
    const p2 = ingest.start();
    const ws2 = getWs();
    ws2.emit('open');
    await p2;

    // Spy on ws1.close BEFORE emitting open on the stale socket
    const closeSpy = jest.spyOn(ws1, 'close');

    // Stale ws1 opens — should schedule a deferred close() via queueMicrotask
    ws1.emit('open');
    // queueMicrotask fires before _connect() resumes (enqueued before resolve()),
    // so closeSpy is already called by the time await p1 returns; the extra
    // await Promise.resolve() is a safety no-op to guard against future ordering changes.
    await p1;
    await Promise.resolve();

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(ingest.connected).toBe(true); // ws2 remains connected
  });

  it('stale pre-open close does not corrupt connected=true when newer connection is live', async () => {
    // Use a very long timeout so p1 never times out during this test
    ({ ingest, getWs } = makeIngest({ _connectTimeoutMs: 99999 }));

    // Spy before any awaits to catch any spurious calls from the first start()
    const spy = jest.spyOn(ingest, '_scheduleReconnect');

    // Start first connect but don't emit open — it's pending
    const p1 = ingest.start();
    const ws1 = getWs();

    // Second start supersedes the first
    const p2 = ingest.start();
    const ws2 = getWs();
    ws2.emit('open');
    await p2;

    expect(ingest.connected).toBe(true);

    // ws1 closes before it ever opened — must NOT corrupt connected or trigger reconnect
    ws1.emit('close', 1006, '');
    await p1; // stale branch resolves p1 silently; ensures no dangling promise
    await Promise.resolve(); // flush any remaining microtasks
    expect(ingest.connected).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('stop() during pending reconnect timer prevents _connect from firing', async () => {
    ({ ingest, getWs } = makeIngest());
    const p = ingest.start();
    getWs().emit('open');
    await p;

    // Track _connect calls
    const connectSpy = jest.spyOn(ingest, '_connect');

    // Trigger reconnect (schedules a timer)
    getWs().emit('close', 1006, '');
    expect(ingest._reconnectTimer).not.toBeNull();

    // stop() before the timer fires
    ingest.stop();
    expect(ingest._reconnectTimer).toBeNull();
    expect(ingest._stopped).toBe(true);

    // Even if the timer somehow fired, the _stopped guard prevents _connect
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('does NOT schedule reconnect when stop() is called before open fires (pre-open stop)', async () => {
    ({ ingest, getWs } = makeIngest({ _connectTimeoutMs: 99999 }));
    const spy = jest.spyOn(ingest, '_scheduleReconnect');

    const p = ingest.start();
    // Don't emit 'open' — handshake is in-flight
    ingest.stop(); // closes the socket mid-handshake, triggers close event before open

    await p; // start() resolves (stop set _stopped=true, close handler bails)
    expect(spy).not.toHaveBeenCalled();
    expect(ingest._stopped).toBe(true);
  });

  it('stale message handler is evicted when old connection closes', async () => {
    const received = [];
    ({ ingest, getWs } = makeIngest({
      onTicker: (_sym, data) => received.push(data),
    }));

    // First connect
    const p1 = ingest.start();
    const ws1 = getWs();
    ws1.emit('open');
    await p1;

    // Second connect supersedes first
    const p2 = ingest.start();
    const ws2 = getWs();
    ws2.emit('open');
    await p2;

    // Overlap window: ws1 is still open but ws2 is now authoritative.
    // Messages from the superseded-but-still-open ws1 must NOT be delivered.
    const tickerMsg = JSON.stringify({ type: 'ticker', product_id: 'BTC-USD', best_bid: '70000', best_ask: '70010', price: '70005', time: new Date().toISOString() });
    ws1.emit('message', tickerMsg);
    expect(received).toHaveLength(0); // overlap window: stale ws1 messages are ignored

    // Now close old WS (stale) — still should not deliver and handler is evicted
    ws1.emit('close', 1001, '');
    ws1.emit('message', tickerMsg);
    expect(received).toHaveLength(0); // handler evicted on close

    // Ticker from new WS SHOULD arrive
    ws2.emit('message', tickerMsg);
    expect(received).toHaveLength(1);
  });
});
