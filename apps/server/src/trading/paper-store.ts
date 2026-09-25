import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StateSchema, type PaperStateFile } from "./paper-state.js";

export type { PaperStateFile } from "./paper-state.js";

export class PaperStore {
  readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "state.json");
  }

  /**
   * Load the saved state. A corrupted file is a hard error: the paper
   * portfolio is never silently reset.
   */
  load(): PaperStateFile | null {
    if (!existsSync(this.file)) return null;
    const parsed = StateSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
    if (!parsed.success) {
      throw new Error(`état paper invalide (${this.file}) : ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
    }
    return parsed.data as unknown as PaperStateFile;
  }

  save(state: PaperStateFile) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.file);
  }
}
