"use client";

import type { Direction, IntelKind, IntelSource, NewsItem } from "@radar/core";
import { useEffect, useMemo, useState } from "react";
import { CoinLink, NewsList, SignalCard, SourceBadge } from "@/components/Intel";
import { Card, Stat } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtPct } from "@/lib/format";
import { ALL_SOURCES, KIND_LABEL, SOURCE_LABEL, fmtAgo, type FeedResponse, type FeedSignal, type SourcesResponse, type UniverseResponse } from "@/lib/intel";
import { useRadarStream } from "@/lib/stream";

type DirFilter = "all" | Direction;

export default function FluxPage() {
  const { intel, state } = useRadarStream();
  const [base, setBase] = useState<FeedResponse | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [sources, setSources] = useState<SourcesResponse | null>(null);
  const [movers, setMovers] = useState<{ up: UniverseResponse | null; down: UniverseResponse | null }>({ up: null, down: null });
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState<DirFilter>("all");
  const [minStrength, setMinStrength] = useState(0);
  const [srcOff, setSrcOff] = useState<Set<IntelSource>>(new Set());
  const [kind, setKind] = useState<"" | IntelKind>("");
  const [coin, setCoin] = useState("");
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<FeedSignal[] | null>(null);
  const [shown, setShown] = useState(300);
  /** "discord": exactly what Discord received · "all": everything detected, sent or not. */
  const [view, setView] = useState<"discord" | "all">("discord");

  useEffect(() => {
    const load = () => {
      getJson<FeedResponse>("/api/intel/feed?limit=3000").then(
        (r) => {
          setBase(r);
          setError(null);
        },
        (e: Error) => setError(e.message),
      );
      getJson<NewsItem[]>("/api/intel/news?limit=150").then(setNews, () => {});
      getJson<SourcesResponse>("/api/intel/sources").then(setSources, () => {});
      getJson<UniverseResponse>("/api/intel/universe?sort=change1h&dir=desc&limit=8").then((up) => setMovers((m) => ({ ...m, up })), () => {});
      getJson<UniverseResponse>("/api/intel/universe?sort=change1h&dir=asc&limit=8").then((down) => setMovers((m) => ({ ...m, down })), () => {});
    };
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  // Merge the live stream (newest first) with the last full load, de-duplicated.
  const all = useMemo(() => {
    const seen = new Set<string>();
    const out: FeedSignal[] = [];
    // The periodic reload carries the latest Discord status of each signal: it wins over the live copy.
    const mark = new Map((base?.signals ?? []).map((s) => [s.id, s.discord]));
    for (const s of [...intel.signals, ...(base?.signals ?? [])]) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      out.push(mark.get(s.id) !== undefined ? { ...s, discord: mark.get(s.id) } : s);
    }
    return out.sort((a, b) => b.ts - a.ts);
  }, [intel.rev, base]); // eslint-disable-line react-hooks/exhaustive-deps

  const allNews = useMemo(() => {
    const seen = new Set<string>();
    return [...intel.news, ...news].filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true))).sort((a, b) => b.ts - a.ts);
  }, [intel.rev, news]); // eslint-disable-line react-hooks/exhaustive-deps

  // On the live site every signal has a Discord status; the local server has none (then: everything).
  const hasMarks = all.some((s) => s.discord !== undefined && s.discord !== null);
  const discordOnly = hasMarks && view === "discord";
  const source = paused && frozen ? frozen : all;
  const list = discordOnly ? source.filter((s) => s.discord === "sent") : source;
  const q = coin.trim().toUpperCase();
  const filtered = list.filter(
    (s) => (dir === "all" || s.direction === dir) && s.strength >= minStrength && !srcOff.has(s.source) && (!kind || s.kind === kind) && (!q || s.coin.includes(q)),
  );
  const confluences = all.filter((s) => s.kind === "CONFLUENCE").slice(0, 8);
  const hourAgo = Date.now() - 3_600_000;
  const lastHour = all.filter((s) => s.ts >= hourAgo);
  const shownLastHour = (discordOnly ? all.filter((s) => s.discord === "sent") : all).filter((s) => s.ts >= hourAgo);
  const okSources = sources?.sources.filter((s) => s.enabled && s.state === "ok").length ?? 0;
  const enabledSources = sources?.sources.filter((s) => s.enabled).length ?? 0;
  const kindsPresent = [...new Set(all.map((s) => s.kind))].sort();
  // Discord follow-up over the last hour (web site only: the local server has no marks).
  const marked = lastHour.filter((s) => s.discord);
  const dc = (m: string) => marked.filter((s) => s.discord === m).length;

  if (error && !base)
    return (
      <Card>
        <p className="text-slate-300">Flux d&apos;informations indisponible : {error}</p>
        <p className="mt-1 text-sm text-slate-500">
          Vérifie que le serveur tourne (<code>pnpm dev:server</code>) et que <code>INTEL_ENABLED</code> n&apos;est pas à <code>false</code>.
        </p>
      </Card>
    );

  return (
    <div className="space-y-4">
      {sources?.simulated && (
        <div className="rounded border border-amber-600/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <strong>DÉMO — SOURCES SIMULÉES.</strong> Les cryptos, prix, signaux et titres d&apos;actualité ci-dessous sont générés dans ton navigateur pour montrer le fonctionnement. Rien n&apos;est réel. En local, le serveur
          se branche sur Binance, CoinGecko, GeckoTerminal et les flux RSS.
        </div>
      )}
      {base?.market && base.market.regime !== "inconnu" && (
        <div
          className={`rounded border px-3 py-2 text-xs ${base.market.regime === "baisse" ? "border-rose-700/60 bg-rose-950/40 text-rose-100" : base.market.regime === "hausse" ? "border-emerald-700/60 bg-emerald-950/40 text-emerald-100" : "border-slate-700 bg-slate-900/60 text-slate-300"}`}
        >
          <strong>Contexte :</strong> {base.market.note}
          {base.market.regime !== "calme" && " — les signaux qui vont contre le marché sont affaiblis, ceux qui vont dans son sens renforcés."}
        </div>
      )}
      {marked.length > 0 && (
        <div className={`rounded border px-3 py-2 text-xs ${dc("nokey") || dc("filtered") || dc("nochannel") ? "border-amber-600/50 bg-amber-500/10 text-amber-100" : "border-slate-800 bg-slate-900/60 text-slate-300"}`}>
          <strong>Discord (1 h) :</strong> {dc("sent")} envoyés · {dc("queued")} en route · {dc("dup")} doublons (même événement déjà envoyé)
          {dc("filtered") > 0 && <> · <strong>{dc("filtered")} écartés par tes réglages</strong> (<a href="#discord" className="underline">page Discord</a>, mets la force minimale à 0 et « Tous » pour tout recevoir)</>}
          {dc("nokey") > 0 && <> · <strong>{dc("nokey")} bloqués sur cet appareil</strong> : entre ton code de relais (<a href="#sources" className="underline">page Sources</a>) pour que ce que ce site détecte parte aussi sur Discord</>}
          {dc("nochannel") > 0 && <> · {dc("nochannel")} sans salon (ajoute le webhook manquant)</>}
          {marked.filter((s) => s.discord?.startsWith("refused:")).length > 0 && <> · {marked.filter((s) => s.discord?.startsWith("refused:")).length} refusés</>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Card>
          <Stat label={discordOnly ? "Envoyés sur Discord (1 h)" : "Signaux (1 h)"} value={shownLastHour.length} hint={discordOnly ? `${lastHour.length} détectés en tout` : `${all.length} en mémoire`} />
        </Card>
        <Card>
          <Stat label="Haussiers (1 h)" value={shownLastHour.filter((s) => s.direction === "bullish").length} tone="good" />
        </Card>
        <Card>
          <Stat label="Baissiers (1 h)" value={shownLastHour.filter((s) => s.direction === "bearish").length} tone="bad" />
        </Card>
        <Card>
          <Stat label="Confluences (1 h)" value={shownLastHour.filter((s) => s.kind === "CONFLUENCE").length} tone="warn" hint="≥ 2 types d'indices d'accord" />
        </Card>
        <Card>
          <Stat label="Cryptos suivies" value={base?.counts.universe ?? "—"} hint="toutes sources" />
        </Card>
        <Card>
          <Stat label="Sources OK" value={`${okSources}/${enabledSources}`} tone={okSources === enabledSources && enabledSources > 0 ? "good" : "warn"} hint={state === "open" ? "flux en direct" : "reconnexion…"} />
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-3">
          <Card>
            {hasMarks && (
              <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3 text-sm">
                {(
                  [
                    ["discord", "📨 Comme sur Discord"],
                    ["all", "Tout ce qui est détecté"],
                  ] as const
                ).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setView(k)} className={`rounded px-3 py-1.5 font-semibold ${view === k ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-400 hover:text-slate-200"}`}>
                    {l}
                  </button>
                ))}
                <span className="text-xs text-slate-500">
                  {discordOnly ? "exactement les signaux envoyés sur tes salons Discord (bot 24 h/24 + ce site)" : "y compris les signaux écartés par tes réglages, les doublons et ceux pas encore envoyés"}
                </span>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {(["all", "bullish", "bearish", "neutral"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDir(d)}
                  className={`rounded px-2.5 py-1 font-semibold ${dir === d ? (d === "bullish" ? "bg-emerald-600 text-white" : d === "bearish" ? "bg-rose-600 text-white" : "bg-slate-700 text-white") : "bg-slate-800 text-slate-400 hover:text-slate-200"}`}
                >
                  {{ all: "Tout", bullish: "▲ Va exploser ?", bearish: "▼ Va chuter ?", neutral: "• Neutre" }[d]}
                </button>
              ))}
              <label className="ml-2 flex items-center gap-2 text-slate-400">
                Force ≥ <input type="range" min={0} max={95} step={5} value={minStrength} onChange={(e) => setMinStrength(Number(e.target.value))} />
                <span className="num w-6 text-slate-200">{minStrength}</span>
              </label>
              <select value={kind} onChange={(e) => setKind(e.target.value as IntelKind | "")} className="rounded border border-slate-700 bg-slate-900 px-2 py-1">
                <option value="">Tous les types</option>
                {kindsPresent.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <input value={coin} onChange={(e) => setCoin(e.target.value)} placeholder="Crypto (ex. PEPE)" className="w-32 rounded border border-slate-700 bg-slate-900 px-2 py-1" />
              <button
                onClick={() => {
                  setFrozen(paused ? null : all);
                  setPaused(!paused);
                }}
                className={`ml-auto rounded px-2.5 py-1 font-semibold ${paused ? "bg-amber-500 text-black" : "bg-slate-800 text-slate-300"}`}
                title="Figer la liste pour lire tranquillement"
              >
                {paused ? "▶ Reprendre le direct" : "⏸ Pause"}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {ALL_SOURCES.map((s) => {
                const off = srcOff.has(s);
                const n = all.filter((x) => x.source === s).length;
                return (
                  <button
                    key={s}
                    onClick={() => {
                      const next = new Set(srcOff);
                      if (off) next.delete(s);
                      else next.add(s);
                      setSrcOff(next);
                    }}
                    className={`rounded border px-2 py-0.5 ${off ? "border-slate-800 text-slate-600 line-through" : "border-slate-700 text-slate-300"}`}
                  >
                    {SOURCE_LABEL[s]} <span className="num text-slate-500">{n}</span>
                  </button>
                );
              })}
            </div>
          </Card>
          <div className="space-y-2">
            {filtered.slice(0, shown).map((s) => (
              <SignalCard key={s.id} s={s} />
            ))}
            {!filtered.length && (
              <Card>
                <p className="text-sm text-slate-500">
                  {all.length ? "Aucun signal ne correspond aux filtres." : "Aucun signal pour l'instant : les sources démarrent (Binance en quelques secondes, CoinGecko et les actus en quelques minutes)."}
                </p>
              </Card>
            )}
            {filtered.length > shown && (
              <button type="button" onClick={() => setShown((n) => n + 300)} className="w-full rounded border border-slate-700 bg-slate-900 py-2 text-sm text-slate-300 hover:bg-slate-800">
                Afficher 300 de plus ({shown} sur {filtered.length})
              </button>
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <Card title="Confluences récentes">
            {!confluences.length && <p className="text-sm text-slate-500">Aucune pour l&apos;instant (il faut au moins deux types d'indices indépendants — prix, attention, actualités, dérivés — dans le même sens).</p>}
            <ul className="space-y-1.5">
              {confluences.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-sm">
                  <span className={s.direction === "bullish" ? "text-emerald-400" : "text-rose-400"}>{s.direction === "bullish" ? "▲" : "▼"}</span>
                  <CoinLink symbol={s.coin} />
                  <span className="truncate text-xs text-slate-400">{String(s.metrics.sources ?? "")}</span>
                  <span className="num ml-auto text-xs text-slate-500">{s.strength} · {fmtAgo(s.ts)}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Plus fortes hausses 1 h">
            <MoverList data={movers.up} sign={1} />
          </Card>
          <Card title="Plus fortes baisses 1 h">
            <MoverList data={movers.down} sign={-1} />
          </Card>
          <Card title={`Actualités (${allNews.length})`}>
            <NewsList items={allNews} max={60} />
          </Card>
          {sources && (
            <Card title="État des sources">
              <ul className="space-y-1 text-xs">
                {sources.sources.map((s) => (
                  <li key={s.source} className="flex items-center gap-2">
                    <span className={`h-2 w-2 rounded-full ${!s.enabled ? "bg-slate-700" : s.state === "ok" ? "bg-emerald-400" : s.state === "waiting" ? "bg-sky-400" : "bg-amber-400"}`} />
                    {s.source === "discord" ? <span className="font-bold text-slate-300">DISCORD</span> : <SourceBadge source={s.source} />}
                    <span className="truncate text-slate-500" title={s.lastError ?? s.note ?? ""}>
                      {!s.enabled ? "désactivée" : s.lastError ?? s.note}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function MoverList({ data, sign }: { data: UniverseResponse | null; sign: 1 | -1 }) {
  if (!data) return <p className="text-sm text-slate-500">…</p>;
  // Only real rises in « hausses » and real falls in « baisses ».
  const rows = data.rows.filter((r) => {
    const ch = r.live?.change1h ?? r.change1h;
    return ch !== null && ch * sign > 0;
  });
  if (!rows.length) return <p className="text-sm text-slate-500">{data.rows.length ? (sign > 0 ? "Aucune crypto en hausse sur 1 h." : "Aucune crypto en baisse sur 1 h.") : "Pas encore de données."}</p>;
  return (
    <ul className="num space-y-1 text-sm">
      {rows.map((r) => {
        const ch = r.live?.change1h ?? r.change1h;
        return (
          <li key={r.symbol} className="flex items-center gap-2">
            <CoinLink symbol={r.symbol} />
            <span className="truncate text-xs text-slate-500">{r.name !== r.symbol ? r.name : ""}</span>
            <span className={`ml-auto font-semibold ${ch !== null && ch > 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(ch)}</span>
          </li>
        );
      })}
    </ul>
  );
}
