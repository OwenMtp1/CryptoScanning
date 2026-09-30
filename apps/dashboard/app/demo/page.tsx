"use client";

import { DEMO_FEES, liqPriceOf, type DemoState, type DemoValuation, type TradeSetup } from "@radar/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { CoinChart } from "@/components/CoinChart";
import { useDialogs } from "@/components/Dialogs";
import { CoinLink } from "@/components/Intel";
import { PriceChart } from "@/components/PriceChart";
import { Card } from "@/components/ui";
import { getJson, postAction } from "@/lib/api";
import { fmtPct, fmtPrice } from "@/lib/format";
import { fmtAgo, type UniverseResponse } from "@/lib/intel";

interface DemoView {
  state: DemoState;
  valuation: DemoValuation;
  events: { ts: number; text: string }[];
}
interface Quote {
  coin: string;
  price: number | null;
  name: string | null;
  change24h: number | null;
  maxLeverage: number | null;
}
type Mode = "buy" | "sell" | "long" | "short";

const usd = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d })} $`);
const signed = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${x >= 0 ? "+" : ""}${usd(x)}`);
const tone = (x: number | null | undefined) => (x === null || x === undefined ? "text-slate-300" : x >= 0 ? "text-emerald-400" : "text-rose-400");
const TYPE_LABEL: Record<string, string> = { DEPOSIT: "Dépôt", BUY: "Achat", SELL: "Vente", OPEN: "Ouverture", CLOSE: "Fermeture", STOP: "Stop touché", TAKE_PROFIT: "Objectif atteint", LIQUIDATION: "Liquidation" };

export default function DemoPage() {
  const { notify } = useDialogs();
  const [d, setD] = useState<DemoView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seenEvents = useRef<number>(Date.now());

  const load = () =>
    getJson<DemoView>("/api/web/demo").then(
      (r) => {
        setD(r);
        setErr(null);
        for (const e of r.events.filter((x) => x.ts > seenEvents.current).reverse()) notify(e.text, e.text.startsWith("💥") ? "error" : "info");
        if (r.events[0]) seenEvents.current = Math.max(seenEvents.current, r.events[0].ts);
      },
      (e: Error) => setErr(e.message),
    );
  useEffect(() => {
    void load();
    const t = setInterval(load, 3_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (body: Record<string, unknown>) => {
    try {
      const r = await postAction<DemoView & { message: string }>("/api/web/demo", body);
      setD(r);
      notify(r.message, "info");
      return true;
    } catch (e) {
      notify((e as Error).message, "error");
      return false;
    }
  };

  if (err && !d)
    return (
      <Card title="Mode démo">
        <p className="text-sm text-slate-300">Indisponible : {err}</p>
        <p className="mt-1 text-xs text-slate-500">Le mode démo fonctionne sur le site en ligne (il utilise les prix en direct que le site lit).</p>
      </Card>
    );
  if (!d) return <Card title="Mode démo">Chargement…</Card>;
  const v = d.valuation;

  return (
    <div className="space-y-4">
      <div className="rounded border border-sky-700/60 bg-sky-950/40 px-3 py-2 text-xs text-sky-100">
        <strong>🎮 Mode démo : argent fictif.</strong> Les ordres sont simulés sur les prix réels du moment (frais {DEMO_FEES.spotPct} % au comptant, {DEMO_FEES.perpPct} % en levier, glissement ≈ {DEMO_FEES.slippagePct} %,
        financement non simulé). Aucun ordre n&apos;est envoyé à une plateforme. Le compte est gardé dans ce navigateur.
      </div>

      <Summary v={v} state={d.state} onAct={act} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Ticket cash={v.cash} holdings={d.state.spot} onAct={act} />
        <Card title="Valeur du compte">
          {d.state.equity.length >= 2 ? (
            <PriceChart candles={d.state.equity.map((p) => ({ t: p.ts, o: p.value, h: p.value, l: p.value, c: p.value, v: 0 }))} levels={[{ y: d.state.deposited, label: `Capital déposé ${usd(d.state.deposited, 0)}`, color: "#94a3b8", dashed: true }]} height={300} title="Valeur du compte de démo" />
          ) : (
            <p className="text-sm text-slate-500">La courbe apparaît après quelques minutes de jeu (un point toutes les 5 min).</p>
          )}
          <div className="num mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Mini label="Trades fermés" value={`${v.stats.trades}`} />
            <Mini label="Réussite" value={v.stats.winRate === null ? "—" : `${v.stats.winRate.toFixed(0)} %`} />
            <Mini label="Meilleur" value={signed(v.stats.best)} cls={tone(v.stats.best)} />
            <Mini label="Pire" value={signed(v.stats.worst)} cls={tone(v.stats.worst)} />
            <Mini label="Gains réalisés" value={signed(v.stats.realized)} cls={tone(v.stats.realized)} />
            <Mini label="Frais payés" value={usd(v.stats.fees)} />
          </div>
        </Card>
      </div>

      <Positions v={v} onAct={act} />
      <Holdings v={v} onAct={act} />
      <History state={d.state} />
    </div>
  );
}

function Mini({ label, value, cls = "text-slate-100" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded border border-slate-800 bg-slate-950/40 px-2 py-1.5">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`text-sm font-semibold ${cls}`}>{value}</div>
    </div>
  );
}

function Summary({ v, state, onAct }: { v: DemoValuation; state: DemoState; onAct: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [amount, setAmount] = useState("1000");
  const { confirm } = useDialogs();
  return (
    <Card>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-xs text-slate-500">Valeur totale</div>
          <div className="text-3xl font-semibold text-slate-100">{usd(v.equity)}</div>
          <div className={`num text-sm ${tone(v.pnl)}`}>
            {signed(v.pnl)} {v.pnlPct !== null && `(${fmtPct(v.pnlPct)})`} <span className="text-slate-500">sur {usd(state.deposited, 0)} déposés</span>
          </div>
        </div>
        <div className="num grid grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-xs text-slate-500">Liquidités</div>
            {usd(v.cash)}
          </div>
          <div>
            <div className="text-xs text-slate-500">Au comptant</div>
            {usd(v.spotValue)}
          </div>
          <div>
            <div className="text-xs text-slate-500">En levier (marge + résultat)</div>
            <span className={tone(v.unrealized)}>{usd(v.marginUsed + v.unrealized)}</span>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-400">
            Ajouter du capital ($)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="num mt-1 block w-32 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100" />
          </label>
          <button onClick={() => void onAct({ action: "deposit", amount: Number(amount.replace(",", ".")) })} className="rounded bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-600">
            + Ajouter
          </button>
          {[1000, 10000].map((a) => (
            <button key={a} onClick={() => void onAct({ action: "deposit", amount: a })} className="rounded bg-slate-800 px-2.5 py-2 text-xs text-slate-200 hover:bg-slate-700">
              +{a.toLocaleString("fr-FR")} $
            </button>
          ))}
          <button
            onClick={() =>
              void confirm({ title: "Remettre le compte à zéro ?", message: "Tout l'historique, les positions et le capital de démo seront effacés.", confirmLabel: "Tout effacer", tone: "danger" }).then((r) => r.ok && onAct({ action: "reset", confirm: "RESET" }))
            }
            className="rounded border border-slate-700 px-2.5 py-2 text-xs text-slate-400 hover:border-rose-600 hover:text-rose-300"
          >
            Remise à zéro
          </button>
        </div>
      </div>
      {state.deposited === 0 && <p className="mt-3 text-sm text-amber-200">Commence par ajouter du capital fictif (par exemple 1 000 $), puis cherche une crypto pour acheter, vendre ou prendre une position à levier.</p>}
      {v.missingPrices.length > 0 && <p className="mt-2 text-xs text-amber-300">Prix momentanément indisponible pour : {v.missingPrices.join(", ")} (valorisé au prix d&apos;achat).</p>}
    </Card>
  );
}

function Ticket({ cash, holdings, onAct }: { cash: number; holdings: DemoState["spot"]; onAct: (b: Record<string, unknown>) => Promise<boolean> }) {
  const [coin, setCoin] = useState("BTC");
  const [input, setInput] = useState("BTC");
  const [coins, setCoins] = useState<{ symbol: string; name: string }[]>([]);
  const [q, setQ] = useState<Quote | null>(null);
  const [mode, setMode] = useState<Mode>("buy");
  const [amount, setAmount] = useState("100");
  const [fraction, setFraction] = useState(100);
  const [lev, setLev] = useState(5);
  const [stop, setStop] = useState("");
  const [tp, setTp] = useState("");
  const [busy, setBusy] = useState(false);
  const [showChart, setShowChart] = useState(true);

  useEffect(() => {
    getJson<UniverseResponse>("/api/intel/universe?sort=volume&limit=500").then((r) => setCoins(r.rows.map((x) => ({ symbol: x.symbol, name: x.name }))), () => {});
  }, []);
  useEffect(() => {
    let live = true;
    setQ(null);
    const load = () => getJson<Quote>(`/api/web/price?coin=${encodeURIComponent(coin)}`).then((r) => live && setQ(r), () => {});
    void load();
    const t = setInterval(load, 5_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [coin]);

  const maxLev = Math.min(100, q?.maxLeverage ?? 50);
  useEffect(() => {
    if (lev > maxLev) setLev(maxLev);
  }, [maxLev]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (c: string) => {
    const v = c.trim().toUpperCase();
    if (/^[A-Z0-9]{1,20}$/.test(v) && v !== coin) {
      setCoin(v);
      setStop("");
      setTp("");
    }
  };
  const held = holdings[coin];
  const amt = Number(amount.replace(",", "."));
  const price = q?.price ?? null;
  const lever = mode === "long" || mode === "short";
  const side = mode === "short" ? "SHORT" : "LONG";
  const liq = lever && price ? liqPriceOf(price, lev, side) : null;
  const fee = lever ? (amt * lev * DEMO_FEES.perpPct) / 100 : (amt * DEMO_FEES.spotPct) / 100;

  const useSetup = async () => {
    try {
      const r = await getJson<{ setup: TradeSetup | null }>(`/api/web/setup?coin=${encodeURIComponent(coin)}`);
      const s = r.setup;
      if (!s) return;
      setMode(s.side === "LONG" ? "long" : "short");
      setStop(String(Number(s.stop.toPrecision(6))));
      setTp(String(Number((s.targets[0]?.price ?? 0).toPrecision(6))));
      setLev(Math.max(1, Math.min(s.maxSafeLeverage, maxLev)));
    } catch {
      // no setup available
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "buy") await onAct({ action: "buy", coin, usd: amt });
      else if (mode === "sell") await onAct({ action: "sell", coin, fraction: fraction / 100 });
      else await onAct({ action: "open", coin, side, leverage: lev, margin: amt, stop: stop.replace(",", ".") || null, takeProfit: tp.replace(",", ".") || null });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Passer un ordre (démo)">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          pick(input);
        }}
      >
        <label className="text-xs text-slate-400">
          Crypto
          <input list="demo-coins" value={input} onChange={(e) => setInput(e.target.value)} onBlur={() => pick(input)} className="mt-1 block w-36 rounded border border-slate-700 bg-slate-900 px-2 py-2 text-base uppercase text-slate-100" autoCapitalize="characters" placeholder="BTC, SOL…" />
          <datalist id="demo-coins">
            {coins.map((c) => (
              <option key={c.symbol} value={c.symbol}>
                {c.name}
              </option>
            ))}
          </datalist>
        </label>
        <div className="pb-1">
          <div className="text-lg font-semibold text-slate-100">
            {coin} <span className="num">{price ? `${fmtPrice(price)} $` : "…"}</span>
          </div>
          <div className="text-xs text-slate-500">
            {q?.name ?? ""} {q?.change24h !== null && q?.change24h !== undefined && <span className={tone(q.change24h)}>{fmtPct(q.change24h)} 24 h</span>}
            {q && !q.price && <span className="text-amber-300">aucun prix trouvé pour cette crypto</span>}
          </div>
        </div>
        <button type="button" onClick={() => setShowChart((x) => !x)} className="ml-auto rounded bg-slate-800 px-2 py-1 text-xs text-slate-300">
          {showChart ? "Masquer la courbe" : "Voir la courbe"}
        </button>
      </form>
      {showChart && (
        <div className="mt-3">
          <CoinChart coin={coin} height={200} />
        </div>
      )}

      <div className="mt-4 grid grid-cols-4 gap-1 text-sm" role="tablist">
        {(
          [
            ["buy", "Acheter", "bg-emerald-700"],
            ["sell", "Vendre", "bg-rose-700"],
            ["long", "▲ Long levier", "bg-emerald-800"],
            ["short", "▼ Short levier", "bg-rose-800"],
          ] as const
        ).map(([k, l, c]) => (
          <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => setMode(k)} className={`rounded px-2 py-2 font-semibold ${mode === k ? `${c} text-white` : "bg-slate-800 text-slate-400"}`}>
            {l}
          </button>
        ))}
      </div>

      <div className="mt-3 space-y-3 text-sm">
        {mode === "sell" ? (
          held ? (
            <>
              <div className="text-xs text-slate-400">
                Tu détiens <strong className="num text-slate-200">{fmtPrice(held.qty)} {coin}</strong> (prix moyen {fmtPrice(held.avgPrice)} $)
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {[25, 50, 75, 100].map((f) => (
                  <button key={f} type="button" onClick={() => setFraction(f)} className={`rounded px-3 py-1.5 ${fraction === f ? "bg-rose-700 text-white" : "bg-slate-800 text-slate-300"}`}>
                    {f} %
                  </button>
                ))}
                {price && <span className="num text-xs text-slate-400">≈ {usd(held.qty * (fraction / 100) * price)}</span>}
              </div>
            </>
          ) : (
            <p className="text-slate-500">Tu ne détiens pas de {coin} au comptant.</p>
          )
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-slate-400">
                {lever ? "Marge engagée ($)" : "Montant ($)"}
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="num mt-1 block w-32 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100" />
              </label>
              {[10, 25, 50, 100].map((f) => (
                <button key={f} type="button" onClick={() => setAmount(String(Math.floor(((cash * f) / 100 / (lever ? 1 + (lev * DEMO_FEES.perpPct) / 100 : 1)) * 100) / 100))} className="rounded bg-slate-800 px-2 py-1.5 text-xs text-slate-300">
                  {f} %
                </button>
              ))}
              <span className="num text-xs text-slate-500">disponible {usd(cash)}</span>
            </div>
            {lever && (
              <>
                <div>
                  <div className="text-xs text-slate-400">
                    Levier <strong className="num text-slate-100">×{lev}</strong> <span className="text-slate-500">(max ×{maxLev}{q?.maxLeverage ? " sur ce marché" : ", valeur de démo"})</span>
                  </div>
                  <input type="range" min={1} max={maxLev} value={lev} onChange={(e) => setLev(Number(e.target.value))} className="mt-1 w-full max-w-md" />
                </div>
                <div className="flex flex-wrap gap-3">
                  <label className="text-xs text-slate-400">
                    Stop (prix, facultatif)
                    <input value={stop} onChange={(e) => setStop(e.target.value)} inputMode="decimal" className="num mt-1 block w-32 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100" />
                  </label>
                  <label className="text-xs text-slate-400">
                    Objectif (prix, facultatif)
                    <input value={tp} onChange={(e) => setTp(e.target.value)} inputMode="decimal" className="num mt-1 block w-32 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-100" />
                  </label>
                  <button type="button" onClick={() => void useSetup()} className="self-end rounded bg-slate-800 px-2.5 py-1.5 text-xs text-sky-300 hover:bg-slate-700">
                    🎯 Remplir avec le setup trader
                  </button>
                </div>
                <div className="num rounded border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">
                  Position {usd(amt * lev)} · liquidation vers <strong className="text-rose-300">{liq ? `${fmtPrice(liq)} $` : "—"}</strong> ({(100 / lev - DEMO_FEES.maintenancePct).toFixed(1)} % contre toi) · frais ≈ {usd(fee)}
                </div>
              </>
            )}
            {!lever && price && amt > 0 && (
              <div className="num text-xs text-slate-400">
                ≈ {fmtPrice((amt - fee) / price)} {coin} · frais ≈ {usd(fee)}
              </div>
            )}
          </>
        )}
        <button type="button" disabled={busy || !price || (mode === "sell" && !held)} onClick={() => void submit()} className={`w-full rounded px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40 ${mode === "buy" || mode === "long" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-rose-600 hover:bg-rose-500"}`}>
          {busy ? "…" : mode === "buy" ? `Acheter ${coin}` : mode === "sell" ? `Vendre ${fraction} % de ${coin}` : `Ouvrir ${side} ${coin} ×${lev}`}
        </button>
      </div>
    </Card>
  );
}

function Positions({ v, onAct }: { v: DemoValuation; onAct: (b: Record<string, unknown>) => Promise<boolean> }) {
  if (!v.positions.length) return null;
  return (
    <Card title={`Positions à levier (${v.positions.length})`}>
      <div className="-mx-3 overflow-x-auto sm:mx-0">
        <table className="num w-full min-w-[760px] text-xs">
          <thead className="text-left text-slate-500">
            <tr>
              {["Crypto", "Sens", "Marge", "Entrée", "Prix", "Liquidation", "Stop / objectif", "Résultat", ""].map((h) => (
                <th key={h} className="px-2 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v.positions.map((p) => {
              const danger = p.distanceToLiqPct !== null && p.distanceToLiqPct < 2;
              return (
                <tr key={p.id} className={`border-t border-slate-800 ${danger ? "bg-rose-950/40" : ""}`}>
                  <td className="px-2 py-1.5">
                    <CoinLink symbol={p.coin} />
                  </td>
                  <td className={`px-2 py-1.5 font-semibold ${p.side === "LONG" ? "text-emerald-300" : "text-rose-300"}`}>
                    {p.side} ×{p.leverage}
                  </td>
                  <td className="px-2 py-1.5">{usd(p.margin)}</td>
                  <td className="px-2 py-1.5">{fmtPrice(p.entry)}</td>
                  <td className="px-2 py-1.5">{p.price ? fmtPrice(p.price) : "—"}</td>
                  <td className={`px-2 py-1.5 ${danger ? "font-bold text-rose-400" : "text-rose-300"}`}>
                    {fmtPrice(p.liqPrice)}
                    {p.distanceToLiqPct !== null && <span className="text-slate-500"> ({p.distanceToLiqPct.toFixed(1)} %)</span>}
                  </td>
                  <td className="px-2 py-1.5 text-slate-400">
                    {p.stop ? fmtPrice(p.stop) : "—"} / {p.takeProfit ? fmtPrice(p.takeProfit) : "—"}
                  </td>
                  <td className={`px-2 py-1.5 font-semibold ${tone(p.pnl)}`}>
                    {signed(p.pnl)} <span className="text-[10px]">{p.pnlPct !== null && fmtPct(p.pnlPct, 1)}</span>
                  </td>
                  <td className="px-2 py-1.5">
                    <button onClick={() => void onAct({ action: "close", id: p.id })} className="rounded bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700">
                      Fermer
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">Stops, objectifs et liquidations sont vérifiés toutes les 5 s tant que cette page (ou un autre onglet du site) est ouverte.</p>
    </Card>
  );
}

function Holdings({ v, onAct }: { v: DemoValuation; onAct: (b: Record<string, unknown>) => Promise<boolean> }) {
  if (!v.holdings.length) return null;
  return (
    <Card title={`Cryptos détenues (${v.holdings.length})`}>
      <div className="-mx-3 overflow-x-auto sm:mx-0">
        <table className="num w-full min-w-[640px] text-xs">
          <thead className="text-left text-slate-500">
            <tr>
              {["Crypto", "Quantité", "Prix moyen", "Prix", "Valeur", "Résultat", "Vendre"].map((h) => (
                <th key={h} className="px-2 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {v.holdings.map((h) => (
              <tr key={h.coin} className="border-t border-slate-800">
                <td className="px-2 py-1.5">
                  <CoinLink symbol={h.coin} />
                </td>
                <td className="px-2 py-1.5">{fmtPrice(h.qty)}</td>
                <td className="px-2 py-1.5">{fmtPrice(h.avgPrice)}</td>
                <td className="px-2 py-1.5">{h.price ? fmtPrice(h.price) : "—"}</td>
                <td className="px-2 py-1.5">{usd(h.value)}</td>
                <td className={`px-2 py-1.5 font-semibold ${tone(h.pnl)}`}>
                  {signed(h.pnl)} <span className="text-[10px]">{h.pnlPct !== null && fmtPct(h.pnlPct, 1)}</span>
                </td>
                <td className="px-2 py-1.5">
                  {[50, 100].map((f) => (
                    <button key={f} onClick={() => void onAct({ action: "sell", coin: h.coin, fraction: f / 100 })} className="mr-1 rounded bg-slate-800 px-2 py-1 text-slate-200 hover:bg-slate-700">
                      {f} %
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function History({ state }: { state: DemoState }) {
  const [n, setN] = useState(20);
  const rows = useMemo(() => state.history.slice(0, n), [state.history, n]);
  if (!state.history.length) return null;
  return (
    <Card title="Historique">
      <div className="-mx-3 overflow-x-auto sm:mx-0">
        <table className="num w-full min-w-[640px] text-xs">
          <thead className="text-left text-slate-500">
            <tr>
              {["Quand", "Opération", "Crypto", "Prix", "Montant", "Frais", "Résultat"].map((h) => (
                <th key={h} className="px-2 py-1.5 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-t border-slate-800">
                <td className="px-2 py-1.5 text-slate-500">il y a {fmtAgo(t.ts)}</td>
                <td className={`px-2 py-1.5 ${t.type === "LIQUIDATION" ? "font-bold text-rose-400" : "text-slate-200"}`}>
                  {TYPE_LABEL[t.type] ?? t.type}
                  {t.side && ` ${t.side}`}
                  {t.leverage && ` ×${t.leverage}`}
                </td>
                <td className="px-2 py-1.5">{t.coin ?? "—"}</td>
                <td className="px-2 py-1.5">{t.price ? fmtPrice(t.price) : "—"}</td>
                <td className="px-2 py-1.5">{usd(t.amount)}</td>
                <td className="px-2 py-1.5 text-slate-500">{t.fee ? usd(t.fee) : "—"}</td>
                <td className={`px-2 py-1.5 font-semibold ${tone(t.pnl)}`}>{t.pnl === null ? "" : signed(t.pnl)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state.history.length > n && (
        <button onClick={() => setN((x) => x + 50)} className="mt-2 w-full rounded border border-slate-700 py-1.5 text-xs text-slate-400">
          Voir plus ({n} sur {state.history.length})
        </button>
      )}
    </Card>
  );
}
