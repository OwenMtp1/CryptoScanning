import { describe, expect, it } from "vitest";
import { loadPerpMarkets, PERP_URLS } from "../src/intel/perp-sources.js";

const intx = JSON.stringify([{ symbol: "SOL-PERP", type: "PERP", base_asset_name: "SOL", base_imf: 0.1, trading_state: "TRADING", quote: { mark_price: "150" } }]);

describe("loadPerpMarkets cascade", () => {
  it("empty Coinbase list → Coinbase International fills in (with the reason reported)", async () => {
    const r = await loadPerpMarkets(async (url) => (url === PERP_URLS.advanced ? JSON.stringify({ products: [] }) : url === PERP_URLS.intx ? intx : "[]"));
    expect(r.markets.map((m) => [m.coin, m.maxLeverage])).toEqual([["SOL", 10]]);
    expect(r.errors).toEqual(["Coinbase : aucune donnée renvoyée"]);
    expect(r.sources).toEqual(["Coinbase International (1)"]);
  });
  it("both Coinbase sources down → Binance Futures, then the CoinGecko fallback", async () => {
    const binance = await loadPerpMarkets(async (url) => {
      if (url === PERP_URLS.binancePremium) return JSON.stringify([{ symbol: "PEPEUSDT", markPrice: "0.00001", lastFundingRate: "0.0003" }]);
      if (url === PERP_URLS.binanceTicker) return "[]";
      throw new Error("HTTP 403");
    });
    expect(binance.markets[0]).toMatchObject({ coin: "PEPE", venue: "Binance Futures" });
    const fb = await loadPerpMarkets(
      async () => {
        throw new Error("hors ligne");
      },
      () => [{ productId: "X", coin: "WIF", name: "WIF perpétuel", venue: "Binance Futures", maxLeverage: null, price: 1, change24h: null, fundingPct: null, openInterest: null, volume24hUsd: null, url: "https://x" }],
    );
    expect(fb.markets.map((m) => m.coin)).toEqual(["WIF"]);
    expect(fb.sources).toEqual(["Binance Futures via CoinGecko (1)"]);
    expect(fb.errors.length).toBe(3);
  });
});
