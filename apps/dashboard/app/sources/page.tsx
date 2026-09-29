"use client";

import type { IntelConfig } from "@radar/core";
import { useEffect, useState } from "react";
import { useDialogs } from "@/components/Dialogs";
import { SourceBadge } from "@/components/Intel";
import { Card, Stat } from "@/components/ui";
import { getJson, postAction } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import { fmtAgo, type SourcesResponse } from "@/lib/intel";

const STATE: Record<string, { label: string; cls: string }> = {
  ok: { label: "OK", cls: "text-emerald-400" },
  waiting: { label: "démarrage", cls: "text-sky-300" },
  degraded: { label: "dégradée", cls: "text-amber-300" },
  down: { label: "hors service", cls: "text-rose-400" },
  disabled: { label: "désactivée", cls: "text-slate-500" },
};

export default function SourcesPage() {
  const { notify } = useDialogs();
  const [d, setD] = useState<SourcesResponse | null>(null);
  const [cfg, setCfg] = useState<IntelConfig | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const load = () => getJson<SourcesResponse>("/api/intel/sources").then(setD, () => {});
    void load();
    getJson<IntelConfig>("/api/intel/config").then(setCfg, () => {});
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const test = async () => {
    setBusy(true);
    try {
      const r = await postAction<{ ok: boolean; message: string }>("/api/intel/discord/test", {});
      notify(r.message, "info");
    } catch (e) {
      notify(`Échec : ${(e as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!d) return <Card><span className="text-slate-400">Chargement…</span></Card>;
  const now = Date.now();
  const cg = d.coingecko;
  const dc = d.discord;
  return (
    <div className="space-y-4">
      {d.simulated && (
        <div className="rounded border border-amber-600/50 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <strong>DÉMO :</strong> sources simulées dans le navigateur. En local, ces lignes montrent l&apos;état réel de Binance, CoinGecko, GeckoTerminal, des flux RSS et de Discord.
        </div>
      )}
      <Card title="Sources d'information">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr>
                <th className="py-1">Source</th>
                <th>État</th>
                <th className="pr-4 text-right">Éléments</th>
                <th>Dernier succès</th>
                <th>Détail</th>
              </tr>
            </thead>
            <tbody>
              {d.sources.map((s) => (
                <tr key={s.source} className="border-t border-slate-800">
                  <td className="py-1.5">{s.source === "discord" ? <span className="text-[10px] font-bold text-indigo-300">DISCORD</span> : <SourceBadge source={s.source} />}</td>
                  <td className={STATE[s.state]?.cls}>{STATE[s.state]?.label ?? s.state}</td>
                  <td className="num pr-4 text-right">{s.items || "—"}</td>
                  <td className="text-xs text-slate-400">{s.lastSuccessAt ? `il y a ${fmtAgo(s.lastSuccessAt, now)}` : "—"}</td>
                  <td className="text-xs text-slate-400">
                    <div>{s.note}</div>
                    {s.lastError && <div className="text-amber-300">{s.lastError}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Discord" className="min-w-0">
          {!dc ? (
            <p className="text-sm text-slate-500">{d.simulated ? "Démo : pas d'envoi Discord (possible uniquement avec le serveur local et ton webhook)." : d.web ? "Site web : pas d'alertes Discord (elles demandent un programme qui tourne 24 h/24, l'analyse s'arrête quand la page est fermée)." : "Non disponible."}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Stat label="Webhook" value={dc.configured ? "configuré" : "absent"} tone={dc.configured ? "good" : "warn"} />
                <Stat label="Envoyés (1 h)" value={`${dc.sentLastHour}/${dc.maxPerHour}`} />
                <Stat label="Seuil d'alerte" value={`force ≥ ${dc.minStrength}`} hint="en dessous : résumé groupé" />
                <Stat label="En file" value={dc.queued} />
                <Stat label="Pour le résumé" value={dc.digestPending} hint={dc.nextDigestAt ? `prochain ${new Date(dc.nextDigestAt).toLocaleTimeString("fr-FR")}` : "résumé désactivé"} />
                <Stat label="Dernier envoi" value={dc.lastSentAt ? fmtAgo(dc.lastSentAt, now) : "—"} />
              </div>
              {dc.lastError && <p className="mt-3 text-sm text-amber-300">{dc.lastError}</p>}
              {!dc.configured && (
                <p className="mt-3 text-sm text-slate-400">
                  Pour recevoir les alertes : dans Discord, <em>Paramètres du salon → Intégrations → Webhooks → Nouveau webhook → Copier l&apos;URL</em>, puis dans le fichier <code>.env</code> :{" "}
                  <code className="text-slate-200">DISCORD_WEBHOOK_URL=…</code> et redémarre le serveur. L&apos;URL est secrète : ne la partage pas.
                </p>
              )}
              <button onClick={test} disabled={busy || !dc.configured} className="mt-3 rounded bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40">
                {busy ? "Envoi…" : "Envoyer un message de test"}
              </button>
            </>
          )}
        </Card>

        <Card title="Budget CoinGecko" className="min-w-0">
          {!cg ? (
            <p className="text-sm text-slate-500">{d.simulated ? "Démo : CoinGecko simulé, pas de quota." : d.web ? "Site web : CoinGecko passe par le cache partagé Cloudflare (rafraîchi toutes les 30 à 60 min), ce qui préserve le quota quel que soit le nombre de visiteurs." : "CoinGecko désactivé."}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Stat label="Plan" value={cg.plan} hint={cg.keyConfigured ? "clé configurée" : "sans clé"} tone={cg.keyConfigured ? "good" : "warn"} />
                <Stat label={`Appels ${cg.budget.month}`} value={`${cg.budget.used} / ${cg.budget.monthly}`} hint={`reste ${cg.budget.remaining}`} />
                <Stat label="Rythme autorisé" value={`${cg.budget.allowedPerHour}/h`} hint="pour tenir jusqu'à la fin du mois" />
                <Stat label="Dernière minute" value={`${cg.budget.lastMinute}/${cg.budget.perMinute}`} />
                <Stat label="Ralentissement" value={Number.isFinite(cg.stretch) ? `×${cg.stretch.toFixed(1)}` : "arrêt"} hint="× intervalles de base" tone={cg.stretch > 3 ? "warn" : "default"} />
              </div>
              <table className="num mt-3 w-full text-xs">
                <thead className="text-left text-slate-500">
                  <tr>
                    <th className="py-1">Tâche</th>
                    <th className="text-right">Toutes les</th>
                    <th className="text-right">Dernière</th>
                    <th className="text-right">Prochaine</th>
                  </tr>
                </thead>
                <tbody>
                  {cg.schedule.map((t) => (
                    <tr key={t.id} className="border-t border-slate-800">
                      <td className="py-1">{t.id}</td>
                      <td className="text-right">{t.everyMin === null ? "—" : `${t.everyMin} min`}</td>
                      <td className="text-right text-slate-400">{t.lastRunAt ? fmtAgo(t.lastRunAt, now) : "jamais"}</td>
                      <td className="text-right text-slate-400">{t.nextAt ? (t.nextAt <= now ? "dès que possible" : `dans ${fmtAgo(now - (t.nextAt - now), now)}`) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-slate-500">
                Le plan Demo gratuit donne 10 000 appels/mois : les intervalles s&apos;allongent automatiquement pour ne jamais dépasser. Binance fournit le temps réel en parallèle, sans quota.
              </p>
            </>
          )}
        </Card>
      </div>

      {d.binanceFeed && (
        <Card title="Binance temps réel">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Stat label="Connexion" value={d.binanceFeed.connected ? "ouverte" : "fermée"} tone={d.binanceFeed.connected ? "good" : "bad"} />
            <Stat label="Cryptos suivies" value={d.binanceFeed.pairs} />
            <Stat label="Messages reçus" value={d.binanceFeed.messages} />
            <Stat label="Erreurs de décodage" value={d.binanceFeed.decodeErrors} tone={d.binanceFeed.decodeErrors ? "warn" : "default"} />
            <Stat label="Dernier message" value={d.binanceFeed.lastMessageAt ? fmtAgo(d.binanceFeed.lastMessageAt, now) : "—"} />
          </div>
        </Card>
      )}

      {!!d.newsFeeds?.length && (
        <Card title="Flux d'actualités (RSS)">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1">Média</th>
                  <th>Langue</th>
                  <th>État</th>
                  <th className="pr-4 text-right">Articles</th>
                  <th>Dernière lecture</th>
                  <th>Erreur</th>
                </tr>
              </thead>
              <tbody>
                {d.newsFeeds.map((f) => (
                  <tr key={f.url} className="border-t border-slate-800">
                    <td className="py-1" title={f.url}>
                      {f.name}
                    </td>
                    <td>{f.lang.toUpperCase()}</td>
                    <td className={f.ok === null ? "text-sky-300" : f.ok ? "text-emerald-400" : "text-amber-300"}>{f.ok === null ? "en attente" : f.ok ? "OK" : "erreur"}</td>
                    <td className="num pr-4 text-right">{f.items || "—"}</td>
                    <td className="text-slate-400">{f.lastSuccessAt ? fmtDateTime(f.lastSuccessAt) : "—"}</td>
                    <td className="text-amber-300">{f.lastError ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">Les adresses des flux sont modifiables dans config/intel.json (clé news.feeds).</p>
        </Card>
      )}

      {cfg && (
        <Card title="Seuils de détection (config/intel.json)">
          <div className="grid gap-x-8 gap-y-1 text-xs text-slate-300 sm:grid-cols-2 lg:grid-cols-3">
            <Row k="Décollage 5 min / 15 min" v={`+${cfg.binance.pumpPct5m} % / +${cfg.binance.pumpPct15m} %`} />
            <Row k="Chute 5 min / 15 min" v={`−${cfg.binance.dumpPct5m} % / −${cfg.binance.dumpPct15m} %`} />
            <Row k="Volume anormal" v={`${cfg.binance.volumeSurgeRatio}x la moyenne horaire`} />
            <Row k="Volume 24 h minimum" v={`$${cfg.binance.minVolume24hUsd.toLocaleString("en-US")}`} />
            <Row k="Top hausse / krach 1 h" v={`+${cfg.coingecko.moverPct1h} % / −${cfg.coingecko.crashPct1h} %`} />
            <Row k="Univers CoinGecko" v={`${cfg.coingecko.universeSize} plus grosses capitalisations`} />
            <Row k="Volume / capitalisation" v={`≥ ${cfg.coingecko.volumeMcapRatio}`} />
            <Row k="Funding extrême" v={`± ${cfg.coingecko.fundingExtremePct} %`} />
            <Row k="Hausse open interest" v={`+${cfg.coingecko.openInterestSurgePct} %`} />
            <Row k="DEX : liquidité min." v={`$${cfg.coingecko.dex.minReserveUsd.toLocaleString("en-US")}`} />
            <Row k="Confluence" v={`${cfg.confluence.minSources} types d'indices en ${cfg.confluence.windowMin} min`} />
            <Row k="Anti-doublon" v={`${cfg.cooldownMin} min par crypto × type`} />
          </div>
        </Card>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-slate-800/60 py-1">
      <span className="text-slate-500">{k}</span>
      <span className="num text-right">{v}</span>
    </div>
  );
}
