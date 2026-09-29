/**
 * POST /api/discord/relay → forwards the site's signals to the Discord worker.
 * The relay code (header x-relay-key) is checked by the worker (RELAY_KEY secret):
 * without it nobody can post to your Discord through this endpoint.
 */
import { json } from "../../../lib/proxy.js";

export async function onRequestPost(ctx) {
  const base = (ctx.env.DISCORD_WORKER_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(base)) return json({ ok: false, error: "DISCORD_WORKER_URL non configurée sur le site" }, 503);
  const key = ctx.request.headers.get("x-relay-key") || "";
  if (!key) return json({ ok: false, error: "code de relais manquant" }, 401);
  const body = await ctx.request.text();
  if (body.length > 64000) return json({ ok: false, error: "trop gros" }, 413);
  try {
    const r = await fetch(`${base}/relay`, { method: "POST", headers: { "content-type": "application/json", "x-relay-key": key }, body });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  } catch {
    return json({ ok: false, error: "bot injoignable" }, 502);
  }
}
