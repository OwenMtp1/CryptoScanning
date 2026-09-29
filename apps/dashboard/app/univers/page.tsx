"use client";

import { useEffect, useState } from "react";
import { CoinLink } from "@/components/Intel";
import { Card } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtPct, pctClass } from "@/lib/format";
import { KIND_LABEL, dirCls, fmtAgo, fmtBig, fmtUsd, type UniverseResponse } from "@/lib/intel";

const FILTERS = [
  ["all", "Toutes"],
  ["signaled", "Avec signal (24 h)"],
  ["trending", "Tendances"],
  ["gainers", "En hausse 24 h"],
  ["losers", "En baisse 24 h"],
  ["binance", "Sur Binance"],
  ["coinbase", "Sur Coinbase"],
] as const;

const COLS: { key: string; label: string; title?: string }[] = [
  { key: "rank", label: "#" },
  { key: "symbol", label: "Crypto" },
  { key: "price", label: "Prix" },
  { key: "change5m", label: "5 min", title: "temps réel (Binance)" },
  { key: "change15m", label: "15 min", title: "temps réel (Binance)" },
  { key: "change1h", label: "1 h" },
  { key: "change24h", label: "24 h" },
  { key: "change7d", label: "7 j" },
  { key: "volRatio", label: "Vol 1 h", title: "volume de la dernière heure / moyenne horaire des 24 h" },
  { key: "volume", label: "Volume 24 h" },
  { key: "mcap", label: "Capitalisation" },
  { key: "volMcap", label: "Vol/Capi", title: "rotation : > 0,6 = spéculation anormale" },
  { key: "funding", label: "Funding", title: "taux de financement moyen des perpétuels" },
  { key: "ath", label: "vs record" },
  { key: "lastSignal", label: "Dernier signal" },
];

const PAGE = 100;

export default function UniversPage() {
  const [data, setData] = useState<UniverseResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [sort, setSort] = useState("rank");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const p = new URLSearchParams({ sort, dir, filter, offset: String(offset), limit: String(PAGE) });
    if (q.trim()) p.set("q", q.trim());
    const load = () =>
      getJson<UniverseResponse>(`/api/intel/universe?${p}`).then(
        (r) => {
          setData(r);
          setError(null);
        },
        (e: Error) => setError(e.message),
      );
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [q, filter, sort, dir, offset]);

  const onSort = (k: string) => {
    if (k === sort) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(k);
      setDir(k === "rank" || k === "symbol" ? "asc" : "desc");
    }
    setOffset(0);
  };
  const now = Date.now();

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
            placeholder="Rechercher (symbole ou nom)…"
            className="w-56 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
          />
          {FILTERS.map(([k, label]) => (
            <button
              key={k}
              onClick={() => {
                setFilter(k);
                setOffset(0);
              }}
              className={`rounded px-2.5 py-1 ${filter === k ? "bg-slate-700 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"}`}
            >
              {label}
            </button>
          ))}
          <span className="num ml-auto text-slate-400">{data ? `${data.total} cryptos` : "…"}</span>
        </div>
        {error && <p className="mt-2 text-sm text-rose-400">{error}</p>}
      </Card>
      <div className="overflow-x-auto rounded border border-slate-800">
        <table className="num w-full text-xs">
          <thead className="bg-slate-900 text-left text-slate-400">
            <tr>
              {COLS.map((c) => (
                <th key={c.key} title={c.title} className={`cursor-pointer select-none whitespace-nowrap px-2 py-2 hover:text-slate-200 ${c.key === "symbol" || c.key === "lastSignal" ? "" : "text-right"}`} onClick={() => onSort(c.key)}>
                  {c.label}
                  {sort === c.key ? (dir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.rows.map((r) => (
              <tr key={r.symbol} className="border-t border-slate-800/70 hover:bg-slate-800/40">
                <td className="px-2 py-1.5 text-right text-slate-500">{r.rank ?? "—"}</td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  <CoinLink symbol={r.symbol} />
                  <span className="ml-1.5 text-slate-500">{r.name !== r.symbol ? r.name : ""}</span>
                  {r.trendingRank && <span className="ml-1" title={`tendance CoinGecko #${r.trendingRank}`}>🔥</span>}
                  {r.onBinance && <span className="ml-1 text-[9px] text-yellow-400/70">BN</span>}
                  {r.onCoinbase && <span className="ml-1 text-[9px] text-blue-400/70">CB</span>}
                </td>
                <td className="px-2 py-1.5 text-right">{fmtUsd(r.priceUsd)}</td>
                {[r.live?.change5m, r.live?.change15m, r.live?.change1h ?? r.change1h, r.change24h, r.change7d].map((v, i) => (
                  <td key={i} className={`px-2 py-1.5 text-right ${pctClass(v)}`}>
                    {fmtPct(v)}
                  </td>
                ))}
                <td className={`px-2 py-1.5 text-right ${r.live?.volumeRatio1h && r.live.volumeRatio1h >= 3 ? "font-bold text-sky-300" : ""}`}>{r.live?.volumeRatio1h ? `${r.live.volumeRatio1h.toFixed(1)}x` : "—"}</td>
                <td className="px-2 py-1.5 text-right">{fmtBig(r.volume24hUsd)}</td>
                <td className="px-2 py-1.5 text-right">{fmtBig(r.marketCapUsd)}</td>
                <td className={`px-2 py-1.5 text-right ${r.volume24hUsd && r.marketCapUsd && r.volume24hUsd / r.marketCapUsd >= 0.6 ? "font-bold text-amber-300" : ""}`}>
                  {r.volume24hUsd && r.marketCapUsd ? (r.volume24hUsd / r.marketCapUsd).toFixed(2) : "—"}
                </td>
                <td className={`px-2 py-1.5 text-right ${r.fundingRatePct !== null && Math.abs(r.fundingRatePct) >= 0.05 ? "font-bold text-orange-300" : ""}`}>{r.fundingRatePct === null ? "—" : `${r.fundingRatePct.toFixed(4)} %`}</td>
                <td className={`px-2 py-1.5 text-right ${r.athChangePct !== null && r.athChangePct > -5 ? "text-emerald-300" : "text-slate-400"}`}>{fmtPct(r.athChangePct, 1)}</td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {r.lastSignal ? (
                    <span className={dirCls(r.lastSignal.direction)}>
                      {KIND_LABEL[r.lastSignal.kind]} · {r.lastSignal.strength} · {fmtAgo(r.lastSignal.ts, now)}
                      {r.signals24h > 1 && <span className="text-slate-500"> (+{r.signals24h - 1})</span>}
                    </span>
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
              </tr>
            ))}
            {data && !data.rows.length && (
              <tr>
                <td colSpan={COLS.length} className="px-2 py-6 text-center text-slate-500">
                  Aucune crypto (les sources démarrent, ou le filtre est trop strict).
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && data.total > PAGE && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40">
            ← Précédent
          </button>
          <span className="num text-slate-400">
            {offset + 1}–{Math.min(data.total, offset + PAGE)} / {data.total}
          </span>
          <button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)} className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40">
            Suivant →
          </button>
        </div>
      )}
    </div>
  );
}
