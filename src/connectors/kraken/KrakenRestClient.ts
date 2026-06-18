import * as crypto from "node:crypto";
import type { TickerUpdate } from "../IExchangeConnector";

export type KrakenTradeVolumeResult = {
  currency?: string;
  volume?: string;
  fees?: Record<
    string,
    {
      fee?: string;
      minfee?: string;
      maxfee?: string;
      nextfee?: string;
      nextvolume?: string;
      tiervolume?: string;
    }
  >;
  fees_maker?: Record<
    string,
    {
      fee?: string;
      minfee?: string;
      maxfee?: string;
      nextfee?: string;
      nextvolume?: string;
      tiervolume?: string;
    }
  >;
};

export type KrakenAssetPairsResult = Record<
  string,
  {
    altname?: string;
    wsname?: string;
    base?: string;
    quote?: string;
    pair_decimals?: number;
    lot_decimals?: number;
    ordermin?: string;
    costmin?: string;
    fees?: [number, number][];
    fees_maker?: [number, number][];
    fee_volume_currency?: string;
  }
>;

export type KrakenOHLCCandle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vwap: number;
  volume: number;
  count: number;
};

export type KrakenBalanceResult = Record<string, string>;

export type KrakenOrderDescription = {
  pair?: string;
  type?: string;
  ordertype?: string;
  price?: string;
  price2?: string;
  leverage?: string;
  order?: string;
  close?: string;
};

export type KrakenOrder = {
  refid?: string;
  userref?: number;
  status?: string;
  reason?: string;
  opentm?: string;
  closetm?: string;
  starttm?: string;
  expiretm?: string;
  descr?: KrakenOrderDescription;
  vol?: string;
  vol_exec?: string;
  cost?: string;
  fee?: string;
  price?: string;
  stopprice?: string;
  limitprice?: string;
  misc?: string;
  oflags?: string;
  trades?: Record<string, unknown>;
};

export type KrakenOpenOrdersResult = {
  open: Record<string, KrakenOrder>;
};

export type KrakenQueryOrdersResult = Record<string, KrakenOrder>;

export type KrakenAddOrderResult = {
  descr?: { order?: string; close?: string };
  txid: string[];
};

export type KrakenCancelOrderResult = {
  count: number;
  pending?: boolean;
};

export type KrakenWebSocketsTokenResult = {
  token: string;
  expires?: number;
};

export type KrakenTickerResult = Record<
  string,
  {
    a?: [string, string?, string?];
    b?: [string, string?, string?];
    c?: [string, string?];
    v?: [string, string?];
  }
>;

export class KrakenRestClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly apiSecret?: string;

  private readonly requestTimeoutMs = 15_000;

  private lastNonce: bigint = 0n;

  private privateRequestQueue: Promise<void> = Promise.resolve();
  private lastPrivateRequestAtMs = 0;
  private readonly minPrivateRequestDelayMs = 100;

  private static readonly KRAKEN_SYMBOL_MAP: Record<string, string> = {
    "BTC/USD": "XXBTZUSD",
    "ETH/USD": "XETHZUSD",
    "PYUSD/USD": "PYUSDUSD",
    "SOL/USD": "SOLUSD",
    "XRP/USD": "XXRPZUSD",
    "ADA/USD": "ADAUSD",
    "DOT/USD": "DOTUSD",
    "LINK/USD": "LINKUSD",
    "AVAX/USD": "AVAXUSD",
    "ATOM/USD": "ATOMUSD",
    "DOGE/USD": "XDGUSD",
    "UNI/USD": "UNIUSD",
    "LTC/USD": "XLTCZUSD",
    "BCH/USD": "BCHUSD",
    "XLM/USD": "XXLMZUSD",
    "BTC/EUR": "XXBTZEUR",
    "ETH/EUR": "XETHZEUR",
    "ETH/BTC": "XETHXXBT",
    "SOL/BTC": "SOLXBT",
  };

  constructor(options: { baseUrl?: string; apiKey?: string; apiSecret?: string }) {
    this.baseUrl = options.baseUrl ?? "https://api.kraken.com";
    this.apiKey = options.apiKey;
    this.apiSecret = options.apiSecret;
  }

  toKrakenPair(pair: string): string {
    return KrakenRestClient.KRAKEN_SYMBOL_MAP[pair] ?? pair;
  }

  async getTradeVolume(params?: { pair?: string }): Promise<KrakenTradeVolumeResult> {
    const body: Record<string, string> = {};

    if (params?.pair) {
      const formattedPair = params.pair
        .split(",")
        .map((p) => this.toKrakenPair(p.trim()))
        .join(",");
      body.pair = formattedPair;
    }

    return await this.privateRequest<KrakenTradeVolumeResult>("/0/private/TradeVolume", body);
  }

  async getAssetPairs(params?: { pair?: string }): Promise<KrakenAssetPairsResult> {
    const query: Record<string, string> = {};
    if (params?.pair) {
      const formattedPair = params.pair
        .split(",")
        .map((p) => this.toKrakenPair(p.trim()))
        .join(",");
      query.pair = formattedPair;
    }

    return await this.publicRequest<KrakenAssetPairsResult>("/0/public/AssetPairs", query);
  }

  async getOHLC(params: { pair: string; interval?: number; since?: number }): Promise<{ pair: string; candles: KrakenOHLCCandle[]; last: number }> {
    const query: Record<string, string> = {
      pair: this.toKrakenPair(params.pair.trim()),
    };

    if (typeof params.interval === "number" && Number.isFinite(params.interval) && params.interval > 0) {
      query.interval = String(Math.floor(params.interval));
    }

    if (typeof params.since === "number" && Number.isFinite(params.since) && params.since > 0) {
      query.since = String(Math.floor(params.since));
    }

    const result = await this.publicRequest<any>("/0/public/OHLC", query);
    const last = Number(result?.last ?? 0);
    const key = Object.keys(result ?? {}).find((k) => k !== "last");
    const raw = (key ? result?.[key] : []) as any[];

    const candles: KrakenOHLCCandle[] = Array.isArray(raw)
      ? raw
          .map((c) => {
            if (!Array.isArray(c) || c.length < 8) return null;
            const ts = Number(c[0]);
            const open = Number(c[1]);
            const high = Number(c[2]);
            const low = Number(c[3]);
            const close = Number(c[4]);
            const vwap = Number(c[5]);
            const volume = Number(c[6]);
            const count = Number(c[7]);
            if (!Number.isFinite(ts) || !Number.isFinite(close) || close <= 0) return null;
            return {
              ts: Math.floor(ts * 1000),
              open,
              high,
              low,
              close,
              vwap,
              volume,
              count,
            };
          })
          .filter((x): x is KrakenOHLCCandle => x !== null)
      : [];

    return { pair: params.pair, candles, last };
  }

  async getTicker(pair: string): Promise<TickerUpdate> {
    const krakenPair = this.toKrakenPair(pair.trim());
    const result = await this.publicRequest<KrakenTickerResult>("/0/public/Ticker", {
      pair: krakenPair,
    });
    const entry = result?.[krakenPair] ?? result?.[Object.keys(result ?? {})[0] ?? ""];

    const bid = Number(entry?.b?.[0] ?? 0);
    const ask = Number(entry?.a?.[0] ?? 0);
    const last = Number(entry?.c?.[0] ?? 0);
    const volume24h = Number(entry?.v?.[1] ?? entry?.v?.[0] ?? 0);

    if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(ask) || ask <= 0 || !Number.isFinite(last) || last <= 0) {
      throw new Error(`Kraken ticker missing bid/ask/last for ${pair}`);
    }

    return {
      exchange: "kraken",
      symbol: pair,
      timestamp: Date.now(),
      bid,
      ask,
      last,
      volume24h: Number.isFinite(volume24h) ? volume24h : 0,
    };
  }

  async getBalance(): Promise<KrakenBalanceResult> {
    return await this.privateRequest<KrakenBalanceResult>("/0/private/Balance", {});
  }

  async addOrder(params: {
    pair: string;
    type: "buy" | "sell";
    ordertype: "limit" | string;
    volume: string;
    price?: string;
    oflags?: string;
    cl_ord_id?: string;
    userref?: string;
    timeinforce?: string;
    expiretm?: string;
  }): Promise<KrakenAddOrderResult> {
    const body: Record<string, string> = {
      pair: this.toKrakenPair(params.pair.trim()),
      type: params.type,
      ordertype: params.ordertype,
      volume: params.volume,
    };

    if (params.ordertype === "limit") {
      if (!params.price) throw new Error("addOrder requires price for limit orders");
      body.price = params.price;
    } else if (params.price) {
      body.price = params.price;
    }

    if (params.oflags) body.oflags = params.oflags;
    if (params.cl_ord_id) body.cl_ord_id = params.cl_ord_id;
    if (params.userref) body.userref = params.userref;
    if (params.timeinforce) body.timeinforce = params.timeinforce;
    if (params.expiretm) body.expiretm = params.expiretm;

    return await this.privateRequest<KrakenAddOrderResult>("/0/private/AddOrder", body);
  }

  async cancelOrder(params: { txid?: string; cl_ord_id?: string; userref?: string }): Promise<KrakenCancelOrderResult> {
    const body: Record<string, string> = {};
    if (params.txid) body.txid = params.txid;
    if (params.cl_ord_id) body.cl_ord_id = params.cl_ord_id;
    if (params.userref) body.userref = params.userref;
    if (!body.txid && !body.cl_ord_id && !body.userref) {
      throw new Error("cancelOrder requires txid, cl_ord_id, or userref");
    }
    return await this.privateRequest<KrakenCancelOrderResult>("/0/private/CancelOrder", body);
  }

  async getOpenOrders(params?: { trades?: boolean; userref?: string }): Promise<KrakenOpenOrdersResult> {
    const body: Record<string, string> = {};
    if (typeof params?.trades === "boolean") body.trades = params.trades ? "true" : "false";
    if (params?.userref) body.userref = params.userref;
    return await this.privateRequest<KrakenOpenOrdersResult>("/0/private/OpenOrders", body);
  }

  async queryOrders(params: { txid: string; trades?: boolean; userref?: string; consolidate_taker?: boolean }): Promise<KrakenQueryOrdersResult> {
    const body: Record<string, string> = {
      txid: params.txid,
    };
    if (typeof params.trades === "boolean") body.trades = params.trades ? "true" : "false";
    if (params.userref) body.userref = params.userref;
    if (typeof params.consolidate_taker === "boolean") body.consolidate_taker = params.consolidate_taker ? "true" : "false";
    return await this.privateRequest<KrakenQueryOrdersResult>("/0/private/QueryOrders", body);
  }

  async getWebSocketsToken(): Promise<KrakenWebSocketsTokenResult> {
    return await this.privateRequest<KrakenWebSocketsTokenResult>("/0/private/GetWebSocketsToken", {});
  }

  private nextNonce(): string {
    const micros = BigInt(Date.now()) * 1000n;
    if (micros <= this.lastNonce) {
      this.lastNonce = this.lastNonce + 1n;
    } else {
      this.lastNonce = micros;
    }
    return this.lastNonce.toString();
  }

  private sign(path: string, nonce: string, postData: string): string {
    if (!this.apiSecret) {
      throw new Error("Kraken API secret is required for private requests");
    }

    const secret = Buffer.from(this.apiSecret, "base64");
    const hash = crypto.createHash("sha256").update(nonce + postData).digest();
    const message = Buffer.concat([Buffer.from(path), hash]);
    return crypto.createHmac("sha512", secret).update(message).digest("base64");
  }

  private async publicRequest<T>(path: string, query: Record<string, string>): Promise<T> {
    const params = new URLSearchParams(query);
    const url = params.size > 0 ? `${this.baseUrl}${path}?${params.toString()}` : `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let resp: Response;
    try {
      resp = await fetch(url, { method: "GET", signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    if (!resp.ok) {
      throw new Error(`Kraken HTTP error ${resp.status}: ${resp.statusText}`);
    }

    const json = (await resp.json()) as { error?: string[]; result?: T };
    if (Array.isArray(json.error) && json.error.length > 0) {
      throw new Error(`Kraken API error: ${json.error.join(", ")}`);
    }

    if (!json.result) {
      throw new Error("Kraken API error: missing result");
    }

    return json.result;
  }

  private async withPrivateRequestLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.privateRequestQueue;
    let releaseLock: (() => void) | undefined;
    this.privateRequestQueue = new Promise<void>((resolve) => {
      releaseLock = () => resolve();
    });

    await prev.catch(() => undefined);
    try {
      const now = Date.now();
      const since = now - this.lastPrivateRequestAtMs;
      if (since < this.minPrivateRequestDelayMs) {
        await new Promise((r) => setTimeout(r, this.minPrivateRequestDelayMs - since));
      }
      const out = await fn();
      this.lastPrivateRequestAtMs = Date.now();
      return out;
    } finally {
      releaseLock?.();
    }
  }

  private async privateRequest<T>(path: string, data: Record<string, string>): Promise<T> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error("Kraken API key and secret are required for private requests");
    }

    const apiKey = this.apiKey;

    return await this.withPrivateRequestLock(async () => {
      const maxNonceRetries = 3;
      for (let attempt = 0; attempt <= maxNonceRetries; attempt++) {
        const nonce = this.nextNonce();
        const params = new URLSearchParams({ ...data, nonce });
        const postData = params.toString();
        const apiSign = this.sign(path, nonce, postData);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

        let resp: Response;
        try {
          resp = await fetch(`${this.baseUrl}${path}`, {
            method: "POST",
            headers: {
              "API-Key": apiKey,
              "API-Sign": apiSign,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: postData,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }

        if (!resp.ok) {
          throw new Error(`Kraken HTTP error ${resp.status}: ${resp.statusText}`);
        }

        const json = (await resp.json()) as { error?: string[]; result?: T };
        const err = Array.isArray(json.error) ? json.error.join(", ") : "";
        if (err) {
          const isNonceError = err.toLowerCase().includes("invalid nonce");
          if (isNonceError && attempt < maxNonceRetries) {
            await new Promise((r) => setTimeout(r, 250 * Math.pow(2, attempt)));
            continue;
          }
          throw new Error(`Kraken API error: ${err}`);
        }

        if (!json.result) {
          throw new Error("Kraken API error: missing result");
        }

        return json.result;
      }

      throw new Error("Kraken API error: exceeded nonce retries");
    });
  }
}
