/** GET /api/news → list of the whitelisted feeds (the browser then reads each one). */
import { FEEDS, json } from "../../../lib/proxy.js";

export function onRequestGet() {
  return json({ feeds: FEEDS.map(({ id, name, url, lang, kind }) => ({ id, name, url, lang, kind: kind ?? "news" })) }, 200, 3600);
}
