export type KrakenSpotTicker = {
  pair: string;
  bid: number;
  ask: number;
  last: number;
  mid: number;
  spread: number;
  spreadBps: number;
  ts: number;
};

type WebSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "message", listener: (evt: { data: unknown }) => void): void;
};

const toKrakenWsPair = (pair: string): string => {
  if (pair === "BTC/USD") return "XBT/USD";
  return pair;
};

const fromKrakenWsPair = (pair: string): string => {
  if (pair === "XBT/USD") return "BTC/USD";
  return pair;
};

export class KrakenSpotTickerWsClient {
  private ws: WebSocketLike | null = null;
  private readonly pairs: string[];
  private readonly onTicker: (ticker: KrakenSpotTicker) => void;

  constructor(options: { pairs: string[]; onTicker: (ticker: KrakenSpotTicker) => void }) {
    this.pairs = options.pairs;
    this.onTicker = options.onTicker;
  }

  async connect(): Promise<void> {
    if (this.ws) return;

    const WebSocketCtor = (globalThis as any).WebSocket as new (url: string) => WebSocketLike;
    const ws = new WebSocketCtor("wss://ws.kraken.com");
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Kraken spot WS connect timeout"));
      }, 10_000);

      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });

      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Kraken spot WS error"));
      });

      ws.addEventListener("message", (evt) => {
        const raw = evt.data;
        let data: string | null = null;

        if (typeof raw === "string") {
          data = raw;
        } else if (raw instanceof ArrayBuffer) {
          data = new TextDecoder().decode(raw);
        } else if (ArrayBuffer.isView(raw)) {
          data = new TextDecoder().decode(raw.buffer);
        }

        if (data) {
          this.handleMessage(data);
        }
      });

      ws.addEventListener("close", () => {
        this.ws = null;
      });
    });

    const msg = {
      event: "subscribe",
      pair: this.pairs.map(toKrakenWsPair),
      subscription: { name: "ticker" },
    };

    ws.send(JSON.stringify(msg));
  }

  close(): void {
    const ws = this.ws;
    if (ws) {
      ws.close();
    }
    this.ws = null;
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (!Array.isArray(message)) return;

    const channelName = message[2];
    const wsPair = message[3];
    const payload = message[1];

    if (channelName !== "ticker" || !payload || typeof wsPair !== "string") return;

    const bid = Number(payload?.b?.[0]);
    const ask = Number(payload?.a?.[0]);
    const last = Number(payload?.c?.[0]);

    if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(last) || bid <= 0 || ask <= 0) return;

    const mid = (bid + ask) / 2;
    const spread = ask - bid;
    const spreadBps = mid > 0 ? (spread / mid) * 10_000 : 0;

    this.onTicker({
      pair: fromKrakenWsPair(wsPair),
      bid,
      ask,
      last,
      mid,
      spread,
      spreadBps,
      ts: Date.now(),
    });
  }
}
