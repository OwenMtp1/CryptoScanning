/** Run modes. LIVE is deliberately absent: it will need its own phase and explicit confirmations. */
export const IMPLEMENTED_MODES = ["RADAR", "PAPER"] as const;
export type ImplementedMode = (typeof IMPLEMENTED_MODES)[number];

export function parseMode(raw: string): { ok: true; mode: ImplementedMode } | { ok: false; message: string } {
  const m = raw.trim().toUpperCase();
  if ((IMPLEMENTED_MODES as readonly string[]).includes(m)) return { ok: true, mode: m as ImplementedMode };
  return { ok: false, message: `Mode ${m || "(vide)"} refusé : modes disponibles ${IMPLEMENTED_MODES.join(", ")}. Le LIVE n'est pas implémenté.` };
}
