"use client";

import { useEffect, useState } from "react";
import { CoinLink } from "@/components/Intel";
import { Card } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtPct, pctClass } from "@/lib/format";
import { KIND_LABEL, fmtAgo, fmtBig, fmtUsd, type LeverageMarketView, type LeverageResponse } from "@/lib/intel";

/** "PUMP_EARLY (80)" → "Décollage (80)". */
const anomalyLabel = (a: string) => a.replace(/^([A-Z0-9_]+) \((\d+)\)$/, (all, k: string, n: string) => (k in KIND_LABEL ? `${KIND_LABEL[k as keyof typeof KIND_LABEL]} (${n})` : all));

type Filter = "all" | "LONG" | "SHORT" | "anomalies";

/** A market "has signals" when it has a LONG / SHORT indication or unusual moves. */
const hasSignal = (m: LeverageMarketView) => m.bias !== "NEUTRE" || m.anomalies.length > 0;
const toneOf = (m: LeverageMarketView) => (m.bias === "LONG" ? "long" : m.bias === "SHORT" ? "short" : "anomaly");
const NEON = {
  long: { color: "#34d399", glow: "0 0 6px #34d399, 0 0 22px rgba(52,211,153,0.55), inset 0 0 12px rgba(52,211,153,0.15)", text: "0 0 8px rgba(52,211,153,0.9)" },
  short: { color: "#fb7185", glow: "0 0 6px #fb7185, 0 0 22px rgba(251,113,133,0.55), inset 0 0 12px rgba(251,113,133,0.15)", text: "0 0 8px rgba(251,113,133,0.9)" },
  anomaly: { color: "#fbbf24", glow: "0 0 6px #fbbf24, 0 0 20px rgba(251,191,36,0.45), inset 0 0 12px rgba(251,191,36,0.12)", text: "0 0 8px rgba(251,191,36,0.9)" },
} as const;

/** Signaled markets first (strongest score first), then every other market by volume. */
function ordered(ms: LeverageMarketView[]) {
  return [...ms].sort((a, b) => {
    const sa = hasSignal(a) ? 1 : 0;
    const sb = hasSignal(b) ? 1 : 0;
    if (sa !== sb) return sb - sa;
    if (sa) return Math.abs(b.score) - Math.abs(a.score);
    return (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0);
  });
}

export default function LevierPage() {
  const [d, setD] = useState<LeverageResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      getJson<LeverageResponse>("/api/intel/leverage").then(
        (r) => {
          setD(r);
          setErr(null);
        },
        (e: Error) => setErr(e.message),
      );
    void load();
    // Quick retries while the list is still empty, then every 20 s.
    let n = 0;
    const quick = setInterval(() => {
      if (++n > 10) clearInterval(quick);
      void load();
    }, 2_000);
    const t = setInterval(load, 20_000);
    return () => {
      clearInterval(t);
      clearInterval(quick);
    };
  }, []);

  const all = ordered(d?.markets ?? []);
  const signaled = all.filter(hasSignal);
  const rows = all.filter((m) => (filter === "all" ? true : filter === "anomalies" ? m.anomalies.length > 0 : m.bias === filter));
  const now = Date.now();
  return (
    <div className="space-y-4">
      <div className="rounded border border-rose-700/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-100">
        <strong>⚠️ Levier = risque de tout perdre.</strong> Avec un levier ×N, un mouvement de 100/N % contre toi liquide la position (×10 → 10 %, ×20 → 5 %). Les indications LONG / SHORT sont une lecture
        statistique des données du moment, <strong>pas un conseil</strong> : elles se trompent souvent. Aucun ordre n&apos;est passé par l&apos;outil.
      </div>
      <Card>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {(
            [
              ["all", "Tous"],
              ["LONG", "▲ Indication LONG"],
              ["SHORT", "▼ Indication SHORT"],
              ["anomalies", "Mouvements anormaux"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={`rounded px-2.5 py-1 font-semibold ${filter === k ? "bg-slate-700 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"}`}>
              {l}
            </button>
          ))}
          <span className="ml-auto text-slate-400">
            {d?.markets.length ?? 0} marché(s) perpétuel(s) Coinbase{d?.at ? ` · mis à jour il y a ${fmtAgo(d.at, now)}` : ""}
            {d?.origin ? ` · lecture ${d.origin === "bot" ? "du bot 24 h/24" : "de cette page"}` : ""}
            {d?.cached ? " · dernière liste connue, actualisation…" : ""}
            {d?.sources?.length ? ` · sources : ${d.sources.join(", ")}` : ""}
            {d?.context?.note ? ` · ${d.context.note}` : ""}
          </span>
        </div>
        {err && <p className="mt-2 text-sm text-amber-300">{err}</p>}
        {d?.unavailable && (
          <p className="mt-2 text-sm text-slate-400">
            Chargement de la liste des marchés à levier… (la page lit Coinbase elle-même ; le bot 24 h/24 ajoute le ratio long/short et les flux d&apos;achats quand <code>DISCORD_WORKER_URL</code> est configurée).
          </p>
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          Source : contrats perpétuels officiels de Coinbase (levier maximal, funding, open interest). Coinbase Wallet ne publie pas d&apos;API pour ses marchés à levier : ce sont les mêmes contrats Coinbase,
          disponibles selon ton pays.
        </p>
      </Card>
      {signaled.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
            <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400 align-middle" style={{ boxShadow: "0 0 8px #34d399" }} />
            Avec signaux ({signaled.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {signaled.map((m) => (
              <NeonCard key={m.productId} m={m} onOpen={() => setOpen(open === m.productId ? null : m.productId)} />
            ))}
          </div>
        </section>
      )}
      <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-400">Tous les marchés ({all.length})</h2>
      <div className="overflow-x-auto rounded border border-slate-800">
        <table className="num w-full text-xs">
          <thead className="bg-slate-900 text-left text-slate-400">
            <tr>
              {["Marché", "Levier max", "Prix", "24 h", "15 min", "1 h", "Funding", "Long/short", "Achats agressifs", "Indication", "Score", "Liquidation au max", "Anomalies"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <Row key={m.productId} m={m} open={open === m.productId} onToggle={() => setOpen(open === m.productId ? null : m.productId)} />
            ))}
            {d && !rows.length && (
              <tr>
                <td colSpan={13} className="px-2 py-6 text-center text-slate-500">
                  {d.markets.length ? (
                    "Aucun marché ne correspond au filtre."
                  ) : d.tried ? (
                    <span className="text-amber-300">
                      Aucune source de marchés à levier n&apos;a répondu :
                      <br />
                      {(d.errors ?? []).join(" · ") || "raison inconnue"}
                      <br />
                      <span className="text-slate-500">Nouvel essai automatique toutes les 2 minutes.</span>
                    </span>
                  ) : (
                    "Chargement des marchés à levier…"
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({ m, open, onToggle }: { m: LeverageMarketView; open: boolean; onToggle: () => void }) {
  const c = m.context;
  const biasCls = m.bias === "LONG" ? "bg-emerald-600/80 text-white" : m.bias === "SHORT" ? "bg-rose-600/80 text-white" : "bg-slate-700 text-slate-200";
  const neon = hasSignal(m) ? NEON[toneOf(m)] : null;
  return (
    <>
      <tr
        className={`cursor-pointer border-t border-slate-800/70 hover:bg-slate-800/40 ${neon ? "bg-slate-900" : ""}`}
        style={neon ? { boxShadow: `inset 3px 0 0 ${neon.color}` } : undefined}
        onClick={onToggle}
      >
        <td className="whitespace-nowrap px-2 py-1.5" style={neon ? { textShadow: neon.text, color: neon.color } : undefined}>
          <CoinLink symbol={m.coin} /> <span className={neon ? "" : "text-slate-500"}>{m.name}</span>
          {m.venue && <span className="ml-1 text-[9px] text-slate-500">{m.venue}</span>}
        </td>
        <td className="px-2 py-1.5 font-bold text-amber-300">{m.maxLeverage ? `×${m.maxLeverage}` : "—"}</td>
        <td className="px-2 py-1.5">{fmtUsd(m.price)}</td>
        <td className={`px-2 py-1.5 ${pctClass(m.change24h)}`}>{fmtPct(m.change24h)}</td>
        <td className={`px-2 py-1.5 ${pctClass(c.change15m)}`}>{fmtPct(c.change15m)}</td>
        <td className={`px-2 py-1.5 ${pctClass(c.change1h)}`}>{fmtPct(c.change1h)}</td>
        <td className={`px-2 py-1.5 ${Math.abs(c.binanceFundingPct ?? m.fundingPct ?? 0) >= 0.05 ? "font-bold text-orange-300" : ""}`}>{(c.binanceFundingPct ?? m.fundingPct) === null ? "—" : `${(c.binanceFundingPct ?? m.fundingPct)!.toFixed(4)} %`}</td>
        <td className="px-2 py-1.5">{c.longShortRatio === null ? "—" : c.longShortRatio.toFixed(2)}</td>
        <td className="px-2 py-1.5">{c.takerBuyRatio === null ? "—" : `${(c.takerBuyRatio * 100).toFixed(0)} %`}</td>
        <td className="px-2 py-1.5">
          <span className={`rounded px-2 py-0.5 text-[11px] font-bold ${biasCls}`}>{m.bias}</span>
        </td>
        <td className={`px-2 py-1.5 font-semibold ${m.score > 0 ? "text-emerald-400" : m.score < 0 ? "text-rose-400" : "text-slate-400"}`}>{m.score > 0 ? `+${m.score}` : m.score}</td>
        <td className="px-2 py-1.5 text-rose-300">{m.liquidationMovePct !== null ? `${m.liquidationMovePct} % contre toi` : "—"}</td>
        <td className="px-2 py-1.5 text-amber-200">{m.anomalies.length ? m.anomalies.slice(0, 2).map(anomalyLabel).join(" · ") : "—"}</td>
      </tr>
      {open && (
        <tr className="border-t border-slate-800/40 bg-slate-900/60">
          <td colSpan={13} className="px-3 py-2">
            <div className="text-xs font-semibold text-slate-300">Pourquoi {m.bias === "NEUTRE" ? "neutre" : m.bias} (score {m.score} sur ±100, seuil ±25) :</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-400">
              {m.reasons.length ? m.reasons.map((r, i) => <li key={i}>{r}</li>) : <li>aucun facteur marqué pour l&apos;instant</li>}
            </ul>
            <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-slate-500">
              <span>Volume 24 h {fmtBig(m.volume24hUsd)}</span>
              <span>Open interest {m.openInterest ?? "—"}</span>
              {c.oiChangePct !== null && <span>Variation OI {fmtPct(c.oiChangePct, 1)}</span>}
              <a href={m.url} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">
                voir le marché ↗
              </a>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function NeonCard({ m, onOpen }: { m: LeverageMarketView; onOpen: () => void }) {
  const n = NEON[toneOf(m)];
  const c = m.context;
  const label = m.bias === "NEUTRE" ? "MOUVEMENT ANORMAL" : m.bias;
  return (
    <button type="button" onClick={onOpen} className="rounded-lg bg-slate-950 p-3 text-left transition hover:brightness-125" style={{ border: `1px solid ${n.color}`, boxShadow: n.glow }}>
      <div className="flex items-center gap-2">
        <span className="text-lg font-bold" style={{ color: n.color, textShadow: n.text }}>
          {m.coin}
        </span>
        <span className="truncate text-xs text-slate-400">{m.name}</span>
        {m.maxLeverage && <span className="ml-auto text-xs font-bold text-amber-300">×{m.maxLeverage}</span>}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="rounded px-2 py-0.5 text-xs font-extrabold tracking-wider" style={{ color: "#0b1020", background: n.color, boxShadow: `0 0 10px ${n.color}` }}>
          {label}
        </span>
        <span className="num text-sm font-semibold" style={{ color: n.color }}>
          score {m.score > 0 ? `+${m.score}` : m.score}
        </span>
        <span className="num ml-auto text-sm text-slate-200">{fmtUsd(m.price)}</span>
      </div>
      <div className="num mt-2 grid grid-cols-3 gap-1 text-[11px] text-slate-400">
        <span>
          15 min <span className={pctClass(c.change15m)}>{fmtPct(c.change15m)}</span>
        </span>
        <span>
          1 h <span className={pctClass(c.change1h)}>{fmtPct(c.change1h)}</span>
        </span>
        <span>
          24 h <span className={pctClass(m.change24h)}>{fmtPct(m.change24h)}</span>
        </span>
      </div>
      {m.anomalies.length > 0 && <div className="mt-2 truncate text-[11px] text-amber-200">⚠ {m.anomalies.slice(0, 3).map(anomalyLabel).join(" · ")}</div>}
      {m.reasons[0] && <div className="mt-1 truncate text-[11px] text-slate-400">{m.reasons[0]}</div>}
      {m.liquidationMovePct !== null && <div className="mt-1 text-[10px] text-rose-300">liquidation au levier max : {m.liquidationMovePct} % contre toi</div>}
    </button>
  );
}
