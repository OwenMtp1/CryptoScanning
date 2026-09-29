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
  /** Optional: separate channels. Bullish / bearish alerts go there; the rest goes to DISCORD_WEBHOOK_URL. */
  DISCORD_WEBHOOK_BULLISH?: string;
  DISCORD_WEBHOOK_BEARISH?: string;
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

    // Channel routing: one webhook per direction when configured, the general webhook for the rest.
    const bull = env.DISCORD_WEBHOOK_BULLISH?.trim() || null;
    const bear = env.DISCORD_WEBHOOK_BEARISH?.trim() || null;
    const general = env.DISCORD_WEBHOOK_URL?.trim() || null;
    const specs: { id: string; label: string; url: string | null; directions: ("bullish" | "bearish" | "neutral")[] }[] = [
      { id: "bullish", label: "haussier", url: bull, directions: ["bullish"] },
      { id: "bearish", label: "baissier", url: bear, directions: ["bearish"] },
      { id: "general", label: "général", url: general, directions: cfg.discord.directions.filter((d) => !(d === "bullish" && bull) && !(d === "bearish" && bear)) },
    ];
    const savedDiscord = ((await st.get<Record<string, unknown>>("discord")) ?? {}) as Record<string, unknown>;
    const channels = specs
      .filter((c) => c.url && c.directions.length)
      .map((c) => {
        const n = new DiscordNotifier({
          webhookUrl: c.url,
          cfg: { ...cfg.discord, directions: c.directions },
          fetchText,
          log: (e) => {
            if (e.level === "warn" || e.level === "error") errors.push(`Discord ${c.label} : ${e.message}`);
          },
          hitRateOf: () => null,
          now: () => now,
        });
        // Old single-channel state (v1) belongs to the general channel.
        n.importState((savedDiscord[c.id] ?? (c.id === "general" && "lastCoinAt" in savedDiscord ? savedDiscord : undefined)) as never);
        return { ...c, n };
      });
    const welcomed = new Set(((await st.get<{ welcomed?: string[] }>("meta")) ?? {}).welcomed ?? []);
    let signals = 0;
    // First run: learn the current state silently (otherwise everything already moving would be alerted at once).
    const svc = new IntelService({
      cfg,
      log: () => {},
      notifier: firstRun ? null : { consider: (s) => (signals++, channels.forEach((c) => c.n.consider(s))), view: () => channels[0]?.n.view() ?? null },
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
    for (const c of channels) {
      if (!c.n.active) {
        errors.push(`Discord ${c.label} : ${c.n.view().lastError ?? "webhook invalide"}`);
        continue;
      }
      if (!welcomed.has(c.id)) {
        // New channel: a hello message instead of a burst of alerts.
        const r = await c.n.test(c.id === "bullish" ? "🟢 Ce salon reçoit les signaux **haussiers** (cryptos qui pourraient exploser)." : c.id === "bearish" ? "🔴 Ce salon reçoit les signaux **baissiers** (cryptos qui pourraient chuter)." : c.directions.length < 2 ? `Ce salon reçoit les signaux ${c.directions.includes("bullish") ? "haussiers" : "baissiers"}.` : "Ce salon reçoit tous les signaux (haussiers 🟢 et baissiers 🔴).");
        if (r.ok) welcomed.add(c.id);
        else errors.push(`Discord ${c.label} : ${r.message}`);
      } else if (!firstRun) await c.n.pump();
    }

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
      config: { siteUrl: site || null, webhookConfigured: channels.some((c) => c.n.active), minStrength: cfg.discord.minStrength },
      discord: Object.fromEntries(channels.map((c) => [c.label, { directions: c.directions, ...c.n.view() }])),
    };
    await st.put({ intel, cb: history.export(), discord: Object.fromEntries(channels.map((c) => [c.id, c.n.exportState()])), meta: { warm: true, welcomed: [...welcomed] }, status });
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
