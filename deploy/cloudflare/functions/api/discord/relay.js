/**
 * POST /api/discord/relay → forwards the site's signals to the Discord worker.
 *
 * Two ways to authenticate:
 * - the relay code typed in the browser (header x-relay-key), checked by the worker;
 * - or, when the Pages project has the RELAY_KEY secret (same value as the worker's), the site adds it
 *   itself for requests coming from its own pages: nothing to type on each device.
 *   Only same-origin browser requests get it (Sec-Fetch-Site / Origin), and the worker still validates,
 *   caps and cleans every relayed signal.
 */
import { json } from "../../../lib/proxy.js";

function sameOrigin(req) {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  return !!origin && origin === new URL(req.url).origin;
}

export async function onRequestPost(ctx) {
  const base = (ctx.env.DISCORD_WORKER_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(base)) return json({ ok: false, error: "DISCORD_WORKER_URL non configurée sur le site" }, 503);
  let key = ctx.request.headers.get("x-relay-key") || "";
  let auto = false;
  if (!key) {
    const siteKey = (ctx.env.RELAY_KEY || "").trim();
    if (!siteKey) return json({ ok: false, error: "code de relais manquant" }, 401);
    if (!sameOrigin(ctx.request)) return json({ ok: false, error: "relais réservé aux pages du site" }, 403);
    key = siteKey;
    auto = true;
  }
  const body = await ctx.request.text();
  if (body.length > 64000) return json({ ok: false, error: "trop gros" }, 413);
  try {
    const r = await fetch(`${base}/relay`, { method: "POST", headers: { "content-type": "application/json", "x-relay-key": key, ...(auto ? { "x-relay-mode": "site" } : {}) }, body });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  } catch {
    return json({ ok: false, error: "bot injoignable" }, 502);
  }
}
