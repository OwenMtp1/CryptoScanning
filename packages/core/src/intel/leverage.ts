/**
 * Leveraged markets (Coinbase perpetual contracts): unusual moves and a
 * rule-based LONG / SHORT / NEUTRAL indication, every factor explained.
 *
 * This is a statistical reading of the current data, NOT advice: with
 * leverage ×N, a move of 100/N % against the position wipes it out.
 */
import { z } from "zod";
import type { Direction, IntelKind } from "./types.js";

const dec = z
  .union([z.string(), z.number()])
  .nullable()
  .optional()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  });

/** Coinbase `GET /market/products?product_type=FUTURE&contract_expiry_type=PERPETUAL` item (fields of the official SDK). */
export const CoinbasePerpSchema = z.object({
  product_id: z.string(),
  price: dec,
  price_percentage_change_24h: dec,
  volume_24h: dec,
  approximate_quote_24h_volume: dec,
  base_display_symbol: z.string().nullable().optional(),
  display_name: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  trading_disabled: z.boolean().nullable().optional(),
  future_product_details: z
    .object({
      venue: z.string().nullable().optional(),
      contract_display_name: z.string().nullable().optional(),
      contract_root_unit: z.string().nullable().optional(),
      contract_expiry_type: z.string().nullable().optional(),
      perpetual_details: z.object({ open_interest: dec, funding_rate: dec, max_leverage: dec }).partial().nullable().optional(),
    })
    .partial()
    .nullable()
    .optional(),
});
export type CoinbasePerp = z.infer<typeof CoinbasePerpSchema>;

export interface PerpMarket {
  productId: string;
  coin: string;
  name: string;
  venue: string | null;
  maxLeverage: number | null;
  price: number | null;
  change24h: number | null;
  /** Coinbase funding rate as returned (a fraction per funding period), shown in %. */
  fundingPct: number | null;
  openInterest: number | null;
  volume24hUsd: number | null;
  url: string;
}

export function parsePerps(json: unknown): PerpMarket[] {
  const list = (json as { products?: unknown[] })?.products ?? [];
  const out: PerpMarket[] = [];
  for (const raw of list) {
    const p = CoinbasePerpSchema.safeParse(raw);
    if (!p.success) continue;
    const d = p.data;
    const fd = d.future_product_details;
    // Only real perpetual contracts (spot products have no future_product_details).
    if (!fd || (fd.contract_expiry_type && fd.contract_expiry_type !== "PERPETUAL")) continue;
    if (d.trading_disabled || (d.status && d.status !== "online")) continue;
    const coin = (fd.contract_root_unit || d.base_display_symbol || d.product_id.split("-")[0] || "").toUpperCase();
    if (!coin) continue;
    const pd = fd.perpetual_details ?? {};
    out.push({
      productId: d.product_id,
      coin,
      name: fd.contract_display_name || d.display_name || d.product_id,
      venue: fd.venue ?? null,
      maxLeverage: pd.max_leverage ?? null,
      price: d.price,
      change24h: d.price_percentage_change_24h,
      fundingPct: pd.funding_rate !== null && pd.funding_rate !== undefined ? pd.funding_rate * 100 : null,
      openInterest: pd.open_interest ?? null,
      volume24hUsd: d.approximate_quote_24h_volume ?? (d.volume_24h !== null && d.price !== null ? d.volume_24h * d.price : null),
      url: `https://www.coinbase.com/advanced-trade/perpetuals/${d.product_id}`,
    });
  }
  return out;
}

export interface LeverageContext {
  change15m: number | null;
  change1h: number | null;
  /** Share of aggressive buy volume (0–1). */
  takerBuyRatio: number | null;
  /** Funding on Binance Futures for the same coin (%, per 8 h). */
  binanceFundingPct: number | null;
  /** Binance global long / short account ratio. */
  longShortRatio: number | null;
  /** Open interest change since the previous reading (%). */
  oiChangePct: number | null;
  /** Signals on this coin in the last 2 h. */
  recent: { direction: Direction; strength: number; kind: IntelKind }[];
  /** Bitcoin 1 h change (market context). */
  btcChange1h: number | null;
}

export interface LeverageReading extends PerpMarket {
  score: number;
  bias: "LONG" | "SHORT" | "NEUTRE";
  reasons: string[];
  anomalies: string[];
  /** Move against the position that liquidates it at max leverage (≈ 100 / leverage, fees ignored). */
  liquidationMovePct: number | null;
  context: LeverageContext;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const pct = (x: number, d = 2) => `${x > 0 ? "+" : ""}${x.toFixed(d)} %`;

export function readLeverage(m: PerpMarket, c: LeverageContext): LeverageReading {
  let score = 0;
  const reasons: string[] = [];
  const anomalies: string[] = [];
  const add = (pts: number, why: string) => {
    if (Math.abs(pts) < 1) return;
    score += pts;
    reasons.push(`${pts > 0 ? "▲" : "▼"} ${why} (${pts > 0 ? "+" : ""}${Math.round(pts)})`);
  };
  if (c.change15m !== null || c.change1h !== null) {
    const mom = clamp((c.change1h ?? 0) * 4 + (c.change15m ?? 0) * 6, -30, 30);
    add(mom, `élan : ${c.change15m !== null ? `${pct(c.change15m)} en 15 min` : ""}${c.change15m !== null && c.change1h !== null ? ", " : ""}${c.change1h !== null ? `${pct(c.change1h)} en 1 h` : ""}`);
  }
  if (c.takerBuyRatio !== null) add(clamp((c.takerBuyRatio - 0.5) * 80, -20, 20), `${(c.takerBuyRatio * 100).toFixed(0)} % des volumes récents sont des achats agressifs`);
  const fund = c.binanceFundingPct ?? m.fundingPct;
  if (fund !== null) {
    if (fund >= 0.05) {
      add(-15, `funding très positif (${fund.toFixed(4)} %) : trop d'acheteurs à levier, risque de purge des longs`);
      anomalies.push(`funding extrême ${fund.toFixed(4)} %`);
    } else if (fund <= -0.03) {
      add(15, `funding négatif (${fund.toFixed(4)} %) : vendeurs à découvert surchargés, squeeze possible`);
      anomalies.push(`funding négatif ${fund.toFixed(4)} %`);
    }
  }
  if (c.longShortRatio !== null) {
    if (c.longShortRatio >= 2.5) add(-12, `${c.longShortRatio.toFixed(2)} comptes long pour 1 short : foule très acheteuse (signal contraire)`);
    else if (c.longShortRatio <= 0.8) add(12, `${c.longShortRatio.toFixed(2)} comptes long pour 1 short : foule vendeuse (signal contraire)`);
  }
  if (c.oiChangePct !== null && Math.abs(c.oiChangePct) >= 5) {
    const up = (c.change1h ?? c.change15m ?? 0) >= 0;
    if (c.oiChangePct > 0) add(up ? 10 : -10, `open interest ${pct(c.oiChangePct, 1)} avec prix ${up ? "en hausse" : "en baisse"} : ${up ? "nouveaux acheteurs" : "nouveaux vendeurs"} à levier`);
    anomalies.push(`open interest ${pct(c.oiChangePct, 1)}`);
  }
  const net = c.recent.reduce((s, x) => s + (x.direction === "bullish" ? 1 : x.direction === "bearish" ? -1 : 0) * x.strength, 0) / 100;
  if (c.recent.length) {
    add(clamp(net * 12, -25, 25), `${c.recent.length} signal(s) récents sur ${m.coin} (${c.recent.filter((x) => x.direction === "bullish").length} haussiers, ${c.recent.filter((x) => x.direction === "bearish").length} baissiers)`);
    for (const r of c.recent.slice(0, 4)) anomalies.push(`${r.kind} (${r.strength})`);
  }
  if (c.btcChange1h !== null && m.coin !== "BTC" && Math.abs(c.btcChange1h) >= 1) add(clamp(c.btcChange1h * 5, -10, 10), `marché : Bitcoin ${pct(c.btcChange1h)} en 1 h`);
  score = Math.round(clamp(score, -100, 100));
  return {
    ...m,
    score,
    bias: score >= 25 ? "LONG" : score <= -25 ? "SHORT" : "NEUTRE",
    reasons,
    anomalies,
    liquidationMovePct: m.maxLeverage && m.maxLeverage > 0 ? Math.round((100 / m.maxLeverage) * 100) / 100 : null,
    context: c,
  };
}
