"use client";

import type { Strategy, StrategyPreview } from "@radar/core";
import { CONDITION_METRICS, StrategySchema, type Condition } from "@radar/core/strategy-schema";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui";
import { getJson, postAction } from "@/lib/api";
import { useDialogs } from "@/components/Dialogs";

interface Limits {
  currency: string;
  maxTradeQuote: number;
  takerFeePct: number;
  mode: "RADAR" | "PAPER";
}

const METRIC_LABEL: Record<Condition["metric"], string> = {
  priceChangePct: "Prix (variation %)",
  volumeRatio: "Volume ratio (x)",
  score: "Score (0–100)",
  spreadPct: "Spread (%)",
  accelerationPct: "Accélération (%)",
  liquidityScore: "Score de liquidité",
};
const WINDOWS = ["10s", "30s", "1m", "5m"] as const;
const OPS = [">", ">=", "<", "<="] as const;

type Draft = Strategy;

function blank(currency: string, maxTrade: number): Draft {
  return StrategySchema.parse({
    id: `strategie-${Math.random().toString(36).slice(2, 7)}`,
    name: "Nouvelle stratégie",
    enabled: false,
    universe: { quoteCurrencies: [currency], excludeBases: [] },
    entry: { conditions: [{ metric: "priceChangePct", window: "1m", op: ">", value: 3 }] },
    sizing: { quoteAmount: Math.min(10, maxTrade) },
    exit: { stopLossPct: 2, trailingStopPct: 2, takeProfitPct: null, maxDurationSec: 3600 },
  });
}

function summary(s: Draft, cur: string): string {
  const cond = s.entry.conditions
    .map((c) => `${METRIC_LABEL[c.metric].split(" (")[0]}${c.window ? ` ${c.window}` : ""} ${c.op} ${c.value}`)
    .join(" ET ");
  const exit = [`stop −${s.exit.stopLossPct} %`, s.exit.trailingStopPct ? `trailing ${s.exit.trailingStopPct} %` : null, s.exit.takeProfitPct ? `take profit +${s.exit.takeProfitPct} %` : null, s.exit.maxDurationSec ? `durée max ${Math.round(s.exit.maxDurationSec / 60)} min` : null]
    .filter(Boolean)
    .join(", ");
  const rot = s.afterExit.rotation.enabled
    ? `, puis ${Object.entries(s.afterExit.rotation.allocations).map(([a, v]) => `${v} % ${a}`).join(" / ")} du ${s.afterExit.rotation.mode === "proceeds" ? "capital récupéré" : "profit"}`
    : "";
  return `SI ${cond} ALORS ouvrir ${s.sizing.quoteAmount} ${cur} max. ; sortie : ${exit}${rot}.`;
}

const input = "rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm outline-none focus:border-sky-500";
const Kw = ({ children }: { children: string }) => <div className="mb-1 mt-4 text-xs font-bold tracking-widest text-sky-300">{children}</div>;

function NumberField({ value, onChange, step = 0.1, min, max, className = "w-24" }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; className?: string }) {
  return <input type="number" className={`${input} ${className}`} value={Number.isFinite(value) ? value : ""} step={step} min={min} max={max} onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))} />;
}

function Editor({ initial, isNew, limits, onSaved, onCancel }: { initial: Draft; isNew: boolean; limits: Limits; onSaved: () => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [preview, setPreview] = useState<StrategyPreview | null>(null);
  const [serverIssues, setServerIssues] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const { confirm } = useDialogs();
  const cur = limits.currency;

  const local = useMemo(() => {
    const r = StrategySchema.safeParse(d);
    const issues = r.success ? [] : r.error.issues.map((i) => `${i.path.join(".") || "stratégie"} : ${i.message}`);
    if (d.sizing.quoteAmount > limits.maxTradeQuote) issues.push(`montant > maximum par trade du Risk Engine (${limits.maxTradeQuote} ${cur})`);
    return issues;
  }, [d, limits, cur]);

  // Live preview on the current market (debounced).
  useEffect(() => {
    if (local.length) return;
    const t = setTimeout(() => {
      postAction<StrategyPreview>("/api/strategies/preview", { strategy: d }).then(setPreview, () => setPreview(null));
    }, 400);
    return () => clearTimeout(t);
  }, [d, local.length]);

  const set = (fn: (x: Draft) => void) =>
    setD((prev) => {
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  const setCond = (i: number, patch: Partial<Condition>) =>
    set((x) => {
      const c = { ...x.entry.conditions[i]!, ...patch };
      if (c.metric !== "priceChangePct") delete c.window;
      else c.window ??= "1m";
      x.entry.conditions[i] = c;
    });

  const save = async () => {
    const warn = d.enabled && limits.mode === "PAPER" ? "\n\nCette stratégie est ACTIVE : elle pourra ouvrir des positions (paper) immédiatement." : "";
    if (!(await confirm({ title: `Enregistrer « ${d.name} » ?`, message: `${summary(d, cur)}${warn}`, confirmLabel: "Enregistrer" })).ok) return;
    setSaving(true);
    try {
      await postAction("/api/strategies/save", { strategy: d });
      setServerIssues([]);
      onSaved();
    } catch (e) {
      setServerIssues([(e as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  const rot = d.afterExit.rotation;
  const rotSum = Object.values(rot.allocations).reduce((s, x) => s + x, 0);

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
      <Card title="Strategy Builder">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            Nom
            <input className={`${input} w-72`} value={d.name} onChange={(e) => set((x) => void (x.name = e.target.value))} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-500">
            Identifiant
            <input className={`${input} w-48 font-mono disabled:opacity-50`} value={d.id} disabled={!isNew} title={isNew ? "" : "l'identifiant d'une stratégie existante ne change pas"} onChange={(e) => set((x) => void (x.id = e.target.value.toLowerCase()))} />
          </label>
          <label className="flex items-center gap-2 pb-1 text-sm text-slate-300">
            <input type="checkbox" checked={d.enabled} onChange={(e) => set((x) => void (x.enabled = e.target.checked))} />
            Active
          </label>
        </div>

        <Kw>WHEN</Kw>
        <div className="space-y-2">
          {d.entry.conditions.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-10 text-right text-xs font-bold text-slate-500">{i === 0 ? "" : "AND"}</span>
              <select className={input} value={c.metric} onChange={(e) => setCond(i, { metric: e.target.value as Condition["metric"] })}>
                {CONDITION_METRICS.map((m) => (
                  <option key={m} value={m}>
                    {METRIC_LABEL[m]}
                  </option>
                ))}
              </select>
              <select className={input} value={c.op} onChange={(e) => setCond(i, { op: e.target.value as Condition["op"] })}>
                {OPS.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
              <NumberField value={c.value} onChange={(v) => setCond(i, { value: v })} />
              {c.metric === "priceChangePct" && (
                <select className={input} value={c.window} onChange={(e) => setCond(i, { window: e.target.value as Condition["window"] })}>
                  {WINDOWS.map((w) => (
                    <option key={w} value={w}>
                      sur {w}
                    </option>
                  ))}
                </select>
              )}
              {d.entry.conditions.length > 1 && (
                <button className="text-xs text-rose-400 hover:underline" onClick={() => set((x) => void x.entry.conditions.splice(i, 1))}>
                  retirer
                </button>
              )}
            </div>
          ))}
          <button className="ml-12 text-xs text-sky-300 hover:underline" onClick={() => set((x) => void x.entry.conditions.push({ metric: "volumeRatio", op: ">", value: 2 }))}>
            + AND condition
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-400">
          Univers : devises
          <input
            className={`${input} w-28`}
            value={d.universe.quoteCurrencies.join(",")}
            onChange={(e) => set((x) => void (x.universe.quoteCurrencies = e.target.value.toUpperCase().split(",").map((v) => v.trim()).filter(Boolean)))}
          />
          sauf
          <input
            className={`${input} w-40`}
            placeholder="ex. BTC,ETH"
            value={d.universe.excludeBases.join(",")}
            onChange={(e) => set((x) => void (x.universe.excludeBases = e.target.value.toUpperCase().split(",").map((v) => v.trim()).filter(Boolean)))}
          />
          <span className="text-xs text-slate-500">(le trading paper n&apos;utilise que la devise du compte : {cur})</span>
        </div>

        <Kw>THEN</Kw>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          Ouvrir une position de maximum <NumberField value={d.sizing.quoteAmount} step={1} min={0} max={limits.maxTradeQuote} onChange={(v) => set((x) => void (x.sizing.quoteAmount = v))} /> {cur}
          <span className="text-xs text-slate-500">(plafond Risk Engine : {limits.maxTradeQuote} {cur}, non modifiable ici)</span>
        </div>

        <Kw>STOP</Kw>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          Stop depuis l&apos;entrée −<NumberField value={d.exit.stopLossPct} onChange={(v) => set((x) => void (x.exit.stopLossPct = v))} /> % <span className="text-xs text-slate-500">(obligatoire)</span>
        </div>

        <Kw>TRAILING</Kw>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input type="checkbox" checked={d.exit.trailingStopPct !== null} onChange={(e) => set((x) => void (x.exit.trailingStopPct = e.target.checked ? 2 : null))} />
          Trailing stop
          {d.exit.trailingStopPct !== null && (
            <>
              <NumberField value={d.exit.trailingStopPct} onChange={(v) => set((x) => void (x.exit.trailingStopPct = v))} /> % sous le plus haut
            </>
          )}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <input type="checkbox" checked={d.exit.takeProfitPct !== null} onChange={(e) => set((x) => void (x.exit.takeProfitPct = e.target.checked ? 5 : null))} />
          Take profit
          {d.exit.takeProfitPct !== null && (
            <>
              +<NumberField value={d.exit.takeProfitPct} onChange={(v) => set((x) => void (x.exit.takeProfitPct = v))} /> %
            </>
          )}
          <span className="mx-2 text-slate-700">|</span>
          <input type="checkbox" checked={d.exit.maxDurationSec !== null} onChange={(e) => set((x) => void (x.exit.maxDurationSec = e.target.checked ? 3600 : null))} />
          Durée max.
          {d.exit.maxDurationSec !== null && (
            <>
              <NumberField value={Math.round(d.exit.maxDurationSec / 60)} step={1} min={1} onChange={(v) => set((x) => void (x.exit.maxDurationSec = Math.round(v * 60)))} /> min
            </>
          )}
        </div>

        <Kw>AFTER EXIT</Kw>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <input type="checkbox" checked={rot.enabled} onChange={(e) => set((x) => void (x.afterExit.rotation.enabled = e.target.checked))} />
          Rotation
          {rot.enabled && (
            <>
              <select className={input} value={rot.mode} onChange={(e) => set((x) => void (x.afterExit.rotation.mode = e.target.value as "proceeds" | "profit_only"))}>
                <option value="profit_only">du profit uniquement</option>
                <option value="proceeds">de tout le capital récupéré</option>
              </select>
              {Object.entries(rot.allocations).map(([asset, pct]) => (
                <span key={asset} className="flex items-center gap-1">
                  <NumberField value={pct} step={5} min={0} max={100} className="w-20" onChange={(v) => set((x) => void (x.afterExit.rotation.allocations[asset] = v))} /> % {asset}
                </span>
              ))}
              <span className={`text-xs ${rotSum > 100 ? "text-rose-400" : "text-slate-500"}`}>total {rotSum} %</span>
            </>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-slate-400">
          Pas de nouvelle entrée sur le même produit pendant <NumberField value={Math.round(d.cooldownPerProductSec / 60)} step={1} min={0} onChange={(v) => set((x) => void (x.cooldownPerProductSec = Math.round(v * 60)))} /> min
        </div>

        <div className="mt-5 rounded bg-slate-900 p-3 text-sm text-slate-300">{summary(d, cur)}</div>
        <p className="mt-2 text-[11px] text-slate-500">
          Frais estimés aller-retour : {(d.sizing.quoteAmount * (limits.takerFeePct / 100) * 2).toFixed(2)} {cur} ({(limits.takerFeePct * 2).toFixed(1)} %, hypothèse). Le Risk Engine reste appliqué à chaque ordre ; les positions déjà ouvertes gardent leurs règles.
        </p>
        {[...local, ...serverIssues].length > 0 && (
          <ul className="mt-3 list-inside list-disc text-sm text-rose-400">
            {[...local, ...serverIssues].map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex gap-2">
          <button disabled={local.length > 0 || saving} onClick={save} className="rounded bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-40">
            Enregistrer
          </button>
          <button onClick={onCancel} className="rounded border border-slate-700 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
            Annuler
          </button>
        </div>
      </Card>

      <Card title="Aperçu sur le marché actuel">
        {local.length > 0 ? (
          <p className="text-sm text-slate-500">Corrige la stratégie pour voir l&apos;aperçu.</p>
        ) : !preview ? (
          <p className="text-sm text-slate-500">Calcul…</p>
        ) : (
          <div className="space-y-4 text-sm">
            <p className="text-slate-400">
              {preview.evaluated} produit(s) évalué(s) · <span className="font-semibold text-slate-200">{preview.matches.length}</span> correspondent maintenant
            </p>
            {preview.matches.map((m) => (
              <div key={m.productId} className="rounded border border-emerald-700/40 bg-emerald-500/[0.05] p-2">
                <div className="font-semibold text-slate-100">{m.productId}</div>
                {m.risk && (
                  <div className={`text-xs font-semibold ${m.risk.approved ? "text-emerald-400" : "text-rose-400"}`}>
                    Risk Engine : {m.risk.approved ? "APPROVED" : "REJECTED"}
                    {!m.risk.approved && <ul className="list-inside list-disc font-normal">{m.risk.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
                  </div>
                )}
              </div>
            ))}
            <div>
              <div className="mb-1 text-xs text-slate-500">Les plus proches</div>
              {preview.closest.map((m) => (
                <div key={m.productId} className="mb-2">
                  <span className="font-semibold text-slate-200">{m.productId}</span>{" "}
                  <span className="text-xs text-slate-500">
                    {m.passed}/{m.total}
                  </span>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {m.conditions.map((c) => (
                      <span key={c.label} className={`rounded px-1.5 py-0.5 text-[10px] ${c.passed ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>
                        {c.passed ? "✓" : "✗"} {c.label} ({c.value === null ? "—" : c.value.toFixed(2)})
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function StrategiesPage() {
  const [list, setList] = useState<Strategy[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [editing, setEditing] = useState<{ draft: Draft; isNew: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm, notify } = useDialogs();

  const load = useCallback(() => {
    getJson<{ strategies: Strategy[]; limits: Limits }>("/api/strategies").then(
      (r) => {
        setList(r.strategies);
        setLimits(r.limits);
      },
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(load, [load]);

  const act = async (path: string, body: unknown) => {
    try {
      await postAction(path, body);
      load();
    } catch (e) {
      notify(`Refusé : ${(e as Error).message}`, "error");
    }
  };

  if (error) return <Card><span className="text-rose-400">{error}</span></Card>;
  if (!limits) return <Card><span className="text-slate-400">Chargement…</span></Card>;
  if (editing)
    return (
      <Editor
        key={editing.draft.id}
        initial={editing.draft}
        isNew={editing.isNew}
        limits={limits}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          load();
        }}
      />
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <p className="text-sm text-slate-400">
          Crée et modifie tes stratégies sans code. Chaque ordre qu&apos;elles proposent passe par le Risk Engine, dont les limites ne sont pas modifiables ici.
        </p>
        <button onClick={() => setEditing({ draft: blank(limits.currency, limits.maxTradeQuote), isNew: true })} className="ml-auto rounded bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-500">
          + Nouvelle stratégie
        </button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {list.map((s) => (
          <Card key={s.id}>
            <div className="flex items-start gap-3">
              <div>
                <div className="font-semibold text-slate-100">{s.name}</div>
                <div className="font-mono text-xs text-slate-500">{s.id}</div>
              </div>
              <span className={`ml-auto rounded px-2 py-0.5 text-xs font-semibold ${s.enabled ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>{s.enabled ? "ACTIVE" : "INACTIVE"}</span>
            </div>
            <p className="mt-3 text-sm text-slate-300">{summary(s, limits.currency)}</p>
            <div className="mt-4 flex flex-wrap gap-2 text-xs">
              <button className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => setEditing({ draft: structuredClone(s), isNew: false })}>
                Modifier
              </button>
              <button className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800" onClick={() => setEditing({ draft: { ...structuredClone(s), id: `${s.id}-copie`.slice(0, 40), name: `${s.name} (copie)`, enabled: false }, isNew: true })}>
                Dupliquer
              </button>
              <button
                className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800"
                onClick={async () => {
                  if (!s.enabled && limits.mode === "PAPER" && !(await confirm({ title: `Activer « ${s.name} » ?`, message: "Elle pourra ouvrir des positions (paper) dès maintenant.", confirmLabel: "Activer" })).ok) return;
                  void act("/api/strategies/toggle", { id: s.id, enabled: !s.enabled });
                }}
              >
                {s.enabled ? "Désactiver" : "Activer"}
              </button>
              <button
                className="rounded border border-rose-900 px-2 py-1 text-rose-300 hover:bg-rose-950"
                onClick={async () => {
                  if ((await confirm({ title: `Supprimer « ${s.name} » ?`, message: "Refusé tant que des positions de cette stratégie sont ouvertes.", confirmLabel: "Supprimer", tone: "danger", requireText: "DELETE" })).ok)
                    void act("/api/strategies/delete", { id: s.id, confirm: "DELETE" });
                }}
              >
                Supprimer
              </button>
            </div>
          </Card>
        ))}
        {list.length === 0 && <Card><p className="text-sm text-slate-500">Aucune stratégie. Crée-en une.</p></Card>}
      </div>
    </div>
  );
}
