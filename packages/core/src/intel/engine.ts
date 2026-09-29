/**
 * IntelEngine — merges every source into one feed of signals and news,
 * de-duplicates (cooldown per coin × kind), detects CONFLUENCE (several
 * independent sources agreeing on a coin), and keeps the merged universe.
 * Pure and deterministic: time is passed in.
 */
import type { IntelConfig } from "./config.js";
import type { Candidate, DerivativesAggregate, LiveSnapshot, TrendingCoin } from "./detectors.js";
import type { CgMarketRow } from "./schemas.js";
import type { CoinRow, Direction, IntelSignal, IntelSource, NewsItem } from "./types.js";

const MAX_SIGNALS = 5000;
const MAX_NEWS = 3000;
/** Sources that can be combined for confluence (DEX symbols are ambiguous across tokens). */
const CONFLUENCE_SOURCES: ReadonlySet<IntelSource> = new Set(["binance", "coinbase", "coingecko", "trending", "derivatives", "news"]);
/**
 * Independent families of evidence. Binance, Coinbase and CoinGecko all see
 * the same price move, so they count as ONE family: a confluence needs
 * agreement between different kinds of information (price, attention, leverage).
 */
const FAMILY: Partial<Record<IntelSource, string>> = { binance: "prix", coinbase: "prix", coingecko: "prix", trending: "attention", news: "actualités", derivatives: "dérivés" };

export interface IntelFilter {
  direction?: Direction;
  sources?: IntelSource[];
  kinds?: string[];
  coin?: string;
  minStrength?: number;
  since?: number;
  limit?: number;
}

export class IntelEngine {
  private readonly signals: IntelSignal[] = [];
  private readonly news: NewsItem[] = [];
  private readonly newsIds = new Set<string>();
  private readonly lastEmit = new Map<string, number>();
  private readonly universe = new Map<string, CoinRow>();
  private seq = 0;

  constructor(
    private cfg: IntelConfig,
    private readonly idFactory: () => string = () => `i${Date.now().toString(36)}${(++this.seq).toString(36)}`,
  ) {}

  updateConfig(cfg: IntelConfig) {
    this.cfg = cfg;
  }

  // ─── Universe ────────────────────────────────────────────────────────────

  private row(symbol: string, now: number): CoinRow {
    const s = symbol.toUpperCase();
    let r = this.universe.get(s);
    if (!r) {
      r = {
        symbol: s,
        name: s,
        coingeckoId: null,
        priceUsd: null,
        marketCapUsd: null,
        rank: null,
        volume24hUsd: null,
        change1h: null,
        change24h: null,
        change7d: null,
        athChangePct: null,
        live: null,
        onCoinbase: false,
        onBinance: false,
        trendingRank: null,
        fundingRatePct: null,
        openInterestUsd: null,
        lastSignalAt: null,
        updatedAt: now,
      };
      this.universe.set(s, r);
    }
    return r;
  }

  upsertMarkets(rows: CgMarketRow[], now: number) {
    for (const m of rows) {
      const sym = m.symbol.toUpperCase();
      const existing = this.universe.get(sym);
      // Symbol collisions: keep the higher-ranked coin.
      if (existing?.coingeckoId && existing.coingeckoId !== m.id && (existing.rank ?? 1e9) < (m.market_cap_rank ?? 1e9)) continue;
      const r = this.row(sym, now);
      r.name = m.name;
      r.coingeckoId = m.id;
      r.priceUsd = r.live && now - r.live.updatedAt < 120_000 ? r.live.price : m.current_price;
      r.marketCapUsd = m.market_cap;
      r.rank = m.market_cap_rank;
      r.volume24hUsd = m.total_volume;
      r.change1h = m.price_change_percentage_1h_in_currency;
      r.change24h = m.price_change_percentage_24h_in_currency ?? m.price_change_percentage_24h;
      r.change7d = m.price_change_percentage_7d_in_currency;
      r.athChangePct = m.ath_change_percentage;
      r.updatedAt = now;
    }
  }

  upsertLive(s: LiveSnapshot, now: number, source: "binance" | "coinbase") {
    const r = this.row(s.coin, now);
    r.live = { price: s.priceUsd, change5m: s.change5m, change15m: s.change15m, change1h: s.change1h, volumeRatio1h: s.volumeRatio1h, updatedAt: now };
    r.priceUsd = s.priceUsd;
    if (source === "binance") r.onBinance = true;
    else r.onCoinbase = true;
    if (r.volume24hUsd === null) r.volume24hUsd = s.volume24hUsd;
    r.updatedAt = now;
  }

  markCoinbase(symbols: Iterable<string>, now: number) {
    for (const s of symbols) this.row(s, now).onCoinbase = true;
  }

  setTrending(list: TrendingCoin[], now: number) {
    for (const r of this.universe.values()) r.trendingRank = null;
    for (const c of list) {
      const r = this.row(c.symbol, now);
      if (r.name === r.symbol) r.name = c.name;
      r.coingeckoId ??= c.id;
      r.trendingRank = c.rank + 1;
    }
  }

  setDerivatives(agg: Map<string, DerivativesAggregate>, now: number) {
    for (const a of agg.values()) {
      const r = this.universe.get(a.coin);
      if (!r) continue;
      r.fundingRatePct = a.fundingRatePct;
      r.openInterestUsd = a.openInterestUsd;
      r.updatedAt = now;
    }
  }

  priceOf(symbol: string): number | null {
    return this.universe.get(symbol.toUpperCase())?.priceUsd ?? null;
  }

  coin(symbol: string): CoinRow | undefined {
    return this.universe.get(symbol.toUpperCase());
  }

  universeRows(): CoinRow[] {
    return [...this.universe.values()];
  }

  /** Symbols + names for the news matcher, largest coins first. */
  dictionary(): { symbol: string; name: string }[] {
    return [...this.universe.values()]
      .filter((r) => r.name && r.name !== r.symbol)
      .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))
      .map((r) => ({ symbol: r.symbol, name: r.name }));
  }

  // ─── Signals ────────────────────────────────────────────────────────────

  /** Add candidates; returns the signals actually emitted (after cooldown), confluences included. */
  ingest(cands: Candidate[], now: number): IntelSignal[] {
    const emitted: IntelSignal[] = [];
    const cool = this.cfg.cooldownMin * 60_000;
    for (const c of cands) {
      const key = `${c.coin}:${c.kind}`;
      const last = this.lastEmit.get(key);
      if (last !== undefined && now - last < cool) continue;
      this.lastEmit.set(key, now);
      const sig: IntelSignal = { id: this.idFactory(), ts: now, ...c, strength: Math.max(0, Math.min(100, Math.round(c.strength))) };
      if (sig.priceUsd === null) sig.priceUsd = this.priceOf(sig.coin);
      this.push(sig);
      emitted.push(sig);
      const conf = this.confluence(sig, now);
      if (conf) emitted.push(conf);
    }
    return emitted;
  }

  private push(sig: IntelSignal) {
    this.signals.push(sig);
    if (this.signals.length > MAX_SIGNALS) this.signals.splice(0, this.signals.length - MAX_SIGNALS);
    const r = this.universe.get(sig.coin);
    if (r) r.lastSignalAt = sig.ts;
  }

  private confluence(sig: IntelSignal, now: number): IntelSignal | null {
    if (sig.direction === "neutral" || !CONFLUENCE_SOURCES.has(sig.source)) return null;
    const since = now - this.cfg.confluence.windowMin * 60_000;
    const related: IntelSignal[] = [];
    for (let i = this.signals.length - 1; i >= 0; i--) {
      const s = this.signals[i] as IntelSignal;
      if (s.ts < since) break;
      if (s.coin === sig.coin && s.direction === sig.direction && s.kind !== "CONFLUENCE" && CONFLUENCE_SOURCES.has(s.source)) related.push(s);
    }
    const sources = new Set(related.map((s) => s.source));
    const families = new Set(related.map((s) => FAMILY[s.source] ?? s.source));
    if (families.size < this.cfg.confluence.minSources) return null;
    const key = `${sig.coin}:CONFLUENCE:${sig.direction}`;
    const last = this.lastEmit.get(key);
    if (last !== undefined && now - last < this.cfg.cooldownMin * 60_000) return null;
    this.lastEmit.set(key, now);
    const top = Math.max(...related.map((s) => s.strength));
    const up = sig.direction === "bullish";
    const conf: IntelSignal = {
      id: this.idFactory(),
      ts: now,
      coin: sig.coin,
      coinName: related.find((s) => s.coinName)?.coinName ?? this.universe.get(sig.coin)?.name ?? null,
      kind: "CONFLUENCE",
      direction: sig.direction,
      source: sig.source,
      strength: Math.min(100, top + 8 * (families.size - 1)),
      title: `${up ? "🚀" : "📉"} ${sig.coin} : ${families.size} types d'indices indépendants ${up ? "haussiers" : "baissiers"} (${[...families].join(" + ")}) en ${this.cfg.confluence.windowMin} min`,
      reasons: related.slice(0, 8).map((s) => `[${s.source}] ${s.title}`),
      metrics: { sources: [...sources].join(","), families: [...families].join(","), signals: related.length, topStrength: top },
      priceUsd: sig.priceUsd ?? this.priceOf(sig.coin),
      url: related.find((s) => s.url)?.url ?? null,
      related: related.map((s) => s.id),
    };
    this.push(conf);
    return conf;
  }

  // ─── News ────────────────────────────────────────────────────────────────

  /** Add news items; returns new items and NEWS_* signals for coins with a clear direction. */
  addNews(items: NewsItem[], now: number): { news: NewsItem[]; signals: IntelSignal[] } {
    const fresh = items.filter((n) => !this.newsIds.has(n.id)).sort((a, b) => a.ts - b.ts);
    const cands: Candidate[] = [];
    for (const n of fresh) {
      this.newsIds.add(n.id);
      this.news.push(n);
      if (n.direction === "neutral" || now - n.ts > 6 * 3_600_000) continue; // old news does not signal
      for (const coin of n.coins.slice(0, 3)) {
        const echoes = this.news.filter((o) => o.coins.includes(coin) && o.direction === n.direction && now - o.ts < 3 * 3_600_000).length;
        const feeds = new Set(this.news.filter((o) => o.coins.includes(coin) && now - o.ts < 3 * 3_600_000).map((o) => o.feed)).size;
        cands.push({
          coin,
          coinName: this.universe.get(coin)?.name ?? null,
          kind: n.direction === "bullish" ? "NEWS_BULLISH" : "NEWS_BEARISH",
          direction: n.direction,
          source: "news",
          strength: Math.min(90, 50 + n.tags.length * 8 + (feeds - 1) * 7 + (echoes - 1) * 3),
          title: `${n.direction === "bullish" ? "📰🟢" : "📰🔴"} ${coin} — ${n.title}`,
          reasons: [`source : ${n.feed}`, `mots-clés : ${n.tags.join(", ")}`, feeds > 1 ? `relayé par ${feeds} médias en 3 h` : "un seul média pour l'instant"],
          metrics: { feed: n.feed, feeds, tags: n.tags.join(","), newsId: n.id },
          priceUsd: this.priceOf(coin),
          url: n.link,
        });
      }
    }
    if (this.news.length > MAX_NEWS) {
      for (const old of this.news.splice(0, this.news.length - MAX_NEWS)) this.newsIds.delete(old.id);
    }
    return { news: fresh, signals: this.ingest(cands, now) };
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  recentSignals(f: IntelFilter = {}): IntelSignal[] {
    const out: IntelSignal[] = [];
    const limit = f.limit ?? 300;
    for (let i = this.signals.length - 1; i >= 0 && out.length < limit; i--) {
      const s = this.signals[i] as IntelSignal;
      if (f.since !== undefined && s.ts < f.since) break;
      if (f.direction && s.direction !== f.direction) continue;
      if (f.sources?.length && !f.sources.includes(s.source)) continue;
      if (f.kinds?.length && !f.kinds.includes(s.kind)) continue;
      if (f.coin && s.coin !== f.coin.toUpperCase()) continue;
      if (f.minStrength !== undefined && s.strength < f.minStrength) continue;
      out.push(s);
    }
    return out;
  }

  recentNews(f: { coin?: string; direction?: Direction; limit?: number } = {}): NewsItem[] {
    const out: NewsItem[] = [];
    const sorted = [...this.news].sort((a, b) => b.ts - a.ts);
    for (const n of sorted) {
      if (out.length >= (f.limit ?? 200)) break;
      if (f.coin && !n.coins.includes(f.coin.toUpperCase())) continue;
      if (f.direction && n.direction !== f.direction) continue;
      out.push(n);
    }
    return out;
  }

  /** Persistence helpers. */
  exportState() {
    return { signals: this.signals.slice(-1500), news: this.news.slice(-800) };
  }

  importState(s: { signals?: IntelSignal[]; news?: NewsItem[] }) {
    for (const sig of s.signals ?? []) this.signals.push(sig);
    for (const n of s.news ?? []) if (!this.newsIds.has(n.id)) {
      this.newsIds.add(n.id);
      this.news.push(n);
    }
  }
}
