/**
 * GET /api/candles?ex=<okx|bybit|kucoin|mexc|gate>&coin=<SYMBOL>&interval=<1m|5m|15m|1h|4h|1d>&limit=<n>
 * → public candles of one exchange, for the chart page (coins missing on Binance and Coinbase).
 * Fixed set of exchanges and parameters (no open proxy), shared edge cache of 30 s to 10 min.
 */
import { cachedFetch, json } from "../../lib/proxy.js";

const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"];
const SEC = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const TTL = { "1m": 30, "5m": 60, "15m": 120, "1h": 300, "4h": 600, "1d": 600 };

const BUILD = {
  okx: (c, iv, n) => `https://www.okx.com/api/v5/market/candles?instId=${c}-USDT&bar=${{ "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc" }[iv]}&limit=${Math.min(300, n)}`,
  bybit: (c, iv, n) => `https://api.bybit.com/v5/market/kline?category=spot&symbol=${c}USDT&interval=${{ "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" }[iv]}&limit=${Math.min(1000, n)}`,
  kucoin: (c, iv, n, now) =>
    `https://api.kucoin.com/api/v1/market/candles?type=${{ "1m": "1min", "5m": "5min", "15m": "15min", "1h": "1hour", "4h": "4hour", "1d": "1day" }[iv]}&symbol=${c}-USDT&startAt=${now - Math.min(1500, n) * SEC[iv]}&endAt=${now}`,
  mexc: (c, iv, n) => `https://api.mexc.com/api/v3/klines?symbol=${c}USDT&interval=${{ "1m": "1m", "5m": "5m", "15m": "15m", "1h": "60m", "4h": "4h", "1d": "1d" }[iv]}&limit=${Math.min(1000, n)}`,
  gate: (c, iv, n) => `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${c}_USDT&interval=${iv}&limit=${Math.min(1000, n)}`,
};

export async function onRequestGet(ctx) {
  const q = new URL(ctx.request.url).searchParams;
  const ex = q.get("ex") || "";
  const coin = (q.get("coin") || "").toUpperCase();
  const iv = q.get("interval") || "";
  const n = Number(q.get("limit") || "300");
  if (!BUILD[ex] || !/^[A-Z0-9]{1,20}$/.test(coin) || !INTERVALS.includes(iv) || !Number.isInteger(n) || n < 10 || n > 1000) return json({ error: "not_allowed" }, 400);
  // Round "now" to the cache period so every visitor shares the same cached answer.
  const now = Math.floor(Date.now() / 1000 / TTL[iv]) * TTL[iv];
  return cachedFetch(ctx, `candles-${ex}-${coin}-${iv}-${n}-${ex === "kucoin" ? now : ""}`, BUILD[ex](coin, iv, n, now), { headers: { accept: "application/json" } }, TTL[iv], "application/json; charset=utf-8");
}
