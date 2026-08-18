import { afterEach, describe, expect, test } from "bun:test";
import { KrakenRestClient } from "./KrakenRestClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("KrakenRestClient", () => {
  test("returns an auditable PreTrade top of book without manufacturing venue timestamps", async () => {
    let now = 1_000;
    global.fetch = (async (url: string | URL | Request) => {
      expect(String(url)).toContain("/0/public/PreTrade?symbol=PYUSD%2FUSD");
      now = 1_025;
      return new Response(JSON.stringify({
        error: [],
        result: {
          symbol: "PYUSD/USD", base_asset: "PYUSD", quote_asset: "USD",
          venue: "PDSL", system: "CLOB",
          bids: [{ side: "BUY", price: "1.0000", qty: "12.5", count: 2,
            submission_ts: "1970-01-01T00:00:00.900Z",
            publication_ts: "1970-01-01T00:00:00.950Z" }],
          asks: [{ side: "SELL", price: "1.0002", qty: "9.5", count: 1,
            submission_ts: "1970-01-01T00:00:00.910Z",
            publication_ts: "1970-01-01T00:00:00.960Z" }],
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    const client = new KrakenRestClient({ now: () => now });
    expect(await client.getPreTradeTopOfBook("PYUSD/USD", { timeoutMs: 100 })).toEqual({
      requestedSymbol: "PYUSD/USD", resolvedSymbol: "PYUSD/USD",
      base: "PYUSD", quote: "USD", venue: "PDSL", system: "CLOB",
      requestTimestamp: 1_000, receivedTimestamp: 1_025,
      bid: { price: 1, qty: 12.5, count: 2, submissionTimestamp: 900,
        publicationTimestamp: 950 },
      ask: { price: 1.0002, qty: 9.5, count: 1, submissionTimestamp: 910,
        publicationTimestamp: 960 },
    });
  });

  test("rejects crossed or timestamp-free PreTrade top of book", async () => {
    global.fetch = (async () => new Response(JSON.stringify({
      error: [], result: {
        symbol: "PYUSD/USD", base_asset: "PYUSD", quote_asset: "USD",
        venue: "PDSL", system: "CLOB",
        bids: [{ side: "BUY", price: "1.1", qty: "1", count: 1,
          submission_ts: "bad", publication_ts: "bad" }],
        asks: [{ side: "SELL", price: "1.0", qty: "1", count: 1,
          submission_ts: "bad", publication_ts: "bad" }],
      },
    }), { status: 200 })) as typeof fetch;
    const client = new KrakenRestClient({ now: () => 1_000 });
    await expect(client.getPreTradeTopOfBook("PYUSD/USD"))
      .rejects.toThrow("Kraken PreTrade invalid top of book");
  });

  test("validates every PreTrade level before selecting max BUY and min SELL", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ error: [], result: {
      symbol: "PYUSD/USD", base_asset: "PYUSD", quote_asset: "USD", venue: "TEST", system: "CLOB",
      bids: [
        { side: "BUY", price: "0.9998", qty: "2", count: 1,
          submission_ts: "1970-01-01T00:00:00.800Z", publication_ts: "1970-01-01T00:00:00.900Z" },
        { side: "BUY", price: "1.0000", qty: "3", count: 2,
          submission_ts: "1970-01-01T00:00:00.810Z", publication_ts: "1970-01-01T00:00:00.910Z" },
      ],
      asks: [
        { side: "SELL", price: "1.0003", qty: "4", count: 1,
          submission_ts: "1970-01-01T00:00:00.820Z", publication_ts: "1970-01-01T00:00:00.920Z" },
        { side: "SELL", price: "1.0001", qty: "5", count: 2,
          submission_ts: "1970-01-01T00:00:00.830Z", publication_ts: "1970-01-01T00:00:00.930Z" },
      ],
    } }), { status: 200 })) as typeof fetch;
    const book = await new KrakenRestClient({ now: () => 1_000 }).getPreTradeTopOfBook("PYUSD/USD");
    expect(book.bid.price).toBe(1);
    expect(book.ask.price).toBe(1.0001);
  });

  test("keeps publication-only PreTrade levels diagnostic without inventing submission time", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ error: [], result: {
      symbol: "PYUSD/USD", base_asset: "PYUSD", quote_asset: "USD", venue: "TEST", system: "CLOB",
      bids: [{ side: "BUY", price: "1", qty: "2", count: 1,
        publication_ts: "1970-01-01T00:00:00.900Z" }],
      asks: [{ side: "SELL", price: "1.0001", qty: "2", count: 1,
        publication_ts: "1970-01-01T00:00:00.910Z" }],
    } }), { status: 200 })) as typeof fetch;
    const book = await new KrakenRestClient({ now: () => 1_000 }).getPreTradeTopOfBook("PYUSD/USD");
    expect(book.bid.submissionTimestamp).toBeNull();
    expect(book.ask.submissionTimestamp).toBeNull();
  });

  test("fails closed when any individual PreTrade level is malformed", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ error: [], result: {
      symbol: "PYUSD/USD", base_asset: "PYUSD", quote_asset: "USD", venue: "TEST", system: "CLOB",
      bids: [
        { side: "BUY", price: "1", qty: "2", count: 1,
          publication_ts: "1970-01-01T00:00:00.900Z" },
        { side: "BUY", price: "garbage", qty: "2", count: 1,
          publication_ts: "1970-01-01T00:00:00.901Z" },
      ],
      asks: [{ side: "SELL", price: "1.0001", qty: "2", count: 1,
        publication_ts: "1970-01-01T00:00:00.910Z" }],
    } }), { status: 200 })) as typeof fetch;
    await expect(new KrakenRestClient({ now: () => 1_000 }).getPreTradeTopOfBook("PYUSD/USD"))
      .rejects.toThrow("invalid top of book");
  });

  test("maps PYUSD/USD to Kraken ticker data", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: [],
          result: {
            PYUSDUSD: {
              a: ["1.00010000", "2021", "2021.000"],
              b: ["1.00000000", "1455", "1455.000"],
              c: ["1.00010000", "34.97330"],
              v: ["23871.38055", "48263.43556"],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const client = new KrakenRestClient({});
    const ticker = await client.getTicker("PYUSD/USD");

    expect(ticker.exchange).toBe("kraken");
    expect(ticker.symbol).toBe("PYUSD/USD");
    expect(ticker.bid).toBe(1);
    expect(ticker.ask).toBe(1.0001);
    expect(ticker.last).toBe(1.0001);
    expect(ticker.volume24h).toBe(48263.43556);
  });

  test("throws when ticker payload omits top of book", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: [],
          result: {
            PYUSDUSD: {
              c: ["1.00010000", "34.97330"],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const client = new KrakenRestClient({});
    await expect(client.getTicker("PYUSD/USD")).rejects.toThrow(
      "Kraken ticker missing bid/ask/last for PYUSD/USD",
    );
  });

  test("honors per-call ticker timeout", async () => {
    let aborted = false;
    global.fetch = ((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }) as typeof fetch;

    const client = new KrakenRestClient({});
    await expect(client.getTicker("PYUSD/USD", { timeoutMs: 5 })).rejects.toThrow("aborted");
    expect(aborted).toBe(true);
  });
});
