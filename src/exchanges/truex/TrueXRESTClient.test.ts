import { afterEach, describe, expect, test } from "bun:test";
import { TrueXRESTClient } from "./TrueXRESTClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("TrueXRESTClient", () => {
  test("aborts getMarketQuote when the request timeout elapses", async () => {
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

    const client = new TrueXRESTClient({
      apiKey: "key",
      apiSecret: "secret",
      userId: "user",
      timeout: 5,
    });

    await expect(
      client.getMarketQuote({ instrument_id: "123" }, { timeoutMs: 5 }),
    ).rejects.toThrow("TrueX API: Request timeout after 5ms");

    expect(aborted).toBe(true);
  });
});
