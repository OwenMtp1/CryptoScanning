/**
 * Leveraged (perpetual) markets from several sources, so the Levier page is
 * never empty: Coinbase Advanced perpetuals + Coinbase International
 * instruments (merged, max leverage known), else Binance Futures (public), else
 * the Binance Futures data already loaded from CoinGecko. Shared by the site
 * and the 24/7 bot; every failure is reported.
 */
import { mergePerps, parseBinanceFutures, parseIntxInstruments, parsePerps, type PerpMarket } from "@radar/core";

/** Fetch `url` (the site may retry through its own proxy `proxy`). Throws on failure. */
export type PerpGetter = (url: string, proxy?: string) => Promise<string>;

export const PERP_URLS = {
  advanced: "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&contract_expiry_type=PERPETUAL",
  intx: "https://api.international.coinbase.com/api/v1/instruments",
  binancePremium: "https://fapi.binance.com/fapi/v1/premiumIndex",
  binanceTicker: "https://fapi.binance.com/fapi/v1/ticker/24hr",
};

export interface PerpLoad {
  markets: PerpMarket[];
  sources: string[];
  errors: string[];
}

export async function loadPerpMarkets(get: PerpGetter, fallback: () => PerpMarket[] = () => []): Promise<PerpLoad> {
  const errors: string[] = [];
  const sources: string[] = [];
  const attempt = async (label: string, fn: () => Promise<PerpMarket[]>) => {
    try {
      const m = await fn();
      if (m.length) sources.push(`${label} (${m.length})`);
      else errors.push(`${label} : aucune donnée renvoyée`);
      return m;
    } catch (e) {
      errors.push(`${label} : ${(e as Error).message}`);
      return [];
    }
  };
  const [adv, intx] = await Promise.all([
    attempt("Coinbase", async () => parsePerps(JSON.parse(await get(PERP_URLS.advanced, "/api/coinbase/products?type=perp")))),
    attempt("Coinbase International", async () => parseIntxInstruments(JSON.parse(await get(PERP_URLS.intx, "/api/coinbase/products?type=intx")))),
  ]);
  let markets = mergePerps(adv, intx);
  if (!markets.length) {
    markets = await attempt("Binance Futures", async () => {
      const [p, t] = await Promise.all([get(PERP_URLS.binancePremium), get(PERP_URLS.binanceTicker)]);
      return parseBinanceFutures(JSON.parse(p), JSON.parse(t));
    });
  }
  if (!markets.length) {
    const f = fallback();
    if (f.length) {
      markets = f;
      sources.push(`Binance Futures via CoinGecko (${f.length})`);
    }
  }
  return { markets, sources, errors };
}
