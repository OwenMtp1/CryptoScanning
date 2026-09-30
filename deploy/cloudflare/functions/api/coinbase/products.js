/**
 * GET /api/coinbase/products → Coinbase public spot product list
 * (GET /api/v3/brokerage/market/products?product_type=SPOT, no key), one call
 * for every product, cached 60 s. The browser tries Coinbase directly first
 * (its own IP, no shared rate limit); this is the fallback.
 */
import { cachedFetch } from "../../../lib/proxy.js";

export async function onRequestGet(ctx) {
  return cachedFetch(ctx, "coinbase-products-all", "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT", { headers: { accept: "application/json" } }, 60, "application/json; charset=utf-8");
}
