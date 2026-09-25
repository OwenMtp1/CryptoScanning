import { z } from "zod";

import { LOG_LEVELS, type LogEvent, type LogLevel } from "./event-types.js";

export * from "./event-types.js";

export const LogQuerySchema = z.object({
  types: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : [])),
  productId: z.string().optional(),
  strategy: z.string().optional(),
  level: z.enum(LOG_LEVELS).optional(),
  success: z
    .enum(["true", "false"])
    .optional()
    .transform((s) => (s === undefined ? undefined : s === "true")),
  from: z.string().optional(),
  to: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});
export type LogQuery = z.infer<typeof LogQuerySchema>;

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Filter events (newest first in the result). `level` means "this level or above". */
export function filterEvents(events: readonly LogEvent[], q: LogQuery): LogEvent[] {
  const from = q.from ? Date.parse(q.from) : Number.NEGATIVE_INFINITY;
  const to = q.to ? Date.parse(q.to) : Number.POSITIVE_INFINITY;
  const text = q.q?.toLowerCase();
  const out: LogEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < q.limit; i--) {
    const e = events[i] as LogEvent;
    if (q.types.length && !q.types.includes(e.type)) continue;
    if (q.productId && e.productId !== q.productId) continue;
    if (q.strategy && e.strategy !== q.strategy) continue;
    if (q.level && LEVEL_RANK[e.level] < LEVEL_RANK[q.level]) continue;
    if (q.success !== undefined && e.success !== q.success) continue;
    const t = Date.parse(e.ts);
    if (t < from || t > to) continue;
    if (text && !e.message.toLowerCase().includes(text) && !e.type.toLowerCase().includes(text)) continue;
    out.push(e);
  }
  return out;
}
