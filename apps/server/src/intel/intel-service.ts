/**
 * IntelService — wires every source into the IntelEngine, measures the
 * outcome of each signal, pushes alerts to Discord and answers the
 * dashboard queries. Transport-agnostic (no Node-only import): the Node
 * server and the in-browser demo feed it through the same `on*` methods.
 */
import {
  BinanceRestHistory,
  CoinMatcher,
  CoinbasePriceHistory,
  IntelEngine,
  OutcomeTracker,
  aggregateDerivatives,
  detectDerivatives,
  detectLive,
  detectMarketRow,
  detectPools,
  detectTrendingEntries,
  toNewsItem,
  type Candidate,
  type CgDerivative,
  type CgMarketRow,
  type CoinRow,
  type Direction,
  type GtPools,
  type IntelConfig,
  type IntelFilter,
  type IntelSignal,
  type IntelSource,
  type KindStats,
  type LiveTracker,
  type NewsItem,
  type BinanceMiniRestTicker,
  type Opportunity,
  type Product,
  type RawFeedItem,
  type Signal,
  type SourceHealth,
  type TrackedSignal,
  type TrendingCoin,
} from "@radar/core";
import type { LogFn } from "../market-data/source.js";

export interface IntelBatch {
  signals: IntelSignal[];
  news: NewsItem[];
}
type Listener = (b: IntelBatch) => void;

export interface IntelNotifier {
  consider(s: IntelSignal): unknown;
  view(): unknown;
  test?(): Promise<{ ok: boolean; message: string }>;
}

export interface IntelSavedState {
  version: 1;
  savedAt: number;
  engine: ReturnType<IntelEngine["exportState"]>;
  tracker: TrackedSignal[];
  trendingIds: string[] | null;
  openInterest: Record<string, number>;
  extras?: Record<string, unknown>;
}

export interface UniverseQuery {
  q?: string;
  sort?: string;
  dir?: "asc" | "desc";
  offset?: number;
  limit?: number;
  filter?: "all" | "binance" | "coinbase" | "trending" | "signaled" | "gainers" | "losers";
}

const SOURCE_LABEL: Record<IntelSource | "discord", string> = {
  binance: "Binance temps réel (toutes les paires)",
  coinbase: "Radar Coinbase",
  coingecko: "CoinGecko marchés",
  trending: "CoinGecko tendances",
  derivatives: "Dérivés (funding, open interest)",
  dex: "DEX on-chain (GeckoTerminal)",
  news: "Actualités (RSS)",
  discord: "Discord",
};

const TASK_SOURCE = (task: string): IntelSource => (task.startsWith("markets") ? "coingecko" : task === "trending" ? "trending" : task === "derivatives" ? "derivatives" : "dex");

export interface IntelServiceOptions {
  cfg: IntelConfig;
  log: LogFn;
  notifier?: IntelNotifier | null;
  /** Sources that are wired (others are shown as disabled). */
  enabledSources: (IntelSource | "discord")[];
  now?: () => number;
}

export class IntelService {
  readonly engine: IntelEngine;
  readonly tracker: OutcomeTracker;
  private readonly listeners = new Set<Listener>();
  private readonly health = new Map<IntelSource | "discord", SourceHealth>();
  private matcher = new CoinMatcher([]);
  private matcherSize = -1;
  private matcherAt = 0;
  private trendingIds: Set<string> | null = null;
  private openInterest = new Map<string, number>();
  private statsCache: { at: number; stats: KindStats[] } | null = null;
  private pending: IntelBatch = { signals: [], news: [] };
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private cfg: IntelConfig;

  constructor(private readonly o: IntelServiceOptions) {
    this.cfg = o.cfg;
    this.now = o.now ?? Date.now;
    this.engine = new IntelEngine(o.cfg);
    this.tracker = new OutcomeTracker(o.cfg.tracking);
    for (const s of ["binance", "coinbase", "coingecko", "trending", "derivatives", "dex", "news", "discord"] as const) {
      const on = o.enabledSources.includes(s);
      this.health.set(s, { source: s, enabled: on, state: on ? "waiting" : "disabled", lastSuccessAt: null, lastError: null, items: 0, note: SOURCE_LABEL[s] });
    }
  }

  config(): IntelConfig {
    return this.cfg;
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  restore(s: unknown) {
    const st = s as Partial<IntelSavedState> | null;
    if (!st || st.version !== 1) return;
    this.engine.importState(st.engine ?? {});
    this.tracker.importState(st.tracker ?? []);
    this.trendingIds = st.trendingIds ? new Set(st.trendingIds) : null;
    this.openInterest = new Map(Object.entries(st.openInterest ?? {}));
  }

  exportState(extras?: Record<string, unknown>): IntelSavedState {
    return {
      version: 1,
      savedAt: this.now(),
      engine: this.engine.exportState(),
      tracker: this.tracker.exportState(),
      trendingIds: this.trendingIds ? [...this.trendingIds] : null,
      openInterest: Object.fromEntries(this.openInterest),
      extras,
    };
  }

  // ─── Source health ───────────────────────────────────────────────────────

  setSourceState(source: IntelSource | "discord", state: SourceHealth["state"], message: string | null, now = this.now(), items?: number) {
    const h = this.health.get(source);
    if (!h) return;
    const changed = h.state !== state;
    h.state = state;
    if (state === "ok") {
      h.lastSuccessAt = now;
      h.lastError = null;
      if (message) h.note = message;
    } else if (state === "down" || state === "degraded") h.lastError = message;
    if (items !== undefined) h.items = items;
    if (changed && (state === "down" || state === "ok"))
      this.o.log({ type: "INTEL_SOURCE_STATE", level: state === "down" ? "warn" : "info", success: state === "ok", message: `${SOURCE_LABEL[source]} : ${state === "ok" ? "OK" : "indisponible"}${message ? ` — ${message}` : ""}` });
  }

  sources() {
    return [...this.health.values()];
  }

  // ─── Ingestion ───────────────────────────────────────────────────────────

  onLive(tracker: LiveTracker, changed: Set<string>, now = this.now()) {
    const cands: Candidate[] = [];
    for (const coin of changed) {
      const s = tracker.snapshot(coin, now);
      if (!s) continue;
      this.engine.upsertLive(s, now, "binance");
      cands.push(...detectLive(s, this.cfg.binance, "binance"));
    }
    const h = this.health.get("binance");
    if (h) {
      h.items = tracker.coins().length;
      h.lastSuccessAt = now;
    }
    this.emit(this.engine.ingest(cands, now), []);
  }

  /** Binance all-market REST snapshot (scheduled worker without WebSocket). */
  onBinanceTickers(tickers: BinanceMiniRestTicker[], history: BinanceRestHistory, now = this.now()) {
    const snaps = history.update(tickers, now);
    const cands: Candidate[] = [];
    for (const s of snaps) {
      this.engine.upsertLive(s, now, "binance");
      cands.push(...detectLive(s, this.cfg.binance, "binance"));
    }
    this.setSourceState("binance", "ok", `${snaps.length} cryptos (Binance, relevé toutes les 20 s)`, now, snaps.length);
    this.emit(this.engine.ingest(cands, now), []);
  }

  /**
   * Snapshot of the public Coinbase product list (prices). Coins already
   * streamed live by Binance keep their Binance data; the others get live
   * 5 / 15 min changes from Coinbase.
   */
  onCoinbaseProducts(products: Product[], history: CoinbasePriceHistory, now = this.now()) {
    const snaps = history.update(products, now);
    this.engine.markCoinbase(snaps.map((s) => s.coin), now);
    const cands: Candidate[] = [];
    let live = 0;
    for (const s of snaps) {
      const row = this.engine.coin(s.coin);
      if (row?.onBinance && row.live && now - row.live.updatedAt < 120_000) continue;
      this.engine.upsertLive(s, now, "coinbase");
      live++;
      for (const c of detectLive(s, this.cfg.binance, "coinbase")) cands.push({ ...c, url: `https://www.coinbase.com/advanced-trade/spot/${s.pair}` });
    }
    this.setSourceState("coinbase", "ok", `${snaps.length} cryptos cotées sur Coinbase, dont ${live} suivies via Coinbase (absentes du flux Binance)`, now, snaps.length);
    this.emit(this.engine.ingest(cands, now), []);
  }

  markCoinbase(bases: Iterable<string>, now = this.now()) {
    this.engine.markCoinbase(bases, now);
  }

  /** New Coinbase radar signals / opportunities (existing Signal Engine). */
  onCoinbaseEvaluation(e: { signals: Signal[]; opened: Opportunity[] }, now = this.now()) {
    const cands: Candidate[] = [];
    const coinOf = (pid: string) => pid.split("-")[0] as string;
    const url = (pid: string) => `https://www.coinbase.com/advanced-trade/spot/${pid}`;
    for (const o of e.opened) {
      const coin = coinOf(o.productId);
      cands.push({
        coin,
        coinName: null,
        kind: "PUMP_EARLY",
        direction: "bullish",
        source: "coinbase",
        strength: o.score,
        title: `${coin} : opportunité détectée par le radar Coinbase (${o.productId}, score ${o.score})`,
        reasons: [...o.reasons.slice(0, 6), o.tradable ? "liquidité suffisante sur Coinbase" : `liquidité insuffisante : ${o.liquidityIssues.join(", ")}`],
        metrics: { productId: o.productId, score: o.score, price: o.price },
        priceUsd: null,
        url: url(o.productId),
      });
    }
    for (const s of e.signals) {
      if (s.type !== "PRICE_DROP" || s.score < 60) continue;
      const coin = coinOf(s.productId);
      cands.push({
        coin,
        coinName: null,
        kind: "DUMP_EARLY",
        direction: "bearish",
        source: "coinbase",
        strength: s.score,
        title: `${coin} chute sur Coinbase (${s.productId}) : ${s.message}`,
        reasons: [s.message],
        metrics: { productId: s.productId, window: s.window, value: s.value, threshold: s.threshold },
        priceUsd: null,
        url: url(s.productId),
      });
    }
    if (cands.length) this.setSourceState("coinbase", "ok", null, now);
    this.emit(this.engine.ingest(cands, now), []);
  }

  onMarkets(rows: CgMarketRow[], _page: number, now = this.now()) {
    this.engine.upsertMarkets(rows, now);
    const cands = rows.flatMap((r) => detectMarketRow(r, this.cfg.coingecko));
    this.emit(this.engine.ingest(cands, now), []);
  }

  onTrending(list: TrendingCoin[], now = this.now()) {
    const cands = detectTrendingEntries(list, this.trendingIds, (s) => this.engine.priceOf(s));
    this.trendingIds = new Set(list.map((c) => c.id));
    this.engine.setTrending(list, now);
    this.emit(this.engine.ingest(cands, now), []);
  }

  onDerivatives(rows: CgDerivative[], now = this.now()) {
    const agg = aggregateDerivatives(rows);
    this.engine.setDerivatives(agg, now);
    const cands: Candidate[] = [];
    for (const a of agg.values()) {
      // Only coins of the universe: derivative index ids are tickers and may be ambiguous otherwise.
      if (!this.engine.coin(a.coin)) continue;
      cands.push(...detectDerivatives(a, this.openInterest.get(a.coin) ?? null, this.cfg.coingecko, this.engine.priceOf(a.coin)));
      this.openInterest.set(a.coin, a.openInterestUsd);
    }
    this.emit(this.engine.ingest(cands, now), []);
  }

  onPools(doc: GtPools, isNewList: boolean, now = this.now()) {
    this.emit(this.engine.ingest(detectPools(doc, this.cfg.coingecko.dex, now, isNewList), now), []);
  }

  onNews(feedName: string, raw: RawFeedItem[], now = this.now()) {
    this.refreshMatcher(now);
    const items = raw.map((r) => toNewsItem(r, feedName, this.matcher));
    const r = this.engine.addNews(items, now);
    const h = this.health.get("news");
    if (h) {
      h.items = this.engine.recentNews({ limit: 100_000 }).length;
      h.lastSuccessAt = now;
      h.state = "ok";
    }
    this.emit(r.signals, r.news);
  }

  onCoinGeckoResult(task: string, ok: boolean, message: string | null, items: number, now = this.now()) {
    const src = TASK_SOURCE(task);
    if (ok) this.setSourceState(src, "ok", null, now, src === "coingecko" ? this.engine.universeRows().filter((r) => r.coingeckoId).length : items);
    else this.setSourceState(src, "degraded", `${task} : ${message}`, now);
  }

  private refreshMatcher(now: number) {
    const dict = this.engine.dictionary();
    if (dict.length === this.matcherSize || (now - this.matcherAt < 60_000 && this.matcherSize > 0)) return;
    this.matcher = new CoinMatcher(dict);
    this.matcherSize = dict.length;
    this.matcherAt = now;
  }

  /** Measure outcomes with current prices (call every ~30 s). */
  tickOutcomes(now = this.now()) {
    return this.tracker.tick(now, (c) => this.engine.priceOf(c));
  }

  private emit(signals: IntelSignal[], news: NewsItem[]) {
    if (!signals.length && !news.length) return;
    for (const s of signals) {
      // DEX tokens are identified by pool, not by the universe price: not tracked.
      if (s.source !== "dex") this.tracker.track(s);
      this.o.notifier?.consider(s);
      this.o.log({
        type: "INTEL_SIGNAL",
        level: s.strength >= this.cfg.discord.minStrength || s.kind === "CONFLUENCE" ? "info" : "debug",
        productId: s.coin,
        message: `[${s.source}] ${s.kind} ${s.strength} — ${s.title}`,
        data: { id: s.id, kind: s.kind, direction: s.direction, source: s.source, strength: s.strength, priceUsd: s.priceUsd, metrics: s.metrics },
      });
    }
    this.pending.signals.push(...signals);
    this.pending.news.push(...news);
    if (!this.flushTimer)
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        const b = this.pending;
        this.pending = { signals: [], news: [] };
        for (const l of this.listeners) {
          try {
            l(b);
          } catch {
            // ignore
          }
        }
      }, 500);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  stats(): KindStats[] {
    const now = this.now();
    if (!this.statsCache || now - this.statsCache.at > 60_000) this.statsCache = { at: now, stats: this.tracker.stats() };
    return this.statsCache.stats;
  }

  /** 1 h hit rate of this kind × direction when at least 10 outcomes exist. */
  hitRateOf(s: Pick<IntelSignal, "kind" | "direction">): number | null {
    const k = this.stats().find((x) => x.kind === s.kind && x.direction === s.direction);
    const h = k?.horizons["60"];
    return h && h.n >= 10 ? h.hitRatePct : null;
  }

  feed(f: IntelFilter) {
    const signals = this.engine.recentSignals(f);
    return { signals: signals.map((s) => ({ ...s, hitRate1h: this.hitRateOf(s) })), counts: this.counts() };
  }

  private counts() {
    const since = this.now() - 3_600_000;
    const last = this.engine.recentSignals({ since, limit: 100_000 });
    return {
      lastHour: last.length,
      bullish: last.filter((s) => s.direction === "bullish").length,
      bearish: last.filter((s) => s.direction === "bearish").length,
      confluences: last.filter((s) => s.kind === "CONFLUENCE").length,
      universe: this.engine.universeRows().length,
    };
  }

  news(f: { coin?: string; direction?: Direction; limit?: number }) {
    return this.engine.recentNews(f);
  }

  universe(q: UniverseQuery) {
    const now = this.now();
    let rows = this.engine.universeRows();
    const text = q.q?.trim().toLowerCase();
    if (text) rows = rows.filter((r) => r.symbol.toLowerCase().includes(text) || r.name.toLowerCase().includes(text));
    const ch24 = (r: CoinRow) => r.change24h ?? null;
    switch (q.filter) {
      case "binance":
        rows = rows.filter((r) => r.onBinance);
        break;
      case "coinbase":
        rows = rows.filter((r) => r.onCoinbase);
        break;
      case "trending":
        rows = rows.filter((r) => r.trendingRank !== null);
        break;
      case "signaled":
        rows = rows.filter((r) => r.lastSignalAt !== null && now - r.lastSignalAt < 86_400_000);
        break;
      case "gainers":
        rows = rows.filter((r) => (ch24(r) ?? 0) > 0);
        break;
      case "losers":
        rows = rows.filter((r) => (ch24(r) ?? 0) < 0);
        break;
    }
    const key: Record<string, (r: CoinRow) => number | string | null> = {
      rank: (r) => r.rank,
      symbol: (r) => r.symbol,
      price: (r) => r.priceUsd,
      change5m: (r) => r.live?.change5m ?? null,
      change15m: (r) => r.live?.change15m ?? null,
      change1h: (r) => r.live?.change1h ?? r.change1h,
      change24h: (r) => r.change24h,
      change7d: (r) => r.change7d,
      volume: (r) => r.volume24hUsd,
      mcap: (r) => r.marketCapUsd,
      volMcap: (r) => (r.volume24hUsd !== null && r.marketCapUsd ? r.volume24hUsd / r.marketCapUsd : null),
      volRatio: (r) => r.live?.volumeRatio1h ?? null,
      funding: (r) => r.fundingRatePct,
      ath: (r) => r.athChangePct,
      lastSignal: (r) => r.lastSignalAt,
    };
    const k = key[q.sort ?? "rank"] ?? (key.rank as (r: CoinRow) => number | null);
    const dir = (q.dir ?? (q.sort && q.sort !== "rank" && q.sort !== "symbol" ? "desc" : "asc")) === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const x = k(a);
      const y = k(b);
      if (x === null && y === null) return a.symbol.localeCompare(b.symbol);
      if (x === null) return 1; // nulls always last
      if (y === null) return -1;
      return (typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number)) * dir;
    });
    const offset = Math.max(0, q.offset ?? 0);
    const limit = Math.min(500, Math.max(1, q.limit ?? 100));
    const page = rows.slice(offset, offset + limit);
    const since = now - 86_400_000;
    return {
      total: rows.length,
      offset,
      rows: page.map((r) => {
        const sig = r.lastSignalAt && r.lastSignalAt >= since ? this.engine.recentSignals({ coin: r.symbol, since, limit: 50 }) : [];
        return { ...r, signals24h: sig.length, lastSignal: sig[0] ? { kind: sig[0].kind, direction: sig[0].direction, strength: sig[0].strength, ts: sig[0].ts } : null };
      }),
    };
  }

  coinDetail(symbol: string) {
    const s = symbol.toUpperCase();
    const row = this.engine.coin(s) ?? null;
    const signals = this.engine.recentSignals({ coin: s, limit: 200 });
    return {
      row,
      signals: signals.map((x) => ({ ...x, hitRate1h: this.hitRateOf(x) })),
      news: this.engine.recentNews({ coin: s, limit: 50 }),
      outcomes: this.tracker.list(20_000).filter((t) => t.coin === s).slice(0, 50),
    };
  }

  performance(q: { minStrength?: number; source?: IntelSource }) {
    const stats = q.minStrength !== undefined || q.source ? this.tracker.stats(q) : this.stats();
    return { horizonsMin: this.cfg.tracking.horizonsMin, hitThresholdPct: this.cfg.tracking.hitThresholdPct, stats, recent: this.tracker.list(100) };
  }

  sourcesView(extra: Record<string, unknown> = {}) {
    const d = this.o.notifier?.view() as { state?: string; lastError?: string | null; lastSentAt?: number | null } | undefined;
    const h = this.health.get("discord");
    if (h && d) {
      h.state = d.state === "ok" || d.state === "idle" ? (h.enabled ? "ok" : "disabled") : d.state === "disabled" ? "disabled" : "degraded";
      h.lastError = d.lastError ?? null;
      h.lastSuccessAt = d.lastSentAt ?? null;
    }
    return { sources: this.sources(), discord: d ?? null, ...extra };
  }

  async discordTest() {
    if (!this.o.notifier?.test) return { ok: false, message: "Discord non disponible dans ce mode" };
    return this.o.notifier.test();
  }
}
