/**
 * Discord webhook message formatting (limits from discord/discord-api-docs:
 * content ≤ 2000 chars, ≤ 10 embeds, title ≤ 256, description ≤ 4096,
 * ≤ 25 fields, field value ≤ 1024, total embed text ≤ 6000).
 */
import { KIND_LABEL, SOURCE_LABEL, metricChips } from "./labels.js";
import type { IntelSignal, NewsItem } from "./types.js";

export interface DiscordEmbed {
  title: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordMessage {
  content?: string;
  username?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions: { parse: never[]; roles?: string[] };
}

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const COLORS = { bullish: 0x22c55e, bearish: 0xef4444, neutral: 0x64748b } as const;
const ICON = { bullish: "🟢", bearish: "🔴", neutral: "⚪" } as const;

function fmtPrice(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "—";
  return p >= 1 ? `$${p.toLocaleString("en-US", { maximumFractionDigits: 4 })}` : `$${p.toPrecision(4)}`;
}

export interface SignalEmbedOptions {
  /** Characters kept for the reasons (grouped messages keep less). */
  maxDescription?: number;
  /** Address of the site: adds a « 📈 Courbe » link to the coin's chart. */
  siteUrl?: string | null;
}

/**
 * One alert, with everything the site shows on its card: type and source in words, strength, direction,
 * price, measured reliability, the measured values (5 min, 1 h, volume, funding…), the reasons and links.
 */
export function signalEmbed(s: IntelSignal, hitRatePct: number | null, opts: SignalEmbedOptions = {}): DiscordEmbed {
  const fields = [
    { name: "Force", value: `${s.strength}/100`, inline: true },
    { name: "Direction", value: `${ICON[s.direction]} ${s.direction === "bullish" ? "haussier" : s.direction === "bearish" ? "baissier" : "neutre"}`, inline: true },
    { name: "Prix", value: fmtPrice(s.priceUsd), inline: true },
  ];
  if (hitRatePct !== null) fields.push({ name: "Fiabilité mesurée", value: `${hitRatePct.toFixed(0)} % de réussite à 1 h`, inline: true });
  const chips = metricChips(s.metrics).filter((c) => !(c.label === "score" && s.kind.startsWith("SETUP")));
  if (chips.length) fields.push({ name: "Mesures", value: cut(chips.map((c) => `${c.tone === "up" ? "▲" : c.tone === "down" ? "▼" : "·"} ${c.label} **${c.value}**`).join("  "), 1024), inline: false });
  const links: string[] = [];
  const site = opts.siteUrl?.replace(/\/+$/, "");
  if (site && /^https:\/\//.test(site) && /^[A-Z0-9]{1,20}$/.test(s.coin)) links.push(`[📈 Courbe et leviers](${site}/#courbe?coin=${s.coin})`);
  if (s.url && /^https:\/\//.test(s.url)) links.push(`[🔗 Source](${s.url})`);
  if (links.length) fields.push({ name: "Liens", value: links.join(" · "), inline: false });
  return {
    title: cut(s.title, 256),
    description: cut(s.reasons.map((r) => `• ${r}`).join("\n"), opts.maxDescription ?? 1500),
    url: s.url ?? undefined,
    color: COLORS[s.direction],
    fields,
    footer: { text: cut(`${KIND_LABEL[s.kind] ?? s.kind} · ${SOURCE_LABEL[s.source] ?? s.source} · ${s.coinName ?? s.coin} · pas un conseil d'investissement`, 200) },
    timestamp: new Date(s.ts).toISOString(),
  };
}

export function newsEmbed(n: NewsItem): DiscordEmbed {
  return {
    title: cut(`📰 ${n.title}`, 256),
    description: cut(n.summary, 600),
    url: n.link,
    color: COLORS[n.direction],
    fields: [
      { name: "Cryptos", value: n.coins.join(", ") || "—", inline: true },
      { name: "Lecture", value: n.tags.join(", ") || "—", inline: true },
    ],
    footer: { text: n.feed },
    timestamp: new Date(n.ts).toISOString(),
  };
}

/** Pack embeds into messages respecting the 10-embed and 6000-char limits. */
/** Characters Discord counts in an embed (title, description, fields, footer). */
export const embedSize = (e: DiscordEmbed) => e.title.length + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.fields ?? []).reduce((s, f) => s + f.name.length + f.value.length, 0);

export function packMessages(embeds: DiscordEmbed[], opts: { username?: string; content?: string; mentionRole?: string | null } = {}): DiscordMessage[] {
  const size = embedSize;
  const out: DiscordMessage[] = [];
  let cur: DiscordEmbed[] = [];
  let total = 0;
  const flush = () => {
    if (!cur.length) return;
    const mention = opts.mentionRole ? `<@&${opts.mentionRole}> ` : "";
    out.push({
      username: opts.username ?? "Crypto Radar",
      content: out.length === 0 && (opts.content || mention) ? cut(`${mention}${opts.content ?? ""}`, 2000) : undefined,
      embeds: cur,
      // Never ping @everyone/@here; only the configured role when asked.
      allowed_mentions: { parse: [], ...(opts.mentionRole ? { roles: [opts.mentionRole] } : {}) },
    });
    cur = [];
    total = 0;
  };
  for (const e of embeds) {
    const s = size(e);
    if (cur.length >= 10 || total + s > 5800) flush();
    cur.push(e);
    total += s;
  }
  flush();
  return out;
}
