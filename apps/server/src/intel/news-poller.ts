/**
 * RSS / Atom poller. Feeds are fetched one after another (spread over the
 * interval), with conditional GET (ETag / Last-Modified) to stay polite.
 */
import { parseFeed, type IntelConfig, type RawFeedItem } from "@radar/core";
import type { FetchText } from "./http.js";

type Feed = IntelConfig["news"]["feeds"][number];

export interface FeedHealth {
  name: string;
  url: string;
  lang: string;
  ok: boolean | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  items: number;
}

export interface NewsPollerOptions {
  feeds: Feed[];
  intervalSec: number;
  fetchText: FetchText;
  onItems(feed: Feed, items: RawFeedItem[], now: number): void;
  onError(feed: Feed, message: string, now: number): void;
  now?: () => number;
}

export class NewsPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private idx = 0;
  private readonly cache = new Map<string, { etag: string | null; lastModified: string | null }>();
  private readonly health = new Map<string, FeedHealth>();
  private readonly now: () => number;

  constructor(private readonly o: NewsPollerOptions) {
    this.now = o.now ?? Date.now;
    for (const f of o.feeds) this.health.set(f.url, { name: f.name, url: f.url, lang: f.lang, ok: null, lastSuccessAt: null, lastError: null, items: 0 });
  }

  start() {
    this.stop();
    if (!this.o.feeds.length) return;
    const every = Math.max(5_000, (this.o.intervalSec * 1000) / this.o.feeds.length);
    this.timer = setInterval(() => void this.pollNext(), every);
    void this.pollNext();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async pollNext() {
    const f = this.o.feeds[this.idx++ % this.o.feeds.length];
    if (f) await this.poll(f);
  }

  async poll(f: Feed) {
    const h = this.health.get(f.url) as FeedHealth;
    const c = this.cache.get(f.url);
    const headers: Record<string, string> = { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5", "user-agent": "CryptoRadar/0.1 (local, read-only)" };
    if (c?.etag) headers["if-none-match"] = c.etag;
    if (c?.lastModified) headers["if-modified-since"] = c.lastModified;
    const now = this.now();
    try {
      const res = await this.o.fetchText(f.url, { headers, timeoutMs: 15_000 });
      if (res.status === 304) {
        h.ok = true;
        h.lastSuccessAt = now;
        h.lastError = null;
        return;
      }
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const items = parseFeed(res.text);
      if (!items.length) throw new Error("flux vide ou illisible (URL à vérifier)");
      this.cache.set(f.url, { etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") });
      h.ok = true;
      h.lastSuccessAt = now;
      h.lastError = null;
      h.items = items.length;
      this.o.onItems(f, items, now);
    } catch (err) {
      h.ok = false;
      h.lastError = (err as Error).message;
      this.o.onError(f, h.lastError, now);
    }
  }

  feedsHealth(): FeedHealth[] {
    return [...this.health.values()];
  }
}
