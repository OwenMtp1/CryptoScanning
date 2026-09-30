"use client";

import { useEffect, useMemo, useState } from "react";
import { CoinLink } from "@/components/Intel";
import { Card } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtPct, pctClass } from "@/lib/format";
import { KIND_LABEL, safeHref, fmtAgo, fmtBig, fmtUsd, type LeverageMarketView, type LeverageResponse } from "@/lib/intel";

/** "PUMP_EARLY (80)" → "Décollage (80)". */
const anomalyLabel = (a: string) => a.replace(/^([A-Z0-9_]+) \((\d+)\)$/, (all, k: string, n: string) => (k in KIND_LABEL ? `${KIND_LABEL[k as keyof typeof KIND_LABEL]} (${n})` : all));

type Filter = "all" | "LONG" | "SHORT" | "anomalies";

/**
 * How interesting a market is right now: strength of the LONG / SHORT reading, plus unusual moves.
 * Used to rank every market (1 = most interesting).
 */
const interest = (m: LeverageMarketView) => Math.abs(m.score) + 10 * Math.min(3, m.anomalies.length);
/** Shown in « À surveiller »: a real indication, or a clear reading with unusual moves. */
const isHot = (m: LeverageMarketView) => m.bias !== "NEUTRE" || (m.anomalies.length > 0 && Math.abs(m.score) >= 15);
const TOP = 6;

function ranked(ms: LeverageMarketView[]) {
  return [...ms].sort((a, b) => interest(b) - interest(a) || (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));
}

const biasCls = (b: LeverageMarketView["bias"]) => (b === "LONG" ? "border-emerald-600/60 text-emerald-300" : b === "SHORT" ? "border-rose-600/60 text-rose-300" : "border-slate-700 text-slate-400");
const edge = (b: LeverageMarketView["bias"]) => (b === "LONG" ? "#34d399" : b === "SHORT" ? "#fb7185" : "#fbbf24");

/** Score −100…+100 as a small diverging bar (grey track, centre line). */
function ScoreBar({ score }: { score: number }) {
  const w = Math.min(50, Math.abs(score) / 2);
  return (
    <span className="relative inline-block h-1.5 w-16 shrink-0 rounded bg-slate-800 align-middle" aria-hidden>
      <span className="absolute top-0 h-1.5 w-px bg-slate-500" style={{ left: "50%" }} />
      <span className={`absolute top-0 h-1.5 rounded ${score >= 0 ? "bg-emerald-400" : "bg-rose-400"}`} style={score >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }} />
    </span>
  );
}

const courbe = (coin: string) => `#courbe?coin=${encodeURIComponent(coin)}`;

export default function LevierPage() {
  const [d, setD] = useState<LeverageResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
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

  const all = useMemo(() => ranked(d?.markets ?? []), [d]);
  const rank = useMemo(() => new Map(all.map((m, i) => [m.productId, i + 1])), [all]);
  const hot = all.filter(isHot).slice(0, TOP);
  const text = q.trim().toUpperCase();
  const rows = all.filter((m) => (filter === "all" ? true : filter === "anomalies" ? m.anomalies.length > 0 : m.bias === filter) && (!text || m.coin.includes(text) || m.name.toUpperCase().includes(text)));
  const count = (f: Filter) => all.filter((m) => (f === "anomalies" ? m.anomalies.length > 0 : m.bias === f)).length;
  const now = Date.now();

  return (
    <div className="space-y-4">
      <div className="rounded border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-100">
        <strong>⚠️ Levier = risque de tout perdre.</strong> Au levier ×N, un mouvement de 100/N % contre toi liquide la position (×10 → 10 %). Les indications LONG / SHORT sont une lecture statistique,{" "}
        <strong>pas un conseil</strong>.
      </div>

      <Card title={`À surveiller (${hot.length})`}>
        <p className="-mt-1 mb-2 text-[11px] text-slate-500">
          {d?.markets.length ?? 0} marchés lus{d?.at ? ` · il y a ${fmtAgo(d.at, now)}` : ""}
          {d?.origin ? ` · lecture ${d.origin === "bot" ? "du bot 24 h/24" : "de cette page"}` : ""}
          {d?.sources?.length ? ` · ${d.sources.join(", ")}` : ""}
          {d?.context?.note ? ` · ${d.context.note}` : ""}
          {d?.cached ? " · actualisation…" : ""}
        </p>
        {err && <p className="text-sm text-amber-300">{err}</p>}
        {!d || d.unavailable ? (
          <p className="text-sm text-slate-500">Chargement des marchés à levier…</p>
        ) : !hot.length ? (
          <p className="text-sm text-slate-400">Rien de marqué pour l&apos;instant : aucun marché n&apos;a d&apos;indication LONG / SHORT ni de mouvement anormal net. Le classement complet est ci-dessous.</p>
        ) : (
          <ol className="divide-y divide-slate-800">
            {hot.map((m) => (
              <li key={m.productId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pl-2.5" style={{ borderLeft: `3px solid ${edge(m.bias)}` }}>
                <span className="num w-6 text-xs text-slate-500">#{rank.get(m.productId)}</span>
                <CoinLink symbol={m.coin} className="text-base" />
                <span className={`rounded border px-1.5 py-0.5 text-[11px] font-bold ${biasCls(m.bias)}`}>{m.bias === "NEUTRE" ? "ANORMAL" : m.bias}</span>
                <span className="flex items-center gap-1.5">
                  <ScoreBar score={m.score} />
                  <span className="num text-xs text-slate-300">{m.score > 0 ? `+${m.score}` : m.score}</span>
                </span>
                <span className={`num text-xs ${pctClass(m.context.change1h)}`}>1 h {fmtPct(m.context.change1h)}</span>
                {m.maxLeverage && <span className="text-xs text-slate-400">×{m.maxLeverage} max</span>}
                <a href={courbe(m.coin)} className="ml-auto rounded bg-slate-800 px-2 py-1 text-xs text-sky-300 hover:bg-slate-700">
                  📈 Courbe
                </a>
                <span className="w-full truncate text-xs text-slate-400">{m.anomalies.length ? `⚠ ${m.anomalies.slice(0, 2).map(anomalyLabel).join(" · ")} · ` : ""}{m.reasons[0] ?? ""}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title={`Classement de tous les marchés (${all.length})`}>
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          {(
            [
              ["all", `Tous (${all.length})`],
              ["LONG", `▲ LONG (${count("LONG")})`],
              ["SHORT", `▼ SHORT (${count("SHORT")})`],
              ["anomalies", `Anormaux (${count("anomalies")})`],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={`rounded px-2.5 py-1.5 font-semibold ${filter === k ? "bg-slate-700 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"}`}>
              {l}
            </button>
          ))}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher (BTC…)" className="ml-auto w-36 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm uppercase placeholder:normal-case" />
        </div>
        <div className="-mx-3 overflow-x-auto sm:mx-0">
          <table className="num w-full min-w-[720px] text-xs">
            <thead className="text-left text-slate-500">
              <tr>
                {["#", "Marché", "Lecture", "1 h", "24 h", "Funding", "Long/short", "Levier max", "À noter", ""].map((h) => (
                  <th key={h} className="whitespace-nowrap px-2 py-1.5 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <Row key={m.productId} m={m} rank={rank.get(m.productId) ?? 0} open={open === m.productId} onToggle={() => setOpen(open === m.productId ? null : m.productId)} />
              ))}
              {d && !rows.length && (
                <tr>
                  <td colSpan={10} className="px-2 py-6 text-center text-slate-500">
                    {d.markets.length ? (
                      "Aucun marché ne correspond."
                    ) : d.tried ? (
                      <span className="text-amber-300">
                        Aucune source de marchés à levier n&apos;a répondu : {(d.errors ?? []).join(" · ") || "raison inconnue"}. Nouvel essai toutes les 2 minutes.
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
        <p className="mt-2 text-[11px] text-slate-500">Classement : force de la lecture LONG / SHORT, plus les mouvements anormaux. Clique sur une ligne pour le détail, sur la crypto pour sa courbe.</p>
      </Card>
    </div>
  );
}

function Row({ m, rank, open, onToggle }: { m: LeverageMarketView; rank: number; open: boolean; onToggle: () => void }) {
  const c = m.context;
  const funding = c.binanceFundingPct ?? m.fundingPct;
  return (
    <>
      <tr className="cursor-pointer border-t border-slate-800/70 hover:bg-slate-800/40" onClick={onToggle}>
        <td className="px-2 py-1.5 text-slate-500">{rank}</td>
        <td className="whitespace-nowrap px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
          <CoinLink symbol={m.coin} /> <span className="text-slate-500">{m.name}</span>
          {m.venue && <span className="ml-1 text-[10px] text-slate-600">{m.venue}</span>}
        </td>
        <td className="whitespace-nowrap px-2 py-1.5">
          <span className={`mr-1.5 rounded border px-1.5 py-0.5 text-[10px] font-bold ${biasCls(m.bias)}`}>{m.bias}</span>
          <ScoreBar score={m.score} /> <span className="text-slate-300">{m.score > 0 ? `+${m.score}` : m.score}</span>
        </td>
        <td className={`px-2 py-1.5 ${pctClass(c.change1h)}`}>{fmtPct(c.change1h)}</td>
        <td className={`px-2 py-1.5 ${pctClass(m.change24h)}`}>{fmtPct(m.change24h)}</td>
        <td className={`px-2 py-1.5 ${Math.abs(funding ?? 0) >= 0.05 ? "font-semibold text-amber-300" : "text-slate-300"}`}>{funding === null ? "—" : `${funding.toFixed(4)} %`}</td>
        <td className="px-2 py-1.5 text-slate-300">{c.longShortRatio === null ? "—" : c.longShortRatio.toFixed(2)}</td>
        <td className="px-2 py-1.5 text-slate-300">{m.maxLeverage ? `×${m.maxLeverage}` : "—"}</td>
        <td className="max-w-[260px] truncate px-2 py-1.5 text-amber-200/90">{m.anomalies.length ? m.anomalies.slice(0, 2).map(anomalyLabel).join(" · ") : ""}</td>
        <td className="px-2 py-1.5 text-slate-500">{open ? "▾" : "▸"}</td>
      </tr>
      {open && (
        <tr className="bg-slate-900/60">
          <td colSpan={10} className="px-3 py-2">
            <div className="text-xs font-semibold text-slate-300">Pourquoi {m.bias === "NEUTRE" ? "neutre" : m.bias} (score {m.score} sur ±100, seuil ±25) :</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-400">
              {m.reasons.length ? m.reasons.map((r, i) => <li key={i}>{r}</li>) : <li>aucun facteur marqué pour l&apos;instant</li>}
            </ul>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
              <span>Prix {fmtUsd(m.price)}</span>
              <span>Volume 24 h {fmtBig(m.volume24hUsd)}</span>
              {c.change15m !== null && <span>15 min {fmtPct(c.change15m)}</span>}
              {c.takerBuyRatio !== null && <span>Achats agressifs {(c.takerBuyRatio * 100).toFixed(0)} %</span>}
              {c.oiChangePct !== null && <span>Variation OI {fmtPct(c.oiChangePct, 1)}</span>}
              {m.liquidationMovePct !== null && <span className="text-rose-300">liquidation au levier max : {m.liquidationMovePct} % contre toi</span>}
              <a href={courbe(m.coin)} className="rounded bg-slate-800 px-2 py-1 text-sky-300">
                📈 Courbe et leviers
              </a>
              <a href={safeHref(m.url)} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">
                voir le marché ↗
              </a>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
