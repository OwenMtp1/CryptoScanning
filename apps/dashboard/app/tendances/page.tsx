"use client";

import type { CoinAttention, ThemeTrend, TrendsView } from "@radar/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { CoinLink } from "@/components/Intel";
import { Card } from "@/components/ui";
import { getJson } from "@/lib/api";
import { fmtPct } from "@/lib/format";
import { fmtAgo, safeHref } from "@/lib/intel";

const GREEN = "#34d399";
const RED = "#fb7185";
const GREY = "#94a3b8";
const tone = (s: number) => (s >= 0.2 ? GREEN : s <= -0.2 ? RED : GREY);
const sentLabel = (s: number) => (s >= 0.5 ? "très positif" : s >= 0.2 ? "plutôt positif" : s <= -0.5 ? "très négatif" : s <= -0.2 ? "plutôt négatif" : "partagé");
const dirDot = (d: string) => (d === "bullish" ? GREEN : d === "bearish" ? RED : GREY);

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => setW(el.clientWidth || 800);
    on();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(on) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  return [ref, w] as const;
}

export default function TendancesPage() {
  const [d, setD] = useState<TrendsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      getJson<TrendsView>("/api/intel/trends").then(
        (r) => {
          setD(r);
          setErr(null);
        },
        (e: Error) => setErr(e.message),
      );
    void load();
    // Quick refreshes while the first news arrive, then every 20 s.
    let n = 0;
    const quick = setInterval(() => {
      if (++n > 10) clearInterval(quick);
      void load();
    }, 3_000);
    const t = setInterval(load, 20_000);
    return () => {
      clearInterval(t);
      clearInterval(quick);
    };
  }, []);

  const themes = d?.themes ?? [];
  const current = themes.find((t) => t.id === sel) ?? themes[0] ?? null;
  const rising = themes.filter((t) => (t.momentum ?? 0) >= 1.5 && t.mentions2h >= 2);

  if (err && !d) return <Card title="Tendances">Tendances indisponibles : {err}</Card>;

  return (
    <div className="space-y-4">
      <Ticker d={d} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Articles et posts (1 h)" value={d ? `${d.totals.posts1h}` : "—"} hint={d ? `${d.totals.posts24h} sur 24 h` : ""} />
        <Kpi label="Humeur des actus (24 h)" value={d ? sentLabel(d.totals.sentiment24h) : "—"} hint={d ? `indice ${d.totals.sentiment24h > 0 ? "+" : ""}${d.totals.sentiment24h}` : ""} color={d ? tone(d.totals.sentiment24h) : undefined} />
        <Kpi label="Narratif n°1" value={themes[0] ? `${themes[0].emoji} ${themes[0].label}` : "—"} hint={themes[0] ? `chaleur ${themes[0].heat}/100` : ""} />
        <Kpi label="En accélération" value={rising.length ? rising.map((t) => t.emoji).join(" ") : "aucun"} hint={rising.length ? rising.map((t) => t.label).join(", ") : "rien ne s'emballe"} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card title="Carte des narratifs (6 h)">
          <p className="-mt-1 mb-2 text-[11px] text-slate-500">Taille = chaleur (mentions récentes). Couleur = humeur des titres. Un anneau qui pulse = thème qui s&apos;emballe (2 h dernières ≥ 1,5 × avant). Clique pour le détail.</p>
          <BubbleField themes={themes} selected={current?.id ?? null} onSelect={setSel} />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {themes.map((t) => (
              <button key={t.id} type="button" onClick={() => setSel(t.id)} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${current?.id === t.id ? "border-sky-500 bg-sky-900/40 text-sky-100" : "border-slate-700 text-slate-300"}`}>
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: tone(t.sentiment) }} />
                {t.emoji} {t.label.split(" (")[0]} <span className="num text-slate-500">{t.heat}</span>
                {(t.momentum ?? 0) >= 1.5 && t.mentions2h >= 2 && <span className="text-amber-300">↗</span>}
              </button>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-slate-400">
            <Key c={GREEN} l="plutôt positif" />
            <Key c={GREY} l="partagé" />
            <Key c={RED} l="plutôt négatif" />
          </div>
        </Card>
        <Card title="Qui monte dans les conversations">
          <Leaderboard coins={d?.coins ?? []} />
        </Card>
      </div>

      {current && <ThemeDetail t={current} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pouls des actus (24 h)">
          <Pulse d={d} />
        </Card>
        <Card title="Secteurs en tendance (CoinGecko)">
          {!d?.categories.length ? (
            <p className="text-sm text-slate-500">Pas encore de données (mises à jour toutes les 30 min).</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {d.categories.map((c) => (
                <li key={c.name} className="flex items-center gap-2">
                  <span className="truncate text-slate-200">{c.name}</span>
                  {c.coinsCount !== null && <span className="text-[11px] text-slate-500">{c.coinsCount} cryptos</span>}
                  <span className={`num ml-auto ${(c.change24h ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(c.change24h)}</span>
                  <span className="num w-20 text-right text-[11px] text-slate-500">1 h {fmtPct(c.change1h)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <p className="text-[11px] text-slate-500">Sources : médias crypto (RSS), Reddit, tendances CoinGecko, signaux du radar. Mesure de l&apos;attention, pas une prédiction : un sujet chaud peut monter comme chuter.</p>
    </div>
  );
}

function Kpi({ label, value, hint, color }: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <Card>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-0.5 flex items-center gap-2 text-base font-semibold text-slate-100">
        {color && <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />}
        <span className="truncate">{value}</span>
      </div>
      {hint && <div className="truncate text-[11px] text-slate-500">{hint}</div>}
    </Card>
  );
}

function Key({ c, l }: { c: string; l: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c }} />
      {l}
    </span>
  );
}

/** Scrolling headline ticker (pauses on hover; static when motion is reduced). */
function Ticker({ d }: { d: TrendsView | null }) {
  const items = (d?.headlines ?? []).slice(0, 20);
  if (!items.length) return <div className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-500">Les actus arrivent (flux RSS et Reddit lus toutes les 5 min)…</div>;
  const row = (k: string) =>
    items.map((h, i) => (
      <a key={`${k}${i}`} href={safeHref(h.link)} target="_blank" rel="noopener noreferrer" className="mx-5 inline-flex shrink-0 items-center gap-2 whitespace-nowrap text-xs text-slate-300 hover:text-white">
        {h.breaking && <span className="anim-blink rounded bg-rose-600 px-1.5 py-0.5 text-[10px] font-bold text-white">NOUVEAU</span>}
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: dirDot(h.direction) }} />
        <span className="text-slate-500">{h.kind === "social" ? "💬" : "📰"} {h.feed}</span>
        {h.title}
        {h.coins.length > 0 && <span className="font-semibold text-sky-300">{h.coins.join(" ")}</span>}
      </a>
    ));
  return (
    <div className="relative overflow-hidden rounded border border-slate-800 bg-slate-900/70 py-2" aria-label="Dernières actus">
      <div className="anim-marquee flex w-max" style={{ animationDuration: `${Math.max(40, items.length * 7)}s` }}>
        {row("a")}
        {row("b")}
      </div>
    </div>
  );
}

/** Narratives as floating bubbles: area ∝ heat, laid out from the centre outwards without overlap. */
function BubbleField({ themes, selected, onSelect }: { themes: ThemeTrend[]; selected: string | null; onSelect: (id: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = width < 520 ? 340 : 400;
  const placed = useMemo(() => {
    const list = themes.filter((t) => t.heat > 0).slice(0, 14);
    const maxR = Math.min(width, height) * (width < 520 ? 0.2 : 0.17);
    const minR = width < 520 ? 26 : 32;
    const out: { t: ThemeTrend; x: number; y: number; r: number }[] = [];
    for (const t of list) {
      const r = minR + Math.sqrt(t.heat / 100) * (maxR - minR);
      let best: { x: number; y: number } | null = null;
      for (let k = 0; k < 900 && !best; k++) {
        const a = k * 0.5;
        const dist = k * 1.6;
        const x = width / 2 + Math.cos(a) * dist * 1.25;
        const y = height / 2 + Math.sin(a) * dist * 0.85;
        if (x - r < 4 || x + r > width - 4 || y - r < 4 || y + r > height - 4) continue;
        if (out.every((o) => Math.hypot(o.x - x, o.y - y) >= o.r + r + 6)) best = { x, y };
      }
      if (best) out.push({ t, ...best, r });
    }
    return out;
  }, [themes, width, height]);

  return (
    <div ref={ref} className="relative w-full overflow-hidden rounded-lg bg-[#0b1220]" style={{ height }}>
      {!placed.length && <p className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">Pas encore assez d&apos;actus pour dessiner les narratifs…</p>}
      {placed.map(({ t, x, y, r }, i) => {
        const c = tone(t.sentiment);
        const hot = (t.momentum ?? 0) >= 1.5 && t.mentions2h >= 2;
        const on = selected === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            title={`${t.label} : chaleur ${t.heat}/100, ${t.mentions6h} mentions en 6 h, humeur ${sentLabel(t.sentiment)}`}
            className="absolute rounded-full transition-all duration-700 ease-out"
            style={{ left: x - r, top: y - r, width: r * 2, height: r * 2 }}
          >
            <span className="anim-float absolute inset-0 block" style={{ animationDelay: `${-i * 1.3}s`, animationDuration: `${6 + (i % 4)}s` }}>
              {hot && <span className="anim-ring absolute inset-0 rounded-full" style={{ border: `2px solid ${c}` }} />}
              <span
                className="absolute inset-0 flex flex-col items-center justify-center rounded-full px-1 text-center"
                style={{ background: `${c}26`, border: `${on ? 3 : 1.5}px solid ${c}`, boxShadow: on ? `0 0 0 3px #0b1220, 0 0 0 5px ${c}` : undefined }}
              >
                <span style={{ fontSize: Math.max(16, r * 0.42) }}>{t.emoji}</span>
                {r >= 40 && <span className="max-w-full truncate text-[11px] font-semibold leading-tight text-slate-100">{t.label.split(" (")[0]}</span>}
                <span className="num text-[10px] text-slate-300">{t.heat}</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Attention ranking; rows glide to their new place when the order changes. */
function Leaderboard({ coins }: { coins: CoinAttention[] }) {
  const ROW = 46;
  const list = coins.slice(0, 15);
  if (!list.length) return <p className="text-sm text-slate-500">Pas encore de données.</p>;
  const max = Math.max(...list.map((c) => c.score), 1);
  return (
    <div className="relative" style={{ height: list.length * ROW }}>
      {list.map((c) => (
        <div key={c.coin} className="rank-row absolute inset-x-0 flex items-center gap-2 border-b border-slate-800/70 transition-transform duration-700 ease-out" style={{ height: ROW, transform: `translateY(${(c.rank - 1) * ROW}px)` }}>
          <span className="num w-5 text-right text-xs text-slate-500">{c.rank}</span>
          <span className="w-8 text-center text-[11px]">
            {c.rankDelta === null ? (
              <span className="anim-in rounded bg-sky-800/60 px-1 text-sky-200">new</span>
            ) : c.rankDelta > 0 ? (
              <span className="text-emerald-400">▲{c.rankDelta}</span>
            ) : c.rankDelta < 0 ? (
              <span className="text-rose-400">▼{-c.rankDelta}</span>
            ) : (
              <span className="text-slate-600">=</span>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <CoinLink symbol={c.coin} />
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: tone(c.sentiment) }} title={`humeur ${sentLabel(c.sentiment)}`} />
              <span className="truncate text-[11px] text-slate-500">
                {c.news > 0 && `📰 ${c.news} `}
                {c.social > 0 && `💬 ${c.social} `}
                {c.trendingRank !== null && `🔥 #${c.trendingRank} `}
                {c.signals > 0 && `⚡ ${c.signals}`}
              </span>
            </div>
            <div className="mt-1 h-1 w-full rounded bg-slate-800">
              <div className="h-1 rounded bg-sky-400 transition-all duration-700" style={{ width: `${(c.score / max) * 100}%` }} />
            </div>
          </div>
          <span className={`num w-16 text-right text-xs ${(c.change24h ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(c.change24h, 1)}</span>
        </div>
      ))}
    </div>
  );
}

function ThemeDetail({ t }: { t: ThemeTrend }) {
  const max = Math.max(1, ...t.timeline);
  return (
    <Card title={`${t.emoji} ${t.label}`}>
      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-1 text-sm">
          <div>
            Chaleur <strong className="num text-slate-100">{t.heat}</strong>/100 · {t.mentions6h} mentions en 6 h
          </div>
          <div>
            Accélération <strong className="num text-slate-100">{t.momentum === null ? "—" : `×${t.momentum}`}</strong>
            <span className="text-xs text-slate-500"> (2 h dernières vs avant)</span>
          </div>
          <div className="flex items-center gap-2">
            Humeur <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: tone(t.sentiment) }} /> {sentLabel(t.sentiment)}
            <span className="text-xs text-slate-500">
              ({t.bull} ▲ / {t.bear} ▼)
            </span>
          </div>
          <div>
            Prix des cryptos du thème (24 h) <strong className={`num ${(t.priceChange24h ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(t.priceChange24h)}</strong>
          </div>
          {t.category && (
            <div className="text-xs text-slate-400">
              Secteur CoinGecko « {t.category.name} » : {fmtPct(t.category.change24h)} en 24 h
            </div>
          )}
          <div className="pt-2">
            <div className="mb-1 text-[11px] text-slate-500">Mentions par demi-heure (6 h)</div>
            <div className="flex h-12 items-end gap-[2px]" role="img" aria-label={`mentions par demi-heure : ${t.timeline.join(", ")}`}>
              {t.timeline.map((v, i) => (
                <div key={i} className="flex-1 rounded-t-[3px] bg-sky-400/80" style={{ height: `${Math.max(v ? 8 : 2, (v / max) * 100)}%`, opacity: v ? 1 : 0.25 }} title={`il y a ${(12 - i) * 30} à ${(11 - i) * 30} min : ${v}`} />
              ))}
            </div>
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Ce qui se dit</div>
          <ul className="space-y-1.5">
            {t.headlines.map((h, i) => (
              <li key={i} className="anim-in flex gap-2 text-sm" style={{ animationDelay: `${i * 60}ms` }}>
                <span className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: dirDot(h.direction) }} />
                <span>
                  <a href={safeHref(h.link)} target="_blank" rel="noopener noreferrer" className="text-slate-200 hover:text-sky-300">
                    {h.title}
                  </a>
                  <span className="ml-1 text-[11px] text-slate-500">
                    {h.kind === "social" ? "💬" : "📰"} {h.feed} · il y a {fmtAgo(h.ts)}
                  </span>
                </span>
              </li>
            ))}
            {!t.headlines.length && <li className="text-sm text-slate-500">Pas de titre récent (secteur suivi via CoinGecko).</li>}
          </ul>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase text-slate-400">Cryptos concernées</div>
          <ul className="space-y-1 text-sm">
            {t.coins.map((c) => (
              <li key={c.coin} className="flex items-center gap-2">
                <CoinLink symbol={c.coin} />
                <span className="text-[11px] text-slate-500">{c.mentions ? `${c.mentions} mention${c.mentions > 1 ? "s" : ""}` : "du thème"}</span>
                <span className={`num ml-auto ${(c.change24h ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>{fmtPct(c.change24h)}</span>
                <a href={`#courbe?coin=${encodeURIComponent(c.coin)}`} className="text-xs text-sky-300" title="Courbe">
                  📈
                </a>
              </li>
            ))}
            {!t.coins.length && <li className="text-slate-500">—</li>}
          </ul>
        </div>
      </div>
    </Card>
  );
}

/** Bullish headlines up, bearish down, per hour (neutral in the tooltip). */
function Pulse({ d }: { d: TrendsView | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const p = d?.pulse ?? [];
  if (!p.some((x) => x.bull + x.bear + x.neutral)) return <p className="text-sm text-slate-500">Pas encore d&apos;actus sur 24 h.</p>;
  const max = Math.max(1, ...p.map((x) => Math.max(x.bull, x.bear)));
  const hv = hover !== null ? p[hover] : null;
  return (
    <div>
      <div className="relative flex h-40 items-stretch gap-[2px]" onPointerLeave={() => setHover(null)}>
        <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-slate-700" />
        {p.map((x, i) => (
          <div key={i} className={`relative flex flex-1 flex-col ${hover === i ? "bg-slate-800/60" : ""}`} onPointerEnter={() => setHover(i)} onPointerDown={() => setHover(i)}>
            <div className="flex flex-1 items-end justify-center pb-px">
              <div className="w-full max-w-[18px] rounded-t-[4px]" style={{ height: `${(x.bull / max) * 100}%`, background: GREEN, minHeight: x.bull ? 3 : 0 }} />
            </div>
            <div className="flex flex-1 items-start justify-center pt-px">
              <div className="w-full max-w-[18px] rounded-b-[4px]" style={{ height: `${(x.bear / max) * 100}%`, background: RED, minHeight: x.bear ? 3 : 0 }} />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>il y a 24 h</span>
        <span>12 h</span>
        <span>maintenant</span>
      </div>
      <div className="mt-2 min-h-[20px] text-xs text-slate-300">
        {hv ? (
          <>
            <strong>{new Date(hv.hour).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</strong> : <span className="text-emerald-400">{hv.bull} positifs</span> · <span className="text-rose-400">{hv.bear} négatifs</span> · {hv.neutral} neutres
          </>
        ) : (
          <span className="text-slate-500">
            <Key c={GREEN} l="titres positifs (au-dessus)" /> <Key c={RED} l="titres négatifs (en dessous)" />
          </span>
        )}
      </div>
    </div>
  );
}
