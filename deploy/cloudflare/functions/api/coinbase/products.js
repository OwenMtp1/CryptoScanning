/**
 * GET /api/coinbase/products?page=0..3 → Coinbase public spot product list
 * (GET /api/v3/brokerage/market/products, no key), 250 per page, cached 60 s.
 */
import { cachedFetch, json } from "../../../lib/proxy.js";

export async function onRequestGet(ctx) {
  const page = Number(new URL(ctx.request.url).searchParams.get("page") ?? "0");
  if (!Number.isInteger(page) || page < 0 || page > 3) return json({ error: "not_allowed" }, 404);
  return cachedFetch(ctx, `coinbase-products-${page}`, `https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT&limit=250&offset=${page * 250}`, { headers: { accept: "application/json" } }, 60, "application/json; charset=utf-8");
}
