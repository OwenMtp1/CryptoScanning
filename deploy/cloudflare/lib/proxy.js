/**
 * Shared helpers for the Cloudflare Pages Functions of the live site.
 * The functions are thin, cached pass-through proxies: they never parse the
 * upstream payloads (Workers free plan = ~10 ms CPU per request), they only
 * fetch a WHITELISTED upstream URL and keep it in the edge cache.
 */

/** Whitelisted RSS feeds (same list as config/intel.json defaults). */
export const FEEDS = [
  { id: "coindesk", name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/", lang: "en" },
  { id: "cointelegraph", name: "Cointelegraph", url: "https://cointelegraph.com/rss", lang: "en" },
  { id: "decrypt", name: "Decrypt", url: "https://decrypt.co/feed", lang: "en" },
  { id: "theblock", name: "The Block", url: "https://www.theblock.co/rss.xml", lang: "en" },
  { id: "bitcoinmagazine", name: "Bitcoin Magazine", url: "https://bitcoinmagazine.com/.rss/full/", lang: "en" },
  // CryptoSlate removed: it refuses requests coming from Cloudflare servers (HTTP 403).
  { id: "cryptoast", name: "Cryptoast", url: "https://cryptoast.fr/feed/", lang: "fr" },
  { id: "journalducoin", name: "Journal du Coin", url: "https://journalducoin.com/feed/", lang: "fr" },
  // Social: new Reddit posts (attention per coin). Reddit may refuse Cloudflare servers; the page Sources says so.
  { id: "reddit-cryptocurrency", name: "r/CryptoCurrency", url: "https://www.reddit.com/r/CryptoCurrency/new/.rss", lang: "en", kind: "social" },
  { id: "reddit-moonshots", name: "r/CryptoMoonShots", url: "https://www.reddit.com/r/CryptoMoonShots/new/.rss", lang: "en", kind: "social" },
  { id: "reddit-satoshistreetbets", name: "r/SatoshiStreetBets", url: "https://www.reddit.com/r/SatoshiStreetBets/new/.rss", lang: "en", kind: "social" },
  { id: "reddit-altcoin", name: "r/altcoin", url: "https://www.reddit.com/r/altcoin/new/.rss", lang: "en", kind: "social" },
];

export const json = (body, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" } });

/**
 * Serve `upstreamUrl` from the edge cache, fetching it at most once per `ttl`
 * seconds (per Cloudflare data centre). Errors are cached briefly so a failing
 * upstream is not hammered by every visitor.
 */
export async function cachedFetch(ctx, key, upstreamUrl, init, ttl, contentType) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.crypto-radar.internal/${key}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let res;
  try {
    const up = await fetch(upstreamUrl, { ...init, cf: { cacheTtl: 0 } });
    const ok = up.status === 200;
    const headers = { "content-type": contentType ?? up.headers.get("content-type") ?? "application/octet-stream", "cache-control": `public, max-age=${ok ? ttl : 120}`, "x-upstream-status": String(up.status) };
    if (!ok) headers["retry-after"] = "120";
    // On error, keep a short excerpt of the upstream answer: it says why (missing key, rate limit…).
    const detail = ok ? null : (await up.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    res = new Response(ok ? up.body : JSON.stringify({ error: "upstream_error", status: up.status, detail }), { status: ok ? 200 : up.status === 429 ? 429 : 502, headers });
  } catch (err) {
    res = new Response(JSON.stringify({ error: "upstream_unreachable" }), { status: 502, headers: { "content-type": "application/json", "cache-control": "public, max-age=60", "retry-after": "60" } });
  }
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
