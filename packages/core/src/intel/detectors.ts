/**
 * Signal detectors — pure functions, one per source. They turn raw data
 * into candidate signals with a 0–100 strength and plain-language reasons.
 * Strength = how far beyond the threshold the measure is, damped by
 * liquidity. It is a signal-quality score, not a return forecast.
 */
import type { IntelConfig } from "./config.js";
import type { CgDerivative, CgMarketRow, GtPools } from "./schemas.js";
import type { Direction, IntelKind, IntelSource } from "./types.js";

export interface Candidate {
  coin: string;
  coinName: string | null;
  kind: IntelKind;
  direction: Direction;
  source: IntelSource;
  strength: number;
  title: string;
  reasons: string[];
  metrics: Record<string, number | string | null>;
  priceUsd: number | null;
  url: string | null;
}

const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(d)}`);
const usd = (x: number | null | undefined) => {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)} Md$`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(2)} M$`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)} k$`;
  return `${x.toFixed(0)} $`;
};
const px = (p: number) => (p >= 1 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: p >= 1000 ? 0 : 4 })}` : `$${p.toPrecision(4)}`);
/** Map ratio = value/threshold (≥ 1) to a strength: threshold → 55, 3× threshold → 100. */
export const strengthFromRatio = (ratio: number, base = 55) => clamp(base + (Math.max(0, ratio - 1) / 2) * (100 - base));
/** Liquidity damping in [0.6, 1]: thin markets produce weaker (less reliable) signals. */
export const liquidityFactor = (volume24hUsd: number | null) =>
  volume24hUsd === null || volume24hUsd <= 0 ? 0.6 : Math.min(1, 0.6 + 0.4 * (Math.log10(volume24hUsd) - 5) / 3);

// ─── Live exchange snapshot (Binance all-market) ───────────────────────────

export interface LiveSnapshot {
  coin: string;
  pair: string;
  priceUsd: number;
  change5m: number | null;
  change15m: number | null;
  change1h: number | null;
  /** 1 h quote volume / (24 h quote volume / 24). */
  volumeRatio1h: number | null;
  volume24hUsd: number;
  high24h: number;
  low24h: number;
}

export function detectLive(s: LiveSnapshot, cfg: IntelConfig["binance"], source: IntelSource = "binance"): Candidate[] {
  if (s.volume24hUsd < cfg.minVolume24hUsd) return [];
  const out: Candidate[] = [];
  const liq = liquidityFactor(s.volume24hUsd);
  const url = source === "binance" ? `https://www.binance.com/en/trade/${s.pair.replace(/(USDT|USDC|FDUSD)$/, "_$1")}` : null;
  const base = { coin: s.coin, coinName: null, source, priceUsd: s.priceUsd, url };
  const metrics = { pair: s.pair, change5m: s.change5m, change15m: s.change15m, change1h: s.change1h, volumeRatio1h: s.volumeRatio1h, volume24hUsd: s.volume24hUsd };
  const vol = s.volumeRatio1h !== null && s.volumeRatio1h >= 1.5 ? ` avec volume ${s.volumeRatio1h.toFixed(1)}x la moyenne` : "";

  const up = Math.max((s.change5m ?? 0) / cfg.pumpPct5m, (s.change15m ?? 0) / cfg.pumpPct15m);
  if (up >= 1) {
    const volBoost = s.volumeRatio1h !== null ? Math.min(1.3, 0.85 + s.volumeRatio1h / 20) : 0.9;
    out.push({
      ...base,
      kind: "PUMP_EARLY",
      direction: "bullish",
      strength: Math.round(clamp(strengthFromRatio(up) * liq * volBoost)),
      title: `${s.coin} décolle : ${f(s.change5m)} % en 5 min, ${f(s.change15m)} % en 15 min${vol}`,
      reasons: [`variation 5 min ${f(s.change5m)} % (seuil ${cfg.pumpPct5m} %)`, `variation 15 min ${f(s.change15m)} % (seuil ${cfg.pumpPct15m} %)`, `volume 24 h ${usd(s.volume24hUsd)} sur ${s.pair}`],
      metrics,
    });
  }
  const down = Math.max(-(s.change5m ?? 0) / cfg.dumpPct5m, -(s.change15m ?? 0) / cfg.dumpPct15m);
  if (down >= 1) {
    out.push({
      ...base,
      kind: "DUMP_EARLY",
      direction: "bearish",
      strength: Math.round(clamp(strengthFromRatio(down) * liq)),
      title: `${s.coin} chute : ${f(s.change5m)} % en 5 min, ${f(s.change15m)} % en 15 min${vol}`,
      reasons: [`variation 5 min ${f(s.change5m)} % (seuil −${cfg.dumpPct5m} %)`, `variation 15 min ${f(s.change15m)} % (seuil −${cfg.dumpPct15m} %)`],
      metrics,
    });
  }
  if (s.volumeRatio1h !== null && s.volumeRatio1h >= cfg.volumeSurgeRatio) {
    const dir: Direction = (s.change1h ?? 0) > 1 ? "bullish" : (s.change1h ?? 0) < -1 ? "bearish" : "neutral";
    out.push({
      ...base,
      kind: "VOLUME_SURGE",
      direction: dir,
      strength: Math.round(clamp(strengthFromRatio(s.volumeRatio1h / cfg.volumeSurgeRatio, 50) * liq)),
      title: `${s.coin} : volume de la dernière heure ${s.volumeRatio1h.toFixed(1)}x la moyenne (prix ${f(s.change1h)} % sur 1 h)`,
      reasons: [`volume 1 h ${s.volumeRatio1h.toFixed(1)}x la moyenne horaire des 24 h (seuil ${cfg.volumeSurgeRatio}x)`, `prix 1 h ${f(s.change1h)} %`],
      metrics,
    });
  }
  const range = s.high24h - s.low24h;
  if (range > 0 && s.priceUsd >= s.high24h && (s.change15m ?? 0) > 1) {
    out.push({
      ...base,
      kind: "BREAKOUT_24H_HIGH",
      direction: "bullish",
      strength: Math.round(clamp((55 + Math.min(30, (s.change15m ?? 0) * 3)) * liq)),
      title: `${s.coin} casse son plus haut 24 h (${px(s.priceUsd)})`,
      reasons: [`prix au plus haut des 24 h`, `15 min ${f(s.change15m)} %`],
      metrics,
    });
  }
  if (range > 0 && s.priceUsd <= s.low24h && (s.change15m ?? 0) < -1) {
    out.push({
      ...base,
      kind: "BREAKDOWN_24H_LOW",
      direction: "bearish",
      strength: Math.round(clamp((55 + Math.min(30, -(s.change15m ?? 0) * 3)) * liq)),
      title: `${s.coin} casse son plus bas 24 h (${px(s.priceUsd)})`,
      reasons: [`prix au plus bas des 24 h`, `15 min ${f(s.change15m)} %`],
      metrics,
    });
  }
  return out;
}

// ─── Aggregator universe (CoinGecko /coins/markets) ────────────────────────

export function detectMarketRow(r: CgMarketRow, cfg: IntelConfig["coingecko"]): Candidate[] {
  const mcap = r.market_cap ?? 0;
  if (mcap < cfg.minMarketCapUsd || r.current_price === null) return [];
  const coin = r.symbol.toUpperCase();
  const ch1h = r.price_change_percentage_1h_in_currency;
  const ch24h = r.price_change_percentage_24h_in_currency ?? r.price_change_percentage_24h;
  const vol = r.total_volume;
  const volMcap = vol !== null && mcap > 0 ? vol / mcap : null;
  const liq = liquidityFactor(vol);
  const base = { coin, coinName: r.name, source: "coingecko" as const, priceUsd: r.current_price, url: `https://www.coingecko.com/en/coins/${r.id}` };
  const metrics = { coingeckoId: r.id, rank: r.market_cap_rank, marketCapUsd: mcap, volume24hUsd: vol, volumeMcap: volMcap, change1h: ch1h, change24h: ch24h, change7d: r.price_change_percentage_7d_in_currency, athChangePct: r.ath_change_percentage };
  const rank = r.market_cap_rank ? `#${r.market_cap_rank}` : "non classé";
  const out: Candidate[] = [];
  if (ch1h !== null && ch1h >= cfg.moverPct1h) {
    out.push({
      ...base,
      kind: "TOP_MOVER_1H",
      direction: "bullish",
      strength: Math.round(clamp(strengthFromRatio(ch1h / cfg.moverPct1h) * liq)),
      title: `${r.name} (${coin}, ${rank}) : ${f(ch1h)} % en 1 h`,
      reasons: [`1 h ${f(ch1h)} % (seuil ${cfg.moverPct1h} %)`, `24 h ${f(ch24h)} %`, `capitalisation ${usd(mcap)}, volume ${usd(vol)}`],
      metrics,
    });
  }
  if (ch1h !== null && ch1h <= -cfg.crashPct1h) {
    out.push({
      ...base,
      kind: "CRASH_1H",
      direction: "bearish",
      strength: Math.round(clamp(strengthFromRatio(-ch1h / cfg.crashPct1h) * liq)),
      title: `${r.name} (${coin}, ${rank}) s'effondre : ${f(ch1h)} % en 1 h`,
      reasons: [`1 h ${f(ch1h)} % (seuil −${cfg.crashPct1h} %)`, `24 h ${f(ch24h)} %`],
      metrics,
    });
  }
  if (volMcap !== null && volMcap >= cfg.volumeMcapRatio) {
    const dir: Direction = (ch24h ?? 0) > 3 ? "bullish" : (ch24h ?? 0) < -3 ? "bearish" : "neutral";
    out.push({
      ...base,
      kind: "VOLUME_MCAP_ANOMALY",
      direction: dir,
      strength: Math.round(clamp(strengthFromRatio(volMcap / cfg.volumeMcapRatio, 50) * liq)),
      title: `${r.name} (${coin}) : volume 24 h = ${(volMcap * 100).toFixed(0)} % de sa capitalisation`,
      reasons: [`volume/capitalisation ${volMcap.toFixed(2)} (seuil ${cfg.volumeMcapRatio})`, `24 h ${f(ch24h)} %`, "rotation anormale : forte spéculation (pump ou distribution)"],
      metrics,
    });
  }
  const athCh = r.ath_change_percentage;
  if (athCh !== null && athCh >= -cfg.nearAthPct && (ch24h ?? 0) > 2) {
    out.push({
      ...base,
      kind: "NEAR_ATH",
      direction: "bullish",
      strength: Math.round(clamp((60 + Math.min(25, (ch24h ?? 0) * 1.5)) * liq)),
      title: `${r.name} (${coin}) à ${Math.abs(athCh).toFixed(1)} % de son plus haut historique`,
      reasons: [`écart au record ${f(athCh)} %`, `24 h ${f(ch24h)} %`, "zone de découverte de prix"],
      metrics,
    });
  }
  return out;
}

// ─── Trending (CoinGecko /search/trending) ──────────────────────────────────

export interface TrendingCoin {
  id: string;
  symbol: string;
  name: string;
  rank: number;
  marketCapRank: number | null;
}

export function detectTrendingEntries(current: TrendingCoin[], previousIds: ReadonlySet<string> | null, priceOf: (symbol: string) => number | null): Candidate[] {
  if (previousIds === null) return []; // first poll: no "entry" can be claimed
  return current
    .filter((c) => !previousIds.has(c.id))
    .map((c) => ({
      coin: c.symbol.toUpperCase(),
      coinName: c.name,
      kind: "TRENDING_ENTRY" as const,
      direction: "bullish" as const,
      source: "trending" as const,
      strength: Math.round(clamp(80 - c.rank * 3 - (c.marketCapRank && c.marketCapRank < 100 ? 10 : 0), 40, 85)),
      title: `${c.name} (${c.symbol.toUpperCase()}) entre dans les tendances CoinGecko (#${c.rank + 1})`,
      reasons: [`nouvelle entrée dans le top des recherches CoinGecko (rang ${c.rank + 1})`, `capitalisation ${c.marketCapRank ? `#${c.marketCapRank}` : "non classée"}`, "l'attention grandit : souvent avant ou pendant un mouvement"],
      metrics: { trendingRank: c.rank + 1, marketCapRank: c.marketCapRank, coingeckoId: c.id },
      priceUsd: priceOf(c.symbol.toUpperCase()),
      url: `https://www.coingecko.com/en/coins/${c.id}`,
    }));
}

// ─── Derivatives (CoinGecko /derivatives) ──────────────────────────────────

export interface DerivativesAggregate {
  coin: string;
  /** Open-interest-weighted funding rate (in %, as returned by CoinGecko — see docs). */
  fundingRatePct: number | null;
  openInterestUsd: number;
  markets: number;
  change24h: number | null;
}

/** Aggregate perpetual tickers per underlying asset. */
export function aggregateDerivatives(rows: CgDerivative[]): Map<string, DerivativesAggregate> {
  const acc = new Map<string, { fw: number; w: number; oi: number; n: number; ch: number[] }>();
  for (const r of rows) {
    if ((r.contract_type ?? "").toLowerCase() !== "perpetual" || !r.index_id) continue;
    const coin = r.index_id.toUpperCase();
    const a = acc.get(coin) ?? { fw: 0, w: 0, oi: 0, n: 0, ch: [] };
    const oi = r.open_interest ?? 0;
    if (r.funding_rate !== null) {
      const w = oi > 0 ? oi : 1;
      a.fw += r.funding_rate * w;
      a.w += w;
    }
    a.oi += oi;
    a.n++;
    if (r.price_percentage_change_24h !== null) a.ch.push(r.price_percentage_change_24h);
    acc.set(coin, a);
  }
  const out = new Map<string, DerivativesAggregate>();
  for (const [coin, a] of acc)
    out.set(coin, {
      coin,
      fundingRatePct: a.w > 0 ? a.fw / a.w : null,
      openInterestUsd: a.oi,
      markets: a.n,
      change24h: a.ch.length ? a.ch.reduce((s, x) => s + x, 0) / a.ch.length : null,
    });
  return out;
}

export function detectDerivatives(cur: DerivativesAggregate, prevOi: number | null, cfg: IntelConfig["coingecko"], priceUsd: number | null): Candidate[] {
  if (cur.openInterestUsd < 5_000_000) return [];
  const out: Candidate[] = [];
  const base = { coin: cur.coin, coinName: null, source: "derivatives" as const, priceUsd, url: null };
  const metrics = { fundingRatePct: cur.fundingRatePct, openInterestUsd: cur.openInterestUsd, markets: cur.markets, change24h: cur.change24h, previousOpenInterestUsd: prevOi };
  const fr = cur.fundingRatePct;
  if (fr !== null && fr >= cfg.fundingExtremePct) {
    out.push({
      ...base,
      kind: "FUNDING_EXTREME_LONG",
      direction: "bearish",
      strength: Math.round(clamp(strengthFromRatio(fr / cfg.fundingExtremePct, 50))),
      title: `${cur.coin} : funding très positif (${fr.toFixed(4)} %) — acheteurs à levier surchargés`,
      reasons: [`funding moyen pondéré ${fr.toFixed(4)} % (seuil ${cfg.fundingExtremePct} %)`, `open interest ${usd(cur.openInterestUsd)} sur ${cur.markets} marchés`, "risque de purge des longs (chute brutale)"],
      metrics,
    });
  }
  if (fr !== null && fr <= -cfg.fundingExtremePct) {
    out.push({
      ...base,
      kind: "FUNDING_EXTREME_SHORT",
      direction: "bullish",
      strength: Math.round(clamp(strengthFromRatio(-fr / cfg.fundingExtremePct, 50))),
      title: `${cur.coin} : funding très négatif (${fr.toFixed(4)} %) — vendeurs à découvert surchargés`,
      reasons: [`funding moyen pondéré ${fr.toFixed(4)} % (seuil −${cfg.fundingExtremePct} %)`, `open interest ${usd(cur.openInterestUsd)}`, "potentiel de short squeeze (hausse brutale)"],
      metrics,
    });
  }
  if (prevOi !== null && prevOi > 0) {
    const d = ((cur.openInterestUsd - prevOi) / prevOi) * 100;
    if (d >= cfg.openInterestSurgePct) {
      const ch = cur.change24h ?? 0;
      out.push({
        ...base,
        kind: "OPEN_INTEREST_SURGE",
        direction: ch > 2 ? "bullish" : ch < -2 ? "bearish" : "neutral",
        strength: Math.round(clamp(strengthFromRatio(d / cfg.openInterestSurgePct, 50))),
        title: `${cur.coin} : open interest ${f(d, 1)} % depuis le dernier relevé`,
        reasons: [`open interest ${usd(prevOi)} → ${usd(cur.openInterestUsd)} (seuil +${cfg.openInterestSurgePct} %)`, `prix 24 h ${f(cur.change24h)} %`, "afflux de positions à levier : mouvement violent probable"],
        metrics: { ...metrics, openInterestChangePct: d },
      });
    }
  }
  return out;
}

// ─── DEX pools (GeckoTerminal via CoinGecko onchain) ───────────────────────

export function detectPools(p: GtPools, cfg: IntelConfig["coingecko"]["dex"], now: number, isNewList: boolean): Candidate[] {
  const tokens = new Map((p.included ?? []).filter((i) => i.type === "token").map((i) => [i.id, i.attributes]));
  const out: Candidate[] = [];
  for (const pool of p.data) {
    const a = pool.attributes;
    const baseId = pool.relationships?.base_token?.data?.id ?? "";
    const tok = tokens.get(baseId);
    const coin = (tok?.symbol ?? a.name.split("/")[0] ?? "?").trim().toUpperCase();
    const network = pool.relationships?.network?.data?.id ?? "?";
    const dex = pool.relationships?.dex?.data?.id ?? "?";
    const reserve = a.reserve_in_usd ?? 0;
    const v1h = a.volume_usd.h1 ?? 0;
    const ch1h = a.price_change_percentage.h1 ?? null;
    const ch5m = a.price_change_percentage.m5 ?? null;
    const tx = a.transactions.h1 ?? {};
    const buys = tx.buys ?? 0;
    const sells = tx.sells ?? 0;
    const ratio = sells > 0 ? buys / sells : buys > 0 ? buys : 0;
    const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
    const ageH = Number.isFinite(created) ? (now - created) / 3_600_000 : null;
    const sus = a.community_sus_report ?? 0;
    const url = `https://www.geckoterminal.com/${network}/pools/${a.address}`;
    const base = { coin, coinName: tok?.name ?? null, source: "dex" as const, priceUsd: a.base_token_price_usd, url };
    const metrics = { pool: a.name, network, dex, reserveUsd: reserve, volume1hUsd: v1h, change5m: ch5m, change1h: ch1h, buys1h: buys, sells1h: sells, poolAgeHours: ageH, suspiciousReports: sus, fdvUsd: a.fdv_usd };
    const where = `${a.name} sur ${dex} (${network})`;

    const rugFlags: string[] = [];
    if (ch1h !== null && ch1h <= -cfg.rugDropPct1h) rugFlags.push(`prix 1 h ${f(ch1h)} %`);
    if (sus > 0) rugFlags.push(`${sus} signalement(s) suspect(s) par la communauté GeckoTerminal`);
    if (reserve > 0 && reserve < cfg.minReserveUsd / 3 && v1h > reserve) rugFlags.push(`liquidité minuscule (${usd(reserve)}) face au volume (${usd(v1h)})`);
    if (sells > buys * 3 && sells > 30) rugFlags.push(`ventes massives (${sells} ventes / ${buys} achats en 1 h)`);
    if (rugFlags.length >= 1 && (ch1h ?? 0) < 0) {
      out.push({ ...base, kind: "DEX_RUG_RISK", direction: "bearish", strength: Math.round(clamp(55 + rugFlags.length * 12)), title: `⚠️ ${coin} : risque de rug / effondrement — ${where}`, reasons: rugFlags, metrics });
      continue;
    }
    if (reserve < cfg.minReserveUsd) continue;
    if (isNewList && ageH !== null && ageH <= cfg.maxPoolAgeHours && v1h >= cfg.minVolume1hUsd && ratio >= cfg.minBuySellRatio) {
      out.push({
        ...base,
        kind: "DEX_NEW_POOL_TRACTION",
        direction: "bullish",
        strength: Math.round(clamp(strengthFromRatio(Math.min(v1h / cfg.minVolume1hUsd, ratio / cfg.minBuySellRatio + 0.5), 50) * (sus > 0 ? 0.7 : 1))),
        title: `Nouveau jeton ${coin} qui prend : ${usd(v1h)} échangés en 1 h — ${where}`,
        reasons: [`pool créé il y a ${ageH.toFixed(1)} h`, `${buys} achats / ${sells} ventes en 1 h (ratio ${ratio.toFixed(1)})`, `liquidité ${usd(reserve)}`, "très risqué : jeton récent, vérifier le contrat avant tout"],
        metrics,
      });
    } else if (ch1h !== null && ch1h >= cfg.pumpPct1h && v1h >= cfg.minVolume1hUsd) {
      out.push({
        ...base,
        kind: "DEX_TRENDING_PUMP",
        direction: "bullish",
        strength: Math.round(clamp(strengthFromRatio(ch1h / cfg.pumpPct1h, 50) * (ratio >= 1 ? 1 : 0.8))),
        title: `${coin} ${f(ch1h, 1)} % en 1 h sur DEX — ${where}`,
        reasons: [`prix 1 h ${f(ch1h, 1)} % (seuil ${cfg.pumpPct1h} %)`, `volume 1 h ${usd(v1h)}, liquidité ${usd(reserve)}`, `${buys} achats / ${sells} ventes`],
        metrics,
      });
    }
  }
  return out;
}

export { usd as formatUsd };
