"use client";

import type { TradeSetup } from "@radar/core";
import { useEffect, useState } from "react";
import { BIAS_STYLE, SetupPlan } from "@/components/Setup";
import { Card } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtAgo, safeHref } from "@/lib/intel";

interface SetupRow {
  coin: string;
  name: string | null;
  at: number;
  url: string | null;
  origin?: string;
  setup: TradeSetup;
}
interface SetupsResponse {
  at: number | null;
  count: number;
  setups: SetupRow[];
  btcTrend?: number | null;
}

type Filter = "ACTIVE" | "LONG" | "SHORT" | "WAIT";

export default function SetupsPage() {
  const [d, setD] = useState<SetupsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("ACTIVE");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      getJson<SetupsResponse>("/api/intel/setups").then(
        (r) => {
          setD(r);
          setErr(null);
        },
        (e: Error) => setErr(e.message),
      );
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const all = d?.setups ?? [];
  const rows = all.filter((x) => (filter === "ACTIVE" ? x.setup.bias !== "WAIT" : x.setup.bias === filter));
  const n = (b: string) => all.filter((x) => x.setup.bias === b).length;

  return (
    <div className="space-y-4">
      <Card title="🎯 Setups façon trader">
        <p className="text-sm text-slate-300">
          Chaque crypto passe la checklist d&apos;un trader : tendance sur 2 unités de temps (moyennes 20/50/200), momentum (RSI, MACD), structure (cassures, supports, résistances), volume (OBV), positionnement des dérivés (financement, ratio long/short, intérêt ouvert — lu à contre-courant), régime du Bitcoin. Un
          setup n&apos;est proposé que si tout est aligné <em>et</em> que le gain possible vaut au moins 1,5 fois le risque ; sinon : « attendre ».
        </p>
        <p className="mt-1 text-[11px] text-amber-300/90">Plan statistique, pas un conseil : un setup sur deux ou plus peut échouer. Le stop fait partie du plan.</p>
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {(
            [
              ["ACTIVE", `Actifs (${n("LONG") + n("SHORT")})`],
              ["LONG", `▲ LONG (${n("LONG")})`],
              ["SHORT", `▼ SHORT (${n("SHORT")})`],
              ["WAIT", `⏸ Attendre (${n("WAIT")})`],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={`rounded px-3 py-1.5 ${filter === k ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"}`}>
              {l}
            </button>
          ))}
          <span className="ml-auto self-center text-xs text-slate-500">{d ? `${d.count} cryptos analysées${d.at ? ` · dernière il y a ${fmtAgo(d.at)}` : ""}` : ""}</span>
        </div>
      </Card>

      {err && <p className="text-sm text-rose-300">Setups indisponibles : {err}</p>}
      {d && !rows.length && <p className="text-sm text-slate-500">{all.length ? "Aucun setup dans cette catégorie pour l'instant." : "Analyse en cours : les premières cryptos arrivent en quelques secondes (une toutes les 3 s, plus celles du bot)."}</p>}

      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {rows.map((x) => {
          const s = x.setup;
          const isOpen = open === x.coin;
          return (
            <section key={x.coin} className={`rounded-lg border bg-slate-900/50 p-3 ${s.bias === "LONG" ? "border-emerald-700/60" : s.bias === "SHORT" ? "border-rose-700/60" : "border-slate-800"}`}>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-base font-bold text-slate-100">{x.coin}</span>
                {x.name && <span className="text-xs text-slate-500">{x.name}</span>}
                <span className={`rounded border px-1.5 py-0.5 text-xs font-bold ${BIAS_STYLE[s.bias].cls}`}>{BIAS_STYLE[s.bias].label}</span>
                <span className="ml-auto text-[11px] text-slate-500">
                  il y a {fmtAgo(x.at)}
                  {x.origin === "bot" ? " · bot" : ""}
                </span>
              </div>
              <SetupPlan s={s} compact={!isOpen} />
              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                <button onClick={() => setOpen(isOpen ? null : x.coin)} className="text-sky-300 underline">
                  {isOpen ? "Réduire" : "Voir la checklist"}
                </button>
                <a href={`#courbe?coin=${encodeURIComponent(x.coin)}`} className="text-sky-300 underline">
                  📈 Courbe et leviers
                </a>
                {safeHref(x.url) && (
                  <a href={safeHref(x.url)} target="_blank" rel="noreferrer noopener" className="text-slate-400 underline">
                    Plateforme
                  </a>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
