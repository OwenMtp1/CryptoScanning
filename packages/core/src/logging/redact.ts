/**
 * Remove secrets from anything that is about to be logged or sent to the
 * dashboard. Keys are matched by name; values that look like PEM keys or
 * JWTs are masked wherever they appear.
 */
const SENSITIVE_KEY = /(secret|private|passw|token|jwt|authorization|api[-_]?key|signature|credential|cookie)/i;
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export const REDACTED = "[REDACTED]";

export function redactString(s: string): string {
  return s.replace(PEM, REDACTED).replace(JWT, REDACTED).replace(BEARER, `Bearer ${REDACTED}`);
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return "[TRUNCATED]" as T;
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    if (value instanceof Error) return { name: value.name, message: redactString(value.message) } as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Booleans, numbers and null cannot carry a secret (e.g. `apiKeyConfigured: false`)
      // and must stay readable; any other value under a sensitive key is masked.
      const harmless = v === null || typeof v === "boolean" || typeof v === "number";
      out[k] = SENSITIVE_KEY.test(k) && !harmless ? REDACTED : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
