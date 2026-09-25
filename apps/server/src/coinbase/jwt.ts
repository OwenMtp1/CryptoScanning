/**
 * CDP API key JWT, reproducing the official SDK (coinbase-advanced-py v1.8.4,
 * coinbase/jwt_generator.py):
 *   header  { alg: "ES256" | "EdDSA", typ: "JWT", kid: <key name>, nonce: <random hex> }
 *   claims  { sub: <key name>, iss: "cdp", nbf: now, exp: now + 120, uri?: "GET api.coinbase.com/api/v3/..." }
 * Keys: ECDSA P-256 (SEC1/PKCS8 PEM) or Ed25519 (PKCS8 PEM, or raw base64 32/64 bytes).
 */
import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";

export interface CdpKey {
  name: string;
  key: KeyObject;
  alg: "ES256" | "EdDSA";
}

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** Parse a private key like the official SDK does. Never logs or returns the secret. */
export function loadCdpKey(name: string, secret: string): CdpKey {
  if (!name.trim()) throw new Error("nom de clé API manquant");
  let key: KeyObject;
  const s = secret.replace(/\\n/g, "\n");
  if (s.trimStart().startsWith("-----BEGIN")) {
    key = createPrivateKey({ key: s, format: "pem" });
  } else {
    const raw = Buffer.from(s.split(/\s+/).join(""), "base64");
    if (raw.length !== 32 && raw.length !== 64) throw new Error(`clé Ed25519 brute : 32 ou 64 octets attendus, ${raw.length} reçus`);
    key = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
  }
  const type = key.asymmetricKeyType;
  if (type === "ed25519") return { name, key, alg: "EdDSA" };
  if (type === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return { name, key, alg: "ES256" };
  throw new Error(`type de clé non supporté (${type}) : ECDSA P-256 ou Ed25519 attendu`);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function buildJwt(k: CdpKey, uri: string | null, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = { alg: k.alg, typ: "JWT", kid: k.name, nonce: randomBytes(32).toString("hex") };
  const claims: Record<string, unknown> = { sub: k.name, iss: "cdp", nbf: nowSec, exp: nowSec + 120 };
  if (uri) claims.uri = uri;
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = k.alg === "EdDSA" ? sign(null, Buffer.from(input), k.key) : sign("sha256", Buffer.from(input), { key: k.key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

/** "GET api.coinbase.com/api/v3/brokerage/accounts" — method, host and path, without query string. */
export function jwtUri(method: string, url: string): string {
  const u = new URL(url);
  return `${method.toUpperCase()} ${u.host}${u.pathname}`;
}
