/**
 * CoinGecko (+ GeckoTerminal on-chain) polling under a strict call budget.
 *
 * Endpoints (github.com/coingecko/coingecko-api-oas, demo-api.json):
 *   GET /coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=N&price_change_percentage=1h,24h,7d
 *   GET /search/trending
 *   GET /derivatives
 *   GET /onchain/networks/trending_pools?include=base_token
 *   GET /onchain/networks/new_pools?include=base_token
 * Auth: header `x-cg-demo-api-key` (Demo, api.coingecko.com) or
 * `x-cg-pro-api-key` (paid plans, pro-api.coingecko.com). Keyless use of the
 * public API is possible but more strictly rate-limited.
 */
import { CgDerivativeExchangeSchema, CgMarketRowSchema, derivativeRowsFromExchange, CgTrendingSchema, GtPoolsSchema, trendingCategories, type TrendCategory, type CgDerivative, type CgMarketRow, type GtPools, type IntelConfig, type TrendingCoin } from "@radar/core";
import type { CallBudget } from "./budget.js";
import type { FetchText } from "./http.js";

export type CoinGeckoPlan = "demo" | "pro" | "public";

export interface CoinGeckoHandlers {
  onMarkets(rows: CgMarketRow[], page: number, now: number): void;
  onTrending(list: TrendingCoin[], now: number, categories?: TrendCategory[]): void;
  onDerivatives(rows: CgDerivative[], now: number): void;
  onPools(doc: GtPools, isNewList: boolean, now: number): void;
  onError(task: string, message: string, now: number): void;
  onSuccess(task: string, items: number, now: number): void;
}

interface Task {
  id: string;
  path: string;
  baseIntervalMin: number;
  run(text: string, now: number): number;
}

export interface CoinGeckoFeedOptions {
  plan: CoinGeckoPlan;
  apiKey: string | null;
  cfg: IntelConfig["coingecko"];
  budget: CallBudget;
  fetchText: FetchText;
  handlers: CoinGeckoHandlers;
  /** Last run time per task (persisted, so a restart does not re-burn the quota). */
  lastRun?: Record<string, number>;
  tickMs?: number;
  now?: () => number;
  /** Override the API root (e.g. a caching proxy such as the Cloudflare function `/api/cg`). */
  baseUrl?: string;
  /** Multiply every base interval (e.g. 3 when a shared proxy cache serves many viewers). */
  intervalMultiplier?: number;
}

export class CoinGeckoFeed {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly lastRun: Record<string, number>;
  private readonly now: () => number;
  private backoffUntil = 0;
  private tasks: Task[] = [];

  constructor(private readonly o: CoinGeckoFeedOptions) {
    this.now = o.now ?? Date.now;
    this.lastRun = { ...(o.lastRun ?? {}) };
    this.buildTasks();
  }

  get baseUrl() {
    if (this.o.baseUrl) return this.o.baseUrl;
    return this.o.plan === "pro" ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json" };
    if (this.o.apiKey && this.o.plan === "demo") h["x-cg-demo-api-key"] = this.o.apiKey;
    if (this.o.apiKey && this.o.plan === "pro") h["x-cg-pro-api-key"] = this.o.apiKey;
    return h;
  }

  private buildTasks() {
    const cfg = this.o.cfg;
    const h = this.o.handlers;
    const pages = Math.ceil(cfg.universeSize / 250);
    const tasks: Task[] = [];
    for (let p = 1; p <= pages; p++)
      tasks.push({
        id: `markets:${p}`,
        path: `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}&sparkline=false&price_change_percentage=1h%2C24h%2C7d`,
        baseIntervalMin: 10,
        run: (text, now) => {
          const raw = JSON.parse(text) as unknown;
          if (!Array.isArray(raw)) throw new Error("réponse /coins/markets inattendue");
          const rows: CgMarketRow[] = [];
          for (const r of raw) {
            const x = CgMarketRowSchema.safeParse(r);
            if (x.success) rows.push(x.data);
          }
          h.onMarkets(rows, p, now);
          return rows.length;
        },
      });
    tasks.push({
      id: "trending",
      path: "/search/trending",
      baseIntervalMin: 10,
      run: (text, now) => {
        const t = CgTrendingSchema.parse(JSON.parse(text));
        const list = t.coins.map((c, i) => ({ id: c.item.id, symbol: c.item.symbol, name: c.item.name, rank: i, marketCapRank: c.item.market_cap_rank }));
        h.onTrending(list, now, trendingCategories(t));
        return list.length;
      },
    });
    tasks.push({
      id: "derivatives",
      // One exchange (Binance Futures, the largest): /derivatives (all exchanges) is several MB.
      path: "/derivatives/exchanges/binance_futures?include_tickers=unexpired",
      baseIntervalMin: 20,
      run: (text, now) => {
        const rows: CgDerivative[] = derivativeRowsFromExchange(CgDerivativeExchangeSchema.parse(JSON.parse(text)));
        h.onDerivatives(rows, now);
        return rows.length;
      },
    });
    if (cfg.dex.enabled) {
      for (const [id, path, isNew] of [
        ["dex:trending", "/onchain/networks/trending_pools?include=base_token&page=1", false],
        ["dex:new", "/onchain/networks/new_pools?include=base_token&page=1", true],
      ] as const)
        tasks.push({
          id,
          path,
          baseIntervalMin: 20,
          run: (text, now) => {
            const doc = GtPoolsSchema.parse(JSON.parse(text));
            h.onPools(doc, isNew, now);
            return doc.data.length;
          },
        });
    }
    this.tasks = tasks;
  }

  /** Planned calls per hour at base intervals. */
  private demandPerHour() {
    return this.tasks.reduce((s, t) => s + 60 / (t.baseIntervalMin * this.mult), 0);
  }

  /** How much every interval is stretched to stay within the budget (≥ 1). */
  stretch(now = this.now()) {
    const allowed = this.o.budget.allowedPerHour(now);
    return allowed <= 0 ? Number.POSITIVE_INFINITY : Math.max(1, this.demandPerHour() / allowed);
  }

  schedule(now = this.now()) {
    const k = this.stretch(now) * this.mult;
    return this.tasks.map((t) => {
      const every = t.baseIntervalMin * k;
      const last = this.lastRun[t.id] ?? 0;
      return { id: t.id, everyMin: Number.isFinite(every) ? Math.round(every) : null, lastRunAt: last || null, nextAt: Number.isFinite(every) ? (last ? last + every * 60_000 : now) : null };
    });
  }

  private get mult() {
    return this.o.intervalMultiplier ?? 1;
  }

  lastRuns() {
    return { ...this.lastRun };
  }

  start() {
    this.stop();
    this.timer = setInterval(() => void this.tick(), this.o.tickMs ?? 15_000);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Run at most one due task (the most overdue). Exposed for tests. */
  async tick(): Promise<string | null> {
    const now = this.now();
    if (this.busy || now < this.backoffUntil) return null;
    const k = this.stretch(now) * this.mult;
    if (!Number.isFinite(k)) return null;
    let best: { t: Task; overdue: number } | null = null;
    for (const t of this.tasks) {
      const every = t.baseIntervalMin * k * 60_000;
      const overdue = (now - (this.lastRun[t.id] ?? 0)) / every;
      if (overdue >= 1 && (!best || overdue > best.overdue)) best = { t, overdue };
    }
    if (!best || !this.o.budget.tryAcquire(now)) return null;
    const t = best.t;
    this.busy = true;
    this.lastRun[t.id] = now;
    try {
      const res = await this.o.fetchText(`${this.baseUrl}${t.path}`, { headers: this.headers(), timeoutMs: 20_000 });
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after") ?? 60);
        this.backoffUntil = now + (Number.isFinite(ra) ? ra : 60) * 1000;
        throw new Error(`limite de débit CoinGecko (429), pause ${Math.round((this.backoffUntil - now) / 1000)} s`);
      }
      if (res.status === 401 || res.status === 403)
        throw new Error(this.o.apiKey ? `clé CoinGecko refusée (HTTP ${res.status}) — vérifier COINGECKO_API_KEY / COINGECKO_PLAN` : `accès refusé (HTTP ${res.status}) — une clé Demo gratuite (COINGECKO_API_KEY) est recommandée`);
      const up = res.headers.get("x-upstream-status");
      let detail = "";
      try {
        const d = (JSON.parse(res.text) as { detail?: string }).detail;
        if (d) detail = ` — ${d.slice(0, 160)}`;
      } catch {
        // not JSON
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}${up ? ` (CoinGecko a répondu ${up}${up === "429" ? " : trop d'appels, ajoute une clé Demo" : up === "401" || up === "403" ? " : accès refusé, clé manquante ou invalide" : ""})` : ""}${detail}`);
      const n = t.run(res.text, now);
      this.o.handlers.onSuccess(t.id, n, now);
    } catch (err) {
      this.o.handlers.onError(t.id, (err as Error).message, now);
    } finally {
      this.busy = false;
    }
    return t.id;
  }
}
