"use client";

import type { IntelSource } from "@radar/core";
import { useEffect, useState } from "react";
import { CoinLink, SourceBadge } from "@/components/Intel";
import { Card } from "@/components/ui";
import { getJson } from "@/lib/api";
import { ALL_SOURCES, KIND_LABEL, SOURCE_LABEL, dirCls, fmtAgo, fmtUsd, type PerformanceResponse } from "@/lib/intel";

const H_LABEL: Record<string, string> = { "15": "15 min", "60": "1 h", "240": "4 h", "1440": "24 h" };
const pc = (v: number | null | undefined, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(d)} %`);
const tone = (v: number | null | undefined) => (v === null || v === undefined || Number.isNaN(v) ? "text-slate-500" : v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-slate-300");

export default function PerformancePage() {
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [minStrength, setMinStrength] = useState(0);
  const [source, setSource] = useState<"" | IntelSource>("");

  useEffect(() => {
    const p = new URLSearchParams();
    if (minStrength) p.set("minStrength", String(minStrength));
    if (source) p.set("source", source);
    const load = () => getJson<PerformanceResponse>(`/api/intel/performance?${p}`).then(setData, () => {});
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [minStrength, source]);

  const horizons = (data?.horizonsMin ?? [15, 60, 240, 1440]).map(String);
  const now = Date.now();
  return (
    <div className="space-y-4">
      <Card>
        <p className="text-sm text-slate-300">
          Chaque signal est suivi : on mesure le prix {horizons.map((h) => H_LABEL[h] ?? `${h} min`).join(", ")} plus tard. Un signal est « réussi » si le prix a bougé d&apos;au moins{" "}
          <strong>{data?.hitThresholdPct ?? 2} %</strong> dans le sens annoncé (hausse pour un signal haussier, baisse pour un baissier). C&apos;est la seule façon honnête de savoir quels signaux valent quelque chose : juge
          sur plusieurs jours et au moins ~30 mesures.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-2 text-slate-400">
            Force ≥ <input type="range" min={0} max={95} step={5} value={minStrength} onChange={(e) => setMinStrength(Number(e.target.value))} />
            <span className="num w-6 text-slate-200">{minStrength}</span>
          </label>
          <select value={source} onChange={(e) => setSource(e.target.value as IntelSource | "")} className="rounded border border-slate-700 bg-slate-900 px-2 py-1">
            <option value="">Toutes les sources</option>
            {ALL_SOURCES.filter((s) => s !== "dex").map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABEL[s]}
              </option>
            ))}
          </select>
          <span className="text-slate-500">Les signaux DEX ne sont pas mesurés (prix par pool, pas par crypto).</span>
        </div>
      </Card>
      <div className="overflow-x-auto rounded border border-slate-800">
        <table className="num w-full text-xs">
          <thead className="bg-slate-900 text-left text-slate-400">
            <tr>
              <th className="px-2 py-2">Type de signal</th>
              <th className="px-2 py-2 text-right">Nombre</th>
              {horizons.map((h) => (
                <th key={h} className="px-2 py-2 text-right" colSpan={2}>
                  {H_LABEL[h] ?? `${h} min`} (réussite · moyenne)
                </th>
              ))}
              <th className="px-2 py-2 text-right" title="meilleur mouvement moyen dans le sens du signal">Meilleur</th>
              <th className="px-2 py-2 text-right" title="pire mouvement moyen contre le signal">Pire</th>
            </tr>
          </thead>
          <tbody>
            {data?.stats.map((s) => (
              <tr key={`${s.kind}:${s.direction}`} className="border-t border-slate-800/70">
                <td className={`whitespace-nowrap px-2 py-1.5 font-semibold ${dirCls(s.direction)}`}>
                  {s.direction === "bullish" ? "▲" : s.direction === "bearish" ? "▼" : "•"} {KIND_LABEL[s.kind]}
                </td>
                <td className="px-2 py-1.5 text-right">{s.count}</td>
                {horizons.map((h) => {
                  const x = s.horizons[h];
                  const hr = x?.hitRatePct ?? null;
                  return [
                    <td key={`${h}a`} className={`px-2 py-1.5 text-right ${hr === null ? "text-slate-500" : hr >= 55 ? "font-bold text-emerald-400" : hr >= 40 ? "text-amber-300" : "text-rose-400"}`} title={`${x?.n ?? 0} mesure(s)`}>
                      {hr === null ? "—" : `${hr.toFixed(0)} %`}
                      <span className="text-[10px] text-slate-500"> n={x?.n ?? 0}</span>
                    </td>,
                    <td key={`${h}b`} className={`px-2 py-1.5 text-right ${tone(x?.avgPct)}`}>
                      {pc(x?.avgPct)}
                    </td>,
                  ];
                })}
                <td className="px-2 py-1.5 text-right text-emerald-300">{pc(s.avgMfePct)}</td>
                <td className="px-2 py-1.5 text-right text-rose-300">{pc(s.avgMaePct)}</td>
              </tr>
            ))}
            {data && !data.stats.length && (
              <tr>
                <td colSpan={4 + horizons.length * 2} className="px-2 py-6 text-center text-slate-500">
                  Pas encore de signal mesuré. Les premiers résultats arrivent 15 minutes après les premiers signaux.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Card title="Derniers signaux suivis">
        <div className="overflow-x-auto">
          <table className="num w-full text-xs">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-1">Quand</th>
                <th>Crypto</th>
                <th>Type</th>
                <th>Source</th>
                <th className="text-right">Force</th>
                <th className="text-right">Prix</th>
                {horizons.map((h) => (
                  <th key={h} className="text-right">
                    {H_LABEL[h] ?? h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data?.recent.map((t) => (
                <tr key={t.id} className="border-t border-slate-800">
                  <td className="py-1 text-slate-500">{fmtAgo(t.ts, now)}</td>
                  <td>
                    <CoinLink symbol={t.coin} />
                  </td>
                  <td className={dirCls(t.direction)}>{KIND_LABEL[t.kind]}</td>
                  <td>
                    <SourceBadge source={t.source} />
                  </td>
                  <td className="text-right">{t.strength}</td>
                  <td className="text-right">{fmtUsd(t.entryPrice)}</td>
                  {horizons.map((h) => {
                    const v = t.returns[h] ?? null;
                    return (
                      <td key={h} className={`text-right ${tone(v)}`}>
                        {v === null ? "…" : Number.isNaN(v) ? "n/m" : pc(v, 2)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">« … » = pas encore l&apos;heure de mesurer · « n/m » = non mesurable (application arrêtée à ce moment-là).</p>
      </Card>
    </div>
  );
}
