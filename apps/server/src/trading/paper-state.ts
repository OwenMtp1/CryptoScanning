import { z } from "zod";
import type { BreakerState, EquityPoint, PortfolioState, Position, TradeRecord } from "@radar/core";

/** Persistent paper-trading state (single JSON file, written atomically). */
export interface PaperStateFile {
  version: 1;
  savedAt: string;
  portfolio: PortfolioState;
  positions: Position[];
  trades: TradeRecord[];
  equity: EquityPoint[];
  breakers: BreakerState[];
  counters: {
    consecutiveErrors: number;
    lastLossAt: number | null;
    entryTimes: number[];
    fillTimes: number[];
    executionRejections: number[];
  };
  lastEntryAt: Record<string, number>;
}

const num = z.number().finite();
const mark = z.object({ price: num, ts: num });
const PositionSchema = z
  .object({
    id: z.string(),
    strategyId: z.string(),
    productId: z.string(),
    baseCurrency: z.string(),
    status: z.enum(["open", "closing", "closed"]),
    openedAt: num,
    entryPrice: num.positive(),
    baseQty: num.nonnegative(),
    initialBaseQty: num.positive(),
    costQuote: num.nonnegative(),
    stopLevel: num,
    trailingLevel: num.nullable(),
    highestPrice: num,
    lastPrice: num,
  })
  .passthrough();
const TradeSchema = z.object({ id: z.string(), productId: z.string(), pnl: num, closedAt: num, fees: num }).passthrough();

export const StateSchema = z.object({
  version: z.literal(1),
  savedAt: z.string(),
  portfolio: z.object({
    currency: z.string(),
    cash: num,
    holdings: z.record(z.string(), num.nonnegative()),
    marks: z.record(z.string(), mark),
    initialized: z.boolean(),
    initializedAt: num.nullable(),
    initialValue: num,
  }),
  positions: z.array(PositionSchema),
  trades: z.array(TradeSchema),
  equity: z.array(z.object({ ts: num, total: num, tradingPnl: num })),
  breakers: z.array(z.object({ id: z.string(), reason: z.string(), since: num, manualReset: z.boolean() })),
  counters: z.object({
    consecutiveErrors: z.number().int().nonnegative(),
    lastLossAt: num.nullable(),
    entryTimes: z.array(num),
    fillTimes: z.array(num),
    executionRejections: z.array(num),
  }),
  lastEntryAt: z.record(z.string(), num),
});


/** Validate a saved paper state (throws with the first issue). */
export function parsePaperState(json: unknown): PaperStateFile {
  const parsed = StateSchema.safeParse(json);
  if (!parsed.success) throw new Error(`état paper invalide : ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  return parsed.data as unknown as PaperStateFile;
}
