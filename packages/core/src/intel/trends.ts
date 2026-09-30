/**
 * Trends: what the crypto market is talking about right now.
 *
 * - Narratives (themes): AI, memecoins, ETF, regulation, hacks… detected in the news and Reddit
 *   headlines by keywords and by the coins they mention. Each theme gets a heat (recency-weighted
 *   mentions), a momentum (last 2 h vs the 4 h before), a sentiment and its price performance.
 * - Attention leaderboard: coins ranked by news + Reddit mentions, CoinGecko trending rank and signals.
 * - Pulse: bullish / bearish / neutral headlines per hour over 24 h.
 * Pure function: the caller passes what it has in memory.
 */
import type { Direction, IntelSignal, NewsItem } from "./types.js";

export interface TrendPost {
  id: string;
  ts: number;
  title: string;
  link: string;
  feed: string;
  coins: string[];
  direction: Direction;
  kind: "news" | "social";
}

export interface TrendCategory {
  name: string;
  change24h: number | null;
  change1h: number | null;
  coinsCount: number | null;
}

export interface TrendInput {
  now: number;
  news: NewsItem[];
  social: TrendPost[];
  /** CoinGecko trending coins (rank 1 = hottest). */
  trending: { symbol: string; name: string; rank: number }[];
  categories: TrendCategory[];
  signals: IntelSignal[];
  coin: (symbol: string) => { name: string | null; change1h: number | null; change24h: number | null } | null;
  /** Ranks of the attention board about an hour ago (for ▲ / ▼). */
  previousRanks?: Record<string, number>;
}

interface ThemeDef {
  id: string;
  label: string;
  emoji: string;
  words: RegExp;
  coins: string[];
}

/** Narratives followed. Keywords in French and English; coins that belong to the theme. */
export const THEMES: ThemeDef[] = [
  { id: "ai", label: "Intelligence artificielle", emoji: "🤖", words: /\b(ai|a\.i\.|artificial intelligence|intelligence artificielle|ia|agents?|llm|gpt|nvidia)\b/i, coins: ["FET", "TAO", "RENDER", "AGIX", "OCEAN", "WLD", "AKT", "ARKM", "VIRTUAL", "AI16Z", "GRT"] },
  { id: "meme", label: "Memecoins", emoji: "🐸", words: /\b(meme ?coins?|memes?|dog(e|gy)?|pepe|shib|bonk|wif|frog|pump\.?fun)\b/i, coins: ["DOGE", "SHIB", "PEPE", "BONK", "WIF", "FLOKI", "BRETT", "MOG", "POPCAT", "TRUMP", "PENGU", "FARTCOIN"] },
  { id: "etf", label: "ETF et institutionnels", emoji: "🏦", words: /\b(etfs?|blackrock|fidelity|grayscale|institution(al|nels?)|inflows?|outflows?|flux entrants?|treasury|microstrategy|strategy inc|saylor)\b/i, coins: [] },
  { id: "regulation", label: "Régulation", emoji: "⚖️", words: /\b(sec|cftc|mica|regulat\w*|réglement\w*|régul\w*|lawsuit|procès|court|tribunal|gensler|atkins|congress|senate|bill|law|loi|ban|interdi\w*|tax\w*|impôts?)\b/i, coins: [] },
  { id: "hack", label: "Hacks et sécurité", emoji: "🚨", words: /\b(hack\w*|exploit\w*|drain\w*|stolen|volés?|piratage|attack|attaque|rug ?pull|scam|arnaque|phishing|vulnerab\w*|faille)\b/i, coins: [] },
  { id: "macro", label: "Macro (Fed, taux, inflation)", emoji: "🌍", words: /\b(fed|fomc|powell|rate cuts?|rate hikes?|taux|inflation|cpi|pce|jobs report|emploi|recession|récession|tariffs?|droits de douane|dollar|dxy|bonds?|treasur(y|ies) yields?)\b/i, coins: [] },
  { id: "l2", label: "Layer 2 et scaling", emoji: "🧱", words: /\b(layer ?2|l2s?|rollups?|zk|zero[- ]knowledge|optimism|arbitrum|base chain|polygon|starknet|zksync|scaling)\b/i, coins: ["ARB", "OP", "MATIC", "POL", "STRK", "ZK", "IMX", "MNT", "METIS"] },
  { id: "defi", label: "DeFi", emoji: "🌀", words: /\b(defi|dex|lending|prêt|yield|rendement|staking|liquid staking|restaking|tvl|amm|perps?|aave|uniswap|lido|eigen\w*)\b/i, coins: ["UNI", "AAVE", "MKR", "LDO", "CRV", "COMP", "SNX", "PENDLE", "JUP", "HYPE", "ENA", "EIGEN", "DYDX", "GMX"] },
  { id: "rwa", label: "Actifs réels (RWA) et tokenisation", emoji: "🏠", words: /\b(rwa|real[- ]world assets?|actifs réels|tokeni[sz]\w*|treasur(y|ies) tokens?|buidl)\b/i, coins: ["ONDO", "CFG", "POLYX", "OM", "PLUME"] },
  { id: "stable", label: "Stablecoins et paiements", emoji: "💵", words: /\b(stablecoins?|usdt|usdc|tether|circle|paiements?|payments?|genius act|cbdc|euro numérique)\b/i, coins: [] },
  { id: "gaming", label: "Gaming et métavers", emoji: "🎮", words: /\b(gaming|games?|jeux?|metaverse|métavers|nfts?|play[- ]to[- ]earn)\b/i, coins: ["IMX", "SAND", "MANA", "AXS", "GALA", "BEAM", "RON", "APE"] },
  { id: "depin", label: "DePIN et infrastructure", emoji: "📡", words: /\b(depin|decentrali[sz]ed physical|storage|stockage|compute|gpu|oracle|bandwidth)\b/i, coins: ["FIL", "AR", "HNT", "RENDER", "AKT", "LINK", "IOTX", "THETA"] },
  { id: "listing", label: "Listings et airdrops", emoji: "🆕", words: /\b(list(s|ed|ing)|listé|cotation|airdrops?|launch(es|ed)?|lancement|tge|token generation)\b/i, coins: [] },
  { id: "btc", label: "Bitcoin", emoji: "🟠", words: /\b(bitcoin|btc|halving|miners?|mineurs?|hashrate|lightning|ordinals|runes)\b/i, coins: ["BTC"] },
  { id: "eth", label: "Ethereum", emoji: "💠", words: /\b(ethereum|ether|eth|vitalik|pectra|fusaka|blobs?)\b/i, coins: ["ETH"] },
  { id: "sol", label: "Écosystème Solana", emoji: "🟣", words: /\b(solana|sol|firedancer|jito|phantom)\b/i, coins: ["SOL", "JUP", "JTO", "RAY", "PYTH", "BONK", "WIF"] },
];

export interface ThemeTrend {
  id: string;
  label: string;
  emoji: string;
  /** 0–100: how much it is talked about, recent mentions counting more. */
  heat: number;
  mentions6h: number;
  mentions2h: number;
  /** Mentions per hour over the last 2 h ÷ over the 4 h before (1 = stable). */
  momentum: number | null;
  /** −1 (only bearish headlines) … +1 (only bullish). */
  sentiment: number;
  bull: number;
  bear: number;
  /** Average 24 h move of the theme's coins mentioned (or listed). */
  priceChange24h: number | null;
  coins: { coin: string; mentions: number; change24h: number | null }[];
  headlines: { title: string; link: string; feed: string; ts: number; direction: Direction; kind: "news" | "social" }[];
  /** Mentions per 30 min over the last 6 h (oldest first). */
  timeline: number[];
  /** CoinGecko category matching the theme (market-cap change). */
  category: TrendCategory | null;
}

export interface CoinAttention {
  coin: string;
  name: string | null;
  score: number;
  news: number;
  social: number;
  trendingRank: number | null;
  signals: number;
  sentiment: number;
  change1h: number | null;
  change24h: number | null;
  rank: number;
  /** Positions gained (+) or lost (−) in about an hour; null = new in the board. */
  rankDelta: number | null;
  topHeadline: string | null;
}

export interface TrendsView {
  at: number;
  themes: ThemeTrend[];
  coins: CoinAttention[];
  /** Per hour over 24 h (oldest first). */
  pulse: { hour: number; bull: number; bear: number; neutral: number }[];
  headlines: { title: string; link: string; feed: string; ts: number; direction: Direction; coins: string[]; kind: "news" | "social"; breaking: boolean }[];
  categories: TrendCategory[];
  totals: { posts24h: number; posts1h: number; sentiment24h: number };
}

const H = 3_600_000;
const HALF_LIFE = 3 * H;
const CATEGORY_HINT: Record<string, RegExp> = {
  ai: /\b(ai|artificial|agent)/i,
  meme: /meme/i,
  l2: /layer 2|l2|rollup/i,
  defi: /defi|decentralized finance|dex|lending/i,
  rwa: /real world|rwa|tokeni/i,
  gaming: /gaming|metaverse|nft/i,
  depin: /depin|storage|infrastructure/i,
  sol: /solana/i,
  stable: /stablecoin/i,
};

const decay = (age: number) => Math.pow(0.5, Math.max(0, age) / HALF_LIFE);
const dirVal = (d: Direction) => (d === "bullish" ? 1 : d === "bearish" ? -1 : 0);

export function buildTrends(i: TrendInput): TrendsView {
  const now = i.now;
  const posts: TrendPost[] = [
    ...i.news.map((n) => ({ id: n.id, ts: n.ts, title: n.title, link: n.link, feed: n.feed, coins: n.coins, direction: n.direction, kind: "news" as const })),
    ...i.social,
  ]
    .filter((p) => p.ts <= now + 5 * 60_000 && now - p.ts < 24 * H)
    .sort((a, b) => b.ts - a.ts);
  // The same story on several feeds counts once per feed but its headline is shown once.
  const seenTitle = new Set<string>();
  const unique = posts.filter((p) => {
    const k = p.title.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 80);
    if (seenTitle.has(k)) return false;
    seenTitle.add(k);
    return true;
  });

  // ── Themes
  const catFor = (id: string) => {
    const re = CATEGORY_HINT[id];
    return re ? (i.categories.find((c) => re.test(c.name)) ?? null) : null;
  };
  const themes: ThemeTrend[] = THEMES.map((t) => {
    const hits = unique.filter((p) => now - p.ts < 6 * H && (t.words.test(p.title) || p.coins.some((c) => t.coins.includes(c))));
    const w = hits.reduce((s, p) => s + decay(now - p.ts) * (p.kind === "news" ? 1 : 0.6), 0);
    const m2 = hits.filter((p) => now - p.ts < 2 * H).length;
    const m4 = hits.length - m2;
    const bull = hits.filter((p) => p.direction === "bullish").length;
    const bear = hits.filter((p) => p.direction === "bearish").length;
    const coinCount = new Map<string, number>();
    for (const p of hits) for (const c of p.coins) coinCount.set(c, (coinCount.get(c) ?? 0) + 1);
    for (const c of t.coins) if (!coinCount.has(c) && i.coin(c)) coinCount.set(c, 0);
    const coins = [...coinCount]
      .map(([coin, mentions]) => ({ coin, mentions, change24h: i.coin(coin)?.change24h ?? null }))
      .sort((a, b) => b.mentions - a.mentions || Math.abs(b.change24h ?? 0) - Math.abs(a.change24h ?? 0))
      .slice(0, 8);
    const moves = coins.map((c) => c.change24h).filter((x): x is number => x !== null);
    const cat = catFor(t.id);
    const timeline = Array.from({ length: 12 }, (_, k) => hits.filter((p) => now - p.ts >= (11 - k) * 0.5 * H && now - p.ts < (12 - k) * 0.5 * H).length);
    return {
      id: t.id,
      label: t.label,
      emoji: t.emoji,
      heat: Math.round(100 * (1 - Math.exp(-w / 6))),
      mentions6h: hits.length,
      mentions2h: m2,
      momentum: hits.length >= 3 ? Math.round((m2 / 2 / Math.max(0.25, m4 / 4)) * 10) / 10 : null,
      sentiment: hits.length ? Math.round(((bull - bear) / hits.length) * 100) / 100 : 0,
      bull,
      bear,
      priceChange24h: moves.length ? Math.round((moves.reduce((s, x) => s + x, 0) / moves.length) * 100) / 100 : (cat?.change24h ?? null),
      coins,
      headlines: hits.slice(0, 6).map((p) => ({ title: p.title, link: p.link, feed: p.feed, ts: p.ts, direction: p.direction, kind: p.kind })),
      timeline,
      category: cat,
    };
  })
    .filter((t) => t.mentions6h > 0 || t.category)
    .sort((a, b) => b.heat - a.heat);

  // ── Coins: attention leaderboard
  const att = new Map<string, { news: number; social: number; w: number; dir: number; n: number; head: string | null }>();
  const bump = (c: string) => att.get(c) ?? { news: 0, social: 0, w: 0, dir: 0, n: 0, head: null };
  for (const p of posts) {
    if (now - p.ts >= 6 * H) continue;
    for (const c of p.coins.slice(0, 4)) {
      const a = bump(c);
      if (p.kind === "news") a.news++;
      else a.social++;
      a.w += decay(now - p.ts) * (p.kind === "news" ? 3 : 1.5);
      a.dir += dirVal(p.direction);
      a.n++;
      a.head ??= p.title;
      att.set(c, a);
    }
  }
  for (const t of i.trending) {
    const a = bump(t.symbol.toUpperCase());
    a.w += Math.max(0, 16 - t.rank) * 0.6;
    att.set(t.symbol.toUpperCase(), a);
  }
  const sigCount = new Map<string, number>();
  for (const s of i.signals) if (now - s.ts < 6 * H && s.source !== "setup") sigCount.set(s.coin, (sigCount.get(s.coin) ?? 0) + 1);
  for (const [c, n] of sigCount) {
    const a = bump(c);
    a.w += Math.min(6, n) * 0.5;
    att.set(c, a);
  }
  const trendRank = new Map(i.trending.map((t) => [t.symbol.toUpperCase(), t.rank]));
  const coins = [...att]
    .filter(([c]) => !/^(USDT|USDC|DAI|FDUSD|TUSD|USDE|EUR|USD)$/.test(c))
    .map(([coin, a]) => {
      const row = i.coin(coin);
      return {
        coin,
        name: row?.name ?? null,
        score: Math.round(a.w * 10) / 10,
        news: a.news,
        social: a.social,
        trendingRank: trendRank.get(coin) ?? null,
        signals: sigCount.get(coin) ?? 0,
        sentiment: a.n ? Math.round((a.dir / a.n) * 100) / 100 : 0,
        change1h: row?.change1h ?? null,
        change24h: row?.change24h ?? null,
        rank: 0,
        rankDelta: null as number | null,
        topHeadline: a.head,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 30);
  coins.forEach((c, k) => {
    c.rank = k + 1;
    const prev = i.previousRanks?.[c.coin];
    c.rankDelta = prev === undefined ? null : prev - c.rank;
  });

  // ── Pulse (24 h)
  const pulse = Array.from({ length: 24 }, (_, k) => {
    const from = now - (24 - k) * H;
    const inH = unique.filter((p) => p.ts >= from && p.ts < from + H);
    return { hour: from, bull: inH.filter((p) => p.direction === "bullish").length, bear: inH.filter((p) => p.direction === "bearish").length, neutral: inH.filter((p) => p.direction === "neutral").length };
  });
  const dir24 = unique.reduce((s, p) => s + dirVal(p.direction), 0);

  return {
    at: now,
    themes,
    coins,
    pulse,
    headlines: unique.slice(0, 40).map((p) => ({ title: p.title, link: p.link, feed: p.feed, ts: p.ts, direction: p.direction, coins: p.coins.slice(0, 4), kind: p.kind, breaking: now - p.ts < 20 * 60_000 })),
    categories: [...i.categories].sort((a, b) => Math.abs(b.change24h ?? 0) - Math.abs(a.change24h ?? 0)).slice(0, 12),
    totals: { posts24h: unique.length, posts1h: unique.filter((p) => now - p.ts < H).length, sentiment24h: unique.length ? Math.round((dir24 / unique.length) * 100) / 100 : 0 },
  };
}
