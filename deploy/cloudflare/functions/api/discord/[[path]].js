/**
 * /api/discord/{stats,signals,leverage,setups,prefs} → the Discord worker (DISCORD_WORKER_URL).
 * GET is public data (no secret inside). POST /prefs needs the relay code
 * (x-relay-key), checked by the worker against its RELAY_KEY secret.
 */
import { json } from "../../../lib/proxy.js";

const GET_PATHS = new Set(["stats", "signals", "leverage", "prefs", "setups", "verdicts"]);

function base(ctx) {
  const b = (ctx.env.DISCORD_WORKER_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9.-]+$/i.test(b) ? b : null;
}

export async function onRequestGet(ctx) {
  const path = [].concat(ctx.params.path ?? []).join("/");
  if (!GET_PATHS.has(path)) return json({ error: "not_allowed" }, 404);
  const b = base(ctx);
  if (!b) return json({ error: "DISCORD_WORKER_URL non configurée sur le site" }, 503);
  const since = new URL(ctx.request.url).searchParams.get("since");
  const q = path === "signals" && since && /^\d{1,15}$/.test(since) ? `?since=${since}` : "";
  try {
    const r = await fetch(`${b}/${path}${q}`, { headers: { accept: "application/json" } });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  } catch {
    return json({ error: "bot injoignable" }, 502);
  }
}

export async function onRequestPost(ctx) {
  const path = [].concat(ctx.params.path ?? []).join("/");
  if (path !== "prefs" && path !== "test-channels") return json({ error: "not_allowed" }, 404);
  const b = base(ctx);
  if (!b) return json({ ok: false, error: "DISCORD_WORKER_URL non configurée sur le site" }, 503);
  const body = await ctx.request.text();
  if (body.length > 32000) return json({ ok: false, error: "trop gros" }, 413);
  try {
    const r = await fetch(`${b}/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-relay-key": ctx.request.headers.get("x-relay-key") || "" }, body });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  } catch {
    return json({ ok: false, error: "bot injoignable" }, 502);
  }
}
