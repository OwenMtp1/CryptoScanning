"use client";

import { liquidationPrice, type Candle, type TradeSetup } from "@radar/core";
import { useEffect, useMemo, useState } from "react";
import { PriceChart, type PriceBand, type PriceLevel } from "@/components/PriceChart";
import { PositionCalculator, SetupPlan } from "@/components/Setup";
import { TV_MARKETS, TradingViewChart, type TvMarket } from "@/components/TradingViewChart";
import { Card } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtPct, fmtPrice } from "@/lib/format";
import { safeHref, type LeverageMarketView, type LeverageResponse, type UniverseResponse } from "@/lib/intel";

const RANGES = [
  ["1h", "1 h"],
  ["1d", "1 jour"],
  ["1w", "1 semaine"],
  ["1m", "1 mois"],
  ["1y", "1 an"],
] as const;
type Range = (typeof RANGES)[number][0];
const LEVERAGES = [2, 3, 5, 10, 20, 25, 50, 100];
const MOVES = [-10, -5, -2, -1, 1, 2, 5, 10];
/** Candle sources of the Radar chart (auto = first one that has the coin, in this order). */
const SOURCES = [
  ["auto", "Auto (la 1re qui a la crypto)"],
  ["binance", "Binance"],
  ["coinbase", "Coinbase"],
  ["okx", "OKX"],
  ["bybit", "Bybit"],
  ["kucoin", "KuCoin"],
  ["mexc", "MEXC"],
  ["gate", "Gate.io"],
] as const;
const MAINT = 0.5; // % maintenance margin (approximate, varies by platform)

const COLOR = { entry: "#94a3b8", liqLong: "#fb7185", liqShort: "#f59e0b", stop: "#f43f5e", target: "#34d399", zone: "#38bdf8" };

function hashCoin(): string {
  if (typeof location === "undefined") return "BTC";
  const q = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const c = (q.get("coin") ?? "").toUpperCase();
  return /^[A-Z0-9]{1,20}$/.test(c) ? c : "BTC";
}

/** Margin gain / loss (%) of a leveraged position for a price move (fees ignored); null = liquidated. */
function pnl(move: number, lev: number, side: "LONG" | "SHORT"): number | null {
  const r = (side === "LONG" ? move : -move) * lev;
  return r <= -(100 - MAINT * lev) ? null : r;
}

export default function CourbePage() {
  const [coin, setCoin] = useState(hashCoin);
  const [input, setInput] = useState(coin);
  const [range, setRange] = useState<Range>("1d");
  const [data, setData] = useState<{ candles: Candle[]; source: string; pair: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tool, setTool] = useState<"radar" | "tv">("radar");
  const [src, setSrc] = useState<string>("auto");
  const [tvMarket, setTvMarket] = useState<TvMarket>("auto");
  const [coins, setCoins] = useState<{ symbol: string; name: string }[]>([]);
  const [showLev, setShowLev] = useState(false);
  const [showSetup, setShowSetup] = useState(true);
  const [lev, setLev] = useState<LeverageResponse | null>(null);
  const [lever, setLever] = useState(10);
  const [side, setSide] = useState<"LONG" | "SHORT" | "BOTH">("BOTH");
  const [entryText, setEntryText] = useState("");
  const [setup, setSetup] = useState<{ setup: TradeSetup | null; source: string } | null>(null);
  const [setupErr, setSetupErr] = useState<string | null>(null);

  useEffect(() => {
    getJson<UniverseResponse>("/api/intel/universe?sort=volume&limit=400").then(
      (r) => setCoins(r.rows.map((x) => ({ symbol: x.symbol, name: x.name }))),
      () => {},
    );
    const onHash = () => {
      const c = hashCoin();
      setCoin(c);
      setInput(c);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    let live = true;
    const load = () => {
      setLoading(true);
      getJson<{ candles: Candle[]; source: string; pair: string }>(`/api/web/candles?coin=${encodeURIComponent(coin)}&range=${range}&src=${src}`).then(
        (r) => {
          if (!live) return;
          setData(r);
          setErr(null);
          setLoading(false);
        },
        (e: Error) => {
          if (!live) return;
          setErr(e.message);
          setLoading(false);
        },
      );
    };
    setData(null);
    load();
    const t = setInterval(load, range === "1h" ? 15_000 : 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [coin, range, src]);

  useEffect(() => {
    if (!showSetup) return;
    let live = true;
    setSetup(null);
    setSetupErr(null);
    getJson<{ setup: TradeSetup | null; source: string }>(`/api/web/setup?coin=${encodeURIComponent(coin)}`).then(
      (r) => live && setSetup(r),
      (e: Error) => live && setSetupErr(e.message),
    );
    return () => {
      live = false;
    };
  }, [coin, showSetup]);

  useEffect(() => {
    if (!showLev) return;
    getJson<LeverageResponse>("/api/intel/leverage").then(setLev, () => {});
  }, [showLev, coin]);

  const markets: LeverageMarketView[] = useMemo(() => (lev?.markets ?? []).filter((m) => m.coin === coin), [lev, coin]);
  const maxAvail = markets.reduce((a, m) => Math.max(a, m.maxLeverage ?? 0), 0);
  const levChoices = LEVERAGES.filter((l) => l <= (maxAvail || 20));
  const lastPrice = data?.candles.at(-1)?.c ?? null;
  const entry = Number(entryText.replace(",", ".")) > 0 ? Number(entryText.replace(",", ".")) : lastPrice;

  useEffect(() => {
    if (levChoices.length && !levChoices.includes(lever)) setLever(levChoices[levChoices.length - 1] as number);
  }, [levChoices.join(","), lever]); // eslint-disable-line react-hooks/exhaustive-deps

  const levels: PriceLevel[] = [];
  const bands: PriceBand[] = [];
  if (showLev && entry) {
    levels.push({ y: entry, label: `Entrée ${fmtPrice(entry)}`, color: COLOR.entry });
    if (side !== "SHORT") levels.push({ y: liquidationPrice(entry, lever, "LONG", MAINT), label: `Liquidation LONG ×${lever} : ${fmtPrice(liquidationPrice(entry, lever, "LONG", MAINT))}`, color: COLOR.liqLong, dashed: true });
    if (side !== "LONG") levels.push({ y: liquidationPrice(entry, lever, "SHORT", MAINT), label: `Liquidation SHORT ×${lever} : ${fmtPrice(liquidationPrice(entry, lever, "SHORT", MAINT))}`, color: COLOR.liqShort, dashed: true });
  }
  const s = setup?.setup ?? null;
  if (showSetup && s) {
    bands.push({ y1: s.entry.low, y2: s.entry.high, color: COLOR.zone, label: "zone d'entrée" });
    levels.push({ y: s.stop, label: `Stop ${fmtPrice(s.stop)}`, color: COLOR.stop, dashed: true, fit: true });
    for (const t of s.targets) levels.push({ y: t.price, label: `${t.label.replace(/ \(.*\)/, "")} ${fmtPrice(t.price)}`, color: COLOR.target, dashed: true, fit: range === "1h" || range === "1d" || range === "1w" });
  }

  const first = data?.candles[0]?.c ?? null;
  const change = first && lastPrice ? ((lastPrice - first) / first) * 100 : null;
  const pick = (c: string) => {
    const v = c.trim().toUpperCase();
    if (/^[A-Z0-9]{1,20}$/.test(v)) {
      setCoin(v);
      setEntryText("");
      try {
        history.replaceState(null, "", `#courbe?coin=${v}`);
      } catch {
        // ignore
      }
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            pick(input);
          }}
        >
          <label className="text-xs text-slate-400">
            Crypto
            <input list="courbe-coins" value={input} onChange={(e) => setInput(e.target.value)} onBlur={() => pick(input)} placeholder="BTC, ETH, SOL…" className="mt-1 block w-40 rounded border border-slate-700 bg-slate-900 px-2 py-2 text-base uppercase text-slate-100" autoCapitalize="characters" />
            <datalist id="courbe-coins">
              {coins.map((c) => (
                <option key={c.symbol} value={c.symbol}>
                  {c.name}
                </option>
              ))}
            </datalist>
          </label>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Période">
            {RANGES.map(([k, l]) => (
              <button key={k} type="button" onClick={() => setRange(k)} className={`rounded px-3 py-2 text-sm ${range === k ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
                {l}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2 text-xs text-slate-400">
            <div>
              Outil de courbe
              <div className="mt-1 flex gap-1">
                {(
                  [
                    ["radar", "Radar (leviers + setup)"],
                    ["tv", "TradingView"],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setTool(k)} className={`rounded px-3 py-2 text-sm ${tool === k ? "bg-violet-600 text-white" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
                    {l}
                  </button>
                ))}
              </div>
            </div>
            {tool === "radar" ? (
              <label>
                Source des prix
                <select value={src} onChange={(e) => setSrc(e.target.value)} className="mt-1 block rounded border border-slate-700 bg-slate-900 px-2 py-2 text-sm text-slate-100">
                  {SOURCES.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Marché TradingView
                <select value={tvMarket} onChange={(e) => setTvMarket(e.target.value as TvMarket)} className="mt-1 block rounded border border-slate-700 bg-slate-900 px-2 py-2 text-sm text-slate-100">
                  {TV_MARKETS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showLev} onChange={(e) => setShowLev(e.target.checked)} className="h-4 w-4" /> Afficher les leviers
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={showSetup} onChange={(e) => setShowSetup(e.target.checked)} className="h-4 w-4" /> Afficher le setup trader
            </label>
          </div>
        </form>
      </Card>

      <Card>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="text-lg font-bold text-slate-100">{coin}</h1>
          {lastPrice !== null && <span className="num text-2xl font-semibold text-slate-100">{fmtPrice(lastPrice)} $</span>}
          {change !== null && <span className={`num text-sm ${change >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(change)} sur {RANGES.find((r) => r[0] === range)?.[1]}</span>}
          {data && <span className="text-xs text-slate-500">source : {data.source} ({data.pair})</span>}
          {loading && <span className="text-xs text-slate-500">mise à jour…</span>}
        </div>
        {tool === "tv" ? (
          <>
            <TradingViewChart coin={coin} market={tvMarket} range={range} height={typeof window !== "undefined" && window.innerWidth < 640 ? 420 : 560} />
            <p className="mt-1 text-[11px] text-slate-500">
              Courbe TradingView (outils et indicateurs intégrés, recherche d&apos;une autre crypto en haut à gauche). Les lignes de liquidation et du setup sont tracées sur l&apos;outil « Radar ». Si la crypto n&apos;apparaît pas, change de marché.
            </p>
          </>
        ) : err && !data ? (
          <>
            <p className="mb-2 text-sm text-amber-300">
              {coin} n&apos;est pas sur {src === "auto" ? "nos 7 sources de prix (Binance, Coinbase, OKX, Bybit, KuCoin, MEXC, Gate.io)" : SOURCES.find((x) => x[0] === src)?.[1]} : voici la courbe TradingView.
            </p>
            <TradingViewChart coin={coin} market="auto" range={range} height={420} />
            <details className="mt-1 text-[11px] text-slate-500">
              <summary>détail</summary>
              {err}
            </details>
          </>
        ) : data ? (
          <PriceChart candles={data.candles} levels={levels} bands={bands} title={`Cours de ${coin}`} />
        ) : (
          <div className="h-[290px] animate-pulse md:h-[380px] rounded bg-slate-900" />
        )}
        {(showLev || showSetup) && (
          <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-slate-400">
            {showLev && <Key color={COLOR.entry} label="entrée" />}
            {showLev && side !== "SHORT" && <Key color={COLOR.liqLong} label="liquidation long" dashed />}
            {showLev && side !== "LONG" && <Key color={COLOR.liqShort} label="liquidation short" dashed />}
            {showSetup && s && <Key color={COLOR.zone} label="zone d'entrée" band />}
            {showSetup && s && <Key color={COLOR.stop} label="stop" dashed />}
            {showSetup && s && <Key color={COLOR.target} label="objectifs" dashed />}
          </div>
        )}
      </Card>

      {showLev && (
        <Card title={`⚖️ Leviers disponibles sur ${coin}`}>
          <div className="mb-3 rounded border border-rose-700/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-100">
            <strong>⚠️ Levier = risque de tout perdre.</strong> Les prix de liquidation sont approximatifs (marge isolée, marge de maintenance ≈ {MAINT} %, frais et financement non inclus) : vérifie toujours sur la plateforme. Pas un conseil.
          </div>
          {!lev ? (
            <p className="text-sm text-slate-500">Chargement des marchés à levier…</p>
          ) : markets.length === 0 ? (
            <p className="text-sm text-slate-400">Aucun marché perpétuel trouvé pour {coin} (Coinbase, Coinbase International, Binance Futures). Les calculs ci-dessous restent valables à titre d&apos;exemple.</p>
          ) : (
            <div className="mb-4 space-y-2">
              {markets.map((m) => (
                <div key={m.productId} className="rounded border border-slate-800 bg-slate-950/40 p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <a href={safeHref(m.url)} target="_blank" rel="noreferrer noopener" className="font-semibold text-sky-300 underline">
                      {m.name}
                    </a>
                    <span className="text-slate-400">{m.venue ?? "—"}</span>
                    <span>levier max <strong>{m.maxLeverage ? `×${m.maxLeverage}` : "inconnu"}</strong></span>
                    <span>financement <strong className="num">{m.fundingPct === null ? "—" : `${m.fundingPct.toFixed(4)} %`}</strong></span>
                    <span className={m.bias === "LONG" ? "text-emerald-300" : m.bias === "SHORT" ? "text-rose-300" : "text-slate-400"}>
                      lecture {m.bias} ({m.score > 0 ? "+" : ""}
                      {m.score})
                    </span>
                  </div>
                  {m.reasons.length > 0 && <div className="mt-1 text-xs text-slate-500">{m.reasons.slice(0, 3).join(" · ")}</div>}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-end gap-4">
            <div>
              <div className="text-xs text-slate-400">Levier</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {levChoices.map((l) => (
                  <button key={l} type="button" onClick={() => setLever(l)} className={`rounded px-2.5 py-1.5 text-sm ${lever === l ? "bg-amber-600 text-white" : "bg-slate-800 text-slate-300"}`}>
                    ×{l}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-400">Sens</div>
              <div className="mt-1 flex gap-1">
                {(["LONG", "SHORT", "BOTH"] as const).map((x) => (
                  <button key={x} type="button" onClick={() => setSide(x)} className={`rounded px-2.5 py-1.5 text-sm ${side === x ? "bg-sky-700 text-white" : "bg-slate-800 text-slate-300"}`}>
                    {x === "BOTH" ? "Les deux" : x}
                  </button>
                ))}
              </div>
            </div>
            <label className="text-xs text-slate-400">
              Prix d&apos;entrée
              <input value={entryText} onChange={(e) => setEntryText(e.target.value)} placeholder={lastPrice ? fmtPrice(lastPrice) : "prix actuel"} inputMode="decimal" className="num mt-1 block w-36 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100" />
            </label>
          </div>

          {entry && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <caption className="mb-1 text-left text-slate-400">Possibilités par levier (entrée {fmtPrice(entry)} $) : gain ou perte sur la mise selon le mouvement du prix</caption>
                <thead>
                  <tr className="text-slate-500">
                    <th className="px-1 py-1 text-left">Levier</th>
                    <th className="px-1 py-1 text-left">Sens</th>
                    <th className="px-1 py-1 text-right">Liquidation</th>
                    <th className="px-1 py-1 text-right">Écart</th>
                    {MOVES.map((m) => (
                      <th key={m} className="px-1 py-1 text-right">
                        {m > 0 ? "+" : ""}
                        {m} %
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {levChoices.flatMap((l) =>
                    (side === "BOTH" ? (["LONG", "SHORT"] as const) : [side]).map((sd) => {
                      const liq = liquidationPrice(entry, l, sd, MAINT);
                      return (
                        <tr key={`${l}${sd}`} className={`border-t border-slate-800 ${l === lever ? "bg-slate-800/50" : ""}`}>
                          <td className="num px-1 py-1 font-semibold">×{l}</td>
                          <td className={`px-1 py-1 ${sd === "LONG" ? "text-emerald-300" : "text-rose-300"}`}>{sd}</td>
                          <td className="num px-1 py-1 text-right">{fmtPrice(liq)}</td>
                          <td className="num px-1 py-1 text-right text-slate-400">{fmtPct(((liq - entry) / entry) * 100, 1)}</td>
                          {MOVES.map((m) => {
                            const r = pnl(m, l, sd);
                            return (
                              <td key={m} className={`num px-1 py-1 text-right ${r === null ? "font-bold text-rose-500" : r >= 0 ? "text-emerald-400" : "text-rose-300"}`}>
                                {r === null ? "liquidé" : fmtPct(r, 0)}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    }),
                  )}
                </tbody>
              </table>
            </div>
          )}
          {s && (
            <p className="mt-3 text-xs text-slate-300">
              D&apos;après le setup trader, le levier maximal qui garde la liquidation au-delà du stop est <strong>×{s.maxSafeLeverage}</strong>
              {lever > s.maxSafeLeverage ? <span className="text-rose-300"> : ×{lever} serait liquidé avant le stop.</span> : "."}
            </p>
          )}
        </Card>
      )}

      {showSetup && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={`🎯 Setup trader sur ${coin} (bougies 1 h + vue 4 h)`} className="lg:col-span-2">
            {setupErr ? <p className="text-sm text-slate-400">Analyse impossible : aucune de nos sources de prix n&apos;a l&apos;historique 1 h de {coin}. <span className="text-[11px] text-slate-600">({setupErr})</span></p> : !setup ? <p className="text-sm text-slate-500">Analyse en cours…</p> : s ? <SetupPlan s={s} /> : <p className="text-sm text-slate-400">Pas assez d&apos;historique pour {coin}.</p>}
          </Card>
          {s && (
            <Card title="Taille de position">
              <PositionCalculator s={s} />
            </Card>
          )}
        </div>
      )}
      <p className="text-[11px] text-slate-500">Données : Binance (sinon Coinbase), directement depuis ton navigateur. Lecture statistique, pas un conseil d&apos;investissement ; aucun ordre n&apos;est passé.</p>
    </div>
  );
}

function Key({ color, label, dashed, band }: { color: string; label: string; dashed?: boolean; band?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      {band ? <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: color, opacity: 0.35 }} /> : <svg width="18" height="6" aria-hidden><line x1="0" x2="18" y1="3" y2="3" stroke={color} strokeWidth={2} strokeDasharray={dashed ? "4 3" : undefined} /></svg>}
      {label}
    </span>
  );
}
