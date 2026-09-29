/**
 * Crypto Radar — Discord alert worker (Cloudflare Workers, free plan).
 *
 * Runs every 5 minutes (cron trigger) even when nobody has the site open:
 *   Coinbase public product list (all cryptos, 5 / 15 min moves)
 *   + CoinGecko markets / trending / derivatives / DEX and RSS news, read
 *     through the live site's cached functions (SITE_URL) so the CoinGecko
 *     quota is shared with the site
 *   → same IntelEngine as the site → Discord webhook.
 * State (cooldowns, price history, Discord limits) lives in a SQLite-backed
 * Durable Object. The webhook URL is a Worker SECRET; it is never returned.
 */
import { CgDerivativeSchema, CgMarketRowSchema, CgTrendingSchema, CoinbasePriceHistory, GtPoolsSchema, IntelConfigSchema, parseFeed, parseProductsPage, type CgDerivative, type CgMarketRow, type Product } from "../../../packages/core/src/index";
import { DiscordNotifier } from "../../../apps/server/src/intel/discord-notifier";
import { fetchText } from "../../../apps/server/src/intel/http";
import { IntelService, type IntelSavedState } from "../../../apps/server/src/intel/intel-service";

interface Env {
  RADAR: { idFromName(n: string): unknown; get(id: unknown): { fetch(url: string): Promise<Response> } };
  DISCORD_WEBHOOK_URL?: string;
  SITE_URL?: string;
  DISCORD_MIN_STRENGTH?: string;
  DISCORD_ROLE_ID?: string;
}
interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
}
interface DOState {
  storage: Storage;
}

interface Status {
  lastRunAt: number | null;
  durationMs: number;
  firstRun: boolean;
  signals: number;
  sources: Record<string, string>;
  errors: string[];
  config: { siteUrl: string | null; webhookConfigured: boolean; minStrength: number };
  discord: unknown;
}

export class RadarState {
  private running = false;

  constructor(
    private readonly state: DOState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/scan") {
      if (this.running) return Response.json({ skipped: "analyse déjà en cours" });
      this.running = true;
      try {
        return Response.json(await this.scan());
      } finally {
        this.running = false;
      }
    }
    return Response.json((await this.state.storage.get<Status>("status")) ?? { message: "Aucune analyse pour l'instant : la première a lieu dans les 5 minutes suivant le déploiement." });
  }

  private async scan(): Promise<Status> {
    const t0 = Date.now();
    const now = t0;
    const errors: string[] = [];
    const sources: Record<string, string> = {};
    const env = this.env;
    const st = this.state.storage;
    const minStrength = Number(env.DISCORD_MIN_STRENGTH);
    const role = env.DISCORD_ROLE_ID?.trim();
    const cfg = IntelConfigSchema.parse({ discord: { ...(Number.isFinite(minStrength) && env.DISCORD_MIN_STRENGTH ? { minStrength } : {}), ...(role && /^\d+$/.test(role) ? { mentionRoleId: role } : {}) } });
    const meta = (await st.get<{ warm?: boolean }>("meta")) ?? {};
    const firstRun = !meta.warm;

    const notifier = new DiscordNotifier({
      webhookUrl: env.DISCORD_WEBHOOK_URL ?? null,
      cfg: cfg.discord,
      fetchText,
      log: (e) => {
        if (e.level === "warn" || e.level === "error") errors.push(e.message);
      },
      hitRateOf: () => null,
      now: () => now,
    });
    notifier.importState(await st.get("discord"));
    let signals = 0;
    // First run: learn the current state silently (otherwise everything already moving would be alerted at once).
    const svc = new IntelService({
      cfg,
      log: () => {},
      notifier: firstRun ? null : { consider: (s) => (signals++, notifier.consider(s)), view: () => notifier.view() },
      enabledSources: ["coinbase", "coingecko", "trending", "derivatives", "dex", "news"],
      now: () => now,
    });
    if (firstRun) svc.subscribe((b) => void (signals += b.signals.length));
    svc.restore(await st.get<IntelSavedState>("intel"));
    const history = new CoinbasePriceHistory((await st.get("cb")) ?? null);
    const site = (env.SITE_URL ?? "").trim().replace(/\/+$/, "");

    const get = async (label: string, url: string): Promise<string | null> => {
      try {
        const r = await fetchText(url, { timeoutMs: 25_000, headers: { accept: "application/json, application/xml;q=0.9, */*;q=0.5" } });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}${r.headers.get("x-upstream-status") ? ` (amont ${r.headers.get("x-upstream-status")})` : ""}`);
        return r.text;
      } catch (err) {
        errors.push(`${label} : ${(err as Error).message}`);
        return null;
      }
    };
    const arr = <T>(text: string | null, schema: { safeParse(x: unknown): { success: boolean; data?: T } }): T[] => {
      if (!text) return [];
      const raw = JSON.parse(text) as unknown;
      return Array.isArray(raw) ? raw.flatMap((x) => {
        const p = schema.safeParse(x);
        return p.success ? [p.data as T] : [];
      }) : [];
    };

    // 1. CoinGecko markets first (names for news matching, USD prices).
    if (site) {
      let n = 0;
      for (let page = 1; page <= 3; page++) {
        const rows = arr<CgMarketRow>(await get(`CoinGecko marchés p${page}`, `${site}/api/cg/coins/markets?page=${page}`), CgMarketRowSchema);
        n += rows.length;
        if (rows.length) svc.onMarkets(rows, page, now);
      }
      sources.coingecko = `${n} cryptos`;
    } else errors.push("SITE_URL non configurée : CoinGecko et actualités ignorés (seul Coinbase est analysé)");

    // 2. Coinbase: every listed crypto, 5 / 15 min moves from the stored history.
    const products: Product[] = [];
    for (let page = 0; page < 4; page++) {
      const text = await get("Coinbase", `https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT&limit=250&offset=${page * 250}`);
      if (!text) break;
      const parsed = parseProductsPage(JSON.parse(text));
      products.push(...parsed.products);
      if (parsed.rawCount < 250) break;
    }
    if (products.length) {
      svc.onCoinbaseProducts(products, history, now);
      sources.coinbase = `${CoinbasePriceHistory.pick(products).length} cryptos`;
    }

    if (site) {
      // 3. Trending, derivatives, DEX (served from the site's cache).
      const tr = await get("Tendances", `${site}/api/cg/search/trending`);
      if (tr) {
        const t = CgTrendingSchema.safeParse(JSON.parse(tr));
        if (t.success) {
          svc.onTrending(t.data.coins.map((c, i) => ({ id: c.item.id, symbol: c.item.symbol, name: c.item.name, rank: i, marketCapRank: c.item.market_cap_rank })), now);
          sources.trending = `${t.data.coins.length}`;
        }
      }
      const der = arr<CgDerivative>(await get("Dérivés", `${site}/api/cg/derivatives`), CgDerivativeSchema);
      if (der.length) {
        svc.onDerivatives(der, now);
        sources.derivatives = `${der.length} contrats`;
      }
      for (const [label, path, isNew] of [["DEX tendances", "trending_pools", false], ["DEX nouveaux", "new_pools", true]] as const) {
        const text = await get(label, `${site}/api/cg/onchain/networks/${path}`);
        const doc = text ? GtPoolsSchema.safeParse(JSON.parse(text)) : null;
        if (doc?.success) svc.onPools(doc.data, isNew, now);
      }
      // 4. News.
      const list = await get("Actualités", `${site}/api/news`);
      let items = 0;
      if (list) {
        for (const f of (JSON.parse(list) as { feeds: { id: string; name: string }[] }).feeds) {
          const xml = await get(`Actu ${f.name}`, `${site}/api/news/${encodeURIComponent(f.id)}`);
          const parsed = xml ? parseFeed(xml) : [];
          items += parsed.length;
          if (parsed.length) svc.onNews(f.name, parsed, now);
        }
      }
      sources.news = `${items} articles`;
    }

    // 5. Discord.
    if (firstRun) {
      if (notifier.active) {
        const r = await notifier.test();
        if (!r.ok) errors.push(`Discord : ${r.message}`);
      }
    } else await notifier.pump();

    // 6. Save (compact: the worker needs cooldowns and recent signals, not full history).
    const intel = svc.exportState();
    const recent = now - 3 * 3_600_000;
    intel.engine.signals = intel.engine.signals.filter((s) => s.ts >= recent).slice(-600);
    intel.engine.news = intel.engine.news.slice(-500).map((n) => ({ ...n, summary: "" }));
    intel.tracker = [];
    const status: Status = {
      lastRunAt: now,
      durationMs: Date.now() - t0,
      firstRun,
      signals,
      sources,
      errors: errors.slice(0, 20),
      config: { siteUrl: site || null, webhookConfigured: notifier.active, minStrength: cfg.discord.minStrength },
      discord: notifier.view(),
    };
    await st.put({ intel, cb: history.export(), discord: notifier.exportState(), meta: { warm: true }, status });
    return status;
  }
}

const stub = (env: Env) => env.RADAR.get(env.RADAR.idFromName("main"));

export default {
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(stub(env).fetch("https://radar/scan"));
  },
  /** Public read-only status page (no secret in it). */
  async fetch(_req: Request, env: Env): Promise<Response> {
    const r = await stub(env).fetch("https://radar/status");
    return new Response(JSON.stringify(await r.json(), null, 2), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  },
};
