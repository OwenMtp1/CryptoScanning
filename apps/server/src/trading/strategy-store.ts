import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StrategiesFileSchema, type Strategy } from "@radar/core";

/**
 * Strategies edited in the Strategy Builder (data/strategies.json).
 * When present, this file replaces the strategies of config/trading.json.
 * A corrupted file is a hard error (never silently ignored).
 */
export class StrategyStore {
  readonly file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "strategies.json");
  }

  load(): Strategy[] | null {
    if (!existsSync(this.file)) return null;
    const parsed = StrategiesFileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new Error(`fichier de stratégies invalide (${this.file}) : ${i?.path.join(".")} ${i?.message}`);
    }
    return parsed.data.strategies;
  }

  save(strategies: Strategy[]) {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), strategies }, null, 2));
    renameSync(tmp, this.file);
  }
}
