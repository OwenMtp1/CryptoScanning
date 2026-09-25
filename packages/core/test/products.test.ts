import { describe, expect, it } from "vitest";
import { filterRadarProducts, parseProductsPage } from "../src/coinbase/products.js";
import { MarketSimulator } from "../src/simulation/simulator.js";
import { product } from "./helpers.js";

describe("parseProductsPage", () => {
  it("parses string decimals and counts invalid items", () => {
    const r = parseProductsPage({
      products: [
        { product_id: "BTC-EUR", price: "95000.01", product_type: "SPOT", status: "online", approximate_quote_24h_volume: "1234.5", alias_to: [] },
        { price: "1" },
        { product_id: "ETH-EUR", price: "not-a-number" },
      ],
      num_products: 3,
    });
    expect(r.rawCount).toBe(3);
    expect(r.invalid).toBe(2);
    expect(r.products[0]).toMatchObject({ productId: "BTC-EUR", baseCurrency: "BTC", quoteCurrency: "EUR", price: 95000.01, volume24hQuote: 1234.5 });
  });

  it("rejects a payload without the products array shape", () => {
    expect(() => parseProductsPage({ products: "nope" })).toThrow();
  });
});

describe("filterRadarProducts", () => {
  it("keeps only online, enabled SPOT products in allowed quotes", () => {
    const products = [
      product("BTC-EUR"),
      product("FUT-USD", { productType: "FUTURE" }),
      product("OFF-EUR", { status: "offline" }),
      product("DIS-EUR", { flags: { ...product("x").flags, tradingDisabled: true } }),
      product("CXL-EUR", { flags: { ...product("x").flags, cancelOnly: true } }),
      product("VIEW-EUR", { flags: { ...product("x").flags, viewOnly: true } }),
      product("AUC-EUR", { flags: { ...product("x").flags, auctionMode: true } }),
      product("BTC-GBP", { quoteCurrency: "GBP" }),
    ];
    const r = filterRadarProducts(products, { quoteCurrencies: ["EUR"], maxProducts: 0 });
    expect(r.selected.map((p) => p.productId)).toEqual(["BTC-EUR"]);
    expect(r.rejected).toMatchObject({ not_spot: 1, not_online: 1, disabled: 1, cancel_only: 1, view_only: 1, auction_mode: 1, quote_not_allowed: 1 });
  });

  it("ranks by 24h quote volume and caps", () => {
    const r = filterRadarProducts(
      [product("A-EUR", { volume24hQuote: 1 }), product("B-EUR", { volume24hQuote: 3 }), product("C-EUR", { volume24hQuote: 2 })],
      { quoteCurrencies: [], maxProducts: 2 },
    );
    expect(r.selected.map((p) => p.productId)).toEqual(["B-EUR", "C-EUR"]);
    expect(r.eligibleBeforeCap).toBe(3);
  });

  it("always includes required products when eligible", () => {
    const r = filterRadarProducts(
      [product("A-USDC", { volume24hQuote: 9 }), product("BTC-EUR", { volume24hQuote: 1 }), product("OFF-EUR", { status: "offline" })],
      { quoteCurrencies: ["USDC"], maxProducts: 1, required: ["BTC-EUR", "OFF-EUR"] },
    );
    expect(r.selected.map((p) => p.productId)).toEqual(["A-USDC", "BTC-EUR"]);
  });

  it("drops one-way alias duplicates but never both sides of a mutual alias", () => {
    const oneWay = filterRadarProducts([product("BTC-USD"), product("BTC-USDC", { alias: "BTC-USD" })], { quoteCurrencies: [], maxProducts: 0 });
    expect(oneWay.selected.map((p) => p.productId)).toEqual(["BTC-USD"]);
    expect(oneWay.rejected.alias_duplicate).toBe(1);
    const mutual = filterRadarProducts(
      [product("A-USD", { alias: "A-USDC" }), product("A-USDC", { alias: "A-USD" })],
      { quoteCurrencies: [], maxProducts: 0 },
    );
    expect(mutual.selected).toHaveLength(2);
  });

  it("filters the simulated catalog exactly like real data", () => {
    const sim = new MarketSimulator({ seed: 1 });
    const page = parseProductsPage(sim.productsResponse());
    expect(page.invalid).toBe(0);
    const r = filterRadarProducts(page.products, { quoteCurrencies: ["EUR", "USDC"], maxProducts: 0 });
    expect(r.selected).toHaveLength(sim.productIds().length);
    expect(r.selected.some((p) => ["BIT-31OCT26-CDE", "OLD-EUR", "HALT-EUR", "CXL-EUR", "VIEW-EUR"].includes(p.productId))).toBe(false);
  });
});
