/**
 * GET /api/cg/<path> → CoinGecko, for a FIXED set of canonical requests only
 * (no open proxy, no cache-busting parameters that would burn the quota).
 * Secrets (Cloudflare dashboard → Settings → Variables and Secrets):
 *   COINGECKO_API_KEY (optional, recommended), COINGECKO_PLAN = demo | pro
 */
import { cachedFetch, json } from "../../../lib/proxy.js";

const PCT = "1h%2C24h%2C7d";

function route(parts, params) {
  const p = parts.join("/");
  if (p === "coins/markets") {
    const page = Number(params.get("page") ?? "1");
    if (!Number.isInteger(page) || page < 1 || page > 8) return null;
    return { key: `markets-${page}`, path: `/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false&price_change_percentage=${PCT}`, ttl: 1800 };
  }
  if (p === "search/trending") return { key: "trending", path: "/search/trending", ttl: 1800 };
  if (p === "derivatives") return { key: "derivatives", path: "/derivatives", ttl: 3600 };
  if (p === "onchain/networks/trending_pools") return { key: "dex-trending", path: "/onchain/networks/trending_pools?include=base_token&page=1", ttl: 1800 };
  if (p === "onchain/networks/new_pools") return { key: "dex-new", path: "/onchain/networks/new_pools?include=base_token&page=1", ttl: 1800 };
  return null;
}

export async function onRequestGet(ctx) {
  const url = new URL(ctx.request.url);
  const parts = [].concat(ctx.params.path ?? []);
  const r = route(parts, url.searchParams);
  if (!r) return json({ error: "not_allowed" }, 404);
  const key = ctx.env.COINGECKO_API_KEY || null;
  const pro = ctx.env.COINGECKO_PLAN === "pro";
  const base = pro ? "https://pro-api.coingecko.com/api/v3" : "https://api.coingecko.com/api/v3";
  const headers = { accept: "application/json" };
  if (key) headers[pro ? "x-cg-pro-api-key" : "x-cg-demo-api-key"] = key;
  return cachedFetch(ctx, `cg-${pro ? "pro" : key ? "demo" : "public"}-${r.key}`, `${base}${r.path}`, { headers }, r.ttl, "application/json; charset=utf-8");
}
