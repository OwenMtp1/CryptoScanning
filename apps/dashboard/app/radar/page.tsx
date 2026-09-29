"use client";

import { RadarTable } from "@/components/RadarTable";
import { Card, SignalChips, Stat } from "@/components/ui";
import { fmtAge, fmtDuration, fmtMoney, fmtTime } from "@/lib/format";
import { useRadarStream } from "@/lib/stream";

const EVENT_CHIP: Record<string, { label: string; cls: string }> = {
  OPPORTUNITY_DETECTED: { label: "🚨 OPPORTUNITÉ", cls: "bg-emerald-500/15 text-emerald-300" },
  POSITION_OPENED: { label: "⚡ OUVERTE", cls: "bg-sky-500/15 text-sky-300" },
  POSITION_CLOSED: { label: "💰 FERMÉE", cls: "bg-slate-600/40 text-slate-100" },
  STOP_TRIGGERED: { label: "🛑 STOP", cls: "bg-amber-500/20 text-amber-300" },
  ORDER_REJECTED: { label: "REFUSÉ", cls: "bg-rose-500/15 text-rose-300" },
  BOT_STOPPED: { label: "🛑 BOT ARRÊTÉ", cls: "bg-rose-600/30 text-rose-200" },
  BOT_PAUSED: { label: "🔴 LIMITE", cls: "bg-orange-500/20 text-orange-200" },
};

export default function RadarPage() {
  const { snapshot, status, events, state, trading } = useRadarStream();
  const recentSignals = events
    .filter((e) => ["SIGNAL_DETECTED", "OPPORTUNITY_DETECTED", "POSITION_OPENED", "POSITION_CLOSED", "STOP_TRIGGERED", "ORDER_REJECTED", "BOT_STOPPED", "BOT_PAUSED"].includes(e.type))
    .slice(0, 14);

  if (state !== "open" && !snapshot) {
    return (
      <Card>
        <p className="text-slate-300">Connexion à l&apos;API locale…</p>
        <p className="mt-1 text-sm text-slate-500">
          Vérifie que le serveur tourne : <code className="text-slate-300">pnpm dev:server</code> (port 4000).
        </p>
      </Card>
    );
  }

  const h = snapshot?.health ?? status?.health;
  const feed = status?.feed;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
        <Card className="col-span-2 md:col-span-4 xl:col-span-2">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${trading?.executionEnabled ? "bg-emerald-400" : "bg-sky-400"}`} />
            <span className={`whitespace-nowrap font-semibold ${trading?.executionEnabled ? "text-emerald-300" : "text-sky-300"}`}>
              {trading?.executionEnabled ? "PAPER MODE" : "MODE RADAR"}
            </span>
            <span className="text-xs text-slate-500">{trading?.executionEnabled ? "trading simulé — aucun ordre réel" : "observation — portefeuille virtuel, aucune exécution"}</span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Stat
              label="Capital"
              value={trading?.initialized ? fmtMoney(trading.capital.total, trading.capital.currency) : "—"}
              hint={trading?.initialized ? `tradable ${fmtMoney(trading.capital.tradable, trading.capital.currency)}` : trading?.waitingFor.length ? `attente prix ${trading.waitingFor.join(", ")}` : undefined}
            />
            <Stat
              label="P&L trading"
              value={trading ? fmtMoney(trading.performance.tradingPnl, trading.capital.currency, true) : "—"}
              tone={!trading || Math.abs(trading.performance.tradingPnl) < 0.005 ? "default" : trading.performance.tradingPnl > 0 ? "good" : "bad"}
              hint={trading ? `${trading.performance.trades} trade(s) clôturé(s)` : undefined}
            />
            <Stat label="Positions" value={trading ? `${trading.positions.length}/${trading.limits.maxOpenPositions}` : "—"} hint="ouvertes / max" />
          </div>
        </Card>
        <Card>
          <Stat label="Actifs suivis" value={status?.products ?? "—"} hint={feed ? `${feed.openConnections}/${feed.connections} connexion(s)` : undefined} />
        </Card>
        <Card>
          <Stat label="Opportunités" value={snapshot?.opportunities ?? 0} tone={(snapshot?.opportunities ?? 0) > 0 ? "good" : "default"} hint="actives" />
        </Card>
        <Card>
          <Stat label="Signaux (5 min)" value={snapshot?.signalsLast5m ?? 0} />
        </Card>
        <Card>
          <Stat
            label="Données"
            value={h?.healthy ? "Fraîches" : "Obsolètes"}
            tone={h?.healthy ? "good" : "bad"}
            hint={h?.healthy ? `dernier message ${fmtAge(h.lastMessageAgeMs)}` : (h?.reason ?? undefined)}
          />
        </Card>
        <Card>
          <Stat
            label="Risque"
            value={trading?.riskLevel ?? "—"}
            tone={trading?.riskLevel === "LOW" ? "good" : trading?.riskLevel === "MEDIUM" ? "warn" : trading ? "bad" : "muted"}
            hint={trading ? `perte 24 h ${fmtMoney(trading.limits.lossUsed24h, trading.capital.currency)} / ${trading.limits.maxDailyLoss}` : status ? `uptime ${fmtDuration(Date.now() - status.startedAt)}` : undefined}
          />
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card title="Live market radar" className="min-w-0">
          <RadarTable rows={snapshot?.rows ?? []} />
        </Card>
        <Card title="Derniers événements" className="min-w-0">
          <ul className="space-y-2 text-xs">
            {recentSignals.length === 0 && <li className="text-slate-500">Aucun signal pour l&apos;instant.</li>}
            {recentSignals.map((e) => (
              <li key={e.id} className="border-b border-slate-800 pb-2">
                <div className="flex items-center gap-2">
                  <span className="num text-slate-500">{fmtTime(e.ts)}</span>
                  <span className="font-semibold text-slate-200">{e.productId}</span>
                  {e.type === "SIGNAL_DETECTED" ? (
                    <SignalChips types={[(e.data as { signalType: never }).signalType]} />
                  ) : (
                    <span className={`rounded px-1.5 text-[10px] font-bold ${EVENT_CHIP[e.type]?.cls ?? "bg-slate-700 text-slate-200"}`}>{EVENT_CHIP[e.type]?.label ?? e.type}</span>
                  )}
                </div>
                <div className="mt-0.5 break-words text-slate-400">{e.message.replace(`${e.productId} : `, "")}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
