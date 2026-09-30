/**
 * IntelService — wires every source into the IntelEngine, measures the
 * outcome of each signal, pushes alerts to Discord and answers the
 * dashboard queries. Transport-agnostic (no Node-only import): the Node
 * server and the in-browser demo feed it through the same `on*` methods.
 */
import {
  BinanceRestHistory,
  CoinMatcher,
  SocialBuzz,
  isNoiseCoin,
  readLeverage,
  type LeverageReading,
  type PerpMarket,
  type SocialPost,
  type SocialState,
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
  /** coin → learned usual 5-min move. */
  volatility?: Record<string, VolEntry>;
  social?: SocialState;
  leverage?: { lastBias: Record<string, string>; oi: Record<string, number> };
  extras?: Record<string, unknown>;
}

interface VolEntry {
  ewma: number;
  n: number;
  at: number;
}

export interface MarketContext {
  btcChange1h: number | null;
  btcChange24h: number | null;
  regime: "hausse" | "baisse" | "calme" | "inconnu";
  note: string;
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
  social: "Réseaux sociaux (Reddit)",
  leverage: "Marchés à levier (Coinbase perpétuels)",
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
  private readonly vol = new Map<string, VolEntry>();
  private social: SocialBuzz;
  private leverageBoard: LeverageReading[] = [];
  private leverageAt: number | null = null;
  private perpDiag: { sources: string[]; errors: string[]; triedAt: number | null } = { sources: [], errors: [], triedAt: null };
  private lastBias = new Map<string, string>();
  private perpOi = new Map<string, number>();
  private lastDerivatives: CgDerivative[] = [];
  private readonly liq = new Map<string, { ts: number; side: "long" | "short"; usd: number }[]>();
  private pending: IntelBatch = { signals: [], news: [] };
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private cfg: IntelConfig;

  constructor(private readonly o: IntelServiceOptions) {
    this.cfg = o.cfg;
    this.now = o.now ?? Date.now;
    this.engine = new IntelEngine(o.cfg);
    this.tracker = new OutcomeTracker(o.cfg.tracking);
    this.social = new SocialBuzz(o.cfg.social);
    for (const s of ["binance", "coinbase", "coingecko", "trending", "derivatives", "dex", "news", "social", "leverage", "discord"] as const) {
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
    for (const [k, v] of Object.entries(st.volatility ?? {})) this.vol.set(k, v);
    if (st.social) this.social = new SocialBuzz(this.cfg.social, st.social);
    this.lastBias = new Map(Object.entries(st.leverage?.lastBias ?? {}));
    this.perpOi = new Map(Object.entries(st.leverage?.oi ?? {}));
  }

  exportState(extras?: Record<string, unknown>): IntelSavedState {
    return {
      version: 1,
      savedAt: this.now(),
      engine: this.engine.exportState(),
      tracker: this.tracker.exportState(),
      trendingIds: this.trendingIds ? [...this.trendingIds] : null,
      openInterest: Object.fromEntries(this.openInterest),
      volatility: Object.fromEntries(this.vol),
      social: this.social.export(),
      leverage: { lastBias: Object.fromEntries(this.lastBias), oi: Object.fromEntries(this.perpOi) },
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
      cands.push(...detectLive(this.withVol(s, now), this.cfg.binance, "binance"));
    }
    const h = this.health.get("binance");
    if (h) {
      h.items = tracker.coins().length;
      h.lastSuccessAt = now;
    }
    this.emit(this.ingest(cands, now), []);
  }

  /** Binance all-market REST snapshot (scheduled worker without WebSocket). */
  onBinanceTickers(tickers: BinanceMiniRestTicker[], history: BinanceRestHistory, now = this.now(), flow?: Map<string, number>) {
    const snaps = history.update(tickers, now);
    const cands: Candidate[] = [];
    for (const s of snaps) {
      this.engine.upsertLive(s, now, "binance");
      cands.push(...detectLive({ ...this.withVol(s, now), takerBuyRatio: flow?.get(s.coin) ?? null }, this.cfg.binance, "binance"));
    }
    this.setSourceState("binance", "ok", `${snaps.length} cryptos (Binance, relevé toutes les 20 s)`, now, snaps.length);
    this.emit(this.ingest(cands, now), []);
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
      for (const c of detectLive(this.withVol(s, now), this.cfg.binance, "coinbase")) cands.push({ ...c, url: `https://www.coinbase.com/advanced-trade/spot/${s.pair}` });
    }
    this.setSourceState("coinbase", "ok", `${snaps.length} cryptos cotées sur Coinbase, dont ${live} suivies via Coinbase (absentes du flux Binance)`, now, snaps.length);
    this.emit(this.ingest(cands, now), []);
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
    this.emit(this.ingest(cands, now), []);
  }

  onMarkets(rows: CgMarketRow[], _page: number, now = this.now()) {
    this.engine.upsertMarkets(rows, now);
    const cands = rows.flatMap((r) => detectMarketRow(r, this.cfg.coingecko));
    this.emit(this.ingest(cands, now), []);
  }

  onTrending(list: TrendingCoin[], now = this.now()) {
    const cands = detectTrendingEntries(list, this.trendingIds, (s) => this.engine.priceOf(s));
    this.trendingIds = new Set(list.map((c) => c.id));
    this.engine.setTrending(list, now);
    this.emit(this.ingest(cands, now), []);
  }

  onDerivatives(rows: CgDerivative[], now = this.now()) {
    this.lastDerivatives = rows;
    const agg = aggregateDerivatives(rows);
    this.engine.setDerivatives(agg, now);
    const cands: Candidate[] = [];
    for (const a of agg.values()) {
      // Only coins of the universe: derivative index ids are tickers and may be ambiguous otherwise.
      if (!this.engine.coin(a.coin)) continue;
      cands.push(...detectDerivatives(a, this.openInterest.get(a.coin) ?? null, this.cfg.coingecko, this.engine.priceOf(a.coin)));
      this.openInterest.set(a.coin, a.openInterestUsd);
    }
    this.emit(this.ingest(cands, now), []);
  }

  onPools(doc: GtPools, isNewList: boolean, now = this.now()) {
    this.emit(this.ingest(detectPools(doc, this.cfg.coingecko.dex, now, isNewList), now), []);
  }

  onNews(feedName: string, raw: RawFeedItem[], now = this.now()) {
    this.refreshMatcher(now);
    const items = raw.map((r) => toNewsItem(r, feedName, this.matcher));
    const r = this.engine.addNews(items, now);
    r.signals = r.signals.filter((x) => !isNoiseCoin(x.coin));
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
      if (s.source !== "dex" && s.source !== "leverage") this.tracker.track(s, this.engine.priceOf("BTC"));
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

  // ─── Refinement: noise filter, calibration from results, market context ──

  /** Learn each coin's usual 5-min move (EWMA of |5-min change|, one sample per minute). */
  private withVol<T extends { coin: string; change5m: number | null }>(s: T, now: number): T & { vol5m: number | null } {
    const e = this.vol.get(s.coin);
    if (s.change5m !== null && Number.isFinite(s.change5m) && (!e || now - e.at >= 60_000)) {
      const a = Math.abs(s.change5m);
      this.vol.set(s.coin, e ? { ewma: e.ewma * 0.97 + a * 0.03, n: e.n + 1, at: now } : { ewma: a, n: 1, at: now });
    }
    const v = this.vol.get(s.coin);
    return { ...s, vol5m: v && v.n >= 30 ? v.ewma : null };
  }

  marketContext(): MarketContext {
    const b = this.engine.coin("BTC");
    const c1 = b?.live?.change1h ?? b?.change1h ?? null;
    const c24 = b?.change24h ?? null;
    if (c1 === null) return { btcChange1h: null, btcChange24h: c24, regime: "inconnu", note: "Bitcoin pas encore mesuré" };
    const regime = c1 <= -1.5 ? "baisse" : c1 >= 1.5 ? "hausse" : "calme";
    return { btcChange1h: c1, btcChange24h: c24, regime, note: regime === "calme" ? `marché calme (Bitcoin ${c1 > 0 ? "+" : ""}${c1.toFixed(2)} % en 1 h)` : `marché en ${regime} (Bitcoin ${c1 > 0 ? "+" : ""}${c1.toFixed(2)} % en 1 h)` };
  }

  /** Measured reliability of a kind × direction (1 h, relative to Bitcoin when possible). */
  private reliability(kind: string, direction: Direction): { p: number; n: number } | null {
    const k = this.stats().find((x) => x.kind === kind && x.direction === direction);
    const h = k?.horizons["60"];
    if (!h) return null;
    const n = h.excessN >= 20 ? h.excessN : h.n;
    const rate = h.excessN >= 20 ? h.excessHitRatePct : h.hitRatePct;
    if (n < 20 || rate === null) return null;
    return { p: rate / 100, n };
  }

  private ingest(cands: Candidate[], now: number): IntelSignal[] {
    const ctx = this.marketContext();
    const out: Candidate[] = [];
    for (const c0 of cands) {
      if (isNoiseCoin(c0.coin)) continue; // stablecoins, wrapped / staked copies
      const c = { ...c0, reasons: [...c0.reasons] };
      // 1. Reliability measured on past outcomes (shrunk towards 50 % while data is thin).
      const r = this.reliability(c.kind, c.direction);
      if (r) {
        const hits = r.p * r.n;
        const p = (hits + 5) / (r.n + 10);
        const factor = Math.max(0.7, Math.min(1.3, 0.5 + p));
        c.strength = c.strength * factor;
        c.reasons.push(`fiabilité mesurée de ce type de signal : ${(r.p * 100).toFixed(0)} % de réussite à 1 h (${r.n} mesures)`);
      }
      // 2. Market context: fighting a strong Bitcoin move rarely works for smaller coins.
      if (ctx.btcChange1h !== null && c.coin !== "BTC" && ctx.regime !== "calme" && c.direction !== "neutral" && c.source !== "leverage") {
        const against = (ctx.regime === "baisse" && c.direction === "bullish") || (ctx.regime === "hausse" && c.direction === "bearish");
        c.strength *= against ? 0.8 : 1.1;
        c.reasons.push(against ? `prudence : ${ctx.note}, signal à contre-courant` : `porté par le marché : ${ctx.note}`);
      }
      c.strength = Math.max(0, Math.min(100, Math.round(c.strength)));
      out.push(c);
    }
    return this.engine.ingest(out, now);
  }

  // ─── Social, liquidations, leveraged markets ─────────────────────────────

  /** Reddit (or other social) posts: attention spikes per coin. */
  onSocial(feed: string, raw: RawFeedItem[], now = this.now()) {
    this.refreshMatcher(now);
    const posts: SocialPost[] = raw.map((r) => {
      const n = toNewsItem(r, feed, this.matcher);
      return { id: n.id, ts: n.ts, coins: n.coins, direction: n.direction, title: n.title, link: n.link, feed };
    });
    this.setSourceState("social", "ok", `${posts.length} posts lus (${feed})`, now, posts.length);
    this.emit(this.ingest(this.social.add(posts, now), now), []);
  }

  /** Binance USDⓈ-M liquidation orders (`!forceOrder@arr`): side SELL = a long was liquidated. */
  onLiquidations(list: { symbol: string; side: "BUY" | "SELL"; usd: number; ts: number }[], now = this.now()) {
    const cands: Candidate[] = [];
    const touched = new Set<string>();
    for (const l of list) {
      const coin = l.symbol.replace(/(USDT|USDC|BUSD)$/, "");
      if (!coin || !(l.usd > 0)) continue;
      const arr = this.liq.get(coin) ?? [];
      arr.push({ ts: l.ts, side: l.side === "SELL" ? "long" : "short", usd: l.usd });
      this.liq.set(coin, arr);
      touched.add(coin);
    }
    for (const coin of touched) {
      const arr = (this.liq.get(coin) ?? []).filter((x) => x.ts > now - 5 * 60_000);
      this.liq.set(coin, arr);
      for (const side of ["long", "short"] as const) {
        const xs = arr.filter((x) => x.side === side);
        const usd = xs.reduce((a, x) => a + x.usd, 0);
        if (usd < this.cfg.leverage.liquidationUsd5m || xs.length < 3) continue;
        const longs = side === "long";
        cands.push({
          coin,
          coinName: null,
          kind: longs ? "LIQUIDATIONS_LONG" : "LIQUIDATIONS_SHORT",
          direction: longs ? "bearish" : "bullish",
          source: "derivatives",
          strength: Math.round(Math.min(95, 55 + Math.log10(usd / this.cfg.leverage.liquidationUsd5m) * 25 + xs.length)),
          title: `${coin} : ${(usd / 1e6).toFixed(2)} M$ de positions ${longs ? "LONGUES" : "COURTES"} liquidées en 5 min`,
          reasons: [`${xs.length} liquidations forcées sur Binance Futures en 5 min`, longs ? "les acheteurs à levier sont éjectés : la chute peut s'accélérer (cascade)" : "les vendeurs à découvert sont éjectés : short squeeze, la hausse peut s'accélérer", "après une grosse cascade, un rebond rapide est aussi fréquent"],
          metrics: { liquidatedUsd5m: Math.round(usd), liquidations5m: xs.length },
          priceUsd: null,
          url: `https://www.binance.com/en/futures/${coin}USDT`,
        });
      }
    }
    this.setSourceState("derivatives", "ok", null, now);
    this.emit(this.ingest(cands, now), []);
  }

  /**
   * Coinbase perpetual markets: reading per market and LONG / SHORT setup
   * signals when the score crosses the configured level.
   */
  onPerps(markets: PerpMarket[], extras: Map<string, { takerBuyRatio?: number | null; longShortRatio?: number | null }>, now = this.now()) {
    const ctx = this.marketContext();
    const board: LeverageReading[] = [];
    const cands: Candidate[] = [];
    for (const m of markets) {
      const row = this.engine.coin(m.coin);
      const prevOi = this.perpOi.get(m.productId);
      if (m.openInterest !== null) this.perpOi.set(m.productId, m.openInterest);
      const recent = this.engine.recentSignals({ coin: m.coin, since: now - 2 * 3_600_000, limit: 30 }).filter((s) => s.source !== "leverage");
      const x = extras.get(m.coin);
      const reading = readLeverage(m, {
        change15m: row?.live?.change15m ?? null,
        change1h: row?.live?.change1h ?? row?.change1h ?? null,
        takerBuyRatio: x?.takerBuyRatio ?? null,
        binanceFundingPct: row?.fundingRatePct ?? null,
        longShortRatio: x?.longShortRatio ?? null,
        oiChangePct: prevOi && m.openInterest !== null && prevOi > 0 ? ((m.openInterest - prevOi) / prevOi) * 100 : null,
        recent: recent.map((s) => ({ direction: s.direction, strength: s.strength, kind: s.kind })),
        btcChange1h: ctx.btcChange1h,
      });
      board.push(reading);
      const setup = Math.abs(reading.score) >= this.cfg.leverage.signalScore ? reading.bias : "NEUTRE";
      const last = this.lastBias.get(m.productId) ?? "NEUTRE";
      if (setup !== last) this.lastBias.set(m.productId, setup);
      if (setup !== "NEUTRE" && setup !== last) {
        const long = setup === "LONG";
        cands.push({
          coin: m.coin,
          coinName: row?.name ?? null,
          kind: long ? "LEVERAGE_LONG" : "LEVERAGE_SHORT",
          direction: long ? "bullish" : "bearish",
          source: "leverage",
          strength: Math.min(100, Math.abs(reading.score)),
          title: `${m.name} : indication ${setup} (score ${reading.score})${m.maxLeverage ? ` — levier max ×${m.maxLeverage}` : ""}`,
          reasons: [...reading.reasons, reading.liquidationMovePct !== null ? `⚠️ au levier max, ${reading.liquidationMovePct} % contre toi = liquidation` : "⚠️ levier : pertes amplifiées", "lecture statistique, pas un conseil"],
          metrics: { productId: m.productId, score: reading.score, maxLeverage: m.maxLeverage, fundingRatePct: m.fundingPct, openInterest: m.openInterest },
          priceUsd: m.price,
          url: m.url,
        });
      }
    }
    this.leverageBoard = board.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
    this.leverageAt = now;
    this.setSourceState("leverage", "ok", `${markets.length} marchés perpétuels Coinbase`, now, markets.length);
    this.emit(this.ingest(cands, now), []);
  }

  /** Candidates produced outside the built-in sources (e.g. new listings detected by the bot). */
  ingestExternal(cands: Candidate[], now = this.now()) {
    this.emit(this.ingest(cands, now), []);
  }

  /** Last-resort list of leveraged markets: Binance Futures perpetuals from the CoinGecko data. */
  perpsFromDerivatives(limit = 100): PerpMarket[] {
    const out: PerpMarket[] = [];
    const seen = new Set<string>();
    const rows = this.lastDerivatives.filter((r) => (r.contract_type ?? "").toLowerCase() === "perpetual" && r.index_id).sort((a, b) => (b.open_interest ?? 0) - (a.open_interest ?? 0));
    for (const r of rows) {
      const coin = (r.index_id as string).toUpperCase();
      if (seen.has(coin)) continue;
      seen.add(coin);
      out.push({ productId: `${r.symbol}-BINANCE`, coin, name: `${coin} perpétuel`, venue: "Binance Futures", maxLeverage: null, price: r.price, change24h: r.price_percentage_change_24h, fundingPct: r.funding_rate, openInterest: r.open_interest, volume24hUsd: r.volume_24h, url: `https://www.binance.com/en/futures/${r.symbol}` });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Where the leveraged markets came from (or why none could be read). */
  setPerpDiagnostics(sources: string[], errors: string[], now = this.now()) {
    this.perpDiag = { sources, errors, triedAt: now };
    if (!sources.length) this.setSourceState("leverage", "down", `aucune source de marchés à levier : ${errors.join(" · ")}`, now);
  }

  leverage() {
    return { at: this.leverageAt, markets: this.leverageBoard, context: this.marketContext(), sources: this.perpDiag.sources, errors: this.perpDiag.errors, triedAt: this.perpDiag.triedAt };
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
    if (h && h.excessN >= 10) return h.excessHitRatePct;
    return h && h.n >= 10 ? h.hitRatePct : null;
  }

  feed(f: IntelFilter) {
    const signals = this.engine.recentSignals(f);
    return { signals: signals.map((s) => ({ ...s, hitRate1h: this.hitRateOf(s) })), counts: this.counts(), market: this.marketContext() };
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
