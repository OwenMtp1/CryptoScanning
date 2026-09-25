import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, loadEnv, loadSignalConfig } from "../src/config/env.js";

describe("env", () => {
  it("defaults to the simulated RADAR setup bound to localhost", () => {
    const env = loadEnv({});
    expect(env).toMatchObject({ HOST: "127.0.0.1", MODE: "RADAR", DATA_SOURCE: "simulated", QUOTE_CURRENCIES: ["EUR", "USDC"] });
    expect(env.COINBASE_WS_URL).toBe("wss://advanced-trade-ws.coinbase.com");
  });

  it("rejects invalid values", () => {
    expect(() => loadEnv({ DATA_SOURCE: "binance" })).toThrow();
    expect(() => loadEnv({ WS_MAX_SUBSCRIBE_MSG_PER_SEC: "50" })).toThrow();
  });

  it("loads and validates the signal config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "radar-cfg-"));
    const good = path.join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ opportunity: { minScore: 80 } }));
    expect(loadSignalConfig(good).config.opportunity.minScore).toBe(80);
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ opportunity: { minScore: 500 } }));
    expect(() => loadSignalConfig(bad)).toThrow();
    expect(loadSignalConfig(path.join(dir, "missing.json")).source).toBe("defaults");
  });

  it("ships a valid example signal config", () => {
    expect(loadSignalConfig(path.join(REPO_ROOT, "config/signal-config.example.json")).source).toBe("file");
  });
});
