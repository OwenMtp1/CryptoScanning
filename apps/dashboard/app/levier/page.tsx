"use client";

import { useEffect, useState } from "react";
import { CoinLink } from "@/components/Intel";
import { Card } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtPct, pctClass } from "@/lib/format";
import { fmtAgo, fmtBig, fmtUsd, type LeverageMarketView, type LeverageResponse } from "@/lib/intel";

type Filter = "all" | "LONG" | "SHORT" | "anomalies";

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
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const rows = (d?.markets ?? []).filter((m) => (filter === "all" ? true : filter === "anomalies" ? m.anomalies.length > 0 : m.bias === filter));
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
            {d?.context?.note ? ` · ${d.context.note}` : ""}
          </span>
        </div>
        {err && <p className="mt-2 text-sm text-amber-300">{err}</p>}
        {d?.unavailable && (
          <p className="mt-2 text-sm text-slate-400">
            Ces données viennent du bot 24 h/24. Ajoute <code>DISCORD_WORKER_URL</code> dans le projet Pages du site (voir la page Sources), puis attends sa prochaine analyse (5 min max).
          </p>
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          Source : contrats perpétuels officiels de Coinbase (levier maximal, funding, open interest). Coinbase Wallet ne publie pas d&apos;API pour ses marchés à levier : ce sont les mêmes contrats Coinbase,
          disponibles selon ton pays.
        </p>
      </Card>
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
                  {d.markets.length ? "Aucun marché ne correspond au filtre." : "Pas encore de données (le bot lit les marchés à levier toutes les 5 min)."}
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
  return (
    <>
      <tr className="cursor-pointer border-t border-slate-800/70 hover:bg-slate-800/40" onClick={onToggle}>
        <td className="whitespace-nowrap px-2 py-1.5">
          <CoinLink symbol={m.coin} /> <span className="text-slate-500">{m.name}</span>
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
        <td className="px-2 py-1.5 text-amber-200">{m.anomalies.length ? m.anomalies.slice(0, 2).join(" · ") : "—"}</td>
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
