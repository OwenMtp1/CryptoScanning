/**
 * News: RSS 2.0 / Atom parsing, coin matching and keyword-based direction.
 * Deterministic and explainable — every direction lists the matched terms.
 */
import { XMLParser } from "fast-xml-parser";
import type { Direction, NewsItem } from "./types.js";

export interface RawFeedItem {
  title: string;
  link: string;
  summary: string;
  ts: number;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  // No DTD / external entity resolution in fast-xml-parser; keep default entity handling only.
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
});

const text = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)["#text"]);
  return "";
};
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
export const stripHtml = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Parse an RSS 2.0 or Atom document. Malformed documents return []. */
export function parseFeed(xml: string): RawFeedItem[] {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: RawFeedItem[] = [];
  const rss = doc.rss as { channel?: { item?: unknown } } | undefined;
  for (const it of arr(rss?.channel?.item as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    const title = stripHtml(text(it.title));
    const link = text(it.link) || text((it.guid as unknown) ?? "");
    const ts = Date.parse(text(it.pubDate) || text(it["dc:date"]));
    if (title && link) out.push({ title, link, summary: stripHtml(text(it.description)).slice(0, 500), ts: Number.isFinite(ts) ? ts : Date.now() });
  }
  const feed = doc.feed as { entry?: unknown } | undefined;
  for (const e of arr(feed?.entry as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    const title = stripHtml(text(e.title));
    const links = arr(e.link as Record<string, unknown> | Record<string, unknown>[] | undefined);
    const alt = links.find((l) => !l["@rel"] || l["@rel"] === "alternate") ?? links[0];
    const link = alt ? String(alt["@href"] ?? "") : "";
    const ts = Date.parse(text(e.published) || text(e.updated));
    if (title && link) out.push({ title, link, summary: stripHtml(text(e.summary) || text(e.content)).slice(0, 500), ts: Number.isFinite(ts) ? ts : Date.now() });
  }
  return out;
}

// ─── Coin matching ─────────────────────────────────────────────────────────

/** Symbols / names that are ordinary words: never matched without a `$` prefix. */
const AMBIGUOUS = new Set(
  "A AI ALL AND ANY APP ARE AT BE BIG BIT BY CAN CAT DAO DOG FOR FUN GAS GET GO GOOD HOT ID IN IS IT JUST KEY LOVE MAN ME MOON MORE MY NEW NO NOT NOW OF OK ON ONE OR OUT PAY POOL SAFE SEC SO SUN THE TIME TO TOP UP US USA WE WIN WHO YOU ETF CEO CFO USD EUR GDP FED NFT DEX CEX API ATH AMA IPO ICO OTC".split(" "),
);
const COMMON_NAMES = new Set(["maker", "graph", "flow", "near", "compound", "celo", "wax", "gala", "render", "status", "civic", "harmony", "helium", "theta", "oasis", "origin", "loom", "request", "decentraland", "wrapped"]);

export interface CoinDictionaryEntry {
  symbol: string;
  name: string;
}

export class CoinMatcher {
  private readonly bySymbol = new Map<string, string>();
  private readonly names: { re: RegExp; symbol: string }[] = [];

  constructor(entries: CoinDictionaryEntry[]) {
    // Larger (earlier) coins win on symbol collisions: entries are expected sorted by market cap.
    const seenNames = new Set<string>();
    for (const e of entries) {
      const sym = e.symbol.toUpperCase();
      if (!this.bySymbol.has(sym)) this.bySymbol.set(sym, sym);
      const n = e.name.trim();
      const key = n.toLowerCase();
      if (n.length >= 4 && !COMMON_NAMES.has(key) && !seenNames.has(key)) {
        seenNames.add(key);
        this.names.push({ re: new RegExp(`(?<![\\p{L}\\d])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "iu"), symbol: sym });
      }
    }
    this.names.sort((a, b) => b.re.source.length - a.re.source.length); // longest names first
  }

  /** Coins mentioned in a text: `$SYM`, standalone uppercase `SYM` (≥ 3 chars, not ambiguous), or the coin's name. */
  match(textIn: string): string[] {
    const found = new Set<string>();
    for (const m of textIn.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/g)) {
      const s = (m[1] as string).toUpperCase();
      if (this.bySymbol.has(s)) found.add(s);
    }
    for (const m of textIn.matchAll(/(?<![A-Za-z0-9$])([A-Z][A-Z0-9]{2,9})(?![A-Za-z0-9])/g)) {
      const s = m[1] as string;
      if (!AMBIGUOUS.has(s) && this.bySymbol.has(s)) found.add(s);
    }
    let rest = textIn;
    for (const n of this.names) {
      if (n.re.test(rest)) {
        found.add(n.symbol);
        rest = rest.replace(n.re, " "); // "Ethereum Classic" must not also match "Ethereum"
      }
    }
    return [...found];
  }
}

// ─── Direction from keywords (EN + FR) ─────────────────────────────────────

const RULES: { re: RegExp; w: number; tag: string }[] = [
  // bullish
  { re: /\b(will list|to list|lists|listing|listed on)\b/i, w: 2, tag: "listing" },
  { re: /\bcotation\b|\blist(é|ée)s? sur\b/i, w: 2, tag: "listing" },
  { re: /\betf\b.*\b(approv|approuv)/i, w: 3, tag: "ETF approuvé" },
  { re: /\b(partnership|partners with|partenariat)\b/i, w: 1, tag: "partenariat" },
  { re: /\b(mainnet|launch(es|ed)?|lancement|upgrade|mise à jour)\b/i, w: 1, tag: "lancement / mise à jour" },
  { re: /\b(adopt(s|ion)?|integrat(es|ion))\b/i, w: 1, tag: "adoption" },
  { re: /\b(buyback|token burn|rachat)\b/i, w: 1, tag: "rachat / burn" },
  { re: /\b(all-time high|record high|new high|ath|nouveau record|record historique)\b/i, w: 2, tag: "record" },
  { re: /\b(surg(e|es|ing)|soar(s|ing)?|rall(y|ies)|jumps?|skyrockets?|flambe|bondit|s'envole|envolée)\b/i, w: 1, tag: "forte hausse" },
  { re: /\b(inflows?|accumulat(e|es|ion)|whales? (buy|accumulate)|afflux)\b/i, w: 1, tag: "achats / afflux" },
  { re: /\b(raises|funding round|levée de fonds)\b/i, w: 1, tag: "levée de fonds" },
  // bearish
  { re: /\b(hack(ed|s)?|exploit(ed)?|drained|stolen|breach|piratage|piraté|faille)\b/i, w: -3, tag: "hack / exploit" },
  { re: /\b(rug ?pull|scam|fraud|ponzi|arnaque|fraude)\b/i, w: -3, tag: "fraude / rug" },
  { re: /\b(lawsuit|sues|sued|charges|charged|indict|plainte|poursuites?|inculp)/i, w: -2, tag: "poursuites" },
  { re: /\b(investigation|probe|enquête)\b/i, w: -1, tag: "enquête" },
  { re: /\b(delist(s|ed|ing)?|retrait de la cote)\b/i, w: -3, tag: "retrait de la cote" },
  { re: /\b(ban(s|ned)?|interdi(t|ction))\b/i, w: -2, tag: "interdiction" },
  { re: /\b(halt(s|ed)?|suspend(s|ed)?|outage|panne|suspension)\b/i, w: -2, tag: "arrêt / panne" },
  { re: /\b(bankrupt(cy)?|insolven(t|cy)|faillite)\b/i, w: -3, tag: "faillite" },
  { re: /\b(liquidat(ed|ions?)|liquidations?)\b/i, w: -1, tag: "liquidations" },
  { re: /\b(plunge(s|d)?|crash(es|ed)?|tumble(s|d)?|dump(s|ed)?|sell-?off|chute|s'effondre|plonge|dégringole)\b/i, w: -1, tag: "forte baisse" },
  { re: /\b(outflows?|sorties de capitaux)\b/i, w: -1, tag: "sorties" },
  { re: /\b(token unlock|unlocks?|déblocage)\b/i, w: -1, tag: "déblocage de jetons" },
  { re: /\b(depeg(s|ged)?|loses? peg)\b/i, w: -3, tag: "perte de parité" },
];

/** `\b` is ASCII-only in JS: rewrite it as a Unicode letter boundary so "piraté" or "enquête" match. */
const UNICODE_RULES = RULES.map((r) => ({ ...r, re: new RegExp(r.re.source.replace(/\\b/g, "(?:(?<![\\p{L}\\d])(?=[\\p{L}\\d])|(?<=[\\p{L}\\d])(?![\\p{L}\\d]))"), "iu") }));

export function classifyNews(title: string, summary: string): { direction: Direction; score: number; tags: string[] } {
  let score = 0;
  const tags: string[] = [];
  for (const r of UNICODE_RULES) {
    const inTitle = r.re.test(title);
    if (inTitle || r.re.test(summary)) {
      score += r.w * (inTitle ? 1 : 0.5);
      if (!tags.includes(r.tag)) tags.push(r.tag);
    }
  }
  return { direction: score >= 1 ? "bullish" : score <= -1 ? "bearish" : "neutral", score, tags };
}

/** Stable id from the link (or title) — FNV-1a 32-bit, hex. */
export function newsId(link: string, title: string): string {
  const s = (link || title).trim().toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `n${h.toString(16)}`;
}

export function toNewsItem(raw: RawFeedItem, feed: string, matcher: CoinMatcher): NewsItem {
  const coins = matcher.match(`${raw.title} ${raw.summary}`);
  const c = classifyNews(raw.title, raw.summary);
  return { id: newsId(raw.link, raw.title), ts: raw.ts, feed, title: raw.title, link: raw.link, summary: raw.summary, coins, direction: c.direction, tags: c.tags };
}
