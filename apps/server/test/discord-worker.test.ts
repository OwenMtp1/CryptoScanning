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
    expect(s1.firstRun).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toContain("Crypto Radar connecté");
    expect(s1.sources.coinbase).toBe("2 cryptos"); // one USD pair per coin

    // +8 % in 5 min on Coinbase, plus a bullish headline → alert(s).
    vi.setSystemTime(Date.now() + 5 * 60_000);
    price = 1.08;
    const s2 = await run();
    expect(s2.firstRun).toBe(false);
    expect(s2.errors).toEqual([]);
    expect(posted.length).toBe(2);
    const msg = JSON.parse(posted[1]!.body);
    const titles = msg.embeds.map((e: { title: string }) => e.title).join(" | ");
    expect(titles).toContain("PEPE : 2 types d'indices indépendants haussiers (prix + actualités)"); // the pump alone (67) waits for the digest
    expect(msg.allowed_mentions).toEqual({ parse: [] });

    // Same move again 5 min later: per-coin cooldown → no new immediate alert.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    price = 1.17;
    await run();
    expect(posted.length).toBe(2);

    // Public status never contains the webhook token.
    const status = await (await new RadarState({ storage: st } as never, env).fetch(new Request("https://radar/status"))).text();
    expect(status).not.toContain("tok_EN-secret");
    expect(status).toContain("lastRunAt");
  });

  it("runs on Coinbase alone when SITE_URL is missing and says so", async () => {
    vi.stubGlobal("fetch", vi.fn(async (u: string, i?: { method?: string; body?: string }) => fakeFetch(u, i)));
    const st = storage();
    const s = (await (await new RadarState({ storage: st } as never, { RADAR: {} as never }).fetch(new Request("https://radar/scan"))).json()) as { errors: string[]; config: { webhookConfigured: boolean } };
    expect(s.errors.join()).toContain("SITE_URL non configurée");
    expect(s.config.webhookConfigured).toBe(false);
  });
});
