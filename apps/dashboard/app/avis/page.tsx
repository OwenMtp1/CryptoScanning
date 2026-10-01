"use client";

import { useEffect, useState } from "react";
import { CoinLink } from "@/components/Intel";
import { Card } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtPct, fmtPrice } from "@/lib/format";
import { fmtAgo } from "@/lib/intel";

interface Verdict {
  coin: string;
  name: string | null;
  state: "STRONG_UP" | "UP" | "NEUTRAL" | "DOWN" | "STRONG_DOWN";
  label: string;
  since: number;
  score: number;
  conviction: number;
  entry: number;
  invalidation: number | null;
  targets: number[];
  price: number | null;
  changeSincePct: number | null;
  pending: string | null;
  reasons: string[];
  parts: { structure: number; evidence: number; talk: number } | null;
  horizon: string | null;
  evaluatedAt: number;
  origin?: "bot" | "site";
}
interface Board {
  count: number;
  verdicts: Verdict[];
  botOnline?: boolean;
}

const STYLE: Record<Verdict["state"], { cls: string; icon: string }> = {
  STRONG_UP: { cls: "border-emerald-500 bg-emerald-500/15 text-emerald-200", icon: "⏫" },
  UP: { cls: "border-emerald-700 bg-emerald-500/10 text-emerald-300", icon: "▲" },
  NEUTRAL: { cls: "border-slate-700 bg-slate-800/60 text-slate-300", icon: "◆" },
  DOWN: { cls: "border-rose-700 bg-rose-500/10 text-rose-300", icon: "▼" },
  STRONG_DOWN: { cls: "border-rose-500 bg-rose-500/15 text-rose-200", icon: "⏬" },
};
const PENDING: Record<string, string> = { STRONG_UP: "haussier fort", UP: "haussier", NEUTRAL: "neutre", DOWN: "baissier", STRONG_DOWN: "baissier fort" };
type Filter = "active" | "up" | "down" | "all";

/** Score part −100…+100 as a small diverging bar. */
function Part({ label, v }: { label: string; v: number }) {
  const w = Math.min(50, Math.abs(v) / 2);
  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-400">
      <span className="w-16">{label}</span>
      <span className="relative inline-block h-1.5 w-24 rounded bg-slate-800" aria-hidden>
        <span className="absolute top-0 h-1.5 w-px bg-slate-500" style={{ left: "50%" }} />
        <span className={`absolute top-0 h-1.5 rounded ${v >= 0 ? "bg-emerald-400" : "bg-rose-400"}`} style={v >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
      </span>
      <span className="num w-8 text-right text-slate-300">{v > 0 ? `+${v}` : v}</span>
    </div>
  );
}

export default function AvisPage() {
  const [d, setD] = useState<Board | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("active");

  useEffect(() => {
    const load = () =>
      getJson<Board>("/api/intel/verdicts").then(
        (r) => {
          setD(r);
          setErr(null);
        },
        (e: Error) => setErr(e.message),
      );
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);

  const all = d?.verdicts ?? [];
  const up = (v: Verdict) => v.state === "UP" || v.state === "STRONG_UP";
  const down = (v: Verdict) => v.state === "DOWN" || v.state === "STRONG_DOWN";
  const rows = all.filter((v) => (filter === "all" ? true : filter === "up" ? up(v) : filter === "down" ? down(v) : v.state !== "NEUTRAL"));

  return (
    <div className="space-y-4">
      <Card title="🧭 Avis de tendance">
        <p className="text-sm text-slate-300">
          Un avis <strong>stable</strong> par crypto, au lieu d&apos;alertes qui se contredisent. Il combine la structure du marché (tendance 1 h et 4 h, momentum, niveaux, volume, dérivés, Bitcoin : 60 %), les signaux récents
          pondérés par leur fiabilité mesurée (25 %) et les actus / Reddit (15 %). Un avis ne change que s&apos;il est <strong>confirmé deux fois</strong> à 8 min d&apos;écart, il est gardé au moins 2 h, et il tombe
          tout de suite si le prix casse son <strong>niveau d&apos;invalidation</strong>.
        </p>
        <p className="mt-1 text-[11px] text-amber-300/90">Lecture statistique du marché, pas un conseil d&apos;investissement : un avis peut se tromper. Respecte toujours le niveau d&apos;invalidation.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {(
            [
              ["active", `Avis actifs (${all.filter((v) => v.state !== "NEUTRAL").length})`],
              ["up", `▲ Haussiers (${all.filter(up).length})`],
              ["down", `▼ Baissiers (${all.filter(down).length})`],
              ["all", `Tout (${all.length})`],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={`rounded px-3 py-1.5 ${filter === k ? "bg-violet-600 text-white" : "bg-slate-800 text-slate-300"}`}>
              {l}
            </button>
          ))}
          <span className="ml-auto text-xs text-slate-500">{d ? (d.botOnline ? "avis du bot 24 h/24 (ceux envoyés sur Discord)" : "avis calculés par cette page (bot injoignable)") : ""}</span>
        </div>
      </Card>

      {err && <p className="text-sm text-rose-300">Avis indisponibles : {err}</p>}
      {d && !rows.length && <p className="text-sm text-slate-500">{all.length ? "Aucun avis dans cette catégorie." : "Les avis se forment : chaque crypto est analysée toutes les quelques minutes, et un avis doit être confirmé deux fois."}</p>}

      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {rows.map((v) => {
          const st = STYLE[v.state];
          return (
            <section key={v.coin} className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <CoinLink symbol={v.coin} className="text-base" />
                {v.name && <span className="text-xs text-slate-500">{v.name}</span>}
                <span className={`rounded border px-2 py-0.5 text-xs font-bold ${st.cls}`}>
                  {st.icon} {v.label}
                </span>
                <span className="ml-auto text-[11px] text-slate-500">depuis {fmtAgo(v.since)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span>
                  conviction <strong className="num text-slate-100">{v.conviction}</strong>/100
                </span>
                {v.horizon && <span className="text-xs text-slate-400">horizon {v.horizon}</span>}
                {v.price !== null && (
                  <span className="num text-xs text-slate-400">
                    {fmtPrice(v.price)} $ {v.state !== "NEUTRAL" && v.changeSincePct !== null && <span className={(v.changeSincePct >= 0) === up(v) ? "text-emerald-400" : "text-rose-400"}>({fmtPct(v.changeSincePct, 1)} depuis l&apos;avis)</span>}
                  </span>
                )}
              </div>
              {v.state !== "NEUTRAL" && (
                <div className="num mt-2 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1">
                    <div className="text-[10px] text-slate-500">L&apos;avis tombe si le prix passe {up(v) ? "sous" : "au-dessus de"}</div>
                    <div className="font-semibold text-rose-300">{v.invalidation !== null ? `${fmtPrice(v.invalidation)} $` : "— (setup non aligné)"}</div>
                  </div>
                  <div className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1">
                    <div className="text-[10px] text-slate-500">Objectifs</div>
                    <div className="font-semibold text-emerald-300">{v.targets.length ? v.targets.map((t) => fmtPrice(t)).join(" / ") : "—"}</div>
                  </div>
                </div>
              )}
              {v.parts && (
                <div className="mt-2 space-y-0.5">
                  <Part label="Structure" v={v.parts.structure} />
                  <Part label="Signaux" v={v.parts.evidence} />
                  <Part label="Actus" v={v.parts.talk} />
                </div>
              )}
              {v.reasons.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-slate-400">
                  {v.reasons.slice(0, 4).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                {v.pending && <span className="text-amber-300">en observation : passage {PENDING[v.pending] ?? v.pending} à confirmer</span>}
                <a href={`#courbe?coin=${encodeURIComponent(v.coin)}`} className="text-sky-300 underline">
                  📈 Courbe et leviers
                </a>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
