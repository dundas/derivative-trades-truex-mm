export type KrakenSpotTrade = {
  pair: string;
  price: number;
  volume: number;
  side: "buy" | "sell";
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

const decodeWsData = (raw: unknown): string | null => {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    return new TextDecoder().decode(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
  }
  return null;
};

export class KrakenSpotTradesWsClient {
  private ws: WebSocketLike | null = null;
  private readonly pairs: string[];
  private readonly onTrade: (trade: KrakenSpotTrade) => void;

  private readonly autoReconnect: boolean;
  private readonly heartbeatMs: number;
  private readonly reconnectMinDelayMs: number;
  private readonly reconnectMaxDelayMs: number;

  private closedByUser = false;
  private reconnectAttempt = 0;
  private connecting: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    pairs: string[];
    onTrade: (trade: KrakenSpotTrade) => void;
    autoReconnect?: boolean;
    heartbeatMs?: number;
    reconnectMinDelayMs?: number;
    reconnectMaxDelayMs?: number;
  }) {
    this.pairs = options.pairs;
    this.onTrade = options.onTrade;

    this.autoReconnect = options.autoReconnect ?? true;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.reconnectMinDelayMs = options.reconnectMinDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
  }

  async connect(): Promise<void> {
    if (this.ws) return;
    if (this.connecting) return this.connecting;

    this.closedByUser = false;

    const WebSocketCtor = (globalThis as any).WebSocket as new (url: string) => WebSocketLike;
    const ws = new WebSocketCtor("wss://ws.kraken.com");
    this.ws = ws;

    this.connecting = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws = null;
        reject(new Error("Kraken spot WS connect timeout"));
      }, 10_000);

      ws.addEventListener("open", () => {
        clearTimeout(timeout);
        this.reconnectAttempt = 0;

        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.heartbeatMs > 0) {
          this.heartbeatTimer = setInterval(() => {
            try {
              if (!this.ws) return;
              this.ws.send(JSON.stringify({ event: "ping", reqid: Date.now() }));
            } catch {
              return;
            }
          }, this.heartbeatMs);
        }
        resolve();
      });

      ws.addEventListener("error", () => {
        clearTimeout(timeout);
        this.ws = null;
        reject(new Error("Kraken spot WS error"));
      });

      ws.addEventListener("message", (evt) => {
        const data = decodeWsData(evt.data);
        if (data) this.handleMessage(data);
      });

      ws.addEventListener("close", () => {
        this.ws = null;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;

        if (this.reconnectTimer) return;
        if (this.closedByUser) return;
        if (!this.autoReconnect) return;

        const exp = Math.min(this.reconnectAttempt, 10);
        const base = Math.min(this.reconnectMaxDelayMs, this.reconnectMinDelayMs * Math.pow(2, exp));
        const delay = Math.max(0, Math.floor(base + Math.random() * 250));
        this.reconnectAttempt++;

        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          void this.connect().catch(() => {
            return;
          });
        }, delay);
      });
    });

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }

    ws.send(
      JSON.stringify({
        event: "subscribe",
        pair: this.pairs.map(toKrakenWsPair),
        subscription: { name: "trade" },
      })
    );
  }

  close(): void {
    this.closedByUser = true;

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;

    const ws = this.ws;
    if (ws) ws.close();
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

    if (channelName !== "trade" || !Array.isArray(payload) || typeof wsPair !== "string") return;

    const pair = fromKrakenWsPair(wsPair);

    for (const t of payload) {
      if (!Array.isArray(t)) continue;

      const price = Number(t[0]);
      const volume = Number(t[1]);
      const timeSec = Number(t[2]);
      const sideRaw = String(t[3]);

      if (!Number.isFinite(price) || price <= 0) continue;
      if (!Number.isFinite(volume) || volume <= 0) continue;
      if (!Number.isFinite(timeSec) || timeSec <= 0) continue;

      const side: "buy" | "sell" = sideRaw === "b" ? "buy" : "sell";

      this.onTrade({
        pair,
        price,
        volume,
        side,
        ts: Math.floor(timeSec * 1000),
      });
    }
  }
}
