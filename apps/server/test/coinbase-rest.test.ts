import { describe, expect, it, vi } from "vitest";
import { CoinbaseApiError, CoinbasePublicRest } from "../src/market-data/coinbase-rest.js";

const product = (id: string) => ({ product_id: id, product_type: "SPOT", status: "online", price: "1" });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function client(fetchImpl: typeof fetch) {
  return new CoinbasePublicRest({ baseUrl: "https://api.example/api/v3/brokerage", maxRps: 1000, fetchImpl, sleep: async () => {} });
}

describe("CoinbasePublicRest", () => {
  it("calls the public products endpoint with SPOT filter and paginates", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      const offset = Number(new URL(String(url)).searchParams.get("offset"));
      return json({ products: offset === 0 ? [product("A-EUR"), product("B-EUR")] : [product("C-EUR")] });
    }) as unknown as typeof fetch;
    const r = await client(fetchImpl).listPublicSpotProducts({ pageSize: 2 });
    expect(r.products.map((p) => p.productId)).toEqual(["A-EUR", "B-EUR", "C-EUR"]);
    expect(r.pages).toBe(2);
    expect(urls[0]).toBe("https://api.example/api/v3/brokerage/market/products?product_type=SPOT&limit=2&offset=0");
  });

  it("stops when a page brings nothing new (offset ignored by server)", async () => {
    const fetchImpl = vi.fn(async () => json({ products: [product("A-EUR"), product("B-EUR")] })) as unknown as typeof fetch;
    const r = await client(fetchImpl).listPublicSpotProducts({ pageSize: 2, maxPages: 10 });
    expect(r.products).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 429/5xx then succeeds, and records rate-limit headers", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      if (n === 1) return json({}, 429);
      if (n === 2) return json({}, 503);
      return json({ iso: "x" }, 200, { "x-ratelimit-remaining": "9", "x-ratelimit-limit": "10" });
    }) as unknown as typeof fetch;
    const log = vi.fn();
    const c = new CoinbasePublicRest({ baseUrl: "https://api.example", maxRps: 1000, fetchImpl, sleep: async () => {}, log });
    expect(await c.getServerTime()).toEqual({ iso: "x" });
    expect(n).toBe(3);
    expect(log).toHaveBeenCalledTimes(2);
    expect(c.lastRateLimit).toMatchObject({ remaining: "9", limit: "10" });
  });

  it("does not retry client errors (4xx other than 429)", async () => {
    const fetchImpl = vi.fn(async () => json({}, 404)) as unknown as typeof fetch;
    await expect(client(fetchImpl).getServerTime()).rejects.toBeInstanceOf(CoinbaseApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries when the API stays unavailable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(client(fetchImpl).getServerTime()).rejects.toThrow(/network error/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("rejects payloads that do not match the documented shape", async () => {
    const fetchImpl = vi.fn(async () => json({ products: "oops" })) as unknown as typeof fetch;
    await expect(client(fetchImpl).listPublicSpotProducts()).rejects.toThrow();
  });

  it("spaces requests according to maxRps", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => json({})) as unknown as typeof fetch;
    const c = new CoinbasePublicRest({ baseUrl: "https://api.example", maxRps: 2, fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
    await Promise.all([c.getServerTime(), c.getServerTime(), c.getServerTime()]);
    expect(sleeps.length).toBe(2);
    for (const s of sleeps) expect(s).toBeGreaterThan(400);
  });
});
