"use client";

import { useState } from "react";
import { postAction } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { useRadarStream } from "@/lib/stream";
import { useDialogs } from "./Dialogs";

/** 🛑 EMERGENCY STOP button (always visible) and blocked-state banner. */
export function EmergencyStopButton() {
  const { trading } = useRadarStream();
  const { confirm, notify } = useDialogs();
  const [busy, setBusy] = useState(false);
  if (!trading || trading.emergencyStop) return null;
  const stop = async () => {
    const r = await confirm({
      title: "🛑 EMERGENCY STOP",
      message: "Aucune nouvelle position ne sera ouverte. Les stops et trailing stops des positions ouvertes restent actifs.\nLa réactivation sera manuelle.",
      confirmLabel: "Arrêter le bot",
      tone: "danger",
      input: "arrêt manuel",
    });
    if (!r.ok) return;
    const reason = r.text.trim();
    setBusy(true);
    try {
      await postAction("/api/trading/emergency-stop", { reason: reason || "arrêt manuel" });
    } catch (e) {
      notify(`Échec : ${(e as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={stop}
      disabled={busy}
      className="rounded bg-rose-600 px-3 py-1.5 text-xs font-bold tracking-wide text-white hover:bg-rose-500 disabled:opacity-50"
    >
      🛑 EMERGENCY STOP
    </button>
  );
}

export function BlockedBanner() {
  const { trading } = useRadarStream();
  const { confirm, notify } = useDialogs();
  const [busy, setBusy] = useState(false);
  if (!trading || trading.breakers.length === 0) return null;
  const manual = trading.breakers.filter((b) => b.manualReset);
  const resume = async () => {
    const r = await confirm({
      title: "Réactiver les nouvelles entrées ?",
      message: `Disjoncteurs levés : ${manual.map((b) => b.id).join(", ")}.
Si la condition persiste, ils se redéclencheront.`,
      confirmLabel: "Réactiver",
      requireText: "RESUME",
    });
    if (!r.ok) return;
    setBusy(true);
    try {
      await postAction("/api/trading/resume", { confirm: "RESUME" });
    } catch (e) {
      notify(`Échec : ${(e as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };
  const emergency = trading.emergencyStop;
  return (
    <div className={`${emergency ? "bg-rose-600/25 text-rose-100" : "bg-orange-500/15 text-orange-200"} px-4 py-2 text-sm`}>
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3">
        <span className="font-bold">{emergency ? "🛑 BOT ARRÊTÉ (EMERGENCY STOP)" : "🔴 DISJONCTEUR DÉCLENCHÉ"}</span>
        <span className="text-xs opacity-90">
          Nouvelles entrées bloquées · sorties de protection actives ·{" "}
          {trading.breakers.map((b) => `${b.id} : ${b.reason} (depuis ${fmtDateTime(b.since)})`).join(" · ")}
        </span>
        {manual.length > 0 && (
          <button onClick={resume} disabled={busy} className="ml-auto rounded border border-current px-2 py-1 text-xs font-semibold hover:bg-white/10 disabled:opacity-50">
            Réactiver manuellement…
          </button>
        )}
      </div>
    </div>
  );
}
