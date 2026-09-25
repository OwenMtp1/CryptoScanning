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
