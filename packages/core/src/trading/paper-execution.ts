/**
 * Paper execution model for MARKET orders (IOC), simulating:
 * fees, spread (buy at ask / sell at bid), slippage (random + size impact
 * vs top-of-book depth), partial fills (order larger than the available
 * depth multiple), unfilled orders, and exchange size increments/minimums.
 *
 * Latency is handled by the caller: the book passed here is the one at
 * fill time, not at decision time.
 *
 * Fee assumption (not verified against Coinbase docs): for a BUY with a
 * quote amount, the fee is INCLUDED in that amount (total spend = amount).
 */
import type { Prng } from "../simulation/prng.js";
import type { PaperConfig } from "./config.js";
import type { Fill, OrderIntent } from "./types.js";

export interface BookTop {
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
}

export interface ProductRules {
  baseIncrement: number | null;
  baseMinSize: number | null;
  quoteMinSize: number | null;
}

export type SimResult =
  | { status: "FILLED" | "PARTIALLY_FILLED"; fill: Fill }
  | { status: "UNFILLED" | "REJECTED"; reason: string };

function floorTo(x: number, inc: number | null): number {
  if (!inc || inc <= 0) return x;
  const decimals = Math.max(0, Math.ceil(-Math.log10(inc)));
  return Number((Math.floor(x / inc + 1e-9) * inc).toFixed(decimals));
}

export function simulateMarketOrder(
  orderId: string,
  intent: OrderIntent,
  book: BookTop,
  rules: ProductRules,
  cfg: PaperConfig,
  rng: Prng,
  ts: number,
  latencyMs: number,
): SimResult {
  const buy = intent.side === "BUY";
  const touch = buy ? book.ask : book.bid;
  const touchQty = buy ? book.askQty : book.bidQty;
  if (touch === null || !(touch > 0) || touchQty === null || !(touchQty > 0)) return { status: "UNFILLED", reason: "carnet indisponible au moment de l'exécution" };
  if (rng.next() < cfg.unfilledProbability) return { status: "UNFILLED", reason: "aucune contrepartie (échec simulé)" };

  const fee = cfg.takerFeePct / 100;
  const depthQuote = touchQty * touch;
  const requestedQuote = buy ? (intent.quoteSize ?? 0) / (1 + fee) : (intent.baseSize ?? 0) * touch;
  if (!(requestedQuote > 0)) return { status: "REJECTED", reason: "taille d'ordre nulle" };

  const fraction = requestedQuote / depthQuote;
  const fillRatio = fraction > cfg.maxDepthMultiple ? cfg.maxDepthMultiple / fraction : 1;
  const impactPct = cfg.impactPctPerDepth * Math.min(fraction, cfg.maxDepthMultiple) + (cfg.baseSlippageBps / 100) * rng.next();
  const price = touch * (buy ? 1 + impactPct / 100 : 1 - impactPct / 100);

  const rawBase = buy ? (requestedQuote * fillRatio) / price : (intent.baseSize ?? 0) * fillRatio;
  const baseQty = floorTo(rawBase, rules.baseIncrement);
  const quoteGross = baseQty * price;
  if (!(baseQty > 0) || (rules.baseMinSize !== null && baseQty < rules.baseMinSize) || (rules.quoteMinSize !== null && quoteGross < rules.quoteMinSize)) {
    return { status: "REJECTED", reason: `taille inférieure au minimum du produit (quantité ${baseQty}, montant ${quoteGross.toFixed(4)})` };
  }
  const slippagePct = ((buy ? price - intent.referencePrice : intent.referencePrice - price) / intent.referencePrice) * 100;
  const fill: Fill = {
    orderId,
    ts,
    productId: intent.productId,
    side: intent.side,
    requestedPrice: intent.referencePrice,
    price,
    baseQty,
    quoteGross,
    fee: quoteGross * fee,
    slippageQuote: Math.abs(price - intent.referencePrice) * baseQty * Math.sign(slippagePct || 0),
    slippagePct,
    partial: fillRatio < 1,
    latencyMs,
  };
  return { status: fill.partial ? "PARTIALLY_FILLED" : "FILLED", fill };
}
