/**
 * The dashboard only talks to the LOCAL radar API. It never talks to
 * Coinbase and never handles any secret.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";

export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Safety controls only (emergency stop, resume, paper reset). The custom
 * header is required by the server: it cannot be sent cross-site without a
 * CORS preflight that only the dashboard origin passes.
 */
export async function postAction<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-radar-action": "confirm" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  if (!res.ok) throw new Error(json.reason ?? json.error ?? `HTTP ${res.status}`);
  return json;
}
