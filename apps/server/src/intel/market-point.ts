/**
 * « Point marché » for Discord: the overview the site shows (context, hot narratives, coins people talk
 * about, biggest moves, headlines, what was sent) in one message, so Discord has at least what the site has.
 */
import type { DiscordEmbed } from "@radar/core";
import type { IntelService } from "./intel-service.js";

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(d).replace(".", ",")} %`);

export function marketPointEmbed(svc: IntelService, now: number, opts: { siteUrl?: string | null; everyMin: number }): DiscordEmbed {
  const ctx = svc.marketContext();
  const t = svc.trends(now);
  const rows = svc.universe({ sort: "change1h", dir: "desc", limit: 40 }).rows;
  const ch1h = (r: (typeof rows)[number]) => r.live?.change1h ?? r.change1h ?? null;
  const up = rows.filter((r) => (ch1h(r) ?? 0) > 0).slice(0, 6);
  const down = svc
    .universe({ sort: "change1h", dir: "asc", limit: 40 })
    .rows.filter((r) => (ch1h(r) ?? 0) < 0)
    .slice(0, 6);
  const recent = svc.engine.recentSignals({ since: now - opts.everyMin * 60_000, limit: 5000 });
  const n = (d: string) => recent.filter((s) => s.direction === d).length;
  const conf = recent.filter((s) => s.kind === "CONFLUENCE").map((s) => s.coin);

  const fields: DiscordEmbed["fields"] = [];
  const add = (name: string, lines: string[]) => {
    if (lines.length) fields.push({ name, value: cut(lines.join("\n"), 1024), inline: false });
  };
  add(
    "🔥 Narratifs chauds (6 h)",
    t.themes.slice(0, 5).map((x) => `${x.emoji} **${x.label}** — chaleur ${x.heat}${(x.momentum ?? 0) >= 1.5 && x.mentions2h >= 2 ? ` ↗ ×${String(x.momentum).replace(".", ",")}` : ""} · humeur ${x.sentiment >= 0.2 ? "🟢" : x.sentiment <= -0.2 ? "🔴" : "⚪"}${x.priceChange24h !== null ? ` · 24 h ${pct(x.priceChange24h)}` : ""}`),
  );
  add(
    "🗣️ Cryptos dont on parle",
    [t.coins.slice(0, 10).map((c) => `**${c.coin}**${c.rankDelta === null ? " 🆕" : c.rankDelta > 0 ? ` ▲${c.rankDelta}` : c.rankDelta < 0 ? ` ▼${-c.rankDelta}` : ""}`).join(" · ")].filter(Boolean),
  );
  add("🚀 Plus fortes hausses (1 h)", [up.map((r) => `**${r.symbol}** ${pct(ch1h(r))}`).join(" · ")].filter(Boolean));
  add("📉 Plus fortes baisses (1 h)", [down.map((r) => `**${r.symbol}** ${pct(ch1h(r))}`).join(" · ")].filter(Boolean));
  add(
    "📰 À la une",
    t.headlines.slice(0, 6).map((h) => `${h.direction === "bullish" ? "🟢" : h.direction === "bearish" ? "🔴" : "⚪"} ${/^https:\/\//.test(h.link) ? `[${cut(h.title.replace(/[[\]]/g, ""), 110)}](${h.link})` : cut(h.title, 110)} — ${h.feed}`),
  );
  const site = opts.siteUrl?.replace(/\/+$/, "");
  const at = new Date(now).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  return {
    title: `📊 Point marché · ${at}`,
    description: cut(
      [
        `**Contexte :** ${ctx.note}`,
        `**Signaux sur ${opts.everyMin} min :** 🟢 ${n("bullish")} haussiers · 🔴 ${n("bearish")} baissiers · ⚪ ${n("neutral")} neutres${conf.length ? ` · confluences : ${[...new Set(conf)].slice(0, 8).join(", ")}` : ""}`,
        `**Actus :** ${t.totals.posts1h} titres sur 1 h, humeur ${t.totals.sentiment24h >= 0.2 ? "plutôt positive 🟢" : t.totals.sentiment24h <= -0.2 ? "plutôt négative 🔴" : "partagée ⚪"} sur 24 h`,
        site && /^https:\/\//.test(site) ? `[Voir les tendances](${site}/#tendances) · [Flux](${site}/#)` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      1500,
    ),
    color: ctx.regime === "hausse" ? 0x22c55e : ctx.regime === "baisse" ? 0xef4444 : 0x64748b,
    fields,
    footer: { text: "Crypto Radar · vue d'ensemble · pas un conseil d'investissement" },
    timestamp: new Date(now).toISOString(),
  };
}
