// Lightweight Coinbase WebSocket ingest for level2 (snapshot + updates), ticker, and matches (trades)
// Uses Coinbase Pro public feed format (ws-feed.exchange.coinbase.com) for simplicity

import { normalizePriceForSymbol } from './symbol-ticks.js';

let WebSocketImpl = null;
async function getWebSocketImpl() {
  if (WebSocketImpl) return WebSocketImpl;
  try {
    const mod = await import('ws');
    WebSocketImpl = mod.default;
    return WebSocketImpl;
  } catch (e) {
    throw new Error('WebSocket implementation not available');
  }
}

// Map our symbols to Coinbase product_ids
export function mapToCoinbaseProductId(symbol) {
  // TrueX BTC-PYUSD -> Coinbase BTC-USD (closest liquid proxy)
  if (symbol === 'BTC-PYUSD' || symbol === 'BTC/USD') return 'BTC-USD';
  if (symbol === 'ETH/USD') return 'ETH-USD';
  return symbol.replace('/', '-');
}

export function mapFromCoinbaseProductId(productId) {
  if (productId === 'BTC-USD') return 'BTC-PYUSD'; // normalize back to session symbol for consistency
  if (productId === 'ETH-USD') return 'ETH/USD';
  return productId.replace('-', '/');
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

export class CoinbaseWsIngest {
  constructor({ symbols, onSnapshot, onL2Update, onTrade, onTicker, logger, _wsFactory, _connectTimeoutMs } = {}) {
    this.symbols = symbols && symbols.length > 0 ? symbols : ['BTC-PYUSD'];
    this.onSnapshot = onSnapshot;
    this.onL2Update = onL2Update;
    this.onTrade = onTrade;
    this.onTicker = onTicker;
    this.logger = logger || console;
    this.ws = null;
    this.connected = false;
    this._stopped = false;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._generation = 0; // incremented per _connect() to detect stale close handlers
    this._wsFactory = _wsFactory || null; // injectable WS constructor class for testing
    this._connectTimeoutMs = _connectTimeoutMs ?? 10000;
    // Track active per-connection handlers so they can be evicted immediately when a new
    // connection supersedes the old one, preventing duplicate delivery during the overlap window.
    this._activeMsgWs = null;
    this._activeMsgHandler = null;
    this._activeErrHandler = null;
  }

  async start() {
    this._stopped = false;
    this._reconnectAttempt = 0;
    // Clear any pending reconnect timer to avoid concurrent connections
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    // Capture generation before _connect() increments it. If this start() is
    // superseded by a second start() call before _connect() resolves, genAtStart+1
    // won't match this._generation and we skip the reconnect to avoid a spurious cycle.
    const genAtStart = this._generation;
    try {
      await this._connect();
    } catch (err) {
      // Initial connect failed — enter reconnect loop rather than dying silently,
      // but only if this start() still owns the current generation slot.
      this.logger.error(`Coinbase WS initial connect failed: ${err.message}`);
      if (!this._stopped && this._generation === genAtStart + 1) this._scheduleReconnect();
    }
  }

  async _connect() {
    const WS = this._wsFactory || await getWebSocketImpl();
    const url = 'wss://ws-feed.exchange.coinbase.com';
    const productIds = this.symbols.map((s) => mapToCoinbaseProductId(s));

    this._generation += 1;
    const gen = this._generation;

    // Evict message/error handlers from the previous active connection immediately.
    // This prevents duplicate delivery during the overlap window where both the old
    // and new sockets are briefly live before the old one closes.
    if (this._activeMsgWs) {
      if (this._activeMsgHandler) this._activeMsgWs.removeListener('message', this._activeMsgHandler);
      if (this._activeErrHandler) this._activeMsgWs.removeListener('error', this._activeErrHandler);
      this._activeMsgWs = null;
      this._activeMsgHandler = null;
      this._activeErrHandler = null;
    }

    this.ws = new WS(url);

    const localWs = this.ws; // capture reference for stale-handler cleanup
    let opened = false;
    let openHandler;
    let handshakeErrHandler;
    let closeHandler; // tracked to allow targeted removeListener on stale bail-out
    let msgHandler; // set after promise resolves; referenced in stale close branch
    let postConnErrHandler; // post-connection error logger; evicted on stale close
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          // Reject first so timeout is always the canonical failure reason,
          // then close the dead socket asynchronously. The generation guard in
          // the close handler prevents any state corruption.
          reject(new Error('Coinbase WS connect timeout'));
          setTimeout(() => { try { localWs.close(); } catch (_) {} }, 0);
        }, this._connectTimeoutMs);
        openHandler = () => {
          clearTimeout(timeout);
          if (gen !== this._generation) {
            // Stale connection opened while a newer one already exists — close the socket
            // to release the TCP connection, then resolve so _connect() can reach the
            // post-await gen bail-out and clean up remaining listeners.
            // queueMicrotask defers close() so it runs outside the current call frame.
            // In production, real WebSocket 'close' events are always async, so closeHandler
            // will have been cleaned up long before any 'close' event arrives.
            queueMicrotask(() => { try { localWs.close(); } catch (_) {} });
            resolve();
            return;
          }
          opened = true;
          this.connected = true;
          this._reconnectAttempt = 0;
          this.logger.info('Coinbase WS connected', { url, productIds });
          resolve();
        };
        this.ws.on('open', openHandler);
        handshakeErrHandler = (err) => {
          clearTimeout(timeout);
          reject(err);
        };
        this.ws.on('error', handshakeErrHandler);
        // Register close handler before open fires — no window for undetected disconnects.
        // Capture reference for targeted removeListener on stale bail-out.
        closeHandler = (code, reason) => {
          clearTimeout(timeout);
          this.logger.info(`Coinbase WS closed: ${code} ${reason?.toString() || ''}`);
          if (!opened) {
            if (gen === this._generation) {
              // Authoritative pre-open close — fail with error so start() schedules reconnect
              this.connected = false;
              reject(new Error(`Coinbase WS closed before open: ${code}`));
            } else {
              // Stale pre-open close — resolve silently;
              // post-await generation guard will bail out setup without taking action
              resolve();
            }
          } else if (gen === this._generation) {
            // Authoritative close for the current connection — evict per-connection handlers
            this.connected = false;
            if (msgHandler) localWs.removeListener('message', msgHandler);
            if (postConnErrHandler) localWs.removeListener('error', postConnErrHandler);
            if (!this._stopped) this._scheduleReconnect();
          } else {
            // Stale connection superseded by a newer one — evict all per-connection handlers
            // to prevent duplicate data delivery and listener leaks
            if (msgHandler) localWs.removeListener('message', msgHandler);
            if (postConnErrHandler) localWs.removeListener('error', postConnErrHandler);
          }
        };
        this.ws.on('close', closeHandler);
      });
    } finally {
      // Always clean up handshake listeners regardless of resolve/reject path.
      // openHandler and handshakeErrHandler are one-shot; remove unconditionally.
      // If the connection never opened (pre-open failure or timeout), also remove
      // the close handler since the socket will produce no meaningful future events.
      if (openHandler) localWs.removeListener('open', openHandler);
      if (handshakeErrHandler) localWs.removeListener('error', handshakeErrHandler);
      if (!opened && closeHandler) localWs.removeListener('close', closeHandler);
    }

    // Bail out if this connection was superseded while we were connecting.
    // Remove only the tracked close handler to avoid clobbering external listeners.
    if (gen !== this._generation) {
      if (closeHandler) localWs.removeListener('close', closeHandler);
      return;
    }

    // Replace with a post-connection error handler that logs without silently dropping.
    // Track the reference so the stale-close branch can evict it alongside msgHandler.
    postConnErrHandler = (err) => {
      this.logger.error(`Coinbase WS error: ${err.message}`);
    };
    localWs.on('error', postConnErrHandler);

    // Subscribe
    const subscribeMessage = {
      type: 'subscribe',
      product_ids: productIds,
      channels: ['level2', 'matches', 'ticker'],
    };
    localWs.send(JSON.stringify(subscribeMessage));
    this.logger.info('Coinbase WS subscribe sent', { channels: subscribeMessage.channels, productIds });

    msgHandler = (data) => this.handleMessage(data);
    localWs.on('message', msgHandler);

    // Record active handlers so the next _connect() can evict them immediately on supersession.
    this._activeMsgWs = localWs;
    this._activeMsgHandler = msgHandler;
    this._activeErrHandler = postConnErrHandler;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    // Cap attempt counter at the point where delay saturates (2^6 * 1000ms = 64s > 60s max)
    this._reconnectAttempt = Math.min(this._reconnectAttempt + 1, 7);
    const base = Math.min(RECONNECT_BASE_MS * 2 ** (this._reconnectAttempt - 1), RECONNECT_MAX_MS);
    const delay = Math.min(Math.floor(base * (0.5 + Math.random())), RECONNECT_MAX_MS); // ±50% jitter, hard-capped
    this.logger.warn(`Coinbase WS reconnecting in ${delay}ms (attempt ${this._reconnectAttempt})`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._stopped) return;
      try {
        await this._connect();
      } catch (err) {
        this.logger.error(`Coinbase WS reconnect failed: ${err.message}`);
        if (!this._stopped) this._scheduleReconnect();
      }
    }, delay);
  }

  stop() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    try {
      if (this.ws) this.ws.close();
    } catch (_) {
      // ignore
    } finally {
      this.ws = null;
      this.connected = false;
      this._activeMsgWs = null;
      this._activeMsgHandler = null;
      this._activeErrHandler = null;
    }
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch (e) {
      this.logger.error('Coinbase WS parse error', { error: e?.message });
      return;
    }

    const type = msg.type;
    if (type === 'subscriptions') {
      this.logger.info('Coinbase WS subscriptions confirmed', { channels: msg.channels?.map((c) => c.name) });
      return;
    }

    if (type === 'snapshot') {
      const symbol = mapFromCoinbaseProductId(msg.product_id);
      if (this.onSnapshot) {
        // Convert to numeric tuples
        const bids = (msg.bids || []).map((p) => [Number(p[0]), Number(p[1])]);
        const asks = (msg.asks || []).map((p) => [Number(p[0]), Number(p[1])]);
        this.onSnapshot(symbol, { bids, asks });
      }
      this.logger.debug('Coinbase snapshot received', { product_id: msg.product_id, bids: msg.bids?.length, asks: msg.asks?.length });
      return;
    }

    if (type === 'l2update') {
      const symbol = mapFromCoinbaseProductId(msg.product_id);
      if (this.onL2Update) {
        const deltas = (msg.changes || []).map((c) => {
          const side = c[0] === 'buy' ? 'bid' : 'ask';
          return { side, price: Number(c[1]), size: Number(c[2]) };
        });
        this.onL2Update(symbol, deltas);
      }
      this.logger.debug('Coinbase l2update received', { product_id: msg.product_id, changes: msg.changes?.length });
      return;
    }

    if (type === 'match') {
      const symbol = mapFromCoinbaseProductId(msg.product_id);
      if (this.onTrade) {
        const price = normalizePriceForSymbol(symbol, Number(msg.price));
        const size = Number(msg.size);
        const ts = new Date(msg.time || Date.now()).getTime();
        this.onTrade(symbol, [{ price, volume: size, timestamp: ts }]);
      }
      this.logger.debug('Coinbase trade match received', { product_id: msg.product_id });
      return;
    }

    if (type === 'ticker') {
      const symbol = mapFromCoinbaseProductId(msg.product_id);
      if (this.onTicker) {
        const ts = new Date(msg.time || Date.now()).getTime();
        this.onTicker(symbol, {
          bid: Number(msg.best_bid),
          ask: Number(msg.best_ask),
          last: Number(msg.price),
          timestamp: ts,
        });
      }
      this.logger.debug('Coinbase ticker received', { product_id: msg.product_id });
    }
  }
}


