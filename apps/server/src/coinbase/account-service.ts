import { z } from "zod";
import type { CoinbasePublicRest } from "../market-data/coinbase-rest.js";
import type { LogFn } from "../market-data/source.js";
import { maskKeyName } from "./credentials.js";
import type { CdpKey } from "./jwt.js";

/**
 * Read-only Coinbase account integration.
 *
 * Least privilege is ENFORCED: a key with `can_transfer = true` is refused
 * and never used again. No endpoint that places orders or moves funds is
 * called anywhere in this service.
 */
const decimal = z.union([z.string(), z.number()]).transform((v) => Number(v)).pipe(z.number().finite());

export const KeyPermissionsSchema = z.object({
  can_view: z.boolean(),
  can_trade: z.boolean(),
  can_transfer: z.boolean(),
  portfolio_uuid: z.string().optional(),
  portfolio_type: z.string().optional(),
});
const AccountSchema = z.object({
  uuid: z.string(),
  currency: z.string(),
  name: z.string().optional(),
  available_balance: z.object({ value: decimal, currency: z.string() }).optional(),
  hold: z.object({ value: decimal, currency: z.string() }).optional(),
  active: z.boolean().optional(),
  retail_portfolio_id: z.string().optional(),
});
const SummarySchema = z.object({
  total_volume: decimal.optional(),
  total_fees: decimal.optional(),
  fee_tier: z
    .object({
      pricing_tier: z.string().optional(),
      taker_fee_rate: decimal.optional(),
      maker_fee_rate: decimal.optional(),
    })
    .optional(),
});

export type AccountState = "disabled" | "connecting" | "connected" | "refused" | "error";

export interface AccountStatus {
  configured: boolean;
  state: AccountState;
  message: string | null;
  keyName: string | null;
  keySource: string | null;
  algorithm: string | null;
  permissions: { canView: boolean; canTrade: boolean; canTransfer: boolean; portfolioUuid: string | null; portfolioType: string | null } | null;
  balances: { currency: string; available: number; hold: number }[];
  fees: { pricingTier: string | null; takerFeePct: number | null; makerFeePct: number | null; volume30d: number | null } | null;
  accountProducts: number | null;
  lastSyncAt: number | null;
  /** Orders are not implemented (LIVE phase). */
  tradingEnabled: false;
}

const REFRESH_MS = 5 * 60_000;

/** Fee rates are returned as fractions (e.g. "0.006" = 0.6 %). Values outside [0, 5 %] are rejected as implausible. */
export function feeRateToPct(rate: number | undefined): number | null {
  if (rate === undefined || !Number.isFinite(rate) || rate < 0 || rate > 0.05) return null;
  return rate * 100;
}

export class AccountService {
  private status: AccountStatus;
  private timer: ReturnType<typeof setInterval> | null = null;
  private accountProductIds: Set<string> | null = null;

  constructor(
    private readonly rest: CoinbasePublicRest,
    private readonly key: CdpKey | null,
    keySource: string | null,
    keyError: string | null,
    private readonly log: LogFn,
    /** Called after each successful sync (fees + products available to the account). */
    private readonly onSync: (takerPct: number | null, productIds: ReadonlySet<string>) => void = () => {},
  ) {
    this.status = {
      configured: !!key,
      state: keyError ? "error" : key ? "connecting" : "disabled",
      message: keyError ?? (key ? null : "aucune clé API configurée (mode public)"),
      keyName: key ? maskKeyName(key.name) : null,
      keySource,
      algorithm: key?.alg ?? null,
      permissions: null,
      balances: [],
      fees: null,
      accountProducts: null,
      lastSyncAt: null,
      tradingEnabled: false,
    };
    if (keyError) log({ type: "API_ERROR", level: "error", success: false, message: `Coinbase : ${keyError}` });
  }

  view(): AccountStatus {
    return this.status;
  }

  /** Products available to this account (null when not connected). */
  productIds(): ReadonlySet<string> | null {
    return this.status.state === "connected" ? this.accountProductIds : null;
  }

  async start() {
    if (!this.key || this.status.state === "error") return;
    await this.sync();
    if (this.status.state === "connected") this.timer = setInterval(() => void this.sync(), REFRESH_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sync() {
    if (!this.key || this.status.state === "refused") return;
    try {
      const perms = KeyPermissionsSchema.parse(await this.rest.getKeyPermissions());
      this.status.permissions = {
        canView: perms.can_view,
        canTrade: perms.can_trade,
        canTransfer: perms.can_transfer,
        portfolioUuid: perms.portfolio_uuid ?? null,
        portfolioType: perms.portfolio_type ?? null,
      };
      if (perms.can_transfer) {
        this.status.state = "refused";
        this.status.message = "clé REFUSÉE : elle a la permission Transfer (retraits/transferts). Crée une clé View (+ Trade plus tard) sans Transfer.";
        this.stop();
        this.log({ type: "API_ERROR", level: "error", success: false, message: `Coinbase : ${this.status.message}`, data: { permissions: this.status.permissions } });
        return;
      }
      if (!perms.can_view) throw new Error("la clé n'a pas la permission View");

      const accounts = (await this.rest.listAccounts()).flatMap((a) => {
        const r = AccountSchema.safeParse(a);
        return r.success ? [r.data] : [];
      });
      this.status.balances = accounts
        .map((a) => ({ currency: a.currency, available: a.available_balance?.value ?? 0, hold: a.hold?.value ?? 0 }))
        .filter((b) => b.available > 0 || b.hold > 0)
        .sort((x, y) => x.currency.localeCompare(y.currency));

      const summary = SummarySchema.parse(await this.rest.getTransactionSummary());
      const taker = feeRateToPct(summary.fee_tier?.taker_fee_rate);
      this.status.fees = {
        pricingTier: summary.fee_tier?.pricing_tier ?? null,
        takerFeePct: taker,
        makerFeePct: feeRateToPct(summary.fee_tier?.maker_fee_rate),
        volume30d: summary.total_volume ?? null,
      };
      const products = await this.rest.listAccountSpotProducts();
      this.accountProductIds = new Set(products.products.map((p) => p.productId));
      this.status.accountProducts = this.accountProductIds.size;
      this.onSync(taker, this.accountProductIds);

      const first = this.status.state !== "connected";
      this.status.state = "connected";
      this.status.message = null;
      this.status.lastSyncAt = Date.now();
      if (first)
        this.log({
          type: "SYSTEM_STARTED",
          level: "info",
          success: true,
          message: `Coinbase connecté en lecture seule (clé ${this.status.keyName}, ${this.key.alg}) — portfolio ${perms.portfolio_type ?? "?"}, ${this.status.balances.length} solde(s), frais taker ${taker === null ? "?" : `${taker.toFixed(3)} %`}, ${products.products.length} produits disponibles pour le compte`,
          data: { permissions: this.status.permissions, fees: this.status.fees },
        });
    } catch (err) {
      this.status.state = "error";
      this.status.message = (err as Error).message;
      this.log({ type: "API_ERROR", level: "error", success: false, message: `Coinbase (compte) : ${(err as Error).message}` });
    }
  }
}
