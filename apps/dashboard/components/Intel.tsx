"use client";

import type { Direction, IntelSource, NewsItem } from "@radar/core";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { CoinChart } from "@/components/CoinChart";
import { ScoreBar } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtPct } from "@/lib/format";
import { KIND_LABEL, SOURCE_CLS, SOURCE_LABEL, dirCls, dirIcon, fmtAgo, fmtBig, fmtUsd, metricChips, safeHref, type CoinDetail, type FeedSignal } from "@/lib/intel";

export function SourceBadge({ source }: { source: IntelSource }) {
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${SOURCE_CLS[source]}`}>{SOURCE_LABEL[source]}</span>;
}

export function DirBadge({ d }: { d: Direction }) {
  return <span className={`text-xs font-bold ${dirCls(d)}`}>{dirIcon(d)} {d === "bullish" ? "haussier" : d === "bearish" ? "baissier" : "neutre"}</span>;
}

// ─── Coin drawer (opened from any page) ─────────────────────────────────────

const CoinCtx = createContext<(symbol: string) => void>(() => {});
export const useCoinDrawer = () => useContext(CoinCtx);

export function CoinLink({ symbol, className = "" }: { symbol: string; className?: string }) {
  const open = useCoinDrawer();
  return (
    <button type="button" onClick={() => open(symbol)} className={`font-bold text-slate-100 underline decoration-slate-600 decoration-dotted underline-offset-2 hover:text-sky-300 ${className}`}>
      {symbol}
    </button>
  );
}

export function CoinDrawerProvider({ children }: { children: ReactNode }) {
  const [symbol, setSymbol] = useState<string | null>(null);
  const open = useCallback((s: string) => setSymbol(s), []);
  return (
    <CoinCtx.Provider value={open}>
      {children}
      {symbol && <CoinDrawer symbol={symbol} onClose={() => setSymbol(null)} />}
    </CoinCtx.Provider>
  );
}

function CoinDrawer({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const [d, setD] = useState<CoinDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      getJson<CoinDetail>(`/api/intel/coin/${encodeURIComponent(symbol)}`).then(
        (x) => alive && setD(x),
        (e: Error) => alive && setErr(e.message),
      );
    void load();
    const t = setInterval(load, 10_000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [symbol, onClose]);
  const r = d?.row;
  const now = Date.now();
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-slate-800 bg-[#0a1020] p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-2xl font-bold">{symbol}</div>
            <div className="text-sm text-slate-400">
              {r?.name ?? "—"}
              {r?.rank ? ` · #${r.rank}` : ""}
              {r?.onBinance ? " · Binance" : ""}
              {r?.onCoinbase ? " · Coinbase" : ""}
              {r?.trendingRank ? ` · 🔥 tendance #${r.trendingRank}` : ""}
            </div>
          </div>
          <button onClick={onClose} className="rounded border border-slate-700 px-2 py-1 text-sm text-slate-300 hover:bg-slate-800">
            Fermer ✕
          </button>
        </div>
        <div className="mt-4">
          <CoinChart coin={symbol} />
          <a href={`#courbe?coin=${encodeURIComponent(symbol)}`} onClick={onClose} className="mt-2 inline-block rounded bg-slate-800 px-3 py-1.5 text-xs text-sky-300 hover:bg-slate-700">
            📈 Ouvrir la page Courbe (leviers, setup trader)
          </a>
        </div>
        {err && !d && <p className="mt-3 text-xs text-slate-500">Pas encore de fiche détaillée pour {symbol} sur ce site.</p>}
        {r && (
          <div className="num mt-4 grid grid-cols-3 gap-3 text-sm">
            <Mini label="Prix" value={fmtUsd(r.priceUsd)} />
            <Mini label="Capitalisation" value={fmtBig(r.marketCapUsd)} />
            <Mini label="Volume 24 h" value={fmtBig(r.volume24hUsd)} />
            <Mini label="5 min" value={fmtPct(r.live?.change5m)} pct={r.live?.change5m} />
            <Mini label="15 min" value={fmtPct(r.live?.change15m)} pct={r.live?.change15m} />
            <Mini label="1 h" value={fmtPct(r.live?.change1h ?? r.change1h)} pct={r.live?.change1h ?? r.change1h} />
            <Mini label="24 h" value={fmtPct(r.change24h)} pct={r.change24h} />
            <Mini label="7 jours" value={fmtPct(r.change7d)} pct={r.change7d} />
            <Mini label="vs record" value={fmtPct(r.athChangePct, 1)} pct={r.athChangePct} />
            <Mini label="Volume 1 h / moy." value={r.live?.volumeRatio1h ? `${r.live.volumeRatio1h.toFixed(1)}x` : "—"} />
            <Mini label="Funding" value={r.fundingRatePct === null ? "—" : `${r.fundingRatePct.toFixed(4)} %`} />
            <Mini label="Open interest" value={fmtBig(r.openInterestUsd)} />
          </div>
        )}
        <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-slate-400">Signaux ({d?.signals.length ?? 0})</h3>
        <div className="mt-2 space-y-2">
          {d?.signals.slice(0, 40).map((s) => <SignalCard key={s.id} s={s} compact />)}
          {d && !d.signals.length && <p className="text-sm text-slate-500">Aucun signal récent.</p>}
        </div>
        <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-slate-400">Résultat des signaux passés</h3>
        <div className="mt-2 overflow-x-auto">
          <table className="num w-full text-xs">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-1">Quand</th>
                <th>Type</th>
                <th className="text-right">Entrée</th>
                <th className="text-right">15 min</th>
                <th className="text-right">1 h</th>
                <th className="text-right">4 h</th>
                <th className="text-right">24 h</th>
              </tr>
            </thead>
            <tbody>
              {d?.outcomes.map((o) => (
                <tr key={o.id} className="border-t border-slate-800">
                  <td className="py-1 text-slate-500">{fmtAgo(o.ts, now)}</td>
                  <td className={dirCls(o.direction)}>{KIND_LABEL[o.kind]}</td>
                  <td className="text-right">{fmtUsd(o.entryPrice)}</td>
                  {["15", "60", "240", "1440"].map((h) => (
                    <td key={h} className={`text-right ${retCls(o.returns[h] ?? null)}`}>
                      {fmtRet(o.returns[h] ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {d && !d.outcomes.length && <p className="text-sm text-slate-500">Pas encore de mesure.</p>}
        </div>
        <h3 className="mt-6 text-xs font-semibold uppercase tracking-wider text-slate-400">Actualités ({d?.news.length ?? 0})</h3>
        <NewsList items={d?.news ?? []} max={30} />
        <p className="mt-6 text-[11px] text-slate-500">Informations de marché, pas des conseils d&apos;investissement. Aucun ordre n&apos;est passé par l&apos;outil.</p>
      </aside>
    </div>
  );
}

const retCls = (v: number | null) => (v === null || Number.isNaN(v) ? "text-slate-600" : v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-slate-400");
const fmtRet = (v: number | null) => (v === null ? "…" : Number.isNaN(v) ? "n/m" : `${v > 0 ? "+" : ""}${v.toFixed(2)} %`);

function Mini({ label, value, pct }: { label: string; value: string; pct?: number | null }) {
  const cls = pct === undefined ? "text-slate-100" : pct === null ? "text-slate-500" : pct > 0 ? "text-emerald-400" : pct < 0 ? "text-rose-400" : "text-slate-300";
  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 px-2 py-1.5">
      <div className="text-[10px] uppercase text-slate-500">{label}</div>
      <div className={`font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

// ─── Signal card ────────────────────────────────────────────────────────────

export function SignalCard({ s, compact = false }: { s: FeedSignal; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const conf = s.kind === "CONFLUENCE";
  const border = conf ? (s.direction === "bullish" ? "border-emerald-500/60" : "border-rose-500/60") : s.direction === "bullish" ? "border-l-emerald-500" : s.direction === "bearish" ? "border-l-rose-500" : "border-l-slate-600";
  const chips = metricChips(s.metrics);
  return (
    <article className={`rounded-md border border-slate-800 ${conf ? `border-2 ${border} bg-slate-900` : `border-l-4 ${border} bg-slate-900/60`} px-3 py-2`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <CoinLink symbol={s.coin} className="text-sm" />
        {s.coinName && <span className="text-slate-500">{s.coinName}</span>}
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${conf ? "bg-amber-400/20 text-amber-200" : "bg-slate-800 text-slate-300"}`}>{KIND_LABEL[s.kind]}</span>
        <SourceBadge source={s.source} />
        <DirBadge d={s.direction} />
        <span className="ml-auto flex items-center gap-2 text-slate-500">
          <span title={new Date(s.ts).toLocaleString("fr-FR")}>il y a {fmtAgo(s.ts)}</span>
          <ScoreBar score={s.strength} />
        </span>
      </div>
      <div className={`mt-1 ${compact ? "text-xs" : "text-sm"} text-slate-200`}>{s.title}</div>
      {!compact && chips.length > 0 && (
        <div className="num mt-1.5 flex flex-wrap gap-1">
          {chips.map((c) => (
            <span key={c.label} className={`rounded bg-slate-800/80 px-1.5 py-0.5 text-[10px] ${c.tone === "up" ? "text-emerald-300" : c.tone === "down" ? "text-rose-300" : "text-slate-300"}`}>
              {c.label} {c.value}
            </span>
          ))}
          {s.priceUsd !== null && <span className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[10px] text-slate-300">prix {fmtUsd(s.priceUsd)}</span>}
          {s.hitRate1h !== undefined && s.hitRate1h !== null && (
            <span className="rounded bg-sky-900/50 px-1.5 py-0.5 text-[10px] text-sky-200" title="Part des signaux de ce type suivis d'un mouvement ≥ seuil dans leur sens, 1 h après">
              historique {s.hitRate1h.toFixed(0)} % à 1 h
            </span>
          )}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-3 text-[11px]">
        <button type="button" className="text-slate-500 hover:text-slate-300" onClick={() => setOpen(!open)}>
          {open ? "▾ masquer le détail" : `▸ pourquoi ? (${s.reasons.length})`}
        </button>
        {s.url && (
          <a href={safeHref(s.url)} target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">
            source ↗
          </a>
        )}
      </div>
      {open && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-slate-400">
          {s.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

// ─── News list ──────────────────────────────────────────────────────────────

export function NewsList({ items, max = 100 }: { items: NewsItem[]; max?: number }) {
  if (!items.length) return <p className="mt-2 text-sm text-slate-500">Aucune actualité pour l&apos;instant.</p>;
  const now = Date.now();
  return (
    <ul className="mt-2 divide-y divide-slate-800">
      {items.slice(0, max).map((n) => (
        <li key={n.id} className="py-2">
          <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
            <span className={`font-bold ${dirCls(n.direction)}`}>{dirIcon(n.direction)}</span>
            <span>{n.feed}</span>
            <span>· il y a {fmtAgo(n.ts, now)}</span>
            {n.coins.slice(0, 5).map((c) => (
              <CoinLink key={c} symbol={c} className="text-[11px]" />
            ))}
            {n.tags.length > 0 && <span className="text-slate-400">· {n.tags.join(", ")}</span>}
          </div>
          <a href={safeHref(n.link)} target="_blank" rel="noopener noreferrer" className="mt-0.5 block text-sm text-slate-200 hover:text-sky-300">
            {n.title}
          </a>
        </li>
      ))}
    </ul>
  );
}
