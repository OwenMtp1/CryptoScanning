import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JS modules deployed as Cloudflare Pages Functions
import { onRequestGet as cg } from "../../../deploy/cloudflare/functions/api/cg/[[path]].js";
// @ts-expect-error plain JS
import { onRequestPost as relayFn } from "../../../deploy/cloudflare/functions/api/discord/relay.js";
// @ts-expect-error plain JS
import { onRequestGet as candles } from "../../../deploy/cloudflare/functions/api/candles.js";
// @ts-expect-error plain JS
import { onRequestGet as newsList } from "../../../deploy/cloudflare/functions/api/news/index.js";
// @ts-expect-error plain JS
import { onRequestGet as newsFeed } from "../../../deploy/cloudflare/functions/api/news/[id].js";

type Fn = (ctx: unknown) => Promise<Response> | Response;
const store = new Map<string, Response>();
let upstream: { url: string; headers: Record<string, string> }[] = [];
let upstreamStatus = 200;

beforeEach(() => {
  store.clear();
  upstream = [];
  upstreamStatus = 200;
  vi.stubGlobal("caches", {
    default: {
      match: async (r: Request) => store.get(r.url)?.clone(),
      put: async (r: Request, res: Response) => void store.set(r.url, res),
    },
  });
  vi.stubGlobal("fetch", async (url: string, init: { headers?: Record<string, string> }) => {
    upstream.push({ url, headers: init?.headers ?? {} });
    return new Response(upstreamStatus === 200 ? '{"ok":true}' : "nope", { status: upstreamStatus, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => vi.unstubAllGlobals());

const ctx = (url: string, params: Record<string, unknown>, env: Record<string, string> = {}) => {
  const waits: Promise<unknown>[] = [];
  return { c: { request: new Request(url), params, env, waitUntil: (p: Promise<unknown>) => waits.push(p) }, waits };
};
const call = async (fn: Fn, url: string, params: Record<string, unknown>, env?: Record<string, string>) => {
  const { c, waits } = ctx(url, params, env);
  const r = await fn(c);
  await Promise.all(waits);
  return r;
};

describe("Cloudflare function /api/cg", () => {
  it("maps whitelisted requests to canonical CoinGecko URLs with the secret key header, and caches them", async () => {
    const r = await call(cg, "https://x/api/cg/coins/markets?vs_currency=eur&page=2&per_page=9", { path: ["coins", "markets"] }, { COINGECKO_API_KEY: "CG-secret" });
    expect(r.status).toBe(200);
    expect(upstream[0]!.url).toBe("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=2&sparkline=false&price_change_percentage=1h%2C24h%2C7d");
    expect(upstream[0]!.headers["x-cg-demo-api-key"]).toBe("CG-secret");
    expect(r.headers.get("cache-control")).toBe("public, max-age=1800");
    expect(await r.text()).not.toContain("CG-secret");
    await call(cg, "https://x/api/cg/coins/markets?page=2&cachebust=1", { path: ["coins", "markets"] }, { COINGECKO_API_KEY: "CG-secret" });
    expect(upstream).toHaveLength(1); // served from cache
  });
  it("refuses anything outside the whitelist (no open proxy, bounded pages)", async () => {
    expect((await call(cg, "https://x/api/cg/coins/list", { path: ["coins", "list"] })).status).toBe(404);
    expect((await call(cg, "https://x/api/cg/coins/markets?page=99", { path: ["coins", "markets"] })).status).toBe(404);
    expect(upstream).toHaveLength(0);
  });
  it("uses the pro host for paid plans and caches upstream errors briefly", async () => {
    upstreamStatus = 429;
    const r = await call(cg, "https://x/api/cg/derivatives/exchanges/binance_futures", { path: ["derivatives", "exchanges", "binance_futures"] }, { COINGECKO_API_KEY: "k", COINGECKO_PLAN: "pro" });
    expect(upstream[0]!.url).toBe("https://pro-api.coingecko.com/api/v3/derivatives/exchanges/binance_futures?include_tickers=unexpired");
    expect(upstream[0]!.headers["x-cg-pro-api-key"]).toBe("k");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("120");
    expect(r.headers.get("cache-control")).toBe("public, max-age=120");
    expect(((await r.json()) as { detail: string }).detail).toBe("nope"); // upstream reason kept for diagnosis
    expect((await call(cg, "https://x/api/cg/derivatives", { path: ["derivatives"] })).status).toBe(404); // too big, no longer relayed
  });
});

describe("Cloudflare function /api/news", () => {
  it("lists feeds and proxies only whitelisted ones", async () => {
    const list = (await (await newsList()).json()) as { feeds: { id: string; kind?: string }[] };
    expect(list.feeds.filter((f) => f.kind !== "social").length).toBe(7); // CryptoSlate refuses Cloudflare
    const r = await call(newsFeed, "https://x/api/news/decrypt", { id: "decrypt" });
    expect(r.status).toBe(200);
    expect(upstream[0]!.url).toBe("https://decrypt.co/feed");
    expect(r.headers.get("content-type")).toContain("xml");
    expect((await call(newsFeed, "https://x/api/news/evil", { id: "https://evil.example" })).status).toBe(404);
    expect(upstream).toHaveLength(1);
  });
});

describe("Cloudflare function /api/candles", () => {
  it("builds the exchange URL from whitelisted parameters only, and caches it", async () => {
    const r = await call(candles, "https://x/api/candles?ex=okx&coin=pepe&interval=1h&limit=300", {});
    expect(r.status).toBe(200);
    expect(upstream[0]!.url).toBe("https://www.okx.com/api/v5/market/candles?instId=PEPE-USDT&bar=1H&limit=300");
    await call(candles, "https://x/api/candles?ex=okx&coin=PEPE&interval=1h&limit=300", {});
    expect(upstream).toHaveLength(1);
    await call(candles, "https://x/api/candles?ex=gate&coin=WIF&interval=1d&limit=365", {});
    expect(upstream[1]!.url).toBe("https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=WIF_USDT&interval=1d&limit=365");
  });
  it("refuses unknown exchanges, odd symbols and intervals", async () => {
    for (const q of ["ex=evil&coin=BTC&interval=1h", "ex=okx&coin=BTC%2F..&interval=1h", "ex=okx&coin=BTC&interval=2h", "ex=okx&coin=BTC&interval=1h&limit=5000"]) {
      expect((await call(candles, `https://x/api/candles?${q}`, {})).status).toBe(400);
    }
    expect(upstream).toHaveLength(0);
  });
});

describe("Cloudflare function /api/discord/relay", () => {
  const post = (headers: Record<string, string>, env: Record<string, string>) =>
    relayFn({ request: new Request("https://site.pages.dev/api/discord/relay", { method: "POST", headers, body: '{"signals":[]}' }), env, params: {}, waitUntil: () => {} });
  const env = { DISCORD_WORKER_URL: "https://bot.example.workers.dev", RELAY_KEY: "site-secret" };
  it("adds the site's relay code for its own pages only (no code to type on each device)", async () => {
    expect((await post({ "sec-fetch-site": "same-origin" }, env)).status).toBe(200);
    expect(upstream[0]!.headers["x-relay-key"]).toBe("site-secret");
    expect((await post({ "sec-fetch-site": "cross-site" }, env)).status).toBe(403);
    expect((await post({ origin: "https://evil.example" }, env)).status).toBe(403);
    expect((await post({}, env)).status).toBe(403);
    expect(upstream).toHaveLength(1);
    // Without the site secret: the typed code is still required.
    expect((await post({ "sec-fetch-site": "same-origin" }, { DISCORD_WORKER_URL: env.DISCORD_WORKER_URL })).status).toBe(401);
    // A typed code is passed through as is.
    await post({ "x-relay-key": "typed" }, env);
    expect(upstream[1]!.headers["x-relay-key"]).toBe("typed");
  });
});
