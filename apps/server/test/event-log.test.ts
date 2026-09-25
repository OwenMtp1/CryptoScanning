import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LogQuerySchema } from "@radar/core";
import { EventLog } from "../src/logging/event-log.js";

describe("EventLog", () => {
  it("timestamps, redacts, persists to daily JSONL and reloads on restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "radar-log-"));
    const now = () => new Date("2026-09-25T10:00:00Z");
    const log = new EventLog({ dir, console: false, now });
    log.emit({ type: "API_ERROR", level: "error", message: "boom Bearer abc.def", data: { api_secret: "S3CR3T", nested: { ok: 1 } } });
    log.emit({ type: "WS_CONNECTING", level: "debug", message: "not persisted" });
    await log.close();

    const files = readdirSync(dir);
    expect(files).toEqual(["events-2026-09-25.jsonl"]);
    const content = readFileSync(path.join(dir, files[0]!), "utf8");
    expect(content).not.toContain("S3CR3T");
    expect(content).not.toContain("abc.def");
    expect(content).not.toContain("not persisted");
    const e = JSON.parse(content.trim());
    expect(e).toMatchObject({ ts: "2026-09-25T10:00:00.000Z", type: "API_ERROR", data: { api_secret: "[REDACTED]", nested: { ok: 1 } } });
    expect(e.id).toMatch(/[0-9a-f-]{36}/);

    const reloaded = new EventLog({ dir, console: false, now });
    expect(reloaded.query(LogQuerySchema.parse({})).map((x) => x.type)).toEqual(["API_ERROR"]);
    await reloaded.close();
  });

  it("notifies subscribers and bounds the memory buffer", () => {
    const log = new EventLog({ dir: null, console: false, bufferSize: 3 });
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.message));
    for (let i = 0; i < 5; i++) log.emit({ type: "SIGNAL_DETECTED", level: "info", message: `m${i}` });
    off();
    log.emit({ type: "SIGNAL_DETECTED", level: "info", message: "after" });
    expect(seen).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(log.query(LogQuerySchema.parse({})).map((e) => e.message)).toEqual(["after", "m4", "m3"]);
  });
});
