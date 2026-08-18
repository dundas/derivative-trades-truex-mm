import WebSocket from 'ws';
import { createHash, randomUUID } from 'node:crypto';

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
const DECIMAL_STRING = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const POSITIVE_INTEGER_STRING = /^[1-9]\d*$/;
const validLevel = level => Array.isArray(level) && level.length === 3 &&
  typeof level[0] === 'string' && DECIMAL_STRING.test(level[0]) && positive(level[0]) &&
  typeof level[1] === 'string' && DECIMAL_STRING.test(level[1]) && positive(level[1]) &&
  typeof level[2] === 'string' && POSITIVE_INTEGER_STRING.test(level[2]) &&
  Number.isSafeInteger(Number(level[2]));
const officialEndpoint = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && url.hostname === 'stream.crypto.com' &&
      (url.port === '' || url.port === '443') && url.pathname === '/exchange/v1/market' &&
      url.username === '' && url.password === '' && url.search === '' && url.hash === '';
  } catch { return false; }
};

export class CryptoComReferenceBookFeed {
  constructor({ url, instrument, depth, maxAgeMs = 5_000, reconnectDelayMs,
    subscribeDelayMs = 1_000, heartbeatTimeoutMs = 15_000, reconnectJitterMs = 0,
    now = Date.now, webSocketFactory = target => new WebSocket(target),
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, random = Math.random,
    logger = console } = {}) {
    if (!officialEndpoint(url)) throw new Error('Crypto.com reference URL must be the exact official public market endpoint');
    if (instrument !== 'BTC_PYUSD') throw new Error('Crypto.com reference instrument must be BTC_PYUSD');
    if (!Number.isSafeInteger(depth) || depth !== 10) throw new Error('Crypto.com reference depth must be 10');
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) throw new Error('maxAgeMs must be positive');
    if (!Number.isSafeInteger(reconnectDelayMs) || reconnectDelayMs < 1) throw new Error('reconnectDelayMs must be positive');
    if (!Number.isSafeInteger(subscribeDelayMs) || subscribeDelayMs < 0 ||
        !Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 0 ||
        (heartbeatTimeoutMs !== 0 && heartbeatTimeoutMs <= subscribeDelayMs) ||
        !Number.isSafeInteger(reconnectJitterMs) || reconnectJitterMs < 0 ||
        reconnectJitterMs > reconnectDelayMs) throw new Error('Crypto.com source timing is invalid');
    Object.assign(this, { url, instrument, depth, maxAgeMs, reconnectDelayMs, now,
      subscribeDelayMs, heartbeatTimeoutMs, reconnectJitterMs, webSocketFactory,
      setTimeoutFn, clearTimeoutFn, random, logger });
    this.channel = `book.${instrument}.${depth}`;
    this.sessionId = randomUUID();
    this.socket = null; this.book = null; this.generation = 0; this.running = false;
    this.reconnectTimer = null; this.subscribeTimer = null; this.watchdogTimer = null;
    this.acknowledgedGeneration = null; this.subscriptionSentGeneration = null;
  }

  start() { if (this.running) return false; this.running = true; this._connect(); return true; }
  stop() {
    this.running = false; this.book = null;
    if (this.reconnectTimer) this.clearTimeoutFn(this.reconnectTimer);
    if (this.subscribeTimer) this.clearTimeoutFn(this.subscribeTimer);
    if (this.watchdogTimer) this.clearTimeoutFn(this.watchdogTimer);
    this.reconnectTimer = null;
    this.subscribeTimer = null; this.watchdogTimer = null;
    const socket = this.socket; this.socket = null;
    try { socket?.close(); } catch {}
    return true;
  }
  getBook() {
    if (!this.book) return null;
    if (this.now() - this.book.sourceTimestamp > this.maxAgeMs) {
      this._invalidate(this.socket, this.generation, 'stale-snapshot');
      return null;
    }
    const { canonical, ...book } = this.book;
    return { ...book };
  }
  getStats() {
    return Object.freeze({
      running: this.running,
      eligible: this.getBook() !== null,
      generation: this.generation,
      lastSourceTimestamp: this.book?.sourceTimestamp ?? null,
      config: Object.freeze({
        endpoint: this.url, instrument: this.instrument, channel: this.channel, depth: this.depth,
        maxAgeMs: this.maxAgeMs, reconnectDelayMs: this.reconnectDelayMs,
        subscribeDelayMs: this.subscribeDelayMs, heartbeatTimeoutMs: this.heartbeatTimeoutMs,
        reconnectJitterMs: this.reconnectJitterMs,
      }),
    });
  }

  _connect() {
    if (!this.running) return;
    const generation = ++this.generation;
    const socket = this.webSocketFactory(this.url); this.socket = socket; this.book = null;
    this.acknowledgedGeneration = null;
    socket.on('open', () => {
      if (!this._current(socket, generation)) return;
      const subscribe = () => {
        this.subscribeTimer = null;
        if (!this._current(socket, generation)) return;
        try {
          socket.send(JSON.stringify({ id: generation, method: 'subscribe',
            params: { channels: [this.channel] }, nonce: this.now() }));
          this.subscriptionSentGeneration = generation; this._armWatchdog(socket, generation);
        } catch (error) { this._invalidate(socket, generation, 'subscribe-send', error); }
      };
      if (this.subscribeDelayMs === 0) subscribe();
      else this.subscribeTimer = this.setTimeoutFn(subscribe, this.subscribeDelayMs);
    });
    socket.on('message', raw => this._message(socket, generation, raw));
    socket.on('error', error => this._invalidate(socket, generation, 'socket-error', error));
    socket.on('close', () => this._invalidate(socket, generation, 'socket-close'));
  }
  _current(socket, generation) { return this.running && this.socket === socket && this.generation === generation; }
  _scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    const jitter = Math.floor(this.random() * (this.reconnectJitterMs + 1));
    this.reconnectTimer = this.setTimeoutFn(() => { this.reconnectTimer = null; this._connect(); },
      this.reconnectDelayMs + jitter);
  }
  _armWatchdog(socket, generation) {
    if (this.heartbeatTimeoutMs === 0) return;
    if (this.watchdogTimer) this.clearTimeoutFn(this.watchdogTimer);
    this.watchdogTimer = this.setTimeoutFn(() => {
      this.watchdogTimer = null; this._invalidate(socket, generation, 'heartbeat-timeout');
    }, this.heartbeatTimeoutMs);
  }
  _invalidate(socket, generation, reason, error) {
    if (!this._current(socket, generation)) return;
    this.book = null; this.socket = null;
    if (this.subscribeTimer) this.clearTimeoutFn(this.subscribeTimer);
    if (this.watchdogTimer) this.clearTimeoutFn(this.watchdogTimer);
    this.subscribeTimer = null; this.watchdogTimer = null;
    if (error) this.logger.warn?.(`Crypto.com reference ${reason}: ${error.message}`);
    try { socket.close(); } catch {}
    this._scheduleReconnect();
  }
  _message(socket, generation, raw) {
    if (!this._current(socket, generation)) return;
    let message;
    try { message = JSON.parse(String(raw)); } catch { return this._invalidate(socket, generation, 'malformed-json'); }
    if (message.method === 'public/heartbeat') {
      this._armWatchdog(socket, generation);
      try { socket.send(JSON.stringify({ id: message.id, method: 'public/respond-heartbeat' })); } catch (error) {
        this._invalidate(socket, generation, 'heartbeat-send', error);
      }
      return;
    }
    if (message.method === 'subscribe' && Object.hasOwn(message, 'channel')) {
      if (this.subscriptionSentGeneration !== generation || message.id !== generation || message.code !== 0 ||
          message.channel !== this.channel ||
          (message.result?.channel !== undefined && message.result.channel !== this.channel)) {
        return this._invalidate(socket, generation, 'invalid-subscription-ack');
      }
      this.acknowledgedGeneration = generation;
      this._armWatchdog(socket, generation);
      return;
    }
    if (this.acknowledgedGeneration !== generation) {
      return this._invalidate(socket, generation, 'snapshot-before-ack');
    }
    if (!message.result) return;
    if (message.method !== 'subscribe' || message.id !== -1 || message.code !== 0 ||
        message.result.subscription !== this.channel ||
        message.result?.instrument_name !== this.instrument ||
        message.result.channel !== 'book' || Number(message.result.depth) !== this.depth) {
      return this._invalidate(socket, generation, 'source-identity-mismatch');
    }
    const rows = message.result.data;
    if (!Array.isArray(rows) || rows.length !== 1) return this._invalidate(socket, generation, 'ambiguous-snapshot');
    const row = rows[0]; const receivedTimestamp = this.now();
    this._armWatchdog(socket, generation);
    if (!safeTime(row?.t) || !safeTime(row?.tt) || !Number.isSafeInteger(row?.u) || row.u < 0 ||
        row.t > receivedTimestamp || row.tt > row.t || receivedTimestamp - row.t > this.maxAgeMs ||
        !Array.isArray(row.bids) || !Array.isArray(row.asks) || !row.bids.length || !row.asks.length ||
        row.bids.length > this.depth || row.asks.length > this.depth ||
        row.bids.some(level => !validLevel(level)) || row.asks.some(level => !validLevel(level))) {
      return this._invalidate(socket, generation, 'invalid-snapshot');
    }
    const bid = Math.max(...row.bids.map(level => Number(level[0])));
    const ask = Math.min(...row.asks.map(level => Number(level[0])));
    if (!positive(bid) || !positive(ask) || bid > ask) return this._invalidate(socket, generation, 'crossed-snapshot');
    const normalize = (levels, descending) => levels.map(level =>
      [Number(level[0]), Number(level[1]), Number(level[2])])
      .sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0]);
    const normalizedBids = normalize(row.bids, true); const normalizedAsks = normalize(row.asks, false);
    const canonical = JSON.stringify({ bids: normalizedBids, asks: normalizedAsks, tt: row.tt });
    if (this.book && (row.u < this.book.sequence || row.t <= this.book.sourceTimestamp ||
        row.tt < this.book.bookUpdateTimestamp ||
        (row.u === this.book.sequence && canonical !== this.book.canonical))) {
      return this._invalidate(socket, generation, 'snapshot-sequence-conflict');
    }
    this.book = { exchange: 'cryptocom', sourceType: 'public-ws-book',
      instrument: this.instrument, channel: this.channel, bid, ask,
      bidQty: normalizedBids[0][1], askQty: normalizedAsks[0][1],
      bidCount: normalizedBids[0][2], askCount: normalizedAsks[0][2], depth: this.depth,
      sourceTimestamp: row.t, bookUpdateTimestamp: row.tt, receivedTimestamp,
      sequence: row.u, generation, canonical };
    this.book.sourceSessionId = this.sessionId;
    this.book.sourceEndpoint = this.url;
    this.book.sourceBookHash = createHash('sha256').update(canonical).digest('hex');
  }
}
