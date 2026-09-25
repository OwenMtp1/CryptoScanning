"use client";

import type { RadarRow } from "@radar/core";
import { useMemo, useState } from "react";
import { fmtCompact, fmtPct, fmtPrice, fmtRatio, pctClass } from "@/lib/format";
import { ScoreBar, SignalChips } from "./ui";

type SortKey = "score" | "asset" | "10s" | "1m" | "5m" | "volume" | "ratio" | "accel" | "spread" | "liquidity";

const num = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? Number.NEGATIVE_INFINITY : x);

function sortValue(r: RadarRow, k: SortKey): number | string {
  const m = r.metrics;
  switch (k) {
    case "asset":
      return m.productId;
    case "score":
      return r.scores.composite;
    case "10s":
    case "1m":
    case "5m":
      return num(m.changes[k]);
    case "volume":
      return num(m.volumeRecentQuote);
    case "ratio":
      return num(m.volumeRatio);
    case "accel":
      return num(m.accelerationPct);
    case "spread":
      return num(m.spreadPct);
    case "liquidity":
      return r.scores.liquidity;
  }
}

const LEVEL_ROW: Record<RadarRow["level"], string> = {
  opportunity: "bg-emerald-500/[0.07]",
  alert: "bg-amber-500/[0.05]",
  watch: "",
  none: "",
};

export function RadarTable({ rows }: { rows: RadarRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "score", desc: true });
  const [query, setQuery] = useState("");
  const [quote, setQuote] = useState("ALL");
  const [onlySignals, setOnlySignals] = useState(false);

  const quotes = useMemo(() => ["ALL", ...new Set(rows.map((r) => r.metrics.quoteCurrency))], [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toUpperCase();
    const out = rows.filter(
      (r) =>
        (!q || r.metrics.productId.includes(q)) &&
        (quote === "ALL" || r.metrics.quoteCurrency === quote) &&
        (!onlySignals || r.activeSignals.length > 0 || r.level === "opportunity"),
    );
    out.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      const c = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sort.desc ? -c : c;
    });
    return out;
  }, [rows, sort, query, quote, onlySignals]);

  const Th = ({ k, children, className = "" }: { k: SortKey; children: string; className?: string }) => (
    <th
      className={`cursor-pointer select-none whitespace-nowrap px-2 py-2 font-medium hover:text-slate-200 ${className}`}
      onClick={() => setSort((s) => ({ key: k, desc: s.key === k ? !s.desc : true }))}
    >
      {children}
      {sort.key === k ? (sort.desc ? " ▾" : " ▴") : ""}
    </th>
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher (ex. SOL)"
          className="w-48 rounded border border-slate-700 bg-slate-950 px-2 py-1 outline-none focus:border-sky-500"
        />
        <select value={quote} onChange={(e) => setQuote(e.target.value)} className="rounded border border-slate-700 bg-slate-950 px-2 py-1">
          {quotes.map((q) => (
            <option key={q} value={q}>
              {q === "ALL" ? "Toutes les devises" : q}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-slate-400">
          <input type="checkbox" checked={onlySignals} onChange={(e) => setOnlySignals(e.target.checked)} />
          Signaux actifs uniquement
        </label>
        <span className="ml-auto text-xs text-slate-500">
          {visible.length} / {rows.length} actifs
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="num w-full text-sm">
          <thead className="bg-slate-900 text-left text-xs text-slate-400">
            <tr>
              <Th k="asset">Actif</Th>
              <th className="px-2 py-2 text-right font-medium">Prix</th>
              <Th k="10s" className="text-right">10s</Th>
              <Th k="1m" className="text-right">1m</Th>
              <Th k="5m" className="text-right">5m</Th>
              <Th k="volume" className="text-right">Volume 1m</Th>
              <Th k="ratio" className="text-right">Vol. ratio</Th>
              <Th k="accel" className="text-right">Accél.</Th>
              <Th k="spread" className="text-right">Spread</Th>
              <Th k="liquidity">Liquidité</Th>
              <Th k="score">Score</Th>
              <th className="px-2 py-2 font-medium">Signal</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const m = r.metrics;
              return (
                <tr key={m.productId} className={`border-t border-slate-800/70 ${LEVEL_ROW[r.level]} hover:bg-slate-800/40`}>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className="font-semibold text-slate-100">{m.baseCurrency}</span>
                    <span className="text-slate-500">-{m.quoteCurrency}</span>
                  </td>
                  <td className="px-2 py-1.5 text-right">{fmtPrice(m.price)}</td>
                  {(["10s", "1m", "5m"] as const).map((w) => (
                    <td key={w} className={`px-2 py-1.5 text-right ${pctClass(m.changes[w])}`}>
                      {fmtPct(m.changes[w])}
                    </td>
                  ))}
                  <td className="px-2 py-1.5 text-right text-slate-300">{fmtCompact(m.volumeRecentQuote)}</td>
                  <td
                    className={`px-2 py-1.5 text-right ${r.activeSignals.includes("VOLUME_SPIKE") ? "font-semibold text-sky-300" : "text-slate-300"}`}
                    title={m.baselineSource === "history" ? "Baseline : historique local" : m.baselineSource === "24h" ? "Baseline : moyenne 24h (historique local insuffisant)" : "Pas de baseline"}
                  >
                    {fmtRatio(m.volumeRatio)}
                    {m.baselineSource === "24h" && <span className="text-slate-600">*</span>}
                  </td>
                  <td className={`px-2 py-1.5 text-right ${pctClass(m.accelerationPct)}`}>{fmtPct(m.accelerationPct)}</td>
                  <td className="px-2 py-1.5 text-right text-slate-300">{m.spreadPct === null ? "—" : `${m.spreadPct.toFixed(3)} %`}</td>
                  <td className="px-2 py-1.5" title={r.liquidity.issues.join("\n") || "Liquidité OK"}>
                    <span className={r.liquidity.tradable ? "text-emerald-400" : "text-amber-300"}>
                      {r.liquidity.tradable ? "OK" : "Faible"}
                    </span>
                    <span className="ml-1 text-xs text-slate-500">{r.scores.liquidity}</span>
                  </td>
                  <td className="px-2 py-1.5">
                    <ScoreBar score={r.scores.composite} />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {r.level === "opportunity" && <span title="Opportunité détectée">🚨</span>}
                      <SignalChips types={r.activeSignals} />
                    </div>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={12} className="px-2 py-8 text-center text-slate-500">
                  Aucun actif à afficher.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Score = qualité interne du signal (0–100), pas une prévision de rendement. * baseline de volume issue de la moyenne 24h tant que
        l&apos;historique local est insuffisant. Liquidité évaluée sur le spread, le top-of-book et le volume 24h.
      </p>
    </div>
  );
}
