/**
 * Crypto Radar — Discord alert worker (Cloudflare Workers, free plan).
 *
 * Two rhythms, both running 24/7 even when nobody has the site open:
 *   - every ~20 s (Durable Object alarm loop): Coinbase public product list
 *     → 5 / 15 min moves on every Coinbase crypto → immediate alerts;
 *   - every 5 min: CoinGecko markets / trending / derivatives / DEX and RSS
 *     news, read through the live site's cached functions (SITE_URL) so the
 *     CoinGecko quota is shared with the site.
 * The cron trigger (every 5 min) is only a safety net that restarts the loop.
 *
 * The live site can also RELAY its own signals (e.g. real-time Binance) with
 * POST /relay + header `x-relay-key` = RELAY_KEY (secret). They go through
 * the same thresholds, cooldowns and channel routing as the worker's own.
 *
 * State lives in a SQLite-backed Durable Object; all work is serialized.
 * Webhook URLs and the relay key are Worker SECRETS and are never returned.
 */
import {
  BinanceMiniRestTickerSchema,
  BinanceRestHistory,
  CgDerivativeExchangeSchema,
  CgMarketRowSchema,
  derivativeRowsFromExchange,
  CgTrendingSchema,
  CoinbasePriceHistory,
  GtPoolsSchema,
  IntelConfigSchema,
  parseFeed,
  parseProductsPage,
  type BinanceMiniRestTicker,
  type CgMarketRow,
  type IntelConfig,
  type IntelKind,
  type IntelSignal,
  type IntelSource,
  type Product,
} from "../../../packages/core/src/index";
import { DiscordNotifier } from "../../../apps/server/src/intel/discord-notifier";
import { fetchText } from "../../../apps/server/src/intel/http";
import { IntelService, type IntelSavedState } from "../../../apps/server/src/intel/intel-service";

interface Env {
  RADAR: { idFromName(n: string): unknown; get(id: unknown, opts?: { locationHint?: string }): { fetch(url: string, init?: RequestInit): Promise<Response> } };
  DISCORD_WEBHOOK_URL?: string;
  /** Optional: separate channels. Bullish / bearish alerts go there; the rest goes to DISCORD_WEBHOOK_URL. */
  DISCORD_WEBHOOK_BULLISH?: string;
  DISCORD_WEBHOOK_BEARISH?: string;
  SITE_URL?: string;
  DISCORD_MIN_STRENGTH?: string;
  DISCORD_ROLE_ID?: string;
  /** Secret shared with the site owner's browser to relay the site's signals. */
  RELAY_KEY?: string;
}
interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(t: number): Promise<void>;
}
interface DOState {
  storage: Storage;
}

const FAST_MS = 20_000;
/** Name of the live instance. An older instance (e.g. before the move to Europe) stops its own loop. */
const ACTIVE = "eu-1";
const FULL_MS = 5 * 60_000;
const KINDS = new Set<IntelKind>(["PUMP_EARLY", "DUMP_EARLY", "VOLUME_SURGE", "BREAKOUT_24H_HIGH", "BREAKDOWN_24H_LOW", "TOP_MOVER_1H", "CRASH_1H", "VOLUME_MCAP_ANOMALY", "NEAR_ATH", "TRENDING_ENTRY", "FUNDING_EXTREME_LONG", "FUNDING_EXTREME_SHORT", "OPEN_INTEREST_SURGE", "DEX_NEW_POOL_TRACTION", "DEX_TRENDING_PUMP", "DEX_RUG_RISK", "NEWS_BULLISH", "NEWS_BEARISH", "CONFLUENCE"]);
const SOURCES = new Set<IntelSource>(["coinbase", "binance", "coingecko", "trending", "derivatives", "dex", "news"]);

interface Channel {
  id: "bullish" | "bearish" | "general";
  label: string;
  directions: ("bullish" | "bearish" | "neutral")[];
  n: DiscordNotifier;
}

interface Status {
  lastRunAt: number | null;
  lastFullRunAt: number | null;
  durationMs: number;
  loop: string;
  signals24h: number;
  sources: Record<string, string>;
  errors: string[];
  relay: { configured: boolean; received: number; lastAt: number | null };
  config: { siteUrl: string | null; webhookConfigured: boolean; minStrength: number };
  discord: unknown;
}

/** Constant-time string comparison (relay key). */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Validate a relayed signal: strict shape, bounded sizes, recent timestamp. */
export function sanitizeRelayed(x: unknown, now: number): IntelSignal | null {
  if (!x || typeof x !== "object") return null;
  const s = x as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
  const id = str(s.id, 64);
  const coin = str(s.coin, 20);
  const title = str(s.title, 300);
  if (!id || !coin || !/^[A-Z0-9._-]+$/.test(coin) || !title) return null;
  if (!KINDS.has(s.kind as IntelKind) || !SOURCES.has(s.source as IntelSource)) return null;
  if (s.direction !== "bullish" && s.direction !== "bearish" && s.direction !== "neutral") return null;
  const strength = Number(s.strength);
  const ts = Number(s.ts);
  if (!Number.isFinite(strength) || strength < 0 || strength > 100) return null;
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 10 * 60_000) return null;
  const url = typeof s.url === "string" && /^https:\/\/[^\s]{1,300}$/.test(s.url) ? s.url : null;
  const priceUsd = typeof s.priceUsd === "number" && Number.isFinite(s.priceUsd) ? s.priceUsd : null;
  const reasons = Array.isArray(s.reasons) ? s.reasons.filter((r): r is string => typeof r === "string").slice(0, 8).map((r) => r.slice(0, 300)) : [];
  return { id: `site-${id}`, ts, coin, coinName: str(s.coinName, 80), kind: s.kind as IntelKind, direction: s.direction, source: s.source as IntelSource, strength: Math.round(strength), title, reasons, metrics: {}, priceUsd, url };
}

export class RadarState {
  private queue: Promise<unknown> = Promise.resolve();
  private clock = Date.now();
  private loaded: {
    cfg: IntelConfig;
    svc: IntelService;
    history: CoinbasePriceHistory;
    binance: BinanceRestHistory;
    binanceBackoffUntil: number;
    coinbaseBackoffUntil: number;
    /** coin:kind → last sent (shared by the bot's own signals and the site's relayed ones). */
    seen: Map<string, number>;
    channels: Channel[];
    warm: boolean;
    welcomed: Set<string>;
    lastFullRunAt: number | null;
    relay: { received: number; lastAt: number | null };
    sentLog: number[];
  } | null = null;
  private signalsThisRun = 0;

  constructor(
    private readonly state: DOState,
    private readonly env: Env,
  ) {}

  /** Serialize every operation touching the state. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    // Requests only reach the live instance (the stub below): mark it as such.
    if (path === "/scan" || path === "/ensure" || path === "/relay") await this.state.storage.put({ active: ACTIVE });
    if (path === "/scan") return Response.json(await this.run(() => this.scan()));
    if (path === "/ensure") return Response.json({ restarted: await this.ensureLoop() });
    if (path === "/relay") {
      const key = this.env.RELAY_KEY?.trim();
      if (!key) return Response.json({ ok: false, error: "RELAY_KEY non configurée sur le worker" }, { status: 503 });
      if (!sameSecret(req.headers.get("x-relay-key") ?? "", key)) return Response.json({ ok: false, error: "code de relais incorrect" }, { status: 401 });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: "json invalide" }, { status: 400 });
      }
      return Response.json(await this.run(() => this.relay(body)));
    }
    return Response.json((await this.state.storage.get<Status>("status")) ?? { message: "Aucune analyse pour l'instant : la première a lieu dans les 5 minutes suivant le déploiement." });
  }

  /** Durable Object alarm: the ~20 s loop. */
  async alarm(): Promise<void> {
    // Only the live instance keeps looping; a retired one simply stops (no duplicate alerts).
    if ((await this.state.storage.get<string>("active")) !== ACTIVE) return;
    await this.run(() => this.scan());
  }

  private async load() {
    if (this.loaded) return this.loaded;
    const st = this.state.storage;
    const env = this.env;
    const minStrength = Number(env.DISCORD_MIN_STRENGTH);
    const role = env.DISCORD_ROLE_ID?.trim();
    // Everything the engine detects is sent, one notification per signal (DISCORD_MIN_STRENGTH can raise the bar).
    const cfg = IntelConfigSchema.parse({
      discord: {
        minStrength: Number.isFinite(minStrength) && env.DISCORD_MIN_STRENGTH ? minStrength : 0,
        directions: ["bullish", "bearish", "neutral"],
        perCoinCooldownMin: 0,
        digestMin: 0,
        maxMessagesPerHour: 5000,
        onePerMessage: true,
        ...(role && /^\d+$/.test(role) ? { mentionRoleId: role } : {}),
      },
    });
    const meta = (await st.get<{ warm?: boolean; welcomed?: string[]; lastFullRunAt?: number; relay?: { received: number; lastAt: number | null }; sentLog?: number[]; seen?: Record<string, number> }>("meta")) ?? {};

    // Channel routing: one webhook per direction when configured, the general webhook for the rest.
    const bull = env.DISCORD_WEBHOOK_BULLISH?.trim() || null;
    const bear = env.DISCORD_WEBHOOK_BEARISH?.trim() || null;
    const general = env.DISCORD_WEBHOOK_URL?.trim() || null;
    const specs: { id: Channel["id"]; label: string; url: string | null; directions: Channel["directions"] }[] = [
      { id: "bullish", label: "haussier", url: bull, directions: ["bullish"] },
      { id: "bearish", label: "baissier", url: bear, directions: ["bearish"] },
      { id: "general", label: "général", url: general, directions: cfg.discord.directions.filter((d) => !(d === "bullish" && bull) && !(d === "bearish" && bear)) },
    ];
    const savedDiscord = ((await st.get<Record<string, unknown>>("discord")) ?? {}) as Record<string, unknown>;
    const errorsSink = (label: string) => (e: { level: string; message: string }) => {
      if (e.level === "warn" || e.level === "error") this.errors.push(`Discord ${label} : ${e.message}`);
    };
    const channels: Channel[] = specs
      .filter((c) => c.url && c.directions.length)
      .map((c) => {
        const n = new DiscordNotifier({ webhookUrl: c.url, cfg: { ...cfg.discord, directions: c.directions }, fetchText, log: errorsSink(c.label), hitRateOf: () => null, now: () => this.clock });
        // Old single-channel state (v1) belongs to the general channel.
        n.importState((savedDiscord[c.id] ?? (c.id === "general" && "lastCoinAt" in savedDiscord ? savedDiscord : undefined)) as never);
        return { id: c.id, label: c.label, directions: c.directions, n };
      });

    const loaded = {
      cfg,
      channels,
      history: new CoinbasePriceHistory((await st.get("cb")) ?? null),
      binance: new BinanceRestHistory(cfg.binance.quotes, (await st.get("bn")) ?? null),
      binanceBackoffUntil: 0,
      coinbaseBackoffUntil: 0,
      seen: new Map(Object.entries(meta.seen ?? {})),
      warm: !!meta.warm,
      welcomed: new Set(meta.welcomed ?? []),
      lastFullRunAt: meta.lastFullRunAt ?? null,
      relay: meta.relay ?? { received: 0, lastAt: null },
      sentLog: (meta.sentLog ?? []).filter((t) => t > Date.now() - 86_400_000),
      svc: null as unknown as IntelService,
    };
    loaded.svc = new IntelService({
      cfg,
      log: () => {},
      // Until the first full pass is done, learn silently (no burst of alerts on what already moves).
      notifier: {
        consider: (s) => {
          if (!loaded.warm) return;
          this.dispatch(s);
        },
        view: () => channels[0]?.n.view() ?? null,
      },
      enabledSources: ["binance", "coinbase", "coingecko", "trending", "derivatives", "dex", "news"],
      now: () => this.clock,
    });
    loaded.svc.restore(await st.get<IntelSavedState>("intel"));
    this.loaded = loaded;
    return loaded;
  }

  private errors: string[] = [];

  /**
   * Send one signal to its channel(s). The same event (coin × type) seen by
   * both the site and the bot within 30 min is sent once.
   */
  private dispatch(s: IntelSignal) {
    const L = this.loaded;
    if (!L) return;
    const key = `${s.coin}:${s.kind}:${s.direction}`;
    const last = L.seen.get(key);
    if (last !== undefined && this.clock - last < 30 * 60_000) return;
    L.seen.set(key, this.clock);
    this.signalsThisRun++;
    L.sentLog.push(this.clock);
    for (const c of L.channels) c.n.consider(s);
  }

  private async get(label: string, url: string): Promise<string | null> {
    try {
      const r = await fetchText(url, { timeoutMs: 25_000, headers: { accept: "application/json, application/xml;q=0.9, */*;q=0.5" } });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}${r.headers.get("x-upstream-status") ? ` (amont ${r.headers.get("x-upstream-status")})` : ""}`);
      return r.text;
    } catch (err) {
      this.errors.push(`${label} : ${(err as Error).message}`);
      return null;
    }
  }

  private async scan(): Promise<Status> {
    const t0 = Date.now();
    this.clock = t0;
    const now = t0;
    this.errors = [];
    this.signalsThisRun = 0;
    const L = await this.load();
    const svc = L.svc;
    const sources: Record<string, string> = {};
    const site = (this.env.SITE_URL ?? "").trim().replace(/\/+$/, "");
    const full = L.lastFullRunAt === null || now - L.lastFullRunAt >= FULL_MS - 10_000;
    const arr = <T>(text: string | null, schema: { safeParse(x: unknown): { success: boolean; data?: T } }): T[] => {
      if (!text) return [];
      const raw = JSON.parse(text) as unknown;
      return Array.isArray(raw)
        ? raw.flatMap((x) => {
            const p = schema.safeParse(x);
            return p.success ? [p.data as T] : [];
          })
        : [];
    };

    // 1. (full) CoinGecko markets first: names for news matching, USD prices.
    if (full) {
      if (site) {
        let n = 0;
        for (let page = 1; page <= 3; page++) {
          const rows = arr<CgMarketRow>(await this.get(`CoinGecko marchés p${page}`, `${site}/api/cg/coins/markets?page=${page}`), CgMarketRowSchema);
          n += rows.length;
          if (rows.length) svc.onMarkets(rows, page, now);
        }
        sources.coingecko = `${n} cryptos`;
      } else this.errors.push("SITE_URL non configurée : CoinGecko et actualités ignorés (seuls Binance et Coinbase sont analysés)");
    }

    // 2. (every run) Binance: every pair, 5 / 15 min moves and 24 h breakouts (weight 80 / call).
    if (now >= L.binanceBackoffUntil) {
      const text = await this.get("Binance", "https://data-api.binance.vision/api/v3/ticker/24hr?type=MINI&symbolStatus=TRADING");
      if (text) {
        const tickers = arr<BinanceMiniRestTicker>(text, BinanceMiniRestTickerSchema);
        if (tickers.length) {
          svc.onBinanceTickers(tickers, L.binance, now);
          sources.binance = `${L.binance.pick(tickers, now).length} cryptos`;
        }
      } else if (this.errors.some((e) => /^Binance : HTTP (451|403)/.test(e))) {
        // Binance refuses this server's location: try again in 30 min, Coinbase covers meanwhile.
        L.binanceBackoffUntil = now + 30 * 60_000;
      } else L.binanceBackoffUntil = now + 60_000;
    } else sources.binance = `en pause jusqu'à ${new Date(L.binanceBackoffUntil).toISOString().slice(11, 16)} UTC (refus précédent)`;

    // 3. (every run) Coinbase: every listed crypto (one call), for coins Binance does not have.
    if (now >= L.coinbaseBackoffUntil) {
      const text = await this.get("Coinbase", "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT");
      if (text) {
        const products: Product[] = parseProductsPage(JSON.parse(text)).products;
        if (products.length) {
          svc.onCoinbaseProducts(products, L.history, now);
          sources.coinbase = `${CoinbasePriceHistory.pick(products).length} cryptos`;
        }
      } else L.coinbaseBackoffUntil = now + (this.errors.some((e) => e.startsWith("Coinbase : HTTP 429")) ? 90_000 : 40_000);
    }

    if (full && site) {
      // 3. Trending, derivatives, DEX (served from the site's cache).
      const tr = await this.get("Tendances", `${site}/api/cg/search/trending`);
      if (tr) {
        const t = CgTrendingSchema.safeParse(JSON.parse(tr));
        if (t.success) {
          svc.onTrending(t.data.coins.map((c, i) => ({ id: c.item.id, symbol: c.item.symbol, name: c.item.name, rank: i, marketCapRank: c.item.market_cap_rank })), now);
          sources.trending = `${t.data.coins.length}`;
        }
      }
      const derText = await this.get("Dérivés", `${site}/api/cg/derivatives/exchanges/binance_futures`);
      const derDoc = derText ? CgDerivativeExchangeSchema.safeParse(JSON.parse(derText)) : null;
      const der = derDoc?.success ? derivativeRowsFromExchange(derDoc.data) : [];
      if (der.length) {
        svc.onDerivatives(der, now);
        sources.derivatives = `${der.length} contrats`;
      }
      for (const [label, path, isNew] of [["DEX tendances", "trending_pools", false], ["DEX nouveaux", "new_pools", true]] as const) {
        const text = await this.get(label, `${site}/api/cg/onchain/networks/${path}`);
        const doc = text ? GtPoolsSchema.safeParse(JSON.parse(text)) : null;
        if (doc?.success) svc.onPools(doc.data, isNew, now);
      }
      // 4. News.
      const list = await this.get("Actualités", `${site}/api/news`);
      let items = 0;
      if (list) {
        for (const f of (JSON.parse(list) as { feeds: { id: string; name: string }[] }).feeds) {
          const xml = await this.get(`Actu ${f.name}`, `${site}/api/news/${encodeURIComponent(f.id)}`);
          const parsed = xml ? parseFeed(xml) : [];
          items += parsed.length;
          if (parsed.length) svc.onNews(f.name, parsed, now);
        }
      }
      sources.news = `${items} articles`;
    }
    if (full) {
      L.lastFullRunAt = now;
      L.warm = true; // after the first full pass, alerts are live
    }

    await this.flushDiscord();
    const status = await this.save(t0, sources, full);
    await this.scheduleNext();
    return status;
  }

  /** Signals relayed by the live site (e.g. Binance real time). */
  private async relay(body: unknown): Promise<{ ok: boolean; accepted: number; rejected: number }> {
    this.clock = Date.now();
    this.errors = [];
    this.signalsThisRun = 0;
    const L = await this.load();
    const list = Array.isArray((body as { signals?: unknown })?.signals) ? ((body as { signals: unknown[] }).signals.slice(0, 50)) : [];
    let accepted = 0;
    for (const x of list) {
      const s = sanitizeRelayed(x, this.clock);
      if (!s) continue;
      accepted++;
      if (!L.warm) continue;
      this.dispatch(s);
    }
    L.relay.received += accepted;
    if (accepted) L.relay.lastAt = this.clock;
    await this.flushDiscord();
    const prev = (await this.state.storage.get<Status>("status")) ?? null;
    await this.state.storage.put({
      discord: Object.fromEntries(L.channels.map((c) => [c.id, c.n.exportState()])),
      meta: this.meta(L),
      ...(prev ? { status: { ...prev, relay: { configured: true, ...L.relay }, discord: this.discordView(L) } } : {}),
    });
    return { ok: true, accepted, rejected: list.length - accepted };
  }

  private async flushDiscord() {
    const L = this.loaded;
    if (!L) return;
    for (const c of L.channels) {
      if (!c.n.active) {
        this.errors.push(`Discord ${c.label} : ${c.n.view().lastError ?? "webhook invalide"}`);
        continue;
      }
      if (!L.welcomed.has(c.id)) {
        // New channel: a hello message instead of a burst of alerts.
        const note =
          c.id === "bullish"
            ? "🟢 Ce salon reçoit les signaux **haussiers** (cryptos qui pourraient exploser)."
            : c.id === "bearish"
              ? "🔴 Ce salon reçoit les signaux **baissiers** (cryptos qui pourraient chuter)."
              : c.directions.length < 2
                ? `Ce salon reçoit les signaux ${c.directions.includes("bullish") ? "haussiers" : "baissiers"}.`
                : "Ce salon reçoit tous les signaux (haussiers 🟢 et baissiers 🔴).";
        const r = await c.n.test(note);
        if (r.ok) L.welcomed.add(c.id);
        else this.errors.push(`Discord ${c.label} : ${r.message}`);
      } else await c.n.pump();
    }
  }

  private meta(L: NonNullable<RadarState["loaded"]>) {
    const seen = Object.fromEntries([...L.seen].filter(([, t]) => t > this.clock - 30 * 60_000));
    return { warm: L.warm, welcomed: [...L.welcomed], lastFullRunAt: L.lastFullRunAt, relay: L.relay, sentLog: L.sentLog.filter((t) => t > this.clock - 86_400_000).slice(-20000), seen };
  }

  private discordView(L: NonNullable<RadarState["loaded"]>) {
    return Object.fromEntries(L.channels.map((c) => [c.label, { directions: c.directions, ...c.n.view() }]));
  }

  private async save(t0: number, sources: Record<string, string>, full: boolean): Promise<Status> {
    const L = this.loaded as NonNullable<RadarState["loaded"]>;
    const st = this.state.storage;
    const prev = (await st.get<Status>("status")) ?? null;
    const status: Status = {
      lastRunAt: this.clock,
      lastFullRunAt: L.lastFullRunAt,
      durationMs: Date.now() - t0,
      loop: `prix Binance et Coinbase toutes les ${FAST_MS / 1000} s, autres sources toutes les ${FULL_MS / 60_000} min, une notification Discord par signal`,
      signals24h: L.sentLog.filter((t) => t > this.clock - 86_400_000).length,
      // Keep the detail of the last full pass visible between fast runs.
      sources: full ? sources : { ...(prev?.sources ?? {}), ...sources },
      errors: (full ? this.errors : [...this.errors, ...(prev?.errors ?? []).filter((e) => !e.startsWith("Coinbase") && !e.startsWith("Discord"))]).slice(0, 20),
      relay: { configured: !!this.env.RELAY_KEY?.trim(), ...L.relay },
      config: { siteUrl: (this.env.SITE_URL ?? "").trim() || null, webhookConfigured: L.channels.some((c) => c.n.active), minStrength: L.cfg.discord.minStrength },
      discord: this.discordView(L),
    };
    const entries: Record<string, unknown> = { cb: L.history.export(), bn: L.binance.export(), discord: Object.fromEntries(L.channels.map((c) => [c.id, c.n.exportState()])), meta: this.meta(L), status };
    if (full) {
      // Compact: the worker needs cooldowns and recent signals, not full history.
      const intel = L.svc.exportState();
      const recent = this.clock - 3 * 3_600_000;
      intel.engine.signals = intel.engine.signals.filter((s) => s.ts >= recent).slice(-600);
      intel.engine.news = intel.engine.news.slice(-500).map((n) => ({ ...n, summary: "" }));
      intel.tracker = [];
      entries.intel = intel;
    } else {
      // Fast runs only persist cooldowns + recent signals (small).
      const e = L.svc.engine.exportState();
      const saved = (await st.get<IntelSavedState>("intel")) ?? null;
      if (saved) entries.intel = { ...saved, engine: { ...saved.engine, cooldowns: e.cooldowns, signals: e.signals.filter((s) => s.ts >= this.clock - 3 * 3_600_000).slice(-600) } };
    }
    await st.put(entries);
    return status;
  }

  private async scheduleNext() {
    try {
      await this.state.storage.setAlarm(Date.now() + FAST_MS);
    } catch {
      // alarms unavailable (tests): the cron keeps running every 5 min
    }
  }

  /** Called by the cron: restart the loop if it stopped. */
  async ensureLoop(): Promise<boolean> {
    try {
      const a = await this.state.storage.getAlarm();
      if (a && a > Date.now() - 60_000) return false;
    } catch {
      // no alarm support: fall through to a scan
    }
    await this.run(() => this.scan());
    return true;
  }
}

/**
 * The Durable Object lives in Western Europe (location hint): its requests to
 * Binance, Coinbase and the site leave from a European data centre (Binance
 * refuses US locations, and the site's CoinGecko cache is shared per region).
 */
const stub = (env: Env) => env.RADAR.get(env.RADAR.idFromName(ACTIVE), { locationHint: "weur" });

export default {
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(stub(env).fetch("https://radar/ensure"));
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/relay") {
      const len = Number(req.headers.get("content-length") ?? 0);
      if (len > 64_000) return Response.json({ ok: false, error: "trop gros" }, { status: 413 });
      return stub(env).fetch("https://radar/relay", { method: "POST", headers: { "x-relay-key": req.headers.get("x-relay-key") ?? "", "content-type": "application/json" }, body: await req.text() });
    }
    // Public read-only status page (no secret in it).
    const r = await stub(env).fetch("https://radar/status");
    return new Response(JSON.stringify(await r.json(), null, 2), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  },
};
