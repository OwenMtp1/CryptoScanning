"use client";

import type { IntelKind, IntelSource } from "@radar/core";
import { useEffect, useState } from "react";
import { useDialogs } from "@/components/Dialogs";
import { Card } from "@/components/ui";
import { getJson, postAction } from "@/lib/api";
import { KIND_LABEL, SOURCE_LABEL, fmtAgo, type SourcesResponse } from "@/lib/intel";

interface Sent24h {
  byChannel: Record<string, number>;
  byDirection: Record<string, number>;
  byKind: Record<string, number>;
  bySource?: Record<string, number>;
  last: { ts: number; dir: string; kind: string; coin: string; channel: string }[];
}

interface Prefs {
  enabled: boolean;
  minStrength: number;
  kinds: string[];
  sources: string[];
  directions: ("bullish" | "bearish" | "neutral")[];
  includeCoins: string[];
  excludeCoins: string[];
  minHitRate: number | null;
  leverage?: LeveragePrefs;
  updatedAt: number | null;
}
interface LeveragePrefs {
  enabled: boolean;
  minScore: number;
  biases: ("LONG" | "SHORT")[];
  minMaxLeverage: number;
  venues: string[];
  includeCoins: string[];
  excludeCoins: string[];
  strengthenStep: number;
  remindHours: number;
  liquidations: boolean;
  minLiquidationUsd: number;
}
const LEV_DEFAULT: LeveragePrefs = { enabled: true, minScore: 25, biases: ["LONG", "SHORT"], minMaxLeverage: 0, venues: [], includeCoins: [], excludeCoins: [], strengthenStep: 15, remindHours: 0, liquidations: true, minLiquidationUsd: 500_000 };
const VENUES = ["Coinbase International", "INTX", "Binance Futures"];
const LIQ_STEPS = [0, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000];
const usd = (n: number) => (n >= 1e6 ? `${n / 1e6} M$` : n >= 1e3 ? `${n / 1e3} k$` : `${n} $`);
interface PrefsResponse {
  prefs: Prefs;
  kinds: IntelKind[];
  sources: IntelSource[];
  channels: { id: string; label: string; directions: string[]; active: boolean }[];
  keySet?: boolean;
}

const GROUPS: { label: string; kinds: IntelKind[] }[] = [
  { label: "Prix en direct", kinds: ["PUMP_EARLY", "DUMP_EARLY", "VOLUME_SURGE", "BREAKOUT_24H_HIGH", "BREAKDOWN_24H_LOW"] },
  { label: "Marché (CoinGecko)", kinds: ["TOP_MOVER_1H", "CRASH_1H", "VOLUME_MCAP_ANOMALY", "NEAR_ATH", "TRENDING_ENTRY"] },
  { label: "Levier et dérivés", kinds: ["LEVERAGE_LONG", "LEVERAGE_SHORT", "LIQUIDATIONS_LONG", "LIQUIDATIONS_SHORT", "FUNDING_EXTREME_LONG", "FUNDING_EXTREME_SHORT", "OPEN_INTEREST_SURGE"] },
  { label: "Nouveautés et attention", kinds: ["NEW_LISTING", "SOCIAL_BUZZ", "NEWS_BULLISH", "NEWS_BEARISH"] },
  { label: "DEX (très risqué)", kinds: ["DEX_NEW_POOL_TRACTION", "DEX_TRENDING_PUMP", "DEX_RUG_RISK"] },
  { label: "Setups de trader (plan complet)", kinds: ["SETUP_LONG", "SETUP_SHORT"] },
  { label: "Plusieurs sources d'accord", kinds: ["CONFLUENCE"] },
];

interface BotBinance {
  host: string | null;
  okAt: number | null;
  lastError: string | null;
  pausedUntil: number | null;
}

const csv = (xs: string[]) => xs.join(", ");
const parseCoins = (t: string) => [...new Set(t.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];

export default function DiscordPage() {
  const { notify } = useDialogs();
  const [d, setD] = useState<PrefsResponse | null>(null);
  const [p, setP] = useState<Prefs | null>(null);
  const [inc, setInc] = useState("");
  const [exc, setExc] = useState("");
  const [linc, setLinc] = useState("");
  const [lexc, setLexc] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tests, setTests] = useState<{ results: { channel: string; ok: boolean; message: string }[]; missing: string[] } | null>(null);
  const [sent, setSent] = useState<{ s: Sent24h | null; filtered: number | null; sources: Record<string, string>; errors: string[]; binance: BotBinance | null } | null>(null);

  const load = () =>
    getJson<PrefsResponse>("/api/web/prefs").then(
      (r) => {
        setD(r);
        setP(r.prefs);
        setInc(csv(r.prefs.includeCoins));
        setExc(csv(r.prefs.excludeCoins));
        setLinc(csv(r.prefs.leverage?.includeCoins ?? []));
        setLexc(csv(r.prefs.leverage?.excludeCoins ?? []));
        setErr(null);
      },
      (e: Error) => setErr(e.message),
    );
  useEffect(() => {
    void load();
    const loadSent = () =>
      getJson<SourcesResponse>("/api/intel/sources").then(
        (r) => {
          const st = r.discordWorker?.status as { sent24h?: Sent24h; filteredByPrefs?: number; sources?: Record<string, string>; errors?: string[]; binance?: BotBinance } | undefined;
          setSent({ s: st?.sent24h ?? null, filtered: st?.filteredByPrefs ?? null, sources: st?.sources ?? {}, errors: st?.errors ?? [], binance: st?.binance ?? null });
        },
        () => {},
      );
    void loadSent();
    const t = setInterval(loadSent, 30_000);
    return () => clearInterval(t);
  }, []);

  const testAll = async () => {
    setTesting(true);
    try {
      setTests(await postAction("/api/web/test-channels", {}));
    } catch (e) {
      notify(`Test impossible : ${(e as Error).message}`, "error");
    } finally {
      setTesting(false);
    }
  };

  if (err || !p || !d)
    return (
      <Card title="Réglages Discord">
        <p className="text-sm text-slate-300">{err ? `Réglages indisponibles : ${err}` : "Chargement…"}</p>
        <p className="mt-2 text-sm text-slate-400">
          Ce panneau règle le <strong>bot Discord 24 h/24</strong>. Il fonctionne sur ton site en ligne (Cloudflare) une fois la variable <code>DISCORD_WORKER_URL</code> ajoutée au projet Pages. Il n&apos;est pas disponible dans la démo.
        </p>
      </Card>
    );

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const allKinds = p.kinds.length === 0;
  const allSources = p.sources.length === 0;
  const lv: LeveragePrefs = { ...LEV_DEFAULT, ...(p.leverage ?? {}) };
  const setLv = (patch: Partial<LeveragePrefs>) => setP({ ...p, leverage: { ...lv, ...patch } });

  const save = async () => {
    setBusy(true);
    try {
      await postAction("/api/web/prefs", { ...p, includeCoins: parseCoins(inc), excludeCoins: parseCoins(exc), leverage: { ...lv, includeCoins: parseCoins(linc), excludeCoins: parseCoins(lexc) } });
      notify("Réglages enregistrés : le bot les applique dès maintenant.", "info");
      await load();
    } catch (e) {
      notify(`Refusé : ${(e as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {!d.keySet && (
        <div className="rounded border border-amber-600/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Pour enregistrer, entre d&apos;abord ton <strong>code de relais</strong> (le secret <code>RELAY_KEY</code> du bot) : page <a href="#sources" className="underline">Sources</a> → carte Discord.
        </div>
      )}
      <Card title="Ce que le bot envoie sur Discord">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} />
          <span className="font-semibold">Envoyer les alertes</span>
          <span className="text-slate-500">(décoche pour mettre le bot en pause sans rien supprimer)</span>
        </label>

        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          <div>
            <div className="text-xs font-semibold uppercase text-slate-400">Force minimale</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <input type="range" min={0} max={100} step={5} value={p.minStrength} onChange={(e) => setP({ ...p, minStrength: Number(e.target.value) })} className="w-full max-w-64 min-w-0 flex-1 sm:w-64 sm:flex-none" />
              <span className="num w-14 text-lg font-bold">{p.minStrength}</span>
              <span className="text-xs text-slate-500">{p.minStrength === 0 ? "tout est envoyé" : "les signaux plus faibles restent sur le site"}</span>
            </div>
            <div className="mt-4 text-xs font-semibold uppercase text-slate-400">Fiabilité mesurée minimale (1 h)</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <input type="range" min={0} max={80} step={5} value={p.minHitRate ?? 0} onChange={(e) => setP({ ...p, minHitRate: Number(e.target.value) || null })} className="w-full max-w-64 min-w-0 flex-1 sm:w-64 sm:flex-none" />
              <span className="num w-14 text-lg font-bold">{p.minHitRate ? `${p.minHitRate} %` : "off"}</span>
            </div>
            <p className="text-[11px] text-slate-500">Écarte les types de signaux dont la réussite mesurée (par rapport au Bitcoin) est trop faible. Les types pas encore mesurés passent toujours.</p>

            <div className="mt-4 text-xs font-semibold uppercase text-slate-400">Sens</div>
            <div className="mt-1 flex flex-wrap gap-3 text-sm">
              {(
                [
                  ["bullish", "🟢 Haussier"],
                  ["bearish", "🔴 Baissier"],
                  ["neutral", "⚪ Neutre"],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={p.directions.includes(k)} onChange={() => setP({ ...p, directions: toggle(p.directions, k) as Prefs["directions"] })} />
                  {l}
                </label>
              ))}
            </div>

            <div className="mt-4 text-xs font-semibold uppercase text-slate-400">Sources</div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs">
              <button onClick={() => setP({ ...p, sources: [] })} className={`rounded border px-2 py-1 ${allSources ? "border-sky-500 text-sky-200" : "border-slate-700 text-slate-400"}`}>
                Toutes
              </button>
              {d.sources.map((s) => (
                <button key={s} onClick={() => setP({ ...p, sources: toggle(p.sources, s) })} className={`rounded border px-2 py-1 ${p.sources.includes(s) ? "border-sky-500 bg-sky-900/40 text-sky-100" : "border-slate-700 text-slate-400"}`}>
                  {SOURCE_LABEL[s] ?? s}
                </button>
              ))}
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs">
                <div className="font-semibold uppercase text-slate-400">Uniquement ces cryptos</div>
                <input value={inc} onChange={(e) => setInc(e.target.value)} placeholder="vide = toutes (ex. BTC, SOL, PEPE)" className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs">
                <div className="font-semibold uppercase text-slate-400">Jamais ces cryptos</div>
                <input value={exc} onChange={(e) => setExc(e.target.value)} placeholder="ex. DOGE, SHIB" className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm" />
              </label>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase text-slate-400">
              Types de signaux
              <button onClick={() => setP({ ...p, kinds: [] })} className={`rounded border px-2 py-0.5 normal-case ${allKinds ? "border-sky-500 text-sky-200" : "border-slate-700 text-slate-400"}`}>
                Tous
              </button>
            </div>
            <div className="mt-2 space-y-3">
              {GROUPS.map((g) => (
                <div key={g.label}>
                  <div className="text-[11px] text-slate-500">{g.label}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {g.kinds.map((k) => (
                      <button key={k} onClick={() => setP({ ...p, kinds: toggle(p.kinds, k) })} className={`rounded border px-2 py-1 text-xs ${p.kinds.includes(k) ? "border-sky-500 bg-sky-900/40 text-sky-100" : allKinds ? "border-slate-700 text-slate-300" : "border-slate-800 text-slate-500"}`}>
                        {KIND_LABEL[k]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">« Tous » = aucun filtre. Clique sur des types pour n&apos;envoyer que ceux-là.</p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button onClick={() => void save()} disabled={busy} className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40">
            {busy ? "Enregistrement…" : "Enregistrer"}
          </button>
          {p.updatedAt && <span className="text-xs text-slate-500">dernière modification : {new Date(p.updatedAt).toLocaleString("fr-FR")}</span>}
        </div>
      </Card>

      <Card title="⚖️ Ce que le bot envoie sur le levier">
        <p className="text-xs text-amber-300/90">Lecture du positionnement des marchés à levier (financement, intérêt ouvert, ratio long/short, liquidations). Ce n&apos;est pas un conseil : le levier peut liquider toute la mise.</p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={lv.enabled} onChange={(e) => setLv({ enabled: e.target.checked })} />
          <span className="font-semibold">Envoyer les indications LONG / SHORT</span>
        </label>
        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          <div className={lv.enabled ? "" : "opacity-50"}>
            <div className="text-xs font-semibold uppercase text-slate-400">Score minimal (|score| sur 100)</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <input type="range" min={5} max={100} step={5} value={lv.minScore} onChange={(e) => setLv({ minScore: Number(e.target.value) })} className="w-full max-w-64 min-w-0 flex-1 sm:w-64 sm:flex-none" />
              <span className="num w-14 text-lg font-bold">{lv.minScore}</span>
              <span className="text-xs text-slate-500">{lv.minScore <= 25 ? "comme la page Levier" : "seulement les lectures marquées"}</span>
            </div>
            <div className="mt-4 text-xs font-semibold uppercase text-slate-400">Sens</div>
            <div className="mt-1 flex gap-4 text-sm">
              {(["LONG", "SHORT"] as const).map((b) => (
                <label key={b} className="flex items-center gap-1.5">
                  <input type="checkbox" checked={lv.biases.includes(b)} onChange={() => setLv({ biases: toggle(lv.biases, b) as LeveragePrefs["biases"] })} />
                  {b === "LONG" ? "🟢 LONG" : "🔴 SHORT"}
                </label>
              ))}
            </div>
            <div className="mt-4 text-xs font-semibold uppercase text-slate-400">Levier maximal proposé au moins</div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <input type="range" min={0} max={100} step={5} value={lv.minMaxLeverage} onChange={(e) => setLv({ minMaxLeverage: Number(e.target.value) })} className="w-full max-w-64 min-w-0 flex-1 sm:w-64 sm:flex-none" />
              <span className="num w-14 text-lg font-bold">{lv.minMaxLeverage ? `×${lv.minMaxLeverage}` : "tous"}</span>
            </div>
            <div className="mt-4 text-xs font-semibold uppercase text-slate-400">Plateformes</div>
            <div className="mt-1 flex flex-wrap gap-2 text-xs">
              <button onClick={() => setLv({ venues: [] })} className={`rounded border px-2 py-1 ${lv.venues.length === 0 ? "border-sky-500 text-sky-200" : "border-slate-700 text-slate-400"}`}>
                Toutes
              </button>
              {VENUES.map((v) => (
                <button key={v} onClick={() => setLv({ venues: toggle(lv.venues, v) })} className={`rounded border px-2 py-1 ${lv.venues.includes(v) ? "border-sky-500 bg-sky-900/40 text-sky-100" : "border-slate-700 text-slate-400"}`}>
                  {v}
                </button>
              ))}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs">
                <div className="font-semibold uppercase text-slate-400">Uniquement ces cryptos</div>
                <input value={linc} onChange={(e) => setLinc(e.target.value)} placeholder="vide = toutes (ex. BTC, ETH, SOL)" className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm" />
              </label>
              <label className="text-xs">
                <div className="font-semibold uppercase text-slate-400">Jamais ces cryptos</div>
                <input value={lexc} onChange={(e) => setLexc(e.target.value)} placeholder="ex. PEPE" className="mt-1 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm" />
              </label>
            </div>
          </div>
          <div>
            <div className={lv.enabled ? "" : "opacity-50"}>
              <div className="text-xs font-semibold uppercase text-slate-400">Renvoyer quand le score se renforce de</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <input type="range" min={0} max={50} step={5} value={lv.strengthenStep} onChange={(e) => setLv({ strengthenStep: Number(e.target.value) })} className="w-full max-w-64 min-w-0 flex-1 sm:w-64 sm:flex-none" />
                <span className="num w-20 text-lg font-bold">{lv.strengthenStep ? `+${lv.strengthenStep} pts` : "jamais"}</span>
              </div>
              <div className="mt-4 text-xs font-semibold uppercase text-slate-400">Rappel si la lecture ne change pas</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <input type="range" min={0} max={24} step={1} value={lv.remindHours} onChange={(e) => setLv({ remindHours: Number(e.target.value) })} className="w-full max-w-64 min-w-0 flex-1 sm:w-64 sm:flex-none" />
                <span className="num w-20 text-lg font-bold">{lv.remindHours ? `${lv.remindHours} h` : "jamais"}</span>
              </div>
            </div>
            <label className="mt-5 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={lv.liquidations} onChange={(e) => setLv({ liquidations: e.target.checked })} />
              <span className="font-semibold">Envoyer les vagues de liquidations</span>
            </label>
            <div className={`mt-2 ${lv.liquidations ? "" : "opacity-50"}`}>
              <div className="text-xs font-semibold uppercase text-slate-400">Montant liquidé minimal en 5 min</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <input type="range" min={0} max={LIQ_STEPS.length - 1} step={1} value={Math.max(0, LIQ_STEPS.findIndex((x) => x >= lv.minLiquidationUsd))} onChange={(e) => setLv({ minLiquidationUsd: LIQ_STEPS[Number(e.target.value)] })} className="w-full max-w-64 min-w-0 flex-1 sm:w-64 sm:flex-none" />
                <span className="num w-20 text-lg font-bold">{lv.minLiquidationUsd ? usd(lv.minLiquidationUsd) : "tout"}</span>
              </div>
            </div>
            <p className="mt-4 text-[11px] text-slate-500">Ces réglages ne touchent que le salon levier. Les autres signaux suivent le panneau du dessus. « Enregistrer » sauve les deux panneaux.</p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button onClick={() => void save()} disabled={busy} className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40">
            {busy ? "Enregistrement…" : "Enregistrer"}
          </button>
          <button onClick={() => { setLv({ ...LEV_DEFAULT }); setLinc(""); setLexc(""); }} className="rounded border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500">
            Valeurs par défaut
          </button>
        </div>
      </Card>

      <Card title="Vérifier les salons">
        <p className="text-sm text-slate-400">Envoie un message de test dans chaque salon configuré : si un salon ne reçoit rien, son webhook est faux ou manquant.</p>
        <button onClick={() => void testAll()} disabled={testing} className="mt-2 rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40">
          {testing ? "Envoi des tests…" : "🧪 Tester tous les salons"}
        </button>
        {tests && (
          <ul className="mt-3 space-y-1 text-sm">
            {tests.results.map((r) => (
              <li key={r.channel} className={r.ok ? "text-emerald-400" : "text-rose-400"}>
                {r.ok ? "✅" : "❌"} Salon {r.channel} : {r.message}
              </li>
            ))}
            {tests.missing.map((m) => (
              <li key={m} className="text-amber-300">
                ⚠️ non configuré : {m}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Envoyés par le bot (24 h)">
        {!sent?.s ? (
          <p className="text-sm text-slate-500">Pas encore de données (le bot les publie à chaque analyse).</p>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-4">
              {Object.entries(sent.s.byChannel).map(([k, v]) => (
                <span key={k}>
                  Salon <strong>{k}</strong> : <span className="num">{v}</span>
                </span>
              ))}
              {!Object.keys(sent.s.byChannel).length && <span className="text-slate-500">aucun envoi sur 24 h</span>}
            </div>
            <div className="flex flex-wrap gap-4 text-xs text-slate-400">
              <span>🟢 haussiers {sent.s.byDirection.bullish ?? 0}</span>
              <span>🔴 baissiers {sent.s.byDirection.bearish ?? 0}</span>
              <span>⚪ neutres {sent.s.byDirection.neutral ?? 0}</span>
              <span>⚖️ levier {(sent.s.byKind.LEVERAGE_LONG ?? 0) + (sent.s.byKind.LEVERAGE_SHORT ?? 0) + (sent.s.byKind.LIQUIDATIONS_LONG ?? 0) + (sent.s.byKind.LIQUIDATIONS_SHORT ?? 0)}</span>
              {sent.filtered !== null && <span>écartés par tes réglages : {sent.filtered}</span>}
            </div>
            {sent.s.bySource && Object.keys(sent.s.bySource).length > 0 && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                <span className="text-slate-500">par source :</span>
                {Object.entries(sent.s.bySource)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <span key={k}>
                      {SOURCE_LABEL[k as keyof typeof SOURCE_LABEL] ?? k} <span className="num text-slate-200">{v}</span>
                    </span>
                  ))}
              </div>
            )}
            {sent.s.last.length > 0 && (
              <ul className="text-xs text-slate-400">
                {sent.s.last.map((x, i) => (
                  <li key={i}>
                    il y a {fmtAgo(x.ts)} · {x.coin} · {KIND_LABEL[x.kind as keyof typeof KIND_LABEL] ?? x.kind} → salon {x.channel}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card title="Ce que le bot lit en ce moment">
        {!sent ? (
          <p className="text-sm text-slate-500">Chargement…</p>
        ) : (
          <div className="space-y-2 text-sm">
            {sent.binance && (
              <p className={sent.binance.okAt && !sent.binance.pausedUntil ? "text-emerald-300" : "text-amber-300"}>
                {sent.binance.okAt && !sent.binance.pausedUntil
                  ? `✅ Binance lu par le bot via ${sent.binance.host?.replace("https://", "")} (il y a ${fmtAgo(sent.binance.okAt)})`
                  : `⚠️ Binance refuse le bot : ${sent.binance.lastError ?? "sans réponse"}. Le bot essaie les 8 accès Binance à tour de rôle. En attendant, les signaux Binance partent sur Discord quand ce site est ouvert (relais), et Coinbase / OKX / KuCoin / MEXC couvrent le reste.`}
              </p>
            )}
            <ul className="space-y-0.5 text-xs text-slate-400">
              {Object.entries(sent.sources).map(([k, v]) => (
                <li key={k}>
                  <span className="font-semibold text-slate-300">{SOURCE_LABEL[k as keyof typeof SOURCE_LABEL] ?? k}</span> : {v}
                </li>
              ))}
            </ul>
            {sent.errors.length > 0 && (
              <ul className="space-y-0.5 text-xs text-rose-300/90">
                {sent.errors.slice(0, 8).map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card title="Salons Discord">
        <ul className="space-y-1 text-sm">
          {d.channels.map((c) => (
            <li key={c.id} className="flex flex-wrap gap-2">
              <span className={c.active ? "text-emerald-400" : "text-amber-300"}>{c.active ? "●" : "○"}</span>
              <span className="font-semibold">Salon {c.label}</span>
              <span className="text-slate-500">{c.id === "leverage" ? "levier, liquidations" : c.directions.join(" + ")}</span>
            </li>
          ))}
          {!d.channels.length && <li className="text-slate-500">Aucun webhook configuré sur le bot.</li>}
        </ul>
        <p className="mt-2 text-[11px] text-slate-500">
          Les salons se règlent dans Cloudflare (worker <code>crypto-radar-discord</code> → Variables and Secrets) : <code>DISCORD_WEBHOOK_BULLISH</code>, <code>DISCORD_WEBHOOK_BEARISH</code>, <code>DISCORD_WEBHOOK_URL</code> (neutres), <code>DISCORD_WEBHOOK_LEVERAGE</code> (levier).
        </p>
      </Card>
    </div>
  );
}
