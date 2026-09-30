import { afterEach, describe, expect, it, vi } from "vitest";
import { RadarState } from "../../../deploy/discord-worker/src/worker.js";

const WEBHOOK = "https://discord.com/api/webhooks/123/tok_EN-secret";
const SITE = "https://crypto-radar.pages.dev";

function storage() {
  const m = new Map<string, unknown>();
  return { m, get: async (k: string) => structuredClone(m.get(k)), put: async (e: Record<string, unknown>) => void Object.entries(e).forEach(([k, v]) => m.set(k, structuredClone(v))) };
}

let price = 1;
const posted: { body: string }[] = [];
const product = (id: string, p: number) => ({ product_id: id, price: String(p), price_percentage_change_24h: "1", volume_24h: "5000000", base_currency_id: id.split("-")[0], quote_currency_id: id.split("-")[1], status: "online", trading_disabled: false, is_disabled: false, product_type: "SPOT", approximate_quote_24h_volume: "50000000" });
const res = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });

function fakeFetch(url: string, init?: { method?: string; body?: string }) {
  if (url.startsWith("https://discord.com/")) {
    posted.push({ body: init?.body ?? "" });
    return res("{}");
  }
  if (url.startsWith("https://data-api.binance.vision/")) return res(JSON.stringify([{ symbol: "WIFUSDT", openPrice: "1", highPrice: "2", lowPrice: "0.5", lastPrice: String(price), volume: "1", quoteVolume: "90000000", openTime: 0, closeTime: Date.now() }]));
  if (url.startsWith("https://api.coinbase.com/")) return res(JSON.stringify({ products: [product("PEPE-USD", price), product("BTC-USD", 100_000), product("BTC-EUR", 90_000)] }));
  if (url.startsWith(`${SITE}/api/cg/coins/markets`)) return res(url.includes("page=1") ? JSON.stringify([{ id: "pepe", symbol: "pepe", name: "Pepe", current_price: price, market_cap: 5e9, market_cap_rank: 30, total_volume: 1e8, price_change_percentage_1h_in_currency: 0.5, price_change_percentage_24h_in_currency: 1 }]) : "[]");
  if (url.startsWith(`${SITE}/api/cg/search/trending`)) return res(JSON.stringify({ coins: [] }));
  if (url.startsWith(`${SITE}/api/cg/derivatives`)) return res("[]");
  if (url.startsWith(`${SITE}/api/cg/onchain`)) return res(JSON.stringify({ data: [] }));
  if (url === `${SITE}/api/news`) return res(JSON.stringify({ feeds: [{ id: "decrypt", name: "Decrypt" }] }));
  if (url.startsWith(`${SITE}/api/news/`)) return res(`<rss><channel><item><title>Pepe surges as whales accumulate</title><link>https://decrypt.co/a${price}</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`);
  return res("{}", 404);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Discord worker", () => {
  it("first run is silent (welcome only), then pumps are alerted with cooldown, state persists, secrets never exposed", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 10, 12, 0), toFake: ["Date"] });
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i)));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK, SITE_URL: `${SITE}/` };
    const run = async () => (await (await new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/scan"))).json()) as Record<string, any>;

    const s1 = await run();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("Crypto Radar connecté");
    expect(s1.sources.coinbase).toBe("2 cryptos"); // one USD pair per coin

    // +8 % in 5 min on Coinbase, plus a bullish headline → alert(s).
    vi.setSystemTime(Date.now() + 5 * 60_000);
    price = 1.08;
    const s2 = await run();
    expect(s2.errors).toEqual([]);
    // No threshold, one notification per signal: Binance pump (WIF), Coinbase pump (PEPE), news, confluence…
    const msgs = posted.slice(1).map((p) => JSON.parse(p.body));
    expect(msgs.every((m) => m.embeds.length === 1)).toBe(true);
    const titles = msgs.map((m) => m.embeds[0].title).join(" | ");
    expect(titles).toContain("WIF décolle");
    expect(titles).toContain("PEPE décolle");
    expect(titles).toContain("PEPE : 2 types d'indices indépendants haussiers");
    expect(msgs[0].allowed_mentions).toEqual({ parse: [] });
    const afterSecond = posted.length;

    // Same move again 5 min later: the same event (coin × type) is not re-sent.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    price = 1.17;
    await run();
    expect(posted.length).toBe(afterSecond);

    // Public status never contains the webhook token.
    const status = await (await new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/status"))).text();
    expect(status).not.toContain("tok_EN-secret");
    expect(status).toContain("lastRunAt");
  });

  it("routes bullish and bearish alerts to separate channels", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 11, 12, 0), toFake: ["Date"] });
    const byHook: Record<string, string[]> = {};
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => {
      if (u.startsWith("https://discord.com/")) (byHook[u.split("/")[5]!] ??= []).push(i?.body ?? "");
      return fakeFetch(u, i);
    }));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_BULLISH: "https://discord.com/api/webhooks/1/up", DISCORD_WEBHOOK_BEARISH: "https://discord.com/api/webhooks/2/down", SITE_URL: SITE };
    const run = () => new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/scan"));
    price = 1;
    await run();
    expect(byHook["1"]![0]).toContain("haussiers");
    expect(byHook["2"]![0]).toContain("baissiers");
    vi.setSystemTime(Date.now() + 5 * 60_000);
    price = 1.1;
    await run();
    expect(byHook["1"]!.length).toBeGreaterThan(2); // every bullish signal, one message each
    expect(byHook["1"]!.slice(1).every((b) => JSON.parse(b).embeds.length === 1)).toBe(true);
    expect(byHook["2"]!.length).toBe(1); // nothing bearish
  });

  it("relays the site's signals only with the right code, through the same cooldowns", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 12, 12, 0), toFake: ["Date"] });
    posted.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i)));
    const st = storage();
    const env = { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK, SITE_URL: SITE, RELAY_KEY: "s3cret-code" };
    const obj = new RadarState({ storage: st } as never, env);
    price = 1;
    await obj.fetch(new Request("https://radar/scan")); // warm-up + welcome
    expect(posted).toHaveLength(1);
    const sig = { id: "b1", ts: Date.now(), coin: "SOLX", kind: "PUMP_EARLY", direction: "bullish", source: "binance", strength: 88, title: "SOLX décolle : +9 % en 5 min", reasons: ["r"], priceUsd: 1.2, url: "https://www.binance.com/en/trade/SOLX_USDT" };
    const relay = (key: string, signals: unknown[]) => obj.fetch(new Request("https://radar/relay", { method: "POST", headers: { "x-relay-key": key }, body: JSON.stringify({ signals }) }));
    expect((await relay("wrong", [sig])).status).toBe(401);
    const r = (await (await relay("s3cret-code", [sig, { ...sig, id: "bad", coin: "<script>" }, { ...sig, id: "old", ts: Date.now() - 3_600_000 }])).json()) as { accepted: number; rejected: number };
    expect(r).toMatchObject({ accepted: 1, rejected: 2 });
    expect(posted).toHaveLength(2);
    expect(posted[1]!.body).toContain("SOLX décolle");
    await relay("s3cret-code", [{ ...sig, id: "b2" }]); // same coin/direction within 1 h → not re-alerted
    expect(posted).toHaveLength(2);
    expect(await (await obj.fetch(new Request("https://radar/status"))).text()).not.toContain("s3cret");
  });

  it("a retired instance (before the move to Europe) stops its loop instead of sending duplicates", async () => {
    const f = vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i));
    vi.stubGlobal("fetch", f);
    const st = storage();
    await new RadarState({ storage: st } as never, { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK }).alarm();
    expect(f).not.toHaveBeenCalled();
    st.m.set("active", "eu-1");
    await new RadarState({ storage: st } as never, { RADAR: {} as never, DISCORD_WEBHOOK_URL: WEBHOOK }).alarm();
    expect(f).toHaveBeenCalled();
  });

  it("runs on Coinbase alone when SITE_URL is missing and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i)));
    const st = storage();
    const s = (await (await new RadarState({ storage: st } as never, { RADAR: {} as never }).fetch(new Request("https://radar/scan"))).json()) as { errors: string[]; config: { webhookConfigured: boolean } };
    expect(s.errors.join()).toContain("SITE_URL non configurée");
    expect(s.config.webhookConfigured).toBe(false);
  });
});
