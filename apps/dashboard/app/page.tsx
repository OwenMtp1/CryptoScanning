"use client";

import { RadarTable } from "@/components/RadarTable";
import { Card, SignalChips, Stat } from "@/components/ui";
import { fmtAge, fmtDuration, fmtTime } from "@/lib/format";
import { useRadarStream } from "@/lib/stream";

export default function RadarPage() {
  const { snapshot, status, events, state } = useRadarStream();
  const recentSignals = events.filter((e) => e.type === "SIGNAL_DETECTED" || e.type === "OPPORTUNITY_DETECTED").slice(0, 12);

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
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-sky-400" />
            <span className="whitespace-nowrap font-semibold text-sky-300">MODE RADAR</span>
            <span className="text-xs text-slate-500">observation uniquement — aucune transaction</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Stat label="Capital / P&L" value="—" tone="muted" hint="disponible avec le Paper Trading" />
            <Stat label="Positions" value="—" tone="muted" hint="aucune (mode RADAR)" />
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
            value="N/A"
            tone="muted"
            hint={status ? `uptime ${fmtDuration(Date.now() - status.startedAt)}` : "Risk Engine : phase ultérieure"}
          />
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card title="Live market radar" className="min-w-0">
          <RadarTable rows={snapshot?.rows ?? []} />
        </Card>
        <Card title="Derniers signaux" className="min-w-0">
          <ul className="space-y-2 text-xs">
            {recentSignals.length === 0 && <li className="text-slate-500">Aucun signal pour l&apos;instant.</li>}
            {recentSignals.map((e) => (
              <li key={e.id} className="border-b border-slate-800 pb-2">
                <div className="flex items-center gap-2">
                  <span className="num text-slate-500">{fmtTime(e.ts)}</span>
                  <span className="font-semibold text-slate-200">{e.productId}</span>
                  {e.type === "OPPORTUNITY_DETECTED" ? (
                    <span className="rounded bg-emerald-500/15 px-1.5 text-[10px] font-bold text-emerald-300">OPPORTUNITÉ</span>
                  ) : (
                    <SignalChips types={[(e.data as { signalType: never }).signalType]} />
                  )}
                </div>
                <div className="mt-0.5 text-slate-400">{e.message.replace(`${e.productId} : `, "")}</div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
