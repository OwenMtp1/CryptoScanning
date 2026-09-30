"use client";

import type { Candle } from "@radar/core";
import { useEffect, useState } from "react";
import { PriceChart } from "@/components/PriceChart";
import { getJson } from "@/lib/api";
import { fmtPct } from "@/lib/format";

export const RANGES = [
  ["1h", "1 h"],
  ["1d", "1 j"],
  ["1w", "1 sem."],
  ["1m", "1 mois"],
  ["1y", "1 an"],
] as const;
export type Range = (typeof RANGES)[number][0];

/** Compact price chart of one coin with a period picker (used in the coin panel). */
export function CoinChart({ coin, height = 240 }: { coin: string; height?: number }) {
  const [range, setRange] = useState<Range>("1d");
  const [data, setData] = useState<{ candles: Candle[]; source: string; pair: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    setErr(null);
    const load = () =>
      getJson<{ candles: Candle[]; source: string; pair: string }>(`/api/web/candles?coin=${encodeURIComponent(coin)}&range=${range}`).then(
        (r) => live && (setData(r), setErr(null)),
        (e: Error) => live && setErr(e.message),
      );
    void load();
    const t = setInterval(load, range === "1h" ? 15_000 : 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [coin, range]);

  const first = data?.candles[0]?.c;
  const last = data?.candles.at(-1)?.c;
  const change = first && last ? ((last - first) / first) * 100 : null;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {RANGES.map(([k, l]) => (
          <button key={k} type="button" onClick={() => setRange(k)} className={`rounded px-2.5 py-1 text-xs ${range === k ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
            {l}
          </button>
        ))}
        {change !== null && <span className={`num ml-2 text-xs ${change >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(change)}</span>}
        {data && <span className="ml-auto text-[10px] text-slate-500">{data.source} {data.pair}</span>}
      </div>
      {data ? (
        <PriceChart candles={data.candles} height={height} title={`Cours de ${coin}`} />
      ) : err ? (
        <p className="rounded bg-slate-900 px-3 py-6 text-center text-xs text-slate-500">Courbe indisponible ({err.includes("→ 404") || err.includes("HTTP 404") ? "disponible sur le site en ligne" : err})</p>
      ) : (
        <div className="animate-pulse rounded bg-slate-900" style={{ height }} />
      )}
    </div>
  );
}
