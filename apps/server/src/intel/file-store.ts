import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Small JSON file store with atomic writes (write to .tmp, then rename). */
export class JsonFileStore {
  constructor(private readonly file: string) {}

  load(): unknown | null {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as unknown;
    } catch {
      return null;
    }
  }

  save(data: unknown) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.file);
  }
}
