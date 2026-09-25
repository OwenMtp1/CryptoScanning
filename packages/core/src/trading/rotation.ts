/**
 * Rotation after exit (spec §10) — optional, per strategy. Produces BUY
 * intents on `<ASSET>-<currency>`; each one is checked by the Risk Engine.
 */
import type { Strategy } from "./config.js";
import type { OrderIntent, TradeRecord } from "./types.js";

export interface RotationPlan {
  intents: OrderIntent[];
  skipped: { asset: string; amount: number; reason: string }[];
  baseAmount: number;
}

export function planRotation(
  trade: TradeRecord,
  strategy: Strategy,
  currency: string,
  priceOf: (productId: string) => number | null,
  newId: () => string,
  now: number,
): RotationPlan {
  const rot = strategy.afterExit.rotation;
  const plan: RotationPlan = { intents: [], skipped: [], baseAmount: 0 };
  if (!rot.enabled) return plan;
  const baseAmount = rot.mode === "proceeds" ? trade.proceedsQuote : Math.max(0, trade.pnl);
  plan.baseAmount = baseAmount;
  for (const [asset, pct] of Object.entries(rot.allocations)) {
    const amount = Math.floor(((baseAmount * pct) / 100) * 100) / 100;
    const productId = `${asset}-${currency}`;
    const price = priceOf(productId);
    if (amount < rot.minOrderQuote) {
      plan.skipped.push({ asset, amount, reason: `montant ${amount.toFixed(2)} < minimum ${rot.minOrderQuote}` });
      continue;
    }
    if (price === null) {
      plan.skipped.push({ asset, amount, reason: `prix ${productId} indisponible` });
      continue;
    }
    plan.intents.push({
      id: newId(),
      ts: now,
      kind: "ROTATION",
      productId,
      side: "BUY",
      quoteSize: amount,
      baseSize: null,
      strategyId: strategy.id,
      positionId: null,
      referencePrice: price,
      reason: `rotation ${pct} % (${rot.mode === "proceeds" ? "capital récupéré" : "profit"}) de ${trade.productId} vers ${asset}`,
      exitReason: null,
      signalScore: null,
    });
  }
  return plan;
}
