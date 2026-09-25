/**
 * Demo persistence. Preferred: the viewer's private space in the artifact
 * database (`data/users/<id>/…`, follows the claude.ai account across
 * devices). Fallback: this browser's localStorage. Both are best effort.
 */
type DbDoc = { get(): Promise<{ exists: boolean; data(): Record<string, unknown> | undefined }>; set(d: Record<string, unknown>): Promise<void> };
type Db = { doc(path: string): DbDoc };
type Claude = { use(name: string): Promise<unknown> };

export type StorageKind = "compte claude.ai" | "ce navigateur" | "aucune (session uniquement)";

export interface DemoStorage {
  kind: StorageKind;
  load(key: string): Promise<unknown | null>;
  /** Queue a save (coalesced: only the latest value is written). */
  save(key: string, value: unknown): void;
  flush(): Promise<void>;
}

const LS_PREFIX = "crypto-radar-demo:";
const MAX_DOC_BYTES = 240_000;

function localStore(): DemoStorage | null {
  try {
    const probe = `${LS_PREFIX}probe`;
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
  } catch {
    return null;
  }
  return {
    kind: "ce navigateur",
    async load(key) {
      try {
        const raw = localStorage.getItem(LS_PREFIX + key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    save(key, value) {
      try {
        localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
      } catch {
        // quota or blocked storage: keep running without persistence
      }
    },
    async flush() {},
  };
}

function memoryStore(): DemoStorage {
  const m = new Map<string, unknown>();
  return { kind: "aucune (session uniquement)", load: async (k) => m.get(k) ?? null, save: (k, v) => void m.set(k, v), flush: async () => {} };
}

function dbStore(db: Db, uid: string, fallback: DemoStorage | null): DemoStorage {
  const pending = new Map<string, string>();
  const written = new Map<string, string>();
  let writing = false;
  let broken = false;
  const self: DemoStorage = {
    kind: "compte claude.ai",
    async load(key) {
      try {
        const snap = await db.doc(`data/users/${uid}/${key}`).get();
        const d = snap.exists ? snap.data() : undefined;
        if (d && typeof d.json === "string") {
          written.set(key, d.json);
          return JSON.parse(d.json);
        }
      } catch {
        // fall through to local copy
      }
      return fallback ? fallback.load(key) : null;
    },
    save(key, value) {
      const json = JSON.stringify(value);
      fallback?.save(key, value); // local copy too (instant, offline)
      if (broken || written.get(key) === json) return;
      if (json.length > MAX_DOC_BYTES) return; // over the document limit: local copy only
      pending.set(key, json);
    },
    async flush() {
      if (writing || broken) return;
      writing = true;
      try {
        // One write at a time per document, latest value only.
        for (const [key, json] of [...pending]) {
          pending.delete(key);
          if (written.get(key) === json) continue;
          try {
            await db.doc(`data/users/${uid}/${key}`).set({ json, savedAt: new Date().toISOString() });
            written.set(key, json);
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === "invalid_argument" || code === "revoked" || code === "not_granted" || code === "quota_exceeded") {
              broken = true;
              self.kind = fallback ? "ce navigateur" : "aucune (session uniquement)";
            } else pending.set(key, json); // transient: retry at next flush
          }
        }
      } finally {
        writing = false;
      }
    },
  };
  return self;
}

export async function createStorage(): Promise<DemoStorage> {
  const local = localStore();
  const claude = (globalThis as { claude?: Claude }).claude;
  if (claude?.use) {
    try {
      const [db, user] = (await Promise.all([claude.use("db"), claude.use("user")])) as [Db | null, { id(): Promise<string | null> } | null];
      const uid = user ? await user.id() : null;
      if (db && uid) return dbStore(db, uid, local);
    } catch {
      // no capability: fall back below
    }
  }
  return local ?? memoryStore();
}
