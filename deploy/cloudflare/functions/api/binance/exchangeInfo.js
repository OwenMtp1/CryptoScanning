/** GET /api/binance/exchangeInfo → Binance spot pair list (fallback when the browser call is refused), cached 6 h. */
import { cachedFetch } from "../../../lib/proxy.js";

export async function onRequestGet(ctx) {
  return cachedFetch(ctx, "binance-exchangeinfo", "https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT", {}, 21600, "application/json; charset=utf-8");
}
