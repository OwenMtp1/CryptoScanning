import { describe, expect, it } from "vitest";
import { REDACTED, redact } from "../src/logging/redact.js";
import { LogQuerySchema, filterEvents, type LogEvent } from "../src/logging/events.js";

describe("redact", () => {
  it("masks sensitive keys at any depth", () => {
    const out = redact({ apiKey: "organizations/x/apiKeys/y", nested: { api_secret: "s", ok: 1, list: [{ jwt: "t" }] }, Authorization: "Bearer abc" });
    expect(out).toEqual({ apiKey: REDACTED, nested: { api_secret: REDACTED, ok: 1, list: [{ jwt: REDACTED }] }, Authorization: REDACTED });
  });

  it("keeps booleans/numbers under sensitive names readable (no false 'configured')", () => {
    expect(redact({ apiKeyConfigured: false, tokenCount: 3, secret: null, apiSecret: { v: "x" } })).toEqual({
      apiKeyConfigured: false,
      tokenCount: 3,
      secret: null,
      apiSecret: REDACTED,
    });
  });

  it("masks PEM keys, JWTs and bearer tokens inside strings", () => {
    const pem = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIA\n-----END EC PRIVATE KEY-----";
    const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJvcmdhbml6YXRpb25zIn0.c2lnbmF0dXJlc2lnbmF0dXJl";
    const s = redact(`key=${pem} token=${jwt} h=Bearer abc.def`);
    expect(s).not.toContain("MHcCAQEEIA");
    expect(s).not.toContain(jwt);
    expect(s).not.toContain("abc.def");
  });

  it("serialises errors without stack traces", () => {
    expect(redact(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
  });
});

describe("filterEvents", () => {
  const ev = (i: number, o: Partial<LogEvent>): LogEvent => ({
    id: String(i),
    ts: new Date(Date.UTC(2026, 8, 25, 10, 0, i)).toISOString(),
    type: "SIGNAL_DETECTED",
    level: "info",
    message: `m${i}`,
    ...o,
  });
  const events = [
    ev(1, { productId: "BTC-EUR" }),
    ev(2, { productId: "SOL-EUR", level: "warn" }),
    ev(3, { type: "API_ERROR", level: "error", success: false }),
    ev(4, { productId: "SOL-EUR", success: true }),
  ];

  it("filters by type, product, level (and above), success and returns newest first", () => {
    const q = (o: Record<string, string>) => filterEvents(events, LogQuerySchema.parse(o)).map((e) => e.id);
    expect(q({})).toEqual(["4", "3", "2", "1"]);
    expect(q({ types: "API_ERROR" })).toEqual(["3"]);
    expect(q({ productId: "SOL-EUR" })).toEqual(["4", "2"]);
    expect(q({ level: "warn" })).toEqual(["3", "2"]);
    expect(q({ success: "false" })).toEqual(["3"]);
    expect(q({ limit: "2" })).toEqual(["4", "3"]);
    expect(q({ from: "2026-09-25T10:00:02Z", to: "2026-09-25T10:00:03Z" })).toEqual(["3", "2"]);
    expect(q({ q: "m1" })).toEqual(["1"]);
  });
});
