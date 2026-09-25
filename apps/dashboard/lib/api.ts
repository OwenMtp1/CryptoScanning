/**
 * The dashboard only talks to the LOCAL radar API. It never talks to
 * Coinbase and never handles any secret.
 *
 * In the standalone demo build, the same engine runs inside the page and
 * registers itself as `globalThis.__RADAR_DEMO__`; calls are routed to it.
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";

export interface DemoBackend {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<{ status: number; body: unknown }>;
  /** Server-sent-event equivalent; returns an unsubscribe function. */
  subscribe(onEvent: (event: string, data: unknown) => void): () => void;
}

export function demoBackend(): DemoBackend | null {
  return ((globalThis as { __RADAR_DEMO__?: DemoBackend }).__RADAR_DEMO__ ?? null) as DemoBackend | null;
}

export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const demo = demoBackend();
  if (demo) return (await demo.get(path)) as T;
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Safety controls and Strategy Builder actions. The custom header is
 * required by the server: it cannot be sent cross-site without a CORS
 * preflight that only the dashboard origin passes.
 */
export async function postAction<T>(path: string, body: unknown): Promise<T> {
  const demo = demoBackend();
  if (demo) {
    const r = await demo.post(path, body);
    const json = r.body as T & { error?: string; reason?: string; issues?: string[] };
    if (r.status >= 400) throw new Error(json.issues?.join(" ; ") ?? json.reason ?? json.error ?? `HTTP ${r.status}`);
    return json;
  }
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-radar-action": "confirm" },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string; issues?: string[] };
  if (!res.ok) throw new Error(json.issues?.join(" ; ") ?? json.reason ?? json.error ?? `HTTP ${res.status}`);
  return json;
}
