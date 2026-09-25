import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AccountService, feeRateToPct } from "../src/coinbase/account-service.js";
import { loadCredentials, maskKeyName } from "../src/coinbase/credentials.js";
import { buildJwt, jwtUri, loadCdpKey } from "../src/coinbase/jwt.js";
import { CoinbasePublicRest } from "../src/market-data/coinbase-rest.js";

const NAME = "organizations/org-123/apiKeys/key-456";
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const EC_PEM = ec.privateKey.export({ format: "pem", type: "sec1" }).toString();
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());

describe("CDP JWT (same structure as the official SDK)", () => {
  it("ES256: header/claims and a valid P-1363 signature", () => {
    const k = loadCdpKey(NAME, EC_PEM);
    const t = buildJwt(k, jwtUri("GET", "https://api.coinbase.com/api/v3/brokerage/accounts?limit=250&cursor=x"), 1_000);
    const [h, c, s] = t.split(".") as [string, string, string];
    expect(decode(h)).toMatchObject({ alg: "ES256", typ: "JWT", kid: NAME });
    expect(decode(h).nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(decode(c)).toEqual({ sub: NAME, iss: "cdp", nbf: 1000, exp: 1120, uri: "GET api.coinbase.com/api/v3/brokerage/accounts" });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("EdDSA from a raw base64 key (CDP portal format) and escaped PEM newlines", () => {
    const ed = generateKeyPairSync("ed25519");
    const raw = Buffer.from(ed.privateKey.export({ format: "der", type: "pkcs8" })).subarray(-32).toString("base64");
    const k = loadCdpKey(NAME, raw);
    expect(k.alg).toBe("EdDSA");
    const [h, c, s] = buildJwt(k, null).split(".") as [string, string, string];
    expect(decode(c)).not.toHaveProperty("uri");
    expect(verify(null, Buffer.from(`${h}.${c}`), ed.publicKey, Buffer.from(s, "base64url"))).toBe(true);
    expect(loadCdpKey(NAME, EC_PEM.replace(/\n/g, "\\n")).alg).toBe("ES256");
  });

  it("refuses unsupported keys", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => loadCdpKey(NAME, rsa)).toThrow(/non supporté/);
    expect(() => loadCdpKey(NAME, "c2hvcnQ=")).toThrow(/32 ou 64/);
  });
});

describe("credentials", () => {
  it("loads from the CDP JSON file or env vars; errors never contain the secret", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cb-key-"));
    const file = path.join(dir, "k.json");
    writeFileSync(file, JSON.stringify({ name: NAME, privateKey: EC_PEM }));
    expect(loadCredentials({ COINBASE_API_KEY_FILE: file })).toMatchObject({ source: "fichier", error: null });
    expect(loadCredentials({ COINBASE_API_KEY_NAME: NAME, COINBASE_API_PRIVATE_KEY: EC_PEM }).key?.alg).toBe("ES256");
    expect(loadCredentials({})).toEqual({ key: null, source: null, error: null });
    const bad = loadCredentials({ COINBASE_API_KEY_NAME: NAME, COINBASE_API_PRIVATE_KEY: "-----BEGIN EC PRIVATE KEY-----\nSECRETSTUFF\n-----END EC PRIVATE KEY-----" });
    expect(bad.key).toBeNull();
    expect(bad.error).not.toContain("SECRETSTUFF");
    expect(maskKeyName(NAME)).toBe("…ey-456");
  });
});

type Route = Record<string, unknown | ((url: URL) => unknown)>;
function fakeFetch(routes: Route, seen: { url: string; auth: string | null }[] = []) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
    seen.push({ url: url.pathname + url.search, auth });
    const key = Object.keys(routes).find((k) => url.pathname.endsWith(k));
    if (!key) return new Response("{}", { status: 404 });
    const r = routes[key];
    const body = typeof r === "function" ? (r as (u: URL) => unknown)(url) : r;
    if (typeof body === "number") return new Response("{}", { status: body });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const okRoutes = (perms: Record<string, unknown>): Route => ({
  "/key_permissions": { can_view: true, can_trade: false, can_transfer: false, portfolio_uuid: "p-1", portfolio_type: "CONSUMER", ...perms },
  "/accounts": { accounts: [{ uuid: "a", currency: "EUR", available_balance: { value: "123.45", currency: "EUR" }, hold: { value: "0", currency: "EUR" } }, { uuid: "b", currency: "DOGE", available_balance: { value: "0", currency: "DOGE" } }], has_next: false },
  "/transaction_summary": { total_volume: 1500, fee_tier: { pricing_tier: "Advanced 1", taker_fee_rate: "0.006", maker_fee_rate: "0.004" } },
  "/products": { products: [{ product_id: "BTC-EUR", product_type: "SPOT", status: "online" }, { product_id: "SOL-EUR", product_type: "SPOT", status: "online" }] },
});

function service(routes: Route, seen: { url: string; auth: string | null }[] = []) {
  const key = loadCdpKey(NAME, EC_PEM);
  const rest = new CoinbasePublicRest({ baseUrl: "https://api.coinbase.com/api/v3/brokerage", maxRps: 1000, fetchImpl: fakeFetch(routes, seen), sleep: async () => {}, key });
  const log = vi.fn();
  const onSync = vi.fn();
  return { svc: new AccountService(rest, key, "test", null, log, onSync), log, onSync };
}

describe("AccountService (read-only)", () => {
  it("syncs permissions, balances, real fees and account products", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const { svc, onSync } = service(okRoutes({}), seen);
    await svc.sync();
    const v = svc.view();
    expect(v.state).toBe("connected");
    expect(v.permissions).toMatchObject({ canView: true, canTransfer: false, portfolioType: "CONSUMER" });
    expect(v.balances).toEqual([{ currency: "EUR", available: 123.45, hold: 0 }]);
    expect(v.fees).toMatchObject({ pricingTier: "Advanced 1", volume30d: 1500 });
    expect(v.fees?.takerFeePct).toBeCloseTo(0.6);
    expect(v.tradingEnabled).toBe(false);
    expect([...svc.productIds()!]).toEqual(["BTC-EUR", "SOL-EUR"]);
    expect(onSync).toHaveBeenCalledWith(expect.closeTo(0.6, 9), expect.any(Set));
    expect(seen.every((r) => r.auth?.startsWith("Bearer ey"))).toBe(true);
    expect(seen.find((r) => r.url.startsWith("/api/v3/brokerage/products"))!.url).toContain("get_tradability_status=true");
    // Only GET endpoints, never orders/transfers.
    expect(seen.some((r) => /orders|transfer|withdraw|move_funds|convert/.test(r.url))).toBe(false);
  });

  it("REFUSES a key with the Transfer permission and stops using it", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const { svc, log } = service(okRoutes({ can_transfer: true }), seen);
    await svc.sync();
    expect(svc.view().state).toBe("refused");
    expect(svc.productIds()).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ level: "error", message: expect.stringMatching(/REFUSÉE/) }));
    const calls = seen.length;
    await svc.sync();
    expect(seen.length).toBe(calls); // never called again
  });

  it("reports auth errors without retrying forever", async () => {
    const { svc } = service({ "/key_permissions": 401 });
    await svc.sync();
    expect(svc.view()).toMatchObject({ state: "error", message: expect.stringMatching(/401/) });
  });

  it("ignores implausible fee rates", () => {
    expect(feeRateToPct(0.012)).toBeCloseTo(1.2);
    expect(feeRateToPct(0.6)).toBeNull(); // would be 60 %: not a fraction
    expect(feeRateToPct(undefined)).toBeNull();
  });

  it("public mode when no key is configured", () => {
    const rest = new CoinbasePublicRest({ baseUrl: "https://x", maxRps: 10 });
    const s = new AccountService(rest, null, null, null, vi.fn());
    expect(s.view()).toMatchObject({ configured: false, state: "disabled" });
  });
});
