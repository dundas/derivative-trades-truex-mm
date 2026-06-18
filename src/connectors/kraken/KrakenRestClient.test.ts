import { afterEach, describe, expect, test } from "bun:test";
import { KrakenRestClient } from "./KrakenRestClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("KrakenRestClient", () => {
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
