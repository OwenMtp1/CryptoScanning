/**
 * GET /api/coinbase/products            → Coinbase public spot product list (cached 60 s)
 * GET /api/coinbase/products?type=perp  → Coinbase perpetual contracts (leverage, funding, OI), cached 60 s
 * (GET /api/v3/brokerage/market/products, no key). The browser tries Coinbase
 * directly first (its own IP, no shared rate limit); this is the fallback.
 */
import { cachedFetch } from "../../../lib/proxy.js";

export async function onRequestGet(ctx) {
  const perp = new URL(ctx.request.url).searchParams.get("type") === "perp";
  const url = perp
    ? "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&contract_expiry_type=PERPETUAL"
    : "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT";
  return cachedFetch(ctx, perp ? "coinbase-perps" : "coinbase-products-all", url, { headers: { accept: "application/json" } }, 60, "application/json; charset=utf-8");
}
