import {
  KrakenRestClient,
  type KrakenOrder,
} from "./KrakenRestClient";

type WebSocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "message", listener: (evt: { data: unknown }) => void): void;
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

export type KrakenPrivateWsFeedName = "openOrders" | "ownTrades";

export type KrakenPrivateWsSequenceEvent = {
  feed: KrakenPrivateWsFeedName;
  prev: number | null;
  nextExpected: number | null;
  received: number;
  kind: "gap" | "reset";
};

export type KrakenPrivateWsOpenOrdersMessage = {
  feed: "openOrders";
  sequence: number;
  isSnapshot: boolean;
  orders: Array<Record<string, KrakenOrder>>;
};

export type KrakenPrivateWsTrade = {
  cost?: string;
  fee?: string;
  margin?: string;
  ordertxid?: string;
  ordertype?: string;
  pair?: string;
  postxid?: string;
  price?: string;
  time?: string;
  type?: string;
  vol?: string;
};

export type KrakenPrivateWsOwnTradesMessage = {
  feed: "ownTrades";
  sequence: number;
  isSnapshot: boolean;
  trades: Array<Record<string, KrakenPrivateWsTrade>>;
};

export class KrakenPrivateWsClient {
  private ws: WebSocketLike | null = null;
  private readonly rest: KrakenRestClient;

  private readonly autoReconnect: boolean;
  private readonly heartbeatMs: number;
  private readonly reconnectMinDelayMs: number;
  private readonly reconnectMaxDelayMs: number;

  private readonly includeRateCounter: boolean;

  private readonly onOpenOrders?: (msg: KrakenPrivateWsOpenOrdersMessage) => void;
  private readonly onOwnTrades?: (msg: KrakenPrivateWsOwnTradesMessage) => void;
  private readonly onSequenceEvent?: (evt: KrakenPrivateWsSequenceEvent) => void;
  private readonly onStatus?: (evt: unknown) => void;

  private closedByUser = false;
  private reconnectAttempt = 0;
  private connecting: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private feedSequence: Partial<Record<KrakenPrivateWsFeedName, number>> = {};
  private feedHasSeenMessage: Partial<Record<KrakenPrivateWsFeedName, boolean>> = {};

  constructor(options: {
    rest: KrakenRestClient;
    onOpenOrders?: (msg: KrakenPrivateWsOpenOrdersMessage) => void;
    onOwnTrades?: (msg: KrakenPrivateWsOwnTradesMessage) => void;
    onSequenceEvent?: (evt: KrakenPrivateWsSequenceEvent) => void;
    onStatus?: (evt: unknown) => void;
    autoReconnect?: boolean;
    heartbeatMs?: number;
    reconnectMinDelayMs?: number;
    reconnectMaxDelayMs?: number;
    includeRateCounter?: boolean;
  }) {
    this.rest = options.rest;
    this.onOpenOrders = options.onOpenOrders;
    this.onOwnTrades = options.onOwnTrades;
    this.onSequenceEvent = options.onSequenceEvent;
    this.onStatus = options.onStatus;

    this.autoReconnect = options.autoReconnect ?? true;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.reconnectMinDelayMs = options.reconnectMinDelayMs ?? 1_000;
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000;
    this.includeRateCounter = options.includeRateCounter ?? true;
  }

  async connect(): Promise<void> {
    if (this.ws) return;
    if (this.connecting) return this.connecting;

    this.closedByUser = false;

    this.connecting = (async () => {
      const tokenResult = await this.rest.getWebSocketsToken();
      const token = String(tokenResult?.token ?? "");
      if (!token) throw new Error("Kraken private WS token missing");

      const WebSocketCtor = (globalThis as any).WebSocket as new (url: string) => WebSocketLike;
      const ws = new WebSocketCtor("wss://ws-auth.kraken.com");
      this.ws = ws;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.ws = null;
          reject(new Error("Kraken private WS connect timeout"));
        }, 10_000);

        ws.addEventListener("open", () => {
          clearTimeout(timeout);
          this.reconnectAttempt = 0;

          this.feedSequence = {};
          this.feedHasSeenMessage = {};

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

          try {
            const openOrdersSub: any = {
              event: "subscribe",
              subscription: {
                name: "openOrders",
                token,
              },
            };
            if (this.includeRateCounter) openOrdersSub.subscription.ratecounter = "true";

            this.ws?.send(JSON.stringify(openOrdersSub));
            this.ws?.send(
              JSON.stringify({
                event: "subscribe",
                subscription: {
                  name: "ownTrades",
                  token,
                },
              })
            );
          } catch {
            return;
          }

          resolve();
        });

        ws.addEventListener("error", () => {
          clearTimeout(timeout);
          this.ws = null;
          reject(new Error("Kraken private WS error"));
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
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
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

    if (!message) return;

    if (!Array.isArray(message)) {
      const event = String(message?.event ?? "");
      if (event) this.onStatus?.(message);
      return;
    }

    const maybeFeed = message[1];
    const maybeSeq = message[2]?.sequence;

    if ((maybeFeed === "openOrders" || maybeFeed === "ownTrades") && typeof maybeSeq === "number") {
      const feed = maybeFeed as KrakenPrivateWsFeedName;
      const seq = maybeSeq;

      const prev = this.feedSequence[feed] ?? null;
      if (prev !== null) {
        const expected = prev + 1;
        if (seq <= prev) {
          this.onSequenceEvent?.({ feed, prev, nextExpected: expected, received: seq, kind: "reset" });
        } else if (seq !== expected) {
          this.onSequenceEvent?.({ feed, prev, nextExpected: expected, received: seq, kind: "gap" });
        }
      }
      this.feedSequence[feed] = seq;

      const isSnapshot = !(this.feedHasSeenMessage[feed] ?? false);
      this.feedHasSeenMessage[feed] = true;

      const payload = message[0];
      if (!Array.isArray(payload)) return;

      if (feed === "openOrders") {
        this.onOpenOrders?.({
          feed,
          sequence: seq,
          isSnapshot,
          orders: payload as Array<Record<string, KrakenOrder>>,
        });
        return;
      }

      if (feed === "ownTrades") {
        this.onOwnTrades?.({
          feed,
          sequence: seq,
          isSnapshot,
          trades: payload as Array<Record<string, KrakenPrivateWsTrade>>,
        });
        return;
      }
    }
  }
}
