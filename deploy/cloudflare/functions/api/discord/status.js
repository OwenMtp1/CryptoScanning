/**
 * GET /api/discord/status → public status of the Discord worker (DISCORD_WORKER_URL, no secret inside).
 * `autoRelay`: the site holds the relay code (RELAY_KEY secret of the Pages project), so its pages relay
 * without anyone typing the code.
 */
import { json } from "../../../lib/proxy.js";

export async function onRequestGet(ctx) {
  const base = (ctx.env.DISCORD_WORKER_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(base)) return json({ configured: false, error: "DISCORD_WORKER_URL non configurée sur le site" }, 200, 30);
  try {
    const r = await fetch(`${base}/`, { headers: { accept: "application/json" } });
    if (r.status !== 200) return json({ configured: true, error: `bot injoignable (HTTP ${r.status})` }, 200, 15);
    return json({ configured: true, autoRelay: !!(ctx.env.RELAY_KEY || "").trim(), status: await r.json() }, 200, 15);
  } catch {
    return json({ configured: true, error: "bot injoignable" }, 200, 15);
  }
}
