/** Small fetch wrapper: timeout, size cap, no secret in errors. Works in Node 22 and browsers. */
export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text: string;
}
export type FetchText = (url: string, init?: { headers?: Record<string, string>; method?: string; body?: string; timeoutMs?: number }) => Promise<HttpResponse>;

const MAX_BYTES = 8 * 1024 * 1024;

export const fetchText: FetchText = async (url, init = {}) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, { method: init.method ?? "GET", headers: init.headers, body: init.body, signal: ctrl.signal, redirect: "follow" });
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) throw new Error(`réponse trop grande (${len} octets)`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("réponse trop grande");
    return { status: res.status, headers: res.headers, text };
  } catch (err) {
    const e = err as Error;
    throw new Error(e.name === "AbortError" ? "délai dépassé" : e.message);
  } finally {
    clearTimeout(timer);
  }
};
