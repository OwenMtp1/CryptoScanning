import { readFileSync } from "node:fs";
import { loadCdpKey, type CdpKey } from "./jwt.js";

/**
 * Credentials are read server-side only, from either:
 *  - COINBASE_API_KEY_FILE: JSON file downloaded from the CDP portal
 *    ({ "name" | "id", "privateKey" }), kept outside git (secrets/ is ignored);
 *  - COINBASE_API_KEY_NAME + COINBASE_API_PRIVATE_KEY.
 */
export function loadCredentials(env: NodeJS.ProcessEnv): { key: CdpKey | null; source: string | null; error: string | null } {
  try {
    if (env.COINBASE_API_KEY_FILE) {
      const j = JSON.parse(readFileSync(env.COINBASE_API_KEY_FILE, "utf8")) as Record<string, unknown>;
      const name = String(j.name ?? j.id ?? "");
      const secret = String(j.privateKey ?? j.private_key ?? "");
      if (!secret) throw new Error("champ privateKey absent du fichier de clé");
      return { key: loadCdpKey(name, secret), source: "fichier", error: null };
    }
    if (env.COINBASE_API_KEY_NAME && env.COINBASE_API_PRIVATE_KEY) {
      return { key: loadCdpKey(env.COINBASE_API_KEY_NAME, env.COINBASE_API_PRIVATE_KEY), source: "variables d'environnement", error: null };
    }
    return { key: null, source: null, error: null };
  } catch (err) {
    // Only the message, never the key material.
    return { key: null, source: null, error: `clé API illisible : ${(err as Error).message}` };
  }
}

/** Non-secret display form of a key name ("organizations/…/apiKeys/…abc123"). */
export function maskKeyName(name: string): string {
  return name.length <= 8 ? "••••" : `…${name.slice(-6)}`;
}
