import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { SignalConfigSchema, TradingConfigSchema, type SignalConfig, type TradingConfig } from "@radar/core";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const csv = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));

/**
 * Server configuration from environment variables (see .env.example).
 * Phase 1 needs NO Coinbase credentials: only public market data is used.
 */
export const EnvSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  /** RADAR (observe) or PAPER (simulated trading). LIVE is refused at startup. */
  MODE: z.string().default("RADAR"),
  DATA_SOURCE: z.enum(["simulated", "coinbase"]).default("simulated"),
  QUOTE_CURRENCIES: csv.default(["EUR", "USDC"]),
  MAX_PRODUCTS: z.coerce.number().int().min(0).max(1000).default(100),
  COINBASE_REST_BASE_URL: z.url().default("https://api.coinbase.com/api/v3/brokerage"),
  COINBASE_WS_URL: z.url().default("wss://advanced-trade-ws.coinbase.com"),
  /** Conservative default: the documented public REST limits are ambiguous (see docs). */
  COINBASE_REST_MAX_RPS: z.coerce.number().positive().max(10).default(3),
  WS_PRODUCTS_PER_CONNECTION: z.coerce.number().int().min(1).max(500).default(25),
  /** Documented unauthenticated WS limit is 8 msg/s per IP; stay well below. */
  WS_MAX_SUBSCRIBE_MSG_PER_SEC: z.coerce.number().positive().max(8).default(4),
  EVAL_INTERVAL_MS: z.coerce.number().int().min(200).max(10_000).default(1000),
  SIM_SEED: z.coerce.number().int().default(42),
  SIM_TICK_MS: z.coerce.number().int().min(50).max(5000).default(250),
  LOG_DIR: z.string().default("data/logs"),
  SIGNAL_CONFIG_FILE: z.string().default("config/signal-config.json"),
  TRADING_CONFIG_FILE: z.string().default("config/trading.json"),
  PAPER_DATA_DIR: z.string().default("data/paper"),
  /** Comma-separated list of dashboard origins allowed by CORS. */
  DASHBOARD_ORIGINS: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
    .default(["http://localhost:3000", "http://127.0.0.1:3000"]),
});

export type Env = z.infer<typeof EnvSchema> & { logDir: string; signalConfigPath: string; tradingConfigPath: string; paperDataDir: string };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = EnvSchema.parse(source);
  return {
    ...env,
    logDir: path.resolve(REPO_ROOT, env.LOG_DIR),
    signalConfigPath: path.resolve(REPO_ROOT, env.SIGNAL_CONFIG_FILE),
    tradingConfigPath: path.resolve(REPO_ROOT, env.TRADING_CONFIG_FILE),
    paperDataDir: path.resolve(REPO_ROOT, env.PAPER_DATA_DIR),
  };
}

/** Load the signal configuration file (optional). Invalid files are a hard error. */
export function loadSignalConfig(file: string): { config: SignalConfig; source: "file" | "defaults" } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { config: SignalConfigSchema.parse({}), source: "defaults" };
  }
  return { config: SignalConfigSchema.parse(JSON.parse(raw)), source: "file" };
}

/** Load the trading configuration file (optional). Invalid files are a hard error. */
export function loadTradingConfig(file: string): { config: TradingConfig; source: "file" | "defaults" } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { config: TradingConfigSchema.parse({}), source: "defaults" };
  }
  return { config: TradingConfigSchema.parse(JSON.parse(raw)), source: "file" };
}
