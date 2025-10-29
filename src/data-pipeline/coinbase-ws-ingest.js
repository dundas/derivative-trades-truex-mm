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

export class CoinbaseWsIngest {
  constructor({ symbols, onSnapshot, onL2Update, onTrade, onTicker, logger } = {}) {
    this.symbols = symbols && symbols.length > 0 ? symbols : ['BTC-PYUSD'];
    this.onSnapshot = onSnapshot;
    this.onL2Update = onL2Update;
    this.onTrade = onTrade;
    this.onTicker = onTicker;
    this.logger = logger || console;
    this.ws = null;
    this.connected = false;
  }

  async start() {
    const WS = await getWebSocketImpl();
    const url = 'wss://ws-feed.exchange.coinbase.com';
    const productIds = this.symbols.map((s) => mapToCoinbaseProductId(s));

    this.ws = new WS(url);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Coinbase WS connect timeout')), 10000);
      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.connected = true;
        this.logger.info('Coinbase WS connected', { url, productIds });
        resolve();
      });
      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    // Subscribe
    const subscribeMessage = {
      type: 'subscribe',
      product_ids: productIds,
      channels: ['level2', 'matches', 'ticker'],
    };
    this.ws.send(JSON.stringify(subscribeMessage));
    this.logger.info('Coinbase WS subscribe sent', { channels: subscribeMessage.channels, productIds });

    // Bind handlers
    this.ws.on('message', (data) => this.handleMessage(data));
    this.ws.on('close', (code, reason) => {
      this.connected = false;
      this.logger.info(`Coinbase WS closed: ${code} ${reason || ''}`);
    });
  }

  stop() {
    try {
      if (this.ws) this.ws.close();
    } catch (_) {
      // ignore
    } finally {
      this.ws = null;
      this.connected = false;
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


