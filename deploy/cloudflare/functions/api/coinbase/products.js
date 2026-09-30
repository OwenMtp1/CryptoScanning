/**
 * GET /api/coinbase/products            → Coinbase public spot product list (cached 60 s)
 * GET /api/coinbase/products?type=perp  → Coinbase perpetual contracts (leverage, funding, OI), cached 60 s
 * (GET /api/v3/brokerage/market/products, no key). The browser tries Coinbase
 * directly first (its own IP, no shared rate limit); this is the fallback.
 */
import { cachedFetch } from "../../../lib/proxy.js";

const URLS = {
  spot: ["coinbase-products-all", "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT"],
  perp: ["coinbase-perps", "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&contract_expiry_type=PERPETUAL"],
  // Coinbase International Exchange: public instruments (perpetuals, margin → max leverage).
  intx: ["coinbase-intx-instruments", "https://api.international.coinbase.com/api/v1/instruments"],
};

export async function onRequestGet(ctx) {
  const type = new URL(ctx.request.url).searchParams.get("type") || "spot";
  const [key, url] = URLS[type] || URLS.spot;
  return cachedFetch(ctx, key, url, { headers: { accept: "application/json" } }, 60, "application/json; charset=utf-8");
}
