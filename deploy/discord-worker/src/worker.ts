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
  trendingCategories,
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
  type Candidate,
  type Direction,
  type ExchangeId,
  EXCHANGE_NAME,
  EXCHANGE_TICKER_URLS,
  BINANCE_WEB_PRODUCTS_URL,
  parseBinanceWebProducts,
  parseExchangeTickers,
} from "../../../packages/core/src/index";
import { DiscordNotifier } from "../../../apps/server/src/intel/discord-notifier";
import { fetchText } from "../../../apps/server/src/intel/http";
import { loadPerpMarkets } from "../../../apps/server/src/intel/perp-sources";
import { IntelService, type IntelSavedState } from "../../../apps/server/src/intel/intel-service";
import { runSetup } from "../../../apps/server/src/intel/setup-scanner";
import { marketPointEmbeds } from "../../../apps/server/src/intel/market-point";

const cutText = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n - 1)}…`);

interface Env {
  RADAR: { idFromName(n: string): unknown; get(id: unknown, opts?: { locationHint?: string }): { fetch(url: string, init?: RequestInit): Promise<Response> } };
  DISCORD_WEBHOOK_URL?: string;
  /** Neutral signals channel (same role as DISCORD_WEBHOOK_URL, clearer name; takes precedence). */
  DISCORD_WEBHOOK_NEUTRAL?: string;
  /** Optional: separate channels. Bullish / bearish alerts go there; the rest goes to DISCORD_WEBHOOK_URL. */
  DISCORD_WEBHOOK_BULLISH?: string;
  DISCORD_WEBHOOK_BEARISH?: string;
  SITE_URL?: string;
  DISCORD_MIN_STRENGTH?: string;
  DISCORD_ROLE_ID?: string;
  /** Secret shared with the site owner's browser to relay the site's signals. */
  RELAY_KEY?: string;
  /** Optional: channel for leveraged markets (long / short setups, liquidations). */
  DISCORD_WEBHOOK_LEVERAGE?: string;
  /** Dedicated channel for the « État du marché » (and the bot's own notices); receives no signals. */
  DISCORD_WEBHOOK_MARKET?: string;
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
/** Cloudflare free plan: 50 outgoing requests per run. Kept: 2 of margin. */
const REQUEST_BUDGET = 48;
/** Requests always kept for Discord messages in a run. */
const DISCORD_RESERVE = 18;
const EXCHANGES: ExchangeId[] = ["okx", "kucoin", "mexc"];
/** Name of the live instance. An older instance (e.g. before the move to Europe) stops its own loop. */
const ACTIVE = "eu-1";
/**
 * Binance public market-data hosts. They sit behind different CDNs / firewalls: when one refuses the
 * bot's Cloudflare address (HTTP 451 / 403 / 418 / 429), the next one is tried and the one that works
 * is remembered.
 */
export const BINANCE_HOSTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api-gcp.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
  "https://www.binance.com",
];
const FULL_MS = 5 * 60_000;
export const ALL_KINDS: IntelKind[] = ["PUMP_EARLY", "DUMP_EARLY", "VOLUME_SURGE", "BREAKOUT_24H_HIGH", "BREAKDOWN_24H_LOW", "TOP_MOVER_1H", "CRASH_1H", "VOLUME_MCAP_ANOMALY", "NEAR_ATH", "TRENDING_ENTRY", "FUNDING_EXTREME_LONG", "FUNDING_EXTREME_SHORT", "OPEN_INTEREST_SURGE", "DEX_NEW_POOL_TRACTION", "DEX_TRENDING_PUMP", "DEX_RUG_RISK", "NEWS_BULLISH", "NEWS_BEARISH", "NEW_LISTING", "LIQUIDATIONS_LONG", "LIQUIDATIONS_SHORT", "SOCIAL_BUZZ", "LEVERAGE_LONG", "LEVERAGE_SHORT", "SETUP_LONG", "SETUP_SHORT", "TREND_UP", "TREND_DOWN", "TREND_EXIT", "CONFLUENCE"];
export const ALL_SOURCES: IntelSource[] = ["coinbase", "binance", "exchanges", "coingecko", "trending", "derivatives", "dex", "news", "social", "leverage", "setup", "verdict"];
const KINDS = new Set<IntelKind>(ALL_KINDS);
const SOURCES = new Set<IntelSource>(ALL_SOURCES);
/** Leverage settings: indications (LONG / SHORT) and liquidations have their own rules. */
export function passesLeverage(l: LeveragePrefs, s: IntelSignal): boolean {
  if (!l.enabled) return false;
  if (l.includeCoins.length && !l.includeCoins.includes(s.coin)) return false;
  if (l.excludeCoins.includes(s.coin)) return false;
  if (s.kind === "LIQUIDATIONS_LONG" || s.kind === "LIQUIDATIONS_SHORT") {
    if (!l.liquidations) return false;
    const usd = Number(s.metrics.liquidatedUsd5m);
    return !Number.isFinite(usd) || usd >= l.minLiquidationUsd;
  }
  const bias = s.kind === "LEVERAGE_LONG" ? "LONG" : "SHORT";
  if (!l.biases.includes(bias)) return false;
  const score = Math.abs(Number(s.metrics.score));
  if (Number.isFinite(score) && score < l.minScore) return false;
  const lev = Number(s.metrics.maxLeverage);
  if (l.minMaxLeverage > 0 && !(Number.isFinite(lev) && lev >= l.minMaxLeverage)) return false;
  if (l.venues.length && !l.venues.includes(String(s.metrics.venue ?? ""))) return false;
  return true;
}

/** Kinds that go to the leverage channel when it exists. */
const LEVERAGE_KINDS = new Set<IntelKind>(["LEVERAGE_LONG", "LEVERAGE_SHORT", "LIQUIDATIONS_LONG", "LIQUIDATIONS_SHORT"]);
const LISTING_QUOTES = ["USDT", "USDC", "FDUSD"];

/** What goes to Discord — set from the site's Discord panel. */
export interface DiscordPrefs {
  enabled: boolean;
  minStrength: number;
  /** Only these kinds (empty = all). */
  kinds: string[];
  /** Only these sources (empty = all). */
  sources: string[];
  directions: Direction[];
  /** Only these coins (empty = all). */
  includeCoins: string[];
  excludeCoins: string[];
  /** Minimum measured 1 h reliability of the signal type (%), or null. Types not measured yet always pass. */
  minHitRate: number | null;
  /** Leveraged markets (LONG / SHORT indications and liquidations). */
  leverage: LeveragePrefs;
  /** Grouped sending, every channel: one message every `everyMin` min with up to `maxPerMessage` alerts. */
  batch: { enabled: boolean; everyMin: number; maxPerMessage: number };
  /**
   * "conseil": only real changes of opinion (trend verdicts), new listings and the « Point marché ».
   * "complet": every signal (contradictory alerts on a coin within 30 min are held back).
   */
  mode: "conseil" | "complet";
  /** « Point marché » (overview message) every `everyMin` min. */
  marketPoint: { enabled: boolean; everyMin: number };
  updatedAt: number | null;
}

export interface LeveragePrefs {
  enabled: boolean;
  /** |score| from which a LONG / SHORT indication is sent (the page shows it from 25). */
  minScore: number;
  biases: ("LONG" | "SHORT")[];
  /** Only markets offering at least this leverage (0 = all, including unknown). */
  minMaxLeverage: number;
  /** Only these venues (empty = all): "Coinbase International", "INTX", "Binance Futures"… */
  venues: string[];
  includeCoins: string[];
  excludeCoins: string[];
  /** Re-send when the score grows by this many points (0 = never). */
  strengthenStep: number;
  /** Re-send an unchanged indication after this many hours (0 = never). */
  remindHours: number;
  liquidations: boolean;
  /** Minimum liquidated amount in 5 min (USD) for a liquidation alert. */
  minLiquidationUsd: number;
}

export function defaultLeveragePrefs(): LeveragePrefs {
  return { enabled: true, minScore: 25, biases: ["LONG", "SHORT"], minMaxLeverage: 0, venues: [], includeCoins: [], excludeCoins: [], strengthenStep: 15, remindHours: 0, liquidations: true, minLiquidationUsd: 500_000 };
}

export function defaultPrefs(minStrength = 0): DiscordPrefs {
  return { enabled: true, minStrength, kinds: [], sources: [], directions: ["bullish", "bearish", "neutral"], includeCoins: [], excludeCoins: [], minHitRate: null, leverage: defaultLeveragePrefs(), batch: { enabled: true, everyMin: 5, maxPerMessage: 10 }, marketPoint: { enabled: true, everyMin: 60 }, mode: "conseil", updatedAt: null };
}

/** Validate prefs sent by the site (strict, bounded). */
export function sanitizePrefs(x: unknown, now: number): DiscordPrefs | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const list = (v: unknown, ok: (s: string) => boolean, max = 60) => (Array.isArray(v) ? [...new Set(v.filter((e): e is string => typeof e === "string" && ok(e)))].slice(0, max) : []);
  const coin = (c: string) => /^[A-Z0-9._-]{1,20}$/.test(c);
  const ms = Number(o.minStrength);
  const hr = o.minHitRate === null || o.minHitRate === undefined || o.minHitRate === "" ? null : Number(o.minHitRate);
  if (!Number.isFinite(ms) || ms < 0 || ms > 100) return null;
  if (hr !== null && (!Number.isFinite(hr) || hr < 0 || hr > 100)) return null;
  const dirs = list(o.directions, (d) => d === "bullish" || d === "bearish" || d === "neutral") as Direction[];
  const lv = (o.leverage && typeof o.leverage === "object" ? o.leverage : {}) as Record<string, unknown>;
  const d = defaultLeveragePrefs();
  const bounded = (v: unknown, lo: number, hi: number, def: number) => {
    const x = Number(v);
    return v === undefined || v === null || v === "" || !Number.isFinite(x) ? def : Math.max(lo, Math.min(hi, x));
  };
  const biases = list(lv.biases, (b) => b === "LONG" || b === "SHORT") as LeveragePrefs["biases"];
  const leverage: LeveragePrefs = {
    enabled: lv.enabled !== false,
    minScore: Math.round(bounded(lv.minScore, 5, 100, d.minScore)),
    biases: Array.isArray(lv.biases) ? biases : d.biases,
    minMaxLeverage: Math.round(bounded(lv.minMaxLeverage, 0, 200, d.minMaxLeverage)),
    venues: list(lv.venues, (v) => v.length <= 40, 10),
    includeCoins: list((lv.includeCoins as unknown[] | undefined)?.map((c) => String(c).trim().toUpperCase()), coin, 200),
    excludeCoins: list((lv.excludeCoins as unknown[] | undefined)?.map((c) => String(c).trim().toUpperCase()), coin, 200),
    strengthenStep: Math.round(bounded(lv.strengthenStep, 0, 100, d.strengthenStep)),
    remindHours: bounded(lv.remindHours, 0, 72, d.remindHours),
    liquidations: lv.liquidations !== false,
    minLiquidationUsd: Math.round(bounded(lv.minLiquidationUsd, 0, 1e9, d.minLiquidationUsd)),
  };
  const bt = (o.batch && typeof o.batch === "object" ? o.batch : {}) as Record<string, unknown>;
  const batch = { enabled: bt.enabled !== false, everyMin: Math.round(bounded(bt.everyMin, 1, 60, 5)), maxPerMessage: Math.round(bounded(bt.maxPerMessage, 1, 10, 10)) };
  const mp = (o.marketPoint && typeof o.marketPoint === "object" ? o.marketPoint : {}) as Record<string, unknown>;
  const marketPoint = { enabled: mp.enabled !== false, everyMin: [15, 30, 60, 120, 240].includes(Number(mp.everyMin)) ? Number(mp.everyMin) : 60 };
  return {
    leverage,
    batch,
    marketPoint,
    mode: o.mode === "complet" ? "complet" : "conseil",
    enabled: o.enabled !== false,
    minStrength: Math.round(ms),
    kinds: list(o.kinds, (k) => KINDS.has(k as IntelKind)),
    sources: list(o.sources, (k) => SOURCES.has(k as IntelSource)),
    directions: dirs.length ? dirs : ["bullish", "bearish", "neutral"],
    includeCoins: list((o.includeCoins as unknown[] | undefined)?.map((c) => String(c).trim().toUpperCase()), coin, 200),
    excludeCoins: list((o.excludeCoins as unknown[] | undefined)?.map((c) => String(c).trim().toUpperCase()), coin, 200),
    minHitRate: hr,
    updatedAt: now,
  };
}

/** What the "conseil" mode keeps: changes of opinion and new listings (plus the « Point marché »). */
export const CONSEIL_KINDS = new Set<IntelKind>(["TREND_UP", "TREND_DOWN", "TREND_EXIT", "NEW_LISTING"]);

export function passesPrefs(p: DiscordPrefs, s: IntelSignal, hitRate: number | null): boolean {
  if (!p.enabled) return false;
  // The leverage channel follows its own panel, in both modes.
  if (LEVERAGE_KINDS.has(s.kind)) return passesLeverage(p.leverage ?? defaultLeveragePrefs(), s);
  if ((p.mode ?? "conseil") === "conseil" && !CONSEIL_KINDS.has(s.kind)) return false;
  if (s.strength < p.minStrength) return false;
  if (p.kinds.length && !p.kinds.includes(s.kind)) return false;
  if (p.sources.length && !p.sources.includes(s.source)) return false;
  if (!p.directions.includes(s.direction)) return false;
  if (p.includeCoins.length && !p.includeCoins.includes(s.coin)) return false;
  if (p.excludeCoins.includes(s.coin)) return false;
  if (p.minHitRate !== null && hitRate !== null && hitRate < p.minHitRate) return false;
  return true;
}

interface Channel {
  id: "bullish" | "bearish" | "general" | "leverage" | "market";
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
  filteredByPrefs?: number;
  sent24h?: unknown;
  market?: unknown;
  binance?: unknown;
  sources: Record<string, string>;
  errors: string[];
  relay: { configured: boolean; received: number; lastAt: number | null; rejected?: number };
  config: { siteUrl: string | null; webhookConfigured: boolean; minStrength: number };
  discord: unknown;
}

/** Constant-time string comparison (relay key). */
function sameSecret(a: string, b: string): boolean {
  // Constant time, and the length of the secret is not revealed either.
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

/** Wrong relay code: answer after a short pause (slows down guessing). */
const denied = async () => {
  await new Promise((r) => setTimeout(r, 400));
  return Response.json({ ok: false, error: "code de relais incorrect" }, { status: 401 });
};

/** Read a request body without trusting Content-Length (chunked bodies are capped too). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) (all.set(c, o), (o += c.byteLength));
  return new TextDecoder().decode(all);
}

/**
 * Fate of a signal on Discord: sent (queued to a channel), dup (the same event from the same source was
 * sent less than 30 min ago), filtered (Discord settings), cold (bot warming up), nochannel, or refused:<reason>.
 */
export type DiscordMark = "sent" | "dup" | "flip" | "conseil" | "filtered" | "cold" | "nochannel" | `refused:${string}`;

/** Why a relayed signal was refused (counted and shown on the site). */
export type RelayReject = "format" | "type" | "sens" | "force" | "trop ancien" | "déjà envoyé" | "trop de signaux";

/** Links kept in relayed signals: exchanges, data sites and the news feeds the site reads. */
const RELAY_LINK_HOSTS = /(^|\.)(binance\.com|coinbase\.com|okx\.com|kucoin\.com|mexc\.com|gate\.io|gate\.com|bybit\.com|coingecko\.com|geckoterminal\.com|dexscreener\.com|tradingview\.com|reddit\.com|coindesk\.com|cointelegraph\.com|decrypt\.co|theblock\.co|bitcoinmagazine\.com|cryptoast\.fr|journalducoin\.com)$/i;
/** Relayed signals accepted per 10 minutes (a flood from a hijacked page cannot drown Discord). */
export const RELAY_CAP_10MIN = 600;

/** Plain text only: no clickable [text](url) and no bare links inside titles or reasons. */
const plain = (t: string) => t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/gi, "").replace(/[<>]/g, "").replace(/\s{2,}/g, " ").trim();

/**
 * Validate a relayed signal: strict shape, bounded sizes (long texts are cut,
 * not refused), and a timestamp within 45 min (the site keeps a backlog while
 * it cannot send; a phone clock can also be a little off).
 */
export function sanitizeRelayed(x: unknown, now: number): IntelSignal | RelayReject {
  if (!x || typeof x !== "object") return "format";
  const s = x as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim().length > 0 ? v.slice(0, max) : null);
  const id = typeof s.id === "string" && s.id.length > 0 && s.id.length <= 80 ? s.id : null;
  const coin = typeof s.coin === "string" ? s.coin.trim().toUpperCase().slice(0, 24) : "";
  const title = typeof s.title === "string" ? str(plain(s.title), 256) : null;
  if (!id || !coin || !/^[\p{L}\p{N}._$-]+$/u.test(coin) || !title) return "format";
  if (!KINDS.has(s.kind as IntelKind) || !SOURCES.has(s.source as IntelSource)) return "type";
  // The official trend verdict is the bot's own (one opinion, not one per open page).
  if (s.source === "verdict" || String(s.kind).startsWith("TREND_")) return "type";
  if (s.direction !== "bullish" && s.direction !== "bearish" && s.direction !== "neutral") return "sens";
  const strength = Number(s.strength);
  const ts = Number(s.ts);
  if (!Number.isFinite(strength) || strength < 0 || strength > 100) return "force";
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 45 * 60_000) return "trop ancien";
  const url = (() => {
    if (typeof s.url !== "string" || !/^https:\/\/[^\s]{1,500}$/.test(s.url)) return null;
    try {
      return RELAY_LINK_HOSTS.test(new URL(s.url).hostname) ? s.url : null;
    } catch {
      return null;
    }
  })();
  const priceUsd = typeof s.priceUsd === "number" && Number.isFinite(s.priceUsd) ? s.priceUsd : null;
  const reasons = Array.isArray(s.reasons) ? s.reasons.filter((r): r is string => typeof r === "string").slice(0, 10).map((r) => plain(r).slice(0, 300)).filter(Boolean) : [];
  const metrics: Record<string, number | string | null> = {};
  if (s.metrics && typeof s.metrics === "object")
    for (const [k, v] of Object.entries(s.metrics as Record<string, unknown>).slice(0, 25))
      if (/^[A-Za-z0-9_]{1,40}$/.test(k) && ((typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 80) || v === null)) metrics[k] = v as number | string | null;
  return { id: `site-${id}`, ts, coin, coinName: str(s.coinName, 80), kind: s.kind as IntelKind, direction: s.direction, source: s.source as IntelSource, strength: Math.round(strength), title, reasons, metrics, priceUsd, url };
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
    binanceHost: number;
    /** What happened to each recent signal on Discord (shown next to it on the site). */
    marks: Map<string, { st: DiscordMark; at: number }>;
    /** Last direction sent per coin (anti-contradiction). */
    lastDir: Map<string, { dir: Direction; ts: number }>;
    binanceDiag: { host: string | null; okAt: number | null; lastError: string | null; webError?: string | null; tried: Record<string, string> };
    /** Since when no Binance access works (null = it works), and when the Discord warning was last sent. */
    binanceDownSince: number | null;
    binanceAlertAt: number;
    coinbaseBackoffUntil: number;
    /** coin:kind → last sent (shared by the bot's own signals and the site's relayed ones). */
    seen: Map<string, number>;
    prefs: DiscordPrefs;
    recentSent: { ts: number; dir: Direction; kind: IntelKind; coin: string; channel: string; src?: string }[];
    listings: { cb: Set<string>; cbCoins: Set<string>; bn: Set<string>; seededCb: boolean; seededBn: boolean };
    lsBackoffUntil: number;
    stage: number;
    lastCycleAt: number | null;
    exchangeTurn: number;
    setupTurn: number;
    lastPointAt: number;
    btcTrend: { value: number | null; at: number };
    exchangeBackoff: Partial<Record<ExchangeId, number>>;
    exchangeHist: Partial<Record<ExchangeId, BinanceRestHistory>>;
    flow: Map<string, number>;
    filtered: number;
    channels: Channel[];
    warm: boolean;
    welcomed: Set<string>;
    lastFullRunAt: number | null;
    relay: { received: number; lastAt: number | null; rejected?: number };
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
      if (!sameSecret(req.headers.get("x-relay-key") ?? "", key)) return denied();
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ ok: false, error: "json invalide" }, { status: 400 });
      }
      return Response.json(await this.run(() => this.relay(body)));
    }
    if (path === "/prefs") {
      if (req.method === "POST") {
        const key = this.env.RELAY_KEY?.trim();
        if (!key) return Response.json({ ok: false, error: "RELAY_KEY non configurée sur le worker" }, { status: 503 });
        if (!sameSecret(req.headers.get("x-relay-key") ?? "", key)) return denied();
        const p = sanitizePrefs(await req.json().catch(() => null), Date.now());
        if (!p) return Response.json({ ok: false, error: "réglages invalides" }, { status: 400 });
        return Response.json(
          await this.run(async () => {
            const L = await this.load();
            L.prefs = p;
            for (const c of L.channels) c.n.setBatch(p.batch.enabled ? p.batch : null);
            await this.state.storage.put({ prefs: p });
            return { ok: true, prefs: p };
          }),
        );
      }
      const L = await this.run(() => this.load());
      return Response.json({ prefs: L.prefs, kinds: ALL_KINDS, sources: ALL_SOURCES, channels: L.channels.map((c) => ({ id: c.id, label: c.label, directions: c.directions, active: c.n.active })) });
    }
    if (path === "/test-channels" && req.method === "POST") {
      const key = this.env.RELAY_KEY?.trim();
      if (!key) return Response.json({ ok: false, error: "RELAY_KEY non configurée sur le worker" }, { status: 503 });
      if (!sameSecret(req.headers.get("x-relay-key") ?? "", key)) return denied();
      return Response.json(
        await this.run(async () => {
          const L = await this.load();
          const results = [];
          for (const c of L.channels) {
            const what = c.id === "market" ? "état du marché (toutes les heures)" : c.id === "leverage" ? "marchés à levier (long/short, liquidations)" : c.directions.map((d) => (d === "bullish" ? "haussiers 🟢" : d === "bearish" ? "baissiers 🔴" : "neutres ⚪")).join(" + ");
            const r = c.n.active ? await c.n.test(`🧪 **Test** depuis le panneau Discord du site : ce salon reçoit les signaux ${what}.`) : { ok: false, message: c.n.view().lastError ?? "webhook invalide" };
            results.push({ channel: c.label, ok: r.ok, message: r.message });
          }
          const missing = [
            !this.env.DISCORD_WEBHOOK_BULLISH && "DISCORD_WEBHOOK_BULLISH (salon haussier)",
            !this.env.DISCORD_WEBHOOK_BEARISH && "DISCORD_WEBHOOK_BEARISH (salon baissier)",
            !this.env.DISCORD_WEBHOOK_NEUTRAL && !this.env.DISCORD_WEBHOOK_URL && "DISCORD_WEBHOOK_NEUTRAL (salon neutre)",
            !this.env.DISCORD_WEBHOOK_LEVERAGE && "DISCORD_WEBHOOK_LEVERAGE (salon levier)",
            !this.env.DISCORD_WEBHOOK_MARKET && "DISCORD_WEBHOOK_MARKET (salon état du marché, facultatif)",
          ].filter(Boolean);
          return { ok: true, results, missing };
        }),
      );
    }
    if (path === "/stats") {
      const L = await this.run(() => this.load());
      return Response.json(L.svc.performance({}));
    }
    if (path === "/signals") {
      const since = Number(new URL(req.url).searchParams.get("since") ?? 0) || Date.now() - 3 * 3_600_000;
      const L = await this.run(() => this.load());
      return Response.json({ signals: L.svc.engine.recentSignals({ since, limit: 1500 }).map((x) => ({ ...x, hitRate1h: L.svc.hitRateOf(x), discord: L.marks.get(x.id)?.st ?? null })) });
    }
    if (path === "/verdicts") return Response.json((await this.state.storage.get("verdictBoard")) ?? { at: null, count: 0, verdicts: [] });
    if (path === "/setups") return Response.json((await this.state.storage.get("setupBoard")) ?? { at: null, count: 0, setups: [] });
    if (path === "/leverage") return Response.json((await this.state.storage.get("leverageBoard")) ?? { at: null, markets: [], context: null });
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
    // Everything the engine detects is sent, one notification per signal. The only strength filter is the
    // one of the Discord settings panel. DISCORD_MIN_STRENGTH (old setting) is ignored: it acted as a second,
    // hidden threshold that silently dropped the weaker signals — most of Binance's.
    void minStrength;
    const cfg = IntelConfigSchema.parse({
      discord: {
        minStrength: 0,
        directions: ["bullish", "bearish", "neutral"],
        perCoinCooldownMin: 0,
        digestMin: 0,
        maxMessagesPerHour: 5000,
        onePerMessage: true,
        ...(role && /^\d+$/.test(role) ? { mentionRoleId: role } : {}),
      },
    });
    const meta = (await st.get<{ warm?: boolean; welcomed?: string[]; lastFullRunAt?: number; relay?: { received: number; lastAt: number | null; rejected?: number }; sentLog?: number[]; seen?: Record<string, number>; stage?: number; lastCycleAt?: number | null; exchangeTurn?: number; setupTurn?: number; lastPointAt?: number; binanceHost?: number; binanceDownSince?: number | null; binanceAlertAt?: number; marks?: Record<string, { st: DiscordMark; at: number }> }>("meta")) ?? {};

    // Channel routing: one webhook per direction when configured, the general webhook for the rest,
    // and an optional leverage channel that takes the leveraged-market kinds.
    const bull = env.DISCORD_WEBHOOK_BULLISH?.trim() || null;
    const bear = env.DISCORD_WEBHOOK_BEARISH?.trim() || null;
    const general = env.DISCORD_WEBHOOK_NEUTRAL?.trim() || env.DISCORD_WEBHOOK_URL?.trim() || null;
    const lev = env.DISCORD_WEBHOOK_LEVERAGE?.trim() || null;
    const specs: { id: Channel["id"]; label: string; url: string | null; directions: Channel["directions"] }[] = [
      // Without a general channel, neutral signals (a move that can break either way) go to both.
      { id: "bullish", label: "haussier", url: bull, directions: general ? ["bullish"] : ["bullish", "neutral"] },
      { id: "bearish", label: "baissier", url: bear, directions: general ? ["bearish"] : ["bearish", "neutral"] },
      { id: "general", label: bull && bear ? "neutre" : "général", url: general, directions: cfg.discord.directions.filter((d) => !(d === "bullish" && bull) && !(d === "bearish" && bear)) },
      { id: "leverage", label: "levier", url: lev, directions: ["bullish", "bearish", "neutral"] },
      { id: "market", label: "état du marché", url: env.DISCORD_WEBHOOK_MARKET?.trim() || null, directions: [] },
    ];
    const savedDiscord = ((await st.get<Record<string, unknown>>("discord")) ?? {}) as Record<string, unknown>;
    const errorsSink = (label: string) => (e: { level: string; message: string }) => {
      if (e.level === "warn" || e.level === "error") this.errors.push(`Discord ${label} : ${e.message}`);
    };
    const channels: Channel[] = specs
      .filter((c) => c.url && (c.directions.length || c.id === "market"))
      .map((c) => {
        const n = new DiscordNotifier({ webhookUrl: c.url, cfg: { ...cfg.discord, directions: c.directions }, fetchText, log: errorsSink(c.label), hitRateOf: (s) => this.loaded?.svc.hitRateOf(s) ?? null, siteUrl: (env.SITE_URL ?? "").trim() || null, now: () => this.clock });
        // Old single-channel state (v1) belongs to the general channel.
        n.importState((savedDiscord[c.id] ?? (c.id === "general" && "lastCoinAt" in savedDiscord ? savedDiscord : undefined)) as never);
        return { id: c.id, label: c.label, directions: c.directions, n };
      });
    const storedPrefs = (await st.get<Partial<DiscordPrefs>>("prefs")) ?? {};
    const batch = { ...defaultPrefs().batch, ...(storedPrefs.batch ?? {}) };
    for (const c of channels) c.n.setBatch(batch.enabled ? batch : null);

    const loaded = {
      cfg,
      channels,
      history: new CoinbasePriceHistory((await st.get("cb")) ?? null),
      binance: new BinanceRestHistory(cfg.binance.quotes, (await st.get("bn")) ?? null),
      binanceBackoffUntil: 0,
      binanceHost: meta.binanceHost ?? 0,
      marks: new Map(Object.entries(meta.marks ?? {})),
      lastDir: new Map(),
      binanceDiag: { host: null, okAt: null, lastError: null, webError: null, tried: {} } as { host: string | null; okAt: number | null; lastError: string | null; webError?: string | null; tried: Record<string, string> },
      binanceDownSince: meta.binanceDownSince ?? null,
      binanceAlertAt: meta.binanceAlertAt ?? 0,
      coinbaseBackoffUntil: 0,
      seen: new Map(Object.entries(meta.seen ?? {})),
      prefs: { ...defaultPrefs(0), ...storedPrefs, batch, marketPoint: { ...defaultPrefs().marketPoint, ...(storedPrefs.marketPoint ?? {}) }, leverage: { ...defaultLeveragePrefs(), ...((await st.get<Partial<DiscordPrefs>>("prefs"))?.leverage ?? {}) } },
      recentSent: (await st.get<{ ts: number; dir: Direction; kind: IntelKind; coin: string; channel: string }[]>("recentSent")) ?? [],
      listings: (() => {
        return { cb: new Set<string>(), cbCoins: new Set<string>(), bn: new Set<string>(), seededCb: false, seededBn: false };
      })(),
      lsBackoffUntil: 0,
      stage: meta.stage ?? 0,
      lastCycleAt: meta.lastCycleAt ?? meta.lastFullRunAt ?? null,
      exchangeTurn: meta.exchangeTurn ?? 0,
      setupTurn: meta.setupTurn ?? 0,
      lastPointAt: meta.lastPointAt ?? 0,
      btcTrend: { value: null, at: 0 },
      exchangeBackoff: {} as Partial<Record<ExchangeId, number>>,
      exchangeHist: {} as Partial<Record<ExchangeId, BinanceRestHistory>>,
      flow: new Map<string, number>(),
      filtered: 0,
      warm: !!meta.warm,
      welcomed: new Set(meta.welcomed ?? []),
      lastFullRunAt: meta.lastFullRunAt ?? null,
      relay: meta.relay ?? { received: 0, lastAt: null, rejected: 0 },
      sentLog: (meta.sentLog ?? []).filter((t) => t > Date.now() - 86_400_000),
      svc: null as unknown as IntelService,
    };
    loaded.svc = new IntelService({
      cfg,
      log: () => {},
      // Until the first full pass is done, learn silently (no burst of alerts on what already moves).
      notifier: {
        consider: (s) => {
          if (!loaded.warm) {
            loaded.marks.set(s.id, { st: "cold", at: Date.now() });
            return;
          }
          this.dispatch(s);
        },
        view: () => channels[0]?.n.view() ?? null,
      },
      enabledSources: ["binance", "coinbase", "exchanges", "coingecko", "trending", "derivatives", "dex", "news", "social", "leverage", "setup", "verdict"],
      now: () => this.clock,
    });
    loaded.svc.restore(await st.get<IntelSavedState>("intel"));
    loaded.svc.tracker.importState((await st.get<never[]>("tracker")) ?? []);
    // v2: the old version remembered LONG / SHORT setups without alerting them (warm-up, ±40 threshold):
    // forget them once so every current setup is sent.
    if (!(await st.get<boolean>("levReset2"))) {
      loaded.svc.resetLeverageBias();
      await st.put({ levReset2: true });
    }
    const li = await st.get<{ cb: string[]; cbCoins: string[]; bn: string[]; seededCb: boolean; seededBn: boolean }>("listings");
    if (li) loaded.listings = { cb: new Set(li.cb), cbCoins: new Set(li.cbCoins), bn: new Set(li.bn), seededCb: li.seededCb, seededBn: li.seededBn };
    this.loaded = loaded;
    return loaded;
  }

  private errors: string[] = [];

  /**
   * Send one signal to its channel(s). The same event (coin × type) seen by
   * both the site and the bot within 30 min is sent once.
   */
  private dispatch(s: IntelSignal): DiscordMark {
    const L = this.loaded;
    if (!L) return "cold";
    const mark = (st: DiscordMark): DiscordMark => {
      L.marks.set(s.id, { st, at: this.clock });
      if (L.marks.size > 4000) for (const k of [...L.marks.keys()].slice(0, 1000)) L.marks.delete(k);
      return st;
    };
    // Per source: Binance and Coinbase seeing the same move are both sent; the same source twice is not.
    const key = `${s.coin}:${s.kind}:${s.direction}:${s.source}`;
    const last = L.seen.get(key);
    if (last !== undefined && this.clock - last < 30 * 60_000) return mark("dup");
    L.seen.set(key, this.clock);
    // Opposite alert on the same coin less than 30 min after the last one sent: held back unless strong.
    if (s.direction !== "neutral" && !CONSEIL_KINDS.has(s.kind) && !LEVERAGE_KINDS.has(s.kind)) {
      const lastDir = L.lastDir.get(s.coin);
      if (lastDir && lastDir.dir !== s.direction && this.clock - lastDir.ts < 30 * 60_000 && s.strength < 75) return mark("flip");
    }
    if (!passesPrefs(L.prefs, s, L.svc.hitRateOf(s))) {
      L.filtered++;
      return mark((L.prefs.mode ?? "conseil") === "conseil" && !CONSEIL_KINDS.has(s.kind) && !LEVERAGE_KINDS.has(s.kind) ? "conseil" : "filtered");
    }
    this.signalsThisRun++;
    L.sentLog.push(this.clock);
    if (s.direction !== "neutral") L.lastDir.set(s.coin, { dir: s.direction, ts: this.clock });
    const lev = L.channels.find((c) => c.id === "leverage");
    const note = (channel: string) => {
      L.recentSent.push({ ts: this.clock, dir: s.direction, kind: s.kind, coin: s.coin, channel, src: s.source });
      if (L.recentSent.length > 400) L.recentSent.splice(0, L.recentSent.length - 400);
    };
    if (lev && LEVERAGE_KINDS.has(s.kind)) {
      lev.n.consider(s);
      note(lev.label);
      return mark("sent");
    }
    const targets = L.channels.filter((c) => c.id !== "leverage" && c.directions.includes(s.direction));
    for (const c of targets) {
      c.n.consider(s.direction === "neutral" && c.id !== "general" ? { ...s, title: `⚪ ${s.title}`.slice(0, 256) } : s);
      note(c.label);
    }
    // Nowhere to go (e.g. only a leverage channel): the leverage channel gets it rather than nothing.
    if (!targets.length && lev) {
      lev.n.consider(s);
      note(lev.label);
    }
    if (!targets.length && !lev) {
      note("aucun salon");
      return mark("nochannel");
    }
    return mark("sent");
  }

  /** New pairs / coins compared with everything seen before (the first pass only learns). */
  private listingCandidates(exchange: "coinbase" | "binance", pairs: { pair: string; coin: string }[]): Candidate[] {
    const L = this.loaded as NonNullable<RadarState["loaded"]>;
    const known = exchange === "coinbase" ? L.listings.cb : L.listings.bn;
    const seeded = exchange === "coinbase" ? L.listings.seededCb : L.listings.seededBn;
    const coinsBefore = exchange === "coinbase" ? new Set(L.listings.cbCoins) : new Set([...L.listings.bn].map((p) => this.baseOf(p)));
    const out: Candidate[] = [];
    for (const { pair, coin } of pairs) {
      if (known.has(pair)) continue;
      known.add(pair);
      if (exchange === "coinbase") L.listings.cbCoins.add(coin);
      if (!seeded) continue;
      const newCoin = !coinsBefore.has(coin);
      coinsBefore.add(coin);
      const where = exchange === "coinbase" ? "Coinbase" : "Binance";
      out.push({
        coin,
        coinName: null,
        kind: "NEW_LISTING",
        direction: "bullish",
        source: exchange,
        strength: newCoin ? 85 : 55,
        title: newCoin ? `🆕 ${coin} arrive sur ${where} (${pair})` : `${coin} : nouvelle paire ${pair} sur ${where}`,
        reasons: newCoin ? [`nouvelle crypto cotée sur ${where}`, "une cotation sur une grande plateforme provoque souvent une forte hausse… et parfois une chute juste après", "vérifie le projet avant tout achat"] : [`nouvelle paire de cotation sur ${where}`, "plus de liquidité et d'accès pour cette crypto"],
        metrics: { pair, exchange: where },
        priceUsd: null,
        url: exchange === "coinbase" ? `https://www.coinbase.com/advanced-trade/spot/${pair}` : `https://www.binance.com/en/trade/${pair}`,
      });
    }
    if (exchange === "coinbase") L.listings.seededCb = true;
    else L.listings.seededBn = true;
    return out;
  }

  private baseOf(symbol: string): string {
    const q = LISTING_QUOTES.find((x) => symbol.endsWith(x) && symbol.length > x.length);
    return q ? symbol.slice(0, -q.length) : symbol;
  }

  /** Outgoing requests left in this run (Cloudflare free plan: 50 per run; a margin is kept). */
  private budget = REQUEST_BUDGET;
  /** Relayed signals accepted recently (cap per 10 min). */
  private relayTimes: number[] = [];
  private lastGetError: string | null = null;

  private async get(label: string, url: string, silent = false): Promise<string | null> {
    // Keep room for Discord: data requests stop when only the Discord reserve is left.
    if (this.budget <= DISCORD_RESERVE) {
      this.lastGetError = "reporté (limite de requêtes de ce passage)";
      if (!silent) this.errors.push(`${label} : ${this.lastGetError}`);
      return null;
    }
    this.budget--;
    try {
      const r = await fetchText(url, { timeoutMs: 25_000, headers: { accept: "application/json, application/xml;q=0.9, */*;q=0.5" } });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}${r.headers.get("x-upstream-status") ? ` (amont ${r.headers.get("x-upstream-status")})` : ""}`);
      return r.text;
    } catch (err) {
      this.lastGetError = (err as Error).message;
      if (!silent) this.errors.push(`${label} : ${this.lastGetError}`);
      return null;
    }
  }

  /**
   * GET on Binance, starting with the host that worked last; up to 3 hosts per run. A refusal
   * (451 / 403 / 418 / 429 / network) moves to the next host, which is remembered when it answers.
   */
  private async binanceGet(L: NonNullable<RadarState["loaded"]>, path: string): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const base = BINANCE_HOSTS[L.binanceHost % BINANCE_HOSTS.length] as string;
      const text = await this.get(`Binance ${base.replace("https://", "")}`, `${base}${path}`, true);
      if (text !== null && text.trimStart().startsWith("[")) {
        L.binanceDiag = { ...L.binanceDiag, host: base, okAt: this.clock, lastError: null, tried: {} };
        return text;
      }
      const why = text !== null ? "réponse inattendue" : (this.lastGetError ?? "sans réponse");
      if (/limite de requêtes/.test(why)) return null; // out of budget for this run, not a refusal
      L.binanceDiag.lastError = `${base.replace("https://", "")} : ${why}`;
      L.binanceDiag.tried[base] = why;
      L.binanceHost = (L.binanceHost + 1) % BINANCE_HOSTS.length;
    }
    return null;
  }

  private async scan(): Promise<Status> {
    const t0 = Date.now();
    this.clock = t0;
    const now = t0;
    this.errors = [];
    this.signalsThisRun = 0;
    this.budget = REQUEST_BUDGET;
    const L = await this.load();
    const svc = L.svc;
    const sources: Record<string, string> = {};
    const site = (this.env.SITE_URL ?? "").trim().replace(/\/+$/, "");
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

    // ── The slow sources (every 5 min) are split into 3 steps, one per run, to stay under the
    // Cloudflare limit of 50 outgoing requests per run (Discord messages included).
    if (L.stage === 0 && (L.lastCycleAt === null || now - L.lastCycleAt >= FULL_MS - 10_000)) {
      L.stage = 1;
      L.lastCycleAt = now;
    }
    const stage = L.stage;

    // Step 1: CoinGecko markets (names for news matching, USD prices), trending, derivatives, DEX.
    if (stage === 1) {
      if (site) {
        let n = 0;
        for (let page = 1; page <= 3; page++) {
          const rows = arr<CgMarketRow>(await this.get(`CoinGecko marchés p${page}`, `${site}/api/cg/coins/markets?page=${page}`), CgMarketRowSchema);
          n += rows.length;
          if (rows.length) svc.onMarkets(rows, page, now);
        }
        sources.coingecko = `${n} cryptos`;
        const tr = await this.get("Tendances", `${site}/api/cg/search/trending`);
        if (tr) {
          const t = CgTrendingSchema.safeParse(JSON.parse(tr));
          if (t.success) {
            svc.onTrending(t.data.coins.map((c, i) => ({ id: c.item.id, symbol: c.item.symbol, name: c.item.name, rank: i, marketCapRank: c.item.market_cap_rank })), now, trendingCategories(t.data));
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
      } else this.errors.push("SITE_URL non configurée : CoinGecko et actualités ignorés (seuls les prix des plateformes sont analysés)");
    }

    // Every run: Binance (all pairs), 5 / 15 min moves and 24 h breakouts (weight 80 / call).
    // 1) the official API (8 hosts in turn), 2) else Binance's website product list (another network).
    {
      let tickers: BinanceMiniRestTicker[] = [];
      let via: string | null = null;
      let apiBase: string | null = null;
      let apiNote = "";
      if (now >= L.binanceBackoffUntil) {
        const text = await this.binanceGet(L, "/api/v3/ticker/24hr?type=MINI&symbolStatus=TRADING");
        tickers = text ? arr<BinanceMiniRestTicker>(text, BinanceMiniRestTickerSchema) : [];
        if (tickers.length) {
          apiBase = BINANCE_HOSTS[L.binanceHost % BINANCE_HOSTS.length] as string;
          via = apiBase.replace("https://", "");
        } else {
          // After a full turn of refusals, the API is left alone for 10 min.
          const allRefused = Object.keys(L.binanceDiag.tried).length >= BINANCE_HOSTS.length;
          L.binanceBackoffUntil = now + (allRefused ? 10 * 60_000 : 20_000);
          if (allRefused) L.binanceDiag.tried = {};
          apiNote = `API refusée (${L.binanceDiag.lastError ?? "sans réponse"})`;
        }
      } else apiNote = `API en pause jusqu'à ${new Date(L.binanceBackoffUntil).toISOString().slice(11, 16)} UTC (${L.binanceDiag.lastError ?? "refus"})`;
      if (!tickers.length) {
        const w = await this.get("Binance (site web)", BINANCE_WEB_PRODUCTS_URL, true);
        try {
          tickers = w ? parseBinanceWebProducts(JSON.parse(w), now) : [];
        } catch {
          tickers = [];
        }
        if (tickers.length) via = "binance.com (site web)";
        else L.binanceDiag.webError = w === null ? (this.lastGetError ?? "sans réponse") : "réponse illisible";
      }
      if (tickers.length && via) {
        L.binanceDiag.okAt = now;
        L.binanceDiag.host = via;
        L.binanceDownSince = null;
        if (apiBase) L.binanceDiag.lastError = null;
        // Buy / sell flow for the coins that are moving (klines 1 min, API only: taker-buy share of the volume).
        if (apiBase) {
          const movers = L.binance
            .preview(tickers, now)
            .filter((x) => Math.abs(x.change5m ?? 0) >= L.cfg.binance.pumpPct5m * 0.5 || Math.abs(x.change15m ?? 0) >= L.cfg.binance.pumpPct15m * 0.5)
            .sort((a, b) => Math.abs(b.change5m ?? 0) - Math.abs(a.change5m ?? 0))
            .slice(0, 4);
          for (const m of movers) {
            const k = await this.get(`Flux ${m.pair}`, `${apiBase}/api/v3/klines?symbol=${m.pair}&interval=1m&limit=5`, true);
            if (!k) continue;
            try {
              const rows = JSON.parse(k) as unknown[][];
              const q = rows.reduce((a, r) => a + Number(r[7]), 0);
              const tb = rows.reduce((a, r) => a + Number(r[10]), 0);
              if (q > 0 && Number.isFinite(tb)) L.flow.set(m.coin, tb / q);
            } catch {
              // ignore a malformed answer
            }
          }
        }
        svc.onBinanceTickers(tickers, L.binance, now, L.flow);
        const pairs = tickers.map((t) => ({ pair: t.symbol, coin: this.baseOf(t.symbol) })).filter((x) => x.coin !== x.pair);
        svc.ingestExternal(this.listingCandidates("binance", pairs), now);
        sources.binance = `${L.binance.pick(tickers, now).length} cryptos via ${via}${apiNote ? ` · ${apiNote}` : ""}`;
      } else {
        L.binanceDownSince ??= now;
        L.binanceDiag.host = null;
        sources.binance = `refusé : ${apiNote} · site web : ${L.binanceDiag.webError ?? "refusé"} → Coinbase et les autres plateformes prennent le relais`;
        this.errors.push(`Binance : ${apiNote} · site web : ${L.binanceDiag.webError ?? "refusé"}`);
      }
    }

    // Every run: Coinbase (every listed crypto, one call).
    if (now >= L.coinbaseBackoffUntil) {
      const text = await this.get("Coinbase", "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT");
      if (text) {
        const products: Product[] = parseProductsPage(JSON.parse(text)).products;
        if (products.length) {
          svc.onCoinbaseProducts(products, L.history, now);
          const online = products.filter((p) => p.status === "online" && !p.flags.tradingDisabled);
          svc.ingestExternal(this.listingCandidates("coinbase", online.map((p) => ({ pair: p.productId, coin: p.baseCurrency }))), now);
          sources.coinbase = `${CoinbasePriceHistory.pick(products).length} cryptos`;
        }
      } else L.coinbaseBackoffUntil = now + (this.errors.some((e) => e.startsWith("Coinbase : HTTP 429")) ? 90_000 : 40_000);
    }

    // Every run: one other exchange in turn (OKX, KuCoin, MEXC → each every minute).
    {
      const ex = EXCHANGES[L.exchangeTurn % EXCHANGES.length] as ExchangeId;
      L.exchangeTurn++;
      if (now >= (L.exchangeBackoff[ex] ?? 0)) {
        const text = await this.get(EXCHANGE_NAME[ex], EXCHANGE_TICKER_URLS[ex]);
        if (text) {
          try {
            const tickers = parseExchangeTickers(ex, JSON.parse(text), now);
            if (tickers.length) {
              svc.onExchangeTickers(ex, tickers, (L.exchangeHist[ex] ??= new BinanceRestHistory(["USDT"])), now);
              sources[ex] = `${tickers.length} paires`;
            } else this.errors.push(`${EXCHANGE_NAME[ex]} : réponse vide`);
          } catch {
            this.errors.push(`${EXCHANGE_NAME[ex]} : réponse illisible`);
          }
        } else L.exchangeBackoff[ex] = now + 10 * 60_000;
      }
    }

    // Step 2: news and Reddit (through the site's cache).
    if (stage === 2 && site) {
      const list = await this.get("Actualités", `${site}/api/news`);
      let items = 0;
      if (list) {
        for (const f of (JSON.parse(list) as { feeds: { id: string; name: string; kind?: string }[] }).feeds) {
          const xml = await this.get(`Actu ${f.name}`, `${site}/api/news/${encodeURIComponent(f.id)}`);
          const parsed = xml ? parseFeed(xml) : [];
          items += parsed.length;
          if (!parsed.length) continue;
          if (f.kind === "social") svc.onSocial(f.name, parsed, now);
          else svc.onNews(f.name, parsed, now);
        }
      }
      sources.news = `${items} articles`;
    }

    // Step 3: leveraged markets (Coinbase, Coinbase International…) + Binance long/short ratio.
    if (stage === 3) {
      const perpLoad = await loadPerpMarkets(async (url) => {
        const t = await this.get("Marchés à levier", url, true);
        if (t === null) throw new Error(this.lastGetError ?? "indisponible");
        return t;
      }, () => svc.perpsFromDerivatives());
      // The loader reports its own failures: do not count them twice.
      this.errors = this.errors.filter((e) => !e.startsWith("Marchés à levier :"));
      svc.setPerpDiagnostics(perpLoad.sources, perpLoad.errors, now);
      if (!perpLoad.markets.length) this.errors.push(`Marchés à levier : ${perpLoad.errors.join(" · ")}`);
      if (perpLoad.markets.length) {
        const markets = perpLoad.markets;
        const extras = new Map<string, { takerBuyRatio?: number | null; longShortRatio?: number | null }>();
        for (const m of markets) extras.set(m.coin, { takerBuyRatio: L.flow.get(m.coin) ?? null });
        if (now >= L.lsBackoffUntil) {
          const top = [...new Set(markets.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)).map((m) => m.coin))].slice(0, 10);
          for (const coin of top) {
            const t = await this.get(`Long/short ${coin}`, `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin}USDT&period=5m&limit=1`);
            if (!t) {
              if (this.errors.some((e) => /^Long\/short .* HTTP (451|403)/.test(e))) {
                L.lsBackoffUntil = now + 30 * 60_000;
                break;
              }
              continue;
            }
            try {
              const r = (JSON.parse(t) as { longShortRatio?: string }[])[0];
              const v = Number(r?.longShortRatio);
              if (Number.isFinite(v)) extras.set(coin, { ...extras.get(coin), longShortRatio: v });
            } catch {
              // ignore
            }
          }
          // A missing futures listing (400) is normal for small coins: keep only real problems visible.
          this.errors = this.errors.filter((e) => !/^Long\/short .* HTTP (400|404)/.test(e));
        }
        svc.setLeverageAlertRules(L.prefs.leverage);
        svc.onPerps(markets, extras, now, L.warm);
        sources.leverage = `${markets.length} marchés (${perpLoad.sources.join(", ")})`;
      }
    }

    // Every run: trader setups on a few coins in turn (1 request each), with what is left of the budget.
    {
      const coins = svc.setupUniverse(60);
      let done = 0;
      const refreshBtc = now - L.btcTrend.at > 15 * 60_000;
      const queue = refreshBtc ? ["BTC"] : [];
      while (queue.length < 4 && coins.length) queue.push(coins[L.setupTurn++ % coins.length] as string);
      for (const coin of [...new Set(queue)]) {
        if (this.budget <= DISCORD_RESERVE + 3) break;
        try {
          const r = await runSetup(
            async (url) => {
              const t = await this.get(`Setup ${coin}`, url, true);
              if (t === null) throw new Error(this.lastGetError ?? "indisponible");
              return t;
            },
            svc,
            coin,
            { btcTrend: L.btcTrend.value, emit: L.warm, skipBinance: now < L.binanceBackoffUntil || L.binanceDiag.okAt === null || L.binanceDiag.host === "binance.com (site web)", binanceBase: BINANCE_HOSTS[L.binanceHost % BINANCE_HOSTS.length], now },
          );
          if (coin === "BTC") L.btcTrend = { value: r.trend, at: now };
          done++;
        } catch {
          // coin without candles on Binance / Coinbase: skipped silently
        }
      }
      if (done) sources.setup = `${done} cryptos analysées (${svc.setups().count} au total)`;
    }

    const full = stage === 3;
    if (stage > 0) L.stage = stage >= 3 ? 0 : stage + 1;
    if (full) {
      L.lastFullRunAt = now;
      L.warm = true; // after the first complete cycle, alerts are live
    }
    svc.tickOutcomes(now);

    // Binance refusing the bot for 30 min: say so on Discord (once every 6 h), with the exact reason.
    // Market overview and the bot's notices: the dedicated channel, else the neutral one, else bull + bear.
    const infoChannels = (() => {
      const market = L.channels.filter((c) => c.id === "market");
      if (market.length) return market;
      const general = L.channels.filter((c) => c.id === "general");
      return general.length ? general : L.channels.filter((c) => c.id !== "leverage");
    })();
    if (L.warm && L.binanceDownSince !== null && now - L.binanceDownSince >= 30 * 60_000 && now - L.binanceAlertAt >= 6 * 3_600_000) {
      L.binanceAlertAt = now;
      const e = {
        title: "⚠️ Binance refuse l'accès du bot",
        description: cutText(
          `Depuis ${Math.round((now - L.binanceDownSince) / 60_000)} min, Binance refuse les requêtes du bot (serveur Cloudflare).\n` +
            `• API : ${L.binanceDiag.lastError ?? "refusée"}\n• Site web binance.com : ${L.binanceDiag.webError ?? "refusé"}\n\n` +
            "En attendant : Coinbase, OKX, KuCoin et MEXC couvrent les mouvements, et **les signaux Binance partent sur Discord quand le site est ouvert** sur un appareil où le code de relais est entré (le navigateur lit Binance directement). Le bot réessaie tout seul.",
          1800,
        ),
        color: 0xf59e0b,
        timestamp: new Date(now).toISOString(),
      };
      for (const c of infoChannels) c.n.enqueue([e]);
    }

    // « Point marché »: the site's overview on Discord, on the neutral / general channel (else bull + bear).
    const mpEvery = L.prefs.marketPoint?.everyMin ?? 60;
    if (L.warm && L.prefs.enabled && L.prefs.marketPoint?.enabled !== false && Math.floor(now / (mpEvery * 60_000)) > Math.floor(L.lastPointAt / (mpEvery * 60_000))) {
      L.lastPointAt = now;
      const bn = L.binanceDiag.host ? `Binance ✅ (${L.binanceDiag.host})` : `Binance ❌ (${L.binanceDiag.lastError ?? L.binanceDiag.webError ?? "refusé"})`;
      const others = ["coinbase", "okx", "kucoin", "mexc", "leverage"].map((k) => `${{ coinbase: "Coinbase", okx: "OKX", kucoin: "KuCoin", mexc: "MEXC", leverage: "Levier" }[k]} ${sources[k] || (k === "coinbase" && now < L.coinbaseBackoffUntil) ? (sources[k] ? "✅" : "⏸") : "·"}`);
      const embeds = marketPointEmbeds(svc, now, { siteUrl: site || null, everyMin: mpEvery, sourcesLine: [bn, ...others].join(" · ") });
      for (const c of infoChannels) c.n.enqueue(embeds);
    }

    await this.flushDiscord();
    const status = await this.save(t0, sources, full, stage > 0);
    await this.scheduleNext();
    return status;
  }

  /** Signals relayed by the live site (e.g. Binance real time). */
  private async relay(body: unknown): Promise<{ ok: boolean; accepted: number; rejected: number; reasons: Partial<Record<RelayReject, number>>; results: Record<string, DiscordMark>; queued: number }> {
    this.clock = Date.now();
    this.errors = [];
    this.signalsThisRun = 0;
    this.budget = REQUEST_BUDGET;
    const L = await this.load();
    const list = Array.isArray((body as { signals?: unknown })?.signals) ? (body as { signals: unknown[] }).signals.slice(0, 100) : [];
    let accepted = 0;
    const reasons: Partial<Record<RelayReject, number>> = {};
    /** Per signal (site id): what happened on Discord. */
    const results: Record<string, DiscordMark> = {};
    const keep: IntelSignal[] = [];
    const idOf = (x: unknown) => {
      const id = (x as { id?: unknown })?.id;
      return typeof id === "string" && id.length <= 80 ? id : null;
    };
    for (const x of list) {
      const s = sanitizeRelayed(x, this.clock);
      const id = idOf(x);
      if (typeof s === "string") {
        reasons[s] = (reasons[s] ?? 0) + 1;
        if (id) results[id] = `refused:${s}`;
        continue;
      }
      // Volume cap over 10 min, whatever sends them.
      this.relayTimes = this.relayTimes.filter((t) => this.clock - t < 10 * 60_000);
      if (this.relayTimes.length >= RELAY_CAP_10MIN) {
        reasons["trop de signaux"] = (reasons["trop de signaux"] ?? 0) + 1;
        if (id) results[id] = "refused:trop de signaux";
        continue;
      }
      this.relayTimes.push(this.clock);
      // The bot computes setups too: a setup it already alerted (same coin, same side, < 12 h) is not repeated.
      if ((s.kind === "SETUP_LONG" || s.kind === "SETUP_SHORT") && !L.svc.claimSetup(s.coin, s.kind === "SETUP_LONG" ? "LONG" : "SHORT", this.clock)) {
        reasons["déjà envoyé"] = (reasons["déjà envoyé"] ?? 0) + 1;
        if (id) results[id] = "dup";
        continue;
      }
      accepted++;
      L.svc.tracker.track(s, L.svc.engine.priceOf("BTC"));
      // The site's signals are live (not a start-up backlog): sent even while the bot warms up.
      const m = this.dispatch(s);
      if (id) results[id] = m;
      keep.push(s);
    }
    // One list of reference: the relayed signals join the bot's own, so /signals returns everything
    // Discord was offered (with what happened to each) and the site shows the same thing.
    if (keep.length) L.svc.engine.addExternal(keep);
    L.relay.received += accepted;
    if (accepted) L.relay.lastAt = this.clock;
    await this.flushDiscord();
    const prev = (await this.state.storage.get<Status>("status")) ?? null;
    await this.state.storage.put({
      discord: Object.fromEntries(L.channels.map((c) => [c.id, c.n.exportState()])),
      meta: this.meta(L),
      ...(prev ? { status: { ...prev, relay: { configured: true, ...L.relay }, discord: this.discordView(L) } } : {}),
    });
    L.relay.rejected = (L.relay.rejected ?? 0) + (list.length - accepted);
    return { ok: true, accepted, rejected: list.length - accepted, reasons, results, queued: L.channels.reduce((a, c) => a + (c.n.view().queued ?? 0), 0) };
  }

  private async flushDiscord() {
    const L = this.loaded;
    if (!L) return;
    const active = L.channels.filter((c) => c.n.active);
    for (const c of L.channels) {
      if (this.budget <= 0) break;
      if (!c.n.active) {
        this.errors.push(`Discord ${c.label} : ${c.n.view().lastError ?? "webhook invalide"}`);
        continue;
      }
      if (!L.welcomed.has(c.id)) {
        // New channel: a hello message instead of a burst of alerts.
        const note =
          c.id === "market"
            ? "📊 Ce salon reçoit l'**état du marché** (météo du marché, avis en cours, ce qui bouge, sujets chauds, actus) à intervalle régulier, et les avertissements du bot."
            : c.id === "leverage"
            ? "⚖️ Ce salon reçoit les **marchés à levier** : indications long / short et liquidations en cascade. Le levier amplifie les pertes."
            : c.id === "bullish"
            ? "🟢 Ce salon reçoit les signaux **haussiers** (cryptos qui pourraient exploser)."
            : c.id === "bearish"
              ? "🔴 Ce salon reçoit les signaux **baissiers** (cryptos qui pourraient chuter)."
              : c.directions.length === 1 && c.directions[0] === "neutral"
                ? "⚪ Ce salon reçoit les signaux **neutres** : mouvements forts ou anormaux dont le sens n'est pas encore clair (volume qui explose, open interest, buzz…)."
                : c.directions.includes("bullish") && c.directions.includes("bearish")
                  ? "Ce salon reçoit tous les signaux (haussiers 🟢, baissiers 🔴 et neutres ⚪)."
                  : `Ce salon reçoit les signaux ${c.directions.includes("bullish") ? "haussiers 🟢" : "baissiers 🔴"}${c.directions.includes("neutral") ? " et neutres ⚪" : ""}.`;
        this.budget--;
        const r = await c.n.test(note);
        if (r.ok) L.welcomed.add(c.id);
        else {
          this.errors.push(`Discord ${c.label} : ${r.message}`);
          continue;
        }
      }
      // Share what is left of the request budget between the channels; the rest leaves on the next run (20 s).
      if (this.budget <= 0) break;
      const share = Math.max(1, Math.floor(this.budget / Math.max(1, active.length)));
      this.budget -= await c.n.pump(share);
    }
  }

  private meta(L: NonNullable<RadarState["loaded"]>) {
    const seen = Object.fromEntries([...L.seen].filter(([, t]) => t > this.clock - 30 * 60_000));
    return { warm: L.warm, welcomed: [...L.welcomed], lastFullRunAt: L.lastFullRunAt, stage: L.stage, lastCycleAt: L.lastCycleAt, exchangeTurn: L.exchangeTurn, setupTurn: L.setupTurn, lastPointAt: L.lastPointAt, binanceHost: L.binanceHost, binanceDownSince: L.binanceDownSince, binanceAlertAt: L.binanceAlertAt, marks: Object.fromEntries([...L.marks].filter(([, v]) => v.at > this.clock - 3 * 3_600_000).slice(-1500)), relay: L.relay, sentLog: L.sentLog.filter((t) => t > this.clock - 86_400_000).slice(-20000), seen };
  }

  private discordView(L: NonNullable<RadarState["loaded"]>) {
    return Object.fromEntries(L.channels.map((c) => [c.label, { directions: c.directions, ...c.n.view() }]));
  }

  private async save(t0: number, sources: Record<string, string>, full: boolean, stageRan = full): Promise<Status> {
    const L = this.loaded as NonNullable<RadarState["loaded"]>;
    const st = this.state.storage;
    const prev = (await st.get<Status>("status")) ?? null;
    const status: Status = {
      lastRunAt: this.clock,
      lastFullRunAt: L.lastFullRunAt,
      durationMs: Date.now() - t0,
      loop: `prix Binance et Coinbase toutes les ${FAST_MS / 1000} s, autres sources toutes les ${FULL_MS / 60_000} min, une notification Discord par signal`,
      signals24h: L.sentLog.filter((t) => t > this.clock - 86_400_000).length,
      filteredByPrefs: L.filtered,
      sent24h: (() => {
        const day = L.recentSent.filter((x) => x.ts > this.clock - 86_400_000);
        const by = (f: (x: (typeof day)[number]) => string) => day.reduce<Record<string, number>>((a, x) => ((a[f(x)] = (a[f(x)] ?? 0) + 1), a), {});
        return { byChannel: by((x) => x.channel), byDirection: by((x) => x.dir), byKind: by((x) => x.kind), bySource: by((x) => x.src ?? "?"), last: day.slice(-10).reverse() };
      })(),
      market: L.svc.marketContext(),
      // Keep the detail of the last full pass visible between fast runs.
      sources: full ? sources : { ...(prev?.sources ?? {}), ...sources },
      errors: (full ? this.errors : [...this.errors, ...(prev?.errors ?? []).filter((e) => !e.startsWith("Coinbase") && !e.startsWith("Discord") && !e.startsWith("Binance"))]).slice(0, 20),
      binance: { ...L.binanceDiag, pausedUntil: L.binanceBackoffUntil > this.clock ? L.binanceBackoffUntil : null },
      relay: { configured: !!this.env.RELAY_KEY?.trim(), ...L.relay },
      config: { siteUrl: (this.env.SITE_URL ?? "").trim() || null, webhookConfigured: L.channels.some((c) => c.n.active), minStrength: L.prefs.minStrength },
      discord: this.discordView(L),
    };
    const entries: Record<string, unknown> = {
      recentSent: L.recentSent,
      listings: { cb: [...L.listings.cb], cbCoins: [...L.listings.cbCoins], bn: [...L.listings.bn], seededCb: L.listings.seededCb, seededBn: L.listings.seededBn },
      cb: L.history.export(),
      bn: L.binance.export(), discord: Object.fromEntries(L.channels.map((c) => [c.id, c.n.exportState()])), meta: this.meta(L), status };
    if (stageRan) {
      // Compact: the worker needs cooldowns and recent signals, not full history.
      const intel = L.svc.exportState();
      const recent = this.clock - 3 * 3_600_000;
      intel.engine.signals = intel.engine.signals.filter((s) => s.ts >= recent).slice(-1000);
      intel.engine.news = intel.engine.news.slice(-500).map((n) => ({ ...n, summary: "" }));
      intel.tracker = [];
      entries.intel = intel;
      entries.tracker = L.svc.tracker.exportRecent(3000);
      entries.leverageBoard = L.svc.leverage();
      entries.setupBoard = L.svc.setups({ limit: 150 });
      entries.verdictBoard = L.svc.verdictBoard();
    } else {
      // Fast runs only persist cooldowns + recent signals (small).
      const e = L.svc.engine.exportState();
      const saved = (await st.get<IntelSavedState>("intel")) ?? null;
      if (saved) entries.intel = { ...saved, setups: L.svc.setupMemory(), engine: { ...saved.engine, cooldowns: e.cooldowns, signals: e.signals.filter((s) => s.ts >= this.clock - 3 * 3_600_000).slice(-1000) } };
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
      const body = await readCapped(req, 64_000);
      if (body === null) return Response.json({ ok: false, error: "trop gros" }, { status: 413 });
      return stub(env).fetch("https://radar/relay", { method: "POST", headers: { "x-relay-key": req.headers.get("x-relay-key") ?? "", "content-type": "application/json" }, body });
    }
    if (req.method === "POST" && url.pathname === "/test-channels") {
      return stub(env).fetch("https://radar/test-channels", { method: "POST", headers: { "x-relay-key": req.headers.get("x-relay-key") ?? "" } });
    }
    if (req.method === "POST" && url.pathname === "/prefs") {
      const body = await readCapped(req, 32_000);
      if (body === null) return Response.json({ ok: false, error: "trop gros" }, { status: 413 });
      return stub(env).fetch("https://radar/prefs", { method: "POST", headers: { "x-relay-key": req.headers.get("x-relay-key") ?? "", "content-type": "application/json" }, body });
    }
    if (req.method === "GET" && ["/prefs", "/stats", "/signals", "/leverage", "/setups", "/verdicts"].includes(url.pathname)) {
      const r = await stub(env).fetch(`https://radar${url.pathname}${url.search}`);
      return new Response(r.body, { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    // Public read-only status page (no secret in it).
    const r = await stub(env).fetch("https://radar/status");
    return new Response(JSON.stringify(await r.json(), null, 2), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  },
};
