/**
 * GET /api/news/<id> → raw RSS/Atom XML of one whitelisted feed, cached 5 min.
 * Browsers cannot read these feeds directly (no CORS headers on news sites).
 */
import { FEEDS, cachedFetch, json } from "../../../lib/proxy.js";

export async function onRequestGet(ctx) {
  const feed = FEEDS.find((f) => f.id === ctx.params.id);
  if (!feed) return json({ error: "unknown_feed" }, 404);
  return cachedFetch(
    ctx,
    `news-${feed.id}`,
    feed.url,
    { headers: { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5", "user-agent": "CryptoRadar/0.1 (+read-only news reader)" } },
    300,
    "application/xml; charset=utf-8",
  );
}
