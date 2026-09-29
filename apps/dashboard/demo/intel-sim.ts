/**
 * Simulated intelligence sources for the standalone demo. Everything here is
 * FAKE (prices, pumps, news headlines, DEX pools) and exists only to show
 * how the real engine behaves. The real server uses Binance, CoinGecko,
 * GeckoTerminal and RSS feeds instead. The same IntelService is used.
 */
import {
  LiveTracker,
  Prng,
  defaultIntelConfig,
  type BinanceMiniTicker,
  type CgDerivative,
  type CgMarketRow,
  type GtPools,
  type RawFeedItem,
  type TrendingCoin,
} from "@radar/core";
import { IntelService } from "../../server/src/intel/intel-service";
import type { LogFn } from "../../server/src/market-data/source";

const REAL: [string, string, number, number][] = [
  // symbol, name, price, market cap (fictional snapshot)
  ["BTC", "Bitcoin", 96_000, 1.9e12],
  ["ETH", "Ethereum", 3_400, 4.1e11],
  ["SOL", "Solana", 185, 8.8e10],
  ["XRP", "XRP", 2.3, 1.3e11],
  ["DOGE", "Dogecoin", 0.32, 4.7e10],
  ["ADA", "Cardano", 0.9, 3.2e10],
  ["AVAX", "Avalanche", 36, 1.5e10],
  ["LINK", "Chainlink", 21, 1.3e10],
  ["DOT", "Polkadot", 6.8, 1e10],
  ["SUI", "Sui", 4.1, 1.2e10],
  ["LTC", "Litecoin", 110, 8.2e9],
  ["UNI", "Uniswap", 12, 7.2e9],
  ["APT", "Aptos", 9.5, 5e9],
  ["ARB", "Arbitrum", 0.78, 3.4e9],
  ["OP", "Optimism", 1.9, 2.5e9],
  ["INJ", "Injective", 24, 2.3e9],
  ["PEPE", "Pepe", 0.000018, 7.5e9],
  ["WIF", "dogwifhat", 2.1, 2.1e9],
  ["BONK", "Bonk", 0.000029, 2.2e9],
  ["RENDER", "Render", 7.2, 3.7e9],
  ["FET", "Artificial Superintelligence Alliance", 1.3, 3.3e9],
  ["TIA", "Celestia", 5.6, 2.8e9],
  ["SEI", "Sei", 0.45, 1.9e9],
  ["JUP", "Jupiter", 0.95, 1.3e9],
  ["ONDO", "Ondo", 1.4, 2e9],
  ["ENA", "Ethena", 0.85, 2.6e9],
  ["AAVE", "Aave", 320, 4.8e9],
  ["HBAR", "Hedera", 0.28, 1.1e10],
  ["TRX", "TRON", 0.25, 2.2e10],
  ["NEAR", "NEAR Protocol", 5.4, 6.5e9],
];

const SYL = ["ka", "zo", "ri", "mu", "tex", "vo", "lin", "qua", "ze", "ny", "flo", "bit", "ra", "dex", "mo", "sol", "ter", "vi", "no", "xa", "pu", "gra", "lu", "fen"];
const SUFFIX = ["Network", "Protocol", "Finance", "Chain", "AI", "Labs", "Coin", "Swap", "DAO", "Token"];

interface SimCoin {
  symbol: string;
  name: string;
  id: string;
  price: number;
  supply: number;
  vol24: number;
  p24: number;
  p7d: number;
  ath: number;
  rank: number;
  history: { t: number; p: number }[];
  event: { until: number; perSec: number; volMult: number } | null;
  funding: number;
  oi: number;
}

export interface IntelSim {
  service: IntelService;
  extras: () => Record<string, unknown>;
  stop: () => void;
}

export function startIntelSim(log: LogFn, coinbaseBases: string[]): IntelSim {
  const rng = new Prng(Math.floor(Math.random() * 1e9));
  const gauss = (mu: number, sd: number) => mu + sd * rng.normal();
  const cfg = defaultIntelConfig();
  let warm = true;
  const quietLog: LogFn = (e) => {
    if (warm && e.type === "INTEL_SIGNAL") return;
    log(e);
  };
  const svc = new IntelService({ cfg, log: quietLog, notifier: null, enabledSources: ["binance", "coinbase", "coingecko", "trending", "derivatives", "dex", "news"] });

  // ── Universe of fake coins ────────────────────────────────────────────────
  const coins: SimCoin[] = [];
  const used = new Set<string>();
  const add = (symbol: string, name: string, price: number, mcap: number) => {
    used.add(symbol);
    const vol = mcap * rng.range(0.02, 0.25);
    coins.push({ symbol, name, id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), price, supply: mcap / price, vol24: vol, p24: price * (1 + gauss(0, 0.04)), p7d: price * (1 + gauss(0, 0.12)), ath: price * rng.range(1.02, 4), rank: 0, history: [], event: null, funding: gauss(0.008, 0.006), oi: mcap * rng.range(0.005, 0.04) });
  };
  for (const [s, n, p, m] of REAL) add(s, n, p, m);
  while (coins.length < 320) {
    const base = `${rng.pick(SYL)}${rng.pick(SYL)}${rng.next() < 0.4 ? rng.pick(SYL) : ""}`;
    const sym = base.toUpperCase().slice(0, rng.int(3, 6));
    if (used.has(sym) || sym.length < 3) continue;
    const mcap = Math.exp(rng.range(Math.log(3e6), Math.log(1.5e9)));
    add(sym, `${base[0]!.toUpperCase()}${base.slice(1)} ${rng.pick(SUFFIX)}`, Math.exp(rng.range(Math.log(0.0005), Math.log(40))), mcap);
  }
  coins.sort((a, b) => b.price * b.supply - a.price * a.supply).forEach((c, i) => (c.rank = i + 1));
  const bySym = new Map(coins.map((c) => [c.symbol, c]));

  const symbols = new Map(coins.map((c) => [`${c.symbol}USDT`, { base: c.symbol, quote: "USDT" }]));
  const tracker = new LiveTracker(symbols, ["USDT"]);
  svc.markCoinbase(coinbaseBases.filter((b) => bySym.has(b)));

  const priceAgo = (c: SimCoin, now: number, sec: number) => {
    const t = now - sec * 1000;
    for (let i = c.history.length - 1; i >= 0; i--) if ((c.history[i] as { t: number }).t <= t) return (c.history[i] as { p: number }).p;
    return c.history[0]?.p ?? c.price;
  };

  // ── Market step: random walk + occasional pump/dump events ───────────────
  const STEP = 10; // seconds
  const step = (now: number) => {
    if (rng.next() < 0.06) {
      const c = rng.pick(coins.filter((x) => !x.event && x.rank > 3));
      const up = rng.next() < 0.55;
      const total = rng.range(0.07, c.rank > 150 ? 0.45 : 0.18) * (up ? 1 : -1);
      const dur = rng.range(180, 900);
      c.event = { until: now + dur * 1000, perSec: Math.log(1 + total) / dur, volMult: rng.range(3, 12) };
    }
    for (const c of coins) {
      const sigma = 0.00035 * (c.rank > 100 ? 1.8 : 1);
      let r = gauss(0, sigma) * Math.sqrt(STEP);
      if (c.event) {
        if (now >= c.event.until) c.event = null;
        else r += c.event.perSec * STEP * rng.range(0.6, 1.4);
      }
      c.price *= Math.exp(r);
      c.ath = Math.max(c.ath, c.price);
      c.history.push({ t: now, p: c.price });
      if (c.history.length > 400) c.history.shift();
      c.p24 += (c.price - c.p24) * (STEP / 86_400);
      c.p7d += (c.price - c.p7d) * (STEP / 604_800);
    }
  };

  const binanceTick = (now: number) => {
    const changed = new Set<string>();
    for (const c of coins) {
      const v = c.vol24 * (c.event ? 1 + (c.event.volMult - 1) * 0.3 : 1);
      // 24 h range: at least ±6 % around the price 24 h ago, plus what the last hour saw.
      const hi = Math.max(c.price, c.p24 * 1.06, ...c.history.slice(-360).map((h) => h.p));
      const lo = Math.min(c.price, c.p24 * 0.94, ...c.history.slice(-360).map((h) => h.p));
      const m: BinanceMiniTicker = { e: "24hrMiniTicker", E: now, s: `${c.symbol}USDT`, c: c.price, o: c.p24, h: hi, l: lo, v: v / c.price, q: v };
      tracker.applyMini(m, now);
      const p1h = priceAgo(c, now, 3600);
      tracker.applyWindow({ e: "1hTicker", E: now, s: `${c.symbol}USDT`, P: ((c.price - p1h) / p1h) * 100, c: c.price, q: (v / 24) * (c.event ? c.event.volMult : rng.range(0.6, 1.5)) }, now);
      changed.add(c.symbol);
    }
    svc.onLive(tracker, changed, now);
    svc.setSourceState("binance", "ok", `${coins.length} cryptos (simulées)`, now, coins.length);
  };

  const marketsTick = (now: number) => {
    const rows: CgMarketRow[] = coins.map((c) => {
      const p1h = priceAgo(c, now, 3600);
      const mcap = c.price * c.supply;
      return {
        id: c.id,
        symbol: c.symbol.toLowerCase(),
        name: c.name,
        current_price: c.price,
        market_cap: mcap,
        market_cap_rank: c.rank,
        total_volume: c.vol24 * (c.event ? c.event.volMult * 0.4 : 1),
        high_24h: c.price * 1.03,
        low_24h: c.price * 0.97,
        price_change_percentage_24h: ((c.price - c.p24) / c.p24) * 100,
        ath: c.ath,
        ath_change_percentage: ((c.price - c.ath) / c.ath) * 100,
        price_change_percentage_1h_in_currency: ((c.price - p1h) / p1h) * 100,
        price_change_percentage_24h_in_currency: ((c.price - c.p24) / c.p24) * 100,
        price_change_percentage_7d_in_currency: ((c.price - c.p7d) / c.p7d) * 100,
        last_updated: new Date(now).toISOString(),
      };
    });
    svc.onMarkets(rows, 1, now);
    svc.onCoinGeckoResult("markets:1", true, null, rows.length, now);
  };

  const trendingTick = (now: number) => {
    const scored = coins.map((c) => ({ c, s: Math.abs(Math.log(c.price / priceAgo(c, now, 3600))) + rng.range(0, 0.03) })).sort((a, b) => b.s - a.s);
    const list: TrendingCoin[] = scored.slice(0, 7).map(({ c }, i) => ({ id: c.id, symbol: c.symbol.toLowerCase(), name: c.name, rank: i, marketCapRank: c.rank }));
    svc.onTrending(list, now);
    svc.onCoinGeckoResult("trending", true, null, list.length, now);
  };

  const derivativesTick = (now: number) => {
    const rows: CgDerivative[] = [];
    for (const c of coins.slice(0, 60)) {
      const heat = c.event ? Math.sign(c.event.perSec) * 0.05 : 0;
      c.funding = c.funding * 0.7 + (0.008 + heat * rng.range(0.5, 2) + gauss(0, 0.004)) * 0.3;
      c.oi *= c.event ? rng.range(1.05, 1.3) : rng.range(0.97, 1.03);
      for (const market of ["Binance (Futures)", "Bybit", "OKX"])
        rows.push({ market, symbol: `${c.symbol}USDT`, index_id: c.symbol, price: c.price, price_percentage_change_24h: ((c.price - c.p24) / c.p24) * 100, contract_type: "perpetual", funding_rate: c.funding * rng.range(0.8, 1.2), open_interest: c.oi / 3, volume_24h: c.vol24 });
    }
    svc.onDerivatives(rows, now);
    svc.onCoinGeckoResult("derivatives", true, null, rows.length, now);
  };

  let poolSeq = 0;
  const dexTick = (now: number, isNew: boolean) => {
    const data: GtPools["data"] = [];
    const included: NonNullable<GtPools["included"]> = [];
    for (let i = 0; i < 4; i++) {
      poolSeq++;
      const sym = `${rng.pick(SYL)}${rng.pick(SYL)}`.toUpperCase().slice(0, 5) + (rng.next() < 0.3 ? "AI" : "");
      const kind = rng.next();
      const ch1h = kind < 0.2 ? -rng.range(45, 90) : kind < 0.55 ? rng.range(25, 300) : rng.range(-15, 20);
      const buys = Math.round(rng.range(20, 900));
      const sells = kind < 0.2 ? buys * rng.range(3, 8) : Math.round(buys / rng.range(0.6, 3));
      const net = rng.pick(["solana", "base", "eth", "bsc"]);
      const tokId = `${net}_tok${poolSeq}`;
      included.push({ id: tokId, type: "token", attributes: { symbol: sym, name: `${sym} (simulé)` } });
      data.push({
        id: `${net}_pool${poolSeq}`,
        attributes: {
          name: `${sym} / ${net === "solana" ? "SOL" : "WETH"}`,
          address: `0xSIMULE${poolSeq.toString(16).padStart(6, "0")}`,
          pool_created_at: new Date(now - rng.range(0.3, isNew ? 20 : 400) * 3_600_000).toISOString(),
          base_token_price_usd: rng.range(0.00001, 0.5),
          fdv_usd: rng.range(1e5, 5e7),
          market_cap_usd: null,
          reserve_in_usd: kind < 0.2 ? rng.range(2_000, 9_000) : rng.range(30_000, 2_000_000),
          price_change_percentage: { m5: ch1h / 6, h1: ch1h, h24: ch1h * 1.5 },
          volume_usd: { h1: rng.range(20_000, 900_000), h24: rng.range(1e5, 5e6) },
          transactions: { h1: { buys, sells: Math.round(sells) } },
          community_sus_report: kind < 0.1 ? 1 : 0,
        },
        relationships: { base_token: { data: { id: tokId } }, network: { data: { id: net } }, dex: { data: { id: net === "solana" ? "raydium" : "uniswap_v3" } } },
      });
    }
    svc.onPools({ data, included }, isNew, now);
    svc.onCoinGeckoResult(isNew ? "dex:new" : "dex:trending", true, null, data.length, now);
  };

  const BULL = ["{name} ({SYM}) will list on a major exchange next week", "{name} surges after partnership announcement", "{SYM} rallies as whales accumulate", "Le {name} s'envole après l'annonce d'un partenariat", "{name} mainnet upgrade goes live, {SYM} jumps", "Record inflows into {name} products"];
  const BEAR = ["{name} protocol exploited, $12M drained", "{SYM} plunges ahead of large token unlock", "Regulators open investigation into {name}", "{name} : une faille critique découverte, le jeton chute", "Exchange to delist {SYM} next month", "{name} network halted after outage"];
  const NEUTRAL = ["Weekly recap: {name} and the wider market", "Analyse : que retenir du marché crypto cette semaine ?", "{name} developers publish quarterly report"];
  const FEEDS = ["CoinDesk (simulé)", "Cointelegraph (simulé)", "Cryptoast (simulé)", "Decrypt (simulé)", "The Block (simulé)"];
  let newsSeq = 0;
  const newsTick = (now: number) => {
    const moving = coins.filter((c) => c.event);
    const c = moving.length && rng.next() < 0.7 ? rng.pick(moving) : rng.pick(coins.slice(0, 120));
    const up = c.event ? c.event.perSec > 0 : rng.next() < 0.5;
    const pool = rng.next() < 0.15 ? NEUTRAL : up ? BULL : BEAR;
    const title = `[SIMULÉ] ${rng.pick(pool).replace("{name}", c.name).replace("{SYM}", c.symbol)}`;
    const item: RawFeedItem = { title, link: `https://www.example.com/demo-news/${++newsSeq}`, summary: "Article fictif généré par la démo pour illustrer la lecture des actualités.", ts: now - rng.range(0, 120_000) };
    const feeds = rng.next() < 0.3 ? [rng.pick(FEEDS), rng.pick(FEEDS)] : [rng.pick(FEEDS)];
    for (const f of new Set(feeds)) svc.onNews(f, [{ ...item, link: `${item.link}-${f.length}` }], now);
  };

  // ── Warm-up: replay 3 simulated hours so the feed and statistics are not empty ─
  const start = Date.now();
  let t = start - 3 * 3_600_000;
  for (const c of coins) c.history.push({ t: t - 3_600_000, p: c.price });
  let k = 0;
  while (t < start) {
    step(t);
    if (k % 1 === 0) binanceTick(t);
    if (k % 12 === 0) marketsTick(t);
    if (k % 18 === 0) trendingTick(t);
    if (k % 24 === 0) derivativesTick(t);
    if (k % 15 === 0) dexTick(t, k % 30 === 0);
    if (k % 7 === 0) newsTick(t);
    if (k % 3 === 0) svc.tickOutcomes(t);
    t += STEP * 1000;
    k++;
  }
  warm = false;

  // ── Live loop ─────────────────────────────────────────────────────────────
  const timers = [
    setInterval(() => {
      const now = Date.now();
      step(now);
      binanceTick(now);
      svc.tickOutcomes(now);
    }, STEP * 1000),
    setInterval(() => marketsTick(Date.now()), 120_000),
    setInterval(() => trendingTick(Date.now()), 180_000),
    setInterval(() => derivativesTick(Date.now()), 240_000),
    setInterval(() => dexTick(Date.now(), rng.next() < 0.5), 150_000),
    setInterval(() => newsTick(Date.now()), 60_000),
  ];
  return {
    service: svc,
    extras: () => ({ simulated: true, coingecko: null, binanceFeed: { pairs: coins.length, messages: k, decodeErrors: 0, connected: true, lastMessageAt: Date.now() }, newsFeeds: FEEDS.map((name) => ({ name, url: "(simulé)", lang: name.startsWith("Cryptoast") ? "fr" : "en", ok: true, lastSuccessAt: Date.now(), lastError: null, items: 0 })) }),
    stop: () => timers.forEach(clearInterval),
  };
}
