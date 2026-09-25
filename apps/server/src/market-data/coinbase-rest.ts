import { parseProductsPage, type Product } from "@radar/core";
import { buildJwt, jwtUri, type CdpKey } from "../coinbase/jwt.js";
import type { LogFn } from "./source.js";

export interface CoinbasePublicRestOptions {
  baseUrl: string;
  maxRps: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: LogFn;
  /** CDP key for authenticated (read-only) endpoints. */
  key?: CdpKey | null;
}

export class CoinbaseApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "CoinbaseApiError";
  }
}

export interface RateLimitInfo {
  limit: string | null;
  remaining: string | null;
  reset: string | null;
}

const USER_AGENT = "crypto-radar/0.1 (local; public market data)";

/**
 * Client for the PUBLIC Advanced Trade REST endpoints (no authentication).
 * Requests are serialised and spaced to respect `maxRps`.
 */
export class CoinbasePublicRest {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  lastRateLimit: RateLimitInfo | null = null;

  constructor(private readonly opts: CoinbasePublicRestOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + 1000 / this.opts.maxRps - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = Date.now();
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async getJson(pathAndQuery: string, auth = false): Promise<unknown> {
    if (auth && !this.opts.key) throw new CoinbaseApiError("aucune clé API configurée", null, false);
    const url = `${this.opts.baseUrl}${pathAndQuery}`;
    const maxRetries = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.schedule(() => this.once(url, auth));
      } catch (err) {
        const e = err instanceof CoinbaseApiError ? err : new CoinbaseApiError(String((err as Error)?.message ?? err), null, true);
        if (!e.retryable || attempt >= maxRetries) throw e;
        const delay = 1000 * 2 ** attempt;
        this.opts.log?.({ type: "API_ERROR", level: "warn", success: false, message: `REST ${pathAndQuery} échoué (${e.message}), nouvel essai dans ${delay} ms`, data: { status: e.status, attempt } });
        await this.sleep(delay);
      }
    }
  }

  private async once(url: string, auth: boolean): Promise<unknown> {
    let res: Response;
    const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
    // A fresh JWT per request (valid 120 s), bound to the method + path.
    if (auth && this.opts.key) headers.authorization = `Bearer ${buildJwt(this.opts.key, jwtUri("GET", url))}`;
    try {
      res = await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new CoinbaseApiError(`network error: ${(err as Error).message}`, null, true);
    }
    this.lastRateLimit = {
      limit: res.headers.get("x-ratelimit-limit"),
      remaining: res.headers.get("x-ratelimit-remaining"),
      reset: res.headers.get("x-ratelimit-reset"),
    };
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      if (res.status === 401 || res.status === 403) throw new CoinbaseApiError(`HTTP ${res.status} (authentification ou permission refusée)`, res.status, false);
      throw new CoinbaseApiError(`HTTP ${res.status}`, res.status, retryable);
    }
    try {
      return await res.json();
    } catch {
      throw new CoinbaseApiError("invalid JSON body", res.status, false);
    }
  }

  // ─── Authenticated, READ-ONLY endpoints (no order, no transfer) ─────────────

  /** `GET /key_permissions` → can_view, can_trade, can_transfer, portfolio_uuid, portfolio_type. */
  getKeyPermissions(): Promise<unknown> {
    return this.getJson("/key_permissions", true);
  }

  /** `GET /accounts` (cursor pagination). */
  async listAccounts(maxPages = 10): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < maxPages; i++) {
      const q = new URLSearchParams({ limit: "250" });
      if (cursor) q.set("cursor", cursor);
      const page = (await this.getJson(`/accounts?${q}`, true)) as { accounts?: unknown[]; has_next?: boolean; cursor?: string };
      out.push(...(page.accounts ?? []));
      if (!page.has_next || !page.cursor) break;
      cursor = page.cursor;
    }
    return out;
  }

  /** `GET /transaction_summary` → fee tier (maker/taker rates) and 30-day volume. */
  getTransactionSummary(): Promise<unknown> {
    return this.getJson("/transaction_summary", true);
  }

  /** `GET /products?product_type=SPOT&get_tradability_status=true` (authenticated product list). */
  async listAccountSpotProducts(maxPages = 20): Promise<{ products: Product[]; raw: unknown[] }> {
    const pageSize = 250;
    const byId = new Map<string, Product>();
    const raw: unknown[] = [];
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ product_type: "SPOT", get_tradability_status: "true", limit: String(pageSize), offset: String(page * pageSize) });
      const json = (await this.getJson(`/products?${q}`, true)) as { products?: unknown[] };
      const parsed = parseProductsPage(json);
      const before = byId.size;
      for (const p of parsed.products) byId.set(p.productId, p);
      raw.push(...(json.products ?? []));
      if (parsed.rawCount < pageSize || byId.size === before) break;
    }
    return { products: [...byId.values()], raw };
  }

  /** `GET /time` (public). */
  async getServerTime(): Promise<unknown> {
    return this.getJson("/time");
  }

  /**
   * `GET /market/products?product_type=SPOT` with limit/offset pagination.
   * Pagination semantics are not fully documented in the sources available,
   * so the loop stops on a short page, an empty page, a page that brings no
   * new product, or after `maxPages`.
   */
  async listPublicSpotProducts(opts: { pageSize?: number; maxPages?: number } = {}): Promise<{ products: Product[]; invalid: number; pages: number }> {
    const pageSize = opts.pageSize ?? 250;
    const maxPages = opts.maxPages ?? 20;
    const byId = new Map<string, Product>();
    let invalid = 0;
    let pages = 0;
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ product_type: "SPOT", limit: String(pageSize), offset: String(page * pageSize) });
      const parsed = parseProductsPage(await this.getJson(`/market/products?${q}`));
      pages++;
      invalid += parsed.invalid;
      const before = byId.size;
      for (const p of parsed.products) byId.set(p.productId, p);
      if (parsed.rawCount < pageSize || byId.size === before) break;
    }
    return { products: [...byId.values()], invalid, pages };
  }
}
