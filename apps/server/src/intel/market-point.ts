/**
 * « État du marché » for Discord: one message of short, ordered blocks, read top to bottom.
 *   1. Météo du marché : general trend in one word, Bitcoin / Ethereum, mood of the news, signal count.
 *   2. Avis en cours : the bot's trend opinions (the most useful part).
 *   3. Ça bouge : biggest rises / falls over 1 h.
 *   4. On en parle : hot narratives and coins people talk about.
 *   5. À la une : a few headlines with their link.
 * Each block is its own embed (coloured), with aligned lines: no wall of text.
 */
import type { DiscordEmbed } from "@radar/core";
import type { IntelService } from "./intel-service.js";

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(d).replace(".", ",")} %`);
const usd = (x: number | null | undefined) =>
  x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x.toLocaleString("fr-FR", { maximumFractionDigits: x >= 100 ? 0 : x >= 1 ? 2 : 6 })} $`;
const dot = (x: number | null | undefined) => (x === null || x === undefined ? "⚪" : x >= 0.3 ? "🟢" : x <= -0.3 ? "🔴" : "⚪");
/** `SOL   ` — fixed-width coin column so the numbers line up in Discord. */
const tag = (coin: string) => `\`${coin.slice(0, 6).padEnd(6, " ")}\``;
const GREEN = 0x22c55e;
const RED = 0xef4444;
const GREY = 0x64748b;
const VIOLET = 0x8b5cf6;
const AMBER = 0xf59e0b;
const SKY = 0x0ea5e9;

export function marketPointEmbeds(svc: IntelService, now: number, opts: { siteUrl?: string | null; everyMin: number; sourcesLine?: string }): DiscordEmbed[] {
  const ctx = svc.marketContext();
  const t = svc.trends(now);
  const site = opts.siteUrl?.replace(/\/+$/, "");
  const link = (path: string, text: string) => (site && /^https:\/\//.test(site) ? `[${text}](${site}/#${path})` : "");
  const at = new Date(now).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" });
  const ch1h = (r: { live?: { change1h: number | null } | null; change1h: number | null }) => r.live?.change1h ?? r.change1h ?? null;

  // 1. Météo du marché
  const trendWord = ctx.regime === "hausse" ? "🟢 **HAUSSE**" : ctx.regime === "baisse" ? "🔴 **BAISSE**" : ctx.regime === "calme" ? "⚪ **CALME**" : "⚪ **INCERTAIN**";
  const recent = svc.engine.recentSignals({ since: now - opts.everyMin * 60_000, limit: 5000 }).filter((s) => s.source !== "verdict");
  const n = (d: string) => recent.filter((s) => s.direction === d).length;
  const coinBox = (sym: string, icon: string) => {
    const r = svc.engine.coin(sym);
    return { name: `${icon} ${sym === "BTC" ? "Bitcoin" : "Ethereum"}`, value: r ? `**${usd(r.priceUsd)}**\n1 h ${pct(ch1h(r))}\n24 h ${pct(r.change24h)}` : "—", inline: true };
  };
  const mood = t.totals.sentiment24h;
  const weather: DiscordEmbed = {
    title: `📊 État du marché · ${at}`,
    description: `Tendance générale : ${trendWord}\n${cut(ctx.note, 200)}`,
    color: ctx.regime === "hausse" ? GREEN : ctx.regime === "baisse" ? RED : GREY,
    fields: [
      coinBox("BTC", "₿"),
      coinBox("ETH", "Ξ"),
      { name: `📡 Signaux (${opts.everyMin >= 60 ? `${opts.everyMin / 60} h` : `${opts.everyMin} min`})`, value: `🟢 ${n("bullish")} haussiers\n🔴 ${n("bearish")} baissiers\n⚪ ${n("neutral")} neutres`, inline: true },
      { name: "📰 Humeur des actus (24 h)", value: `${dot(mood)} ${mood >= 0.3 ? "plutôt positive" : mood <= -0.3 ? "plutôt négative" : "partagée"} · ${t.totals.posts1h} titres sur 1 h`, inline: false },
    ],
  };

  // 2. Avis en cours (the bot's stable opinions)
  const board = svc.verdictBoard(now).verdicts.filter((v) => v.state !== "NEUTRAL");
  const up = board.filter((v) => v.state === "UP" || v.state === "STRONG_UP").slice(0, 5);
  const down = board.filter((v) => v.state === "DOWN" || v.state === "STRONG_DOWN").slice(0, 5);
  const vLine = (v: (typeof board)[number]) => `${tag(v.coin)} ${v.state.startsWith("STRONG") ? "**fort**" : "      "} · conviction **${v.conviction}** · ${v.changeSincePct === null ? "" : pct(v.changeSincePct)}`;
  const opinions: DiscordEmbed = {
    title: "🧭 Avis en cours",
    description: board.length ? undefined : "Aucun avis net pour l'instant : le marché ne donne pas de direction claire.",
    color: VIOLET,
    fields: [
      ...(up.length ? [{ name: "▲ Haussiers", value: cut(up.map(vLine).join("\n"), 1024), inline: false }] : []),
      ...(down.length ? [{ name: "▼ Baissiers", value: cut(down.map(vLine).join("\n"), 1024), inline: false }] : []),
      ...(board.length && site ? [{ name: "​", value: link("avis", "Détail, niveaux et objectifs →"), inline: false }] : []),
    ],
  };

  // 3. Ça bouge (1 h)
  const rows = svc.universe({ sort: "change1h", dir: "desc", limit: 40 }).rows.filter((r) => (ch1h(r) ?? 0) > 0).slice(0, 5);
  const falls = svc
    .universe({ sort: "change1h", dir: "asc", limit: 40 })
    .rows.filter((r) => (ch1h(r) ?? 0) < 0)
    .slice(0, 5);
  const moveLine = (r: (typeof rows)[number]) => `${tag(r.symbol)} **${pct(ch1h(r))}**`;
  const moves: DiscordEmbed = {
    title: "🚀 Ça bouge (1 h)",
    color: AMBER,
    fields: [
      { name: "Hausses", value: rows.length ? rows.map(moveLine).join("\n") : "—", inline: true },
      { name: "Baisses", value: falls.length ? falls.map(moveLine).join("\n") : "—", inline: true },
    ],
  };

  // 4. On en parle
  const themes = t.themes.slice(0, 3).map((x) => `${x.emoji} **${x.label.split(" (")[0]}** · chaleur ${x.heat}${(x.momentum ?? 0) >= 1.5 && x.mentions2h >= 2 ? " · ↗ s'accélère" : ""} · ${dot(x.sentiment)}`);
  const coins = t.coins.slice(0, 8).map((c) => `**${c.coin}**${c.rankDelta === null ? " 🆕" : c.rankDelta > 0 ? ` ▲${c.rankDelta}` : ""}`);
  const talk: DiscordEmbed = {
    title: "🔥 On en parle",
    color: SKY,
    fields: [
      { name: "Sujets chauds (6 h)", value: themes.length ? themes.join("\n") : "—", inline: false },
      { name: "Cryptos les plus citées", value: coins.length ? coins.join(" · ") : "—", inline: false },
    ],
  };

  // 5. À la une
  const heads = t.headlines.slice(0, 4).map((h) => `${dot(h.direction === "bullish" ? 1 : h.direction === "bearish" ? -1 : 0)} ${/^https:\/\//.test(h.link) ? `[${cut(h.title.replace(/[[\]]/g, ""), 95)}](${h.link})` : cut(h.title, 95)} · *${h.feed}*`);
  const news: DiscordEmbed = {
    title: "📰 À la une",
    description: heads.length ? heads.join("\n") : "Pas de titre récent.",
    color: GREY,
    footer: { text: cut(`${opts.sourcesLine ? `Sources du bot : ${opts.sourcesLine} · ` : ""}lecture statistique, pas un conseil d'investissement`, 2000) },
    timestamp: new Date(now).toISOString(),
  };
  if (site) news.description += `\n\n${[link("tendances", "Tendances"), link("", "Flux"), link("avis", "Avis")].filter(Boolean).join(" · ")}`;

  return [weather, opinions, moves, talk, news];
}
