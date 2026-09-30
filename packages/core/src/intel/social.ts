/**
 * Social attention (Reddit): how often each coin is mentioned in new posts,
 * compared with its own recent baseline. A sudden jump in attention often
 * comes before or with a big move — it says "people are looking", not "up".
 */
import type { Candidate } from "./detectors.js";
import type { Direction } from "./types.js";

export interface SocialPost {
  id: string;
  ts: number;
  coins: string[];
  direction: Direction;
  title: string;
  link: string;
  feed: string;
}

export interface SocialConfig {
  /** Mentions in the last hour needed for an alert. */
  minMentions1h: number;
  /** …and at least this many times the coin's usual hourly mentions. */
  ratio: number;
}

export type SocialState = { mentions: Record<string, { ts: number; dir: Direction; id: string }[]>; seen: string[] };

const BASELINE_H = 12;

export class SocialBuzz {
  private readonly mentions = new Map<string, { ts: number; dir: Direction; id: string }[]>();
  private readonly seen = new Set<string>();

  constructor(
    private readonly cfg: SocialConfig,
    state: SocialState | null = null,
  ) {
    for (const [k, v] of Object.entries(state?.mentions ?? {})) this.mentions.set(k, v);
    for (const id of state?.seen ?? []) this.seen.add(id);
  }

  add(posts: SocialPost[], now: number): Candidate[] {
    const touched = new Set<string>();
    for (const p of posts) {
      if (this.seen.has(p.id) || now - p.ts > BASELINE_H * 3_600_000) continue;
      this.seen.add(p.id);
      for (const c of p.coins.slice(0, 3)) {
        const l = this.mentions.get(c) ?? [];
        l.push({ ts: p.ts, dir: p.direction, id: p.id });
        this.mentions.set(c, l);
        touched.add(c);
      }
    }
    const out: Candidate[] = [];
    for (const coin of touched) {
      const l = (this.mentions.get(coin) ?? []).filter((m) => m.ts > now - BASELINE_H * 3_600_000);
      this.mentions.set(coin, l);
      const last = l.filter((m) => m.ts > now - 3_600_000);
      const before = l.length - last.length;
      const usual = Math.max(0.5, before / (BASELINE_H - 1));
      const ratio = last.length / usual;
      if (last.length < this.cfg.minMentions1h || ratio < this.cfg.ratio) continue;
      const bull = last.filter((m) => m.dir === "bullish").length;
      const bear = last.filter((m) => m.dir === "bearish").length;
      const direction: Direction = bull >= 2 * Math.max(1, bear) ? "bullish" : bear >= 2 * Math.max(1, bull) ? "bearish" : "neutral";
      out.push({
        coin,
        coinName: null,
        kind: "SOCIAL_BUZZ",
        direction,
        source: "social",
        strength: Math.round(Math.min(90, 50 + (ratio - this.cfg.ratio) * 6 + last.length)),
        title: `${coin} : ${last.length} mentions sur Reddit en 1 h (${ratio.toFixed(1)}x l'habitude)`,
        reasons: [`${last.length} nouveaux posts citent ${coin} en 1 h, contre ${usual.toFixed(1)} par heure d'habitude`, `ton des posts : ${bull} positifs, ${bear} négatifs`, "l'attention grimpe : souvent avant ou pendant un gros mouvement (dans un sens ou l'autre)"],
        metrics: { mentions1h: last.length, usualPerHour: Math.round(usual * 10) / 10, ratio: Math.round(ratio * 10) / 10 },
        priceUsd: null,
        url: null,
      });
    }
    if (this.seen.size > 5000) {
      const keep = [...this.seen].slice(-3000);
      this.seen.clear();
      for (const id of keep) this.seen.add(id);
    }
    return out;
  }

  export(): SocialState {
    return { mentions: Object.fromEntries(this.mentions), seen: [...this.seen].slice(-3000) };
  }
}
