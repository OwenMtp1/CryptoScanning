import { ListProductsResponseSchema, RestProductSchema, type RestProduct } from "./schemas.js";
import type { Product } from "../market/types.js";

export function normalizeProduct(p: RestProduct): Product {
  const [baseFromId = "", quoteFromId = ""] = p.product_id.split("-");
  return {
    productId: p.product_id,
    baseCurrency: p.base_currency_id || p.base_display_symbol || baseFromId,
    quoteCurrency: p.quote_currency_id || p.quote_display_symbol || quoteFromId,
    baseName: p.base_name ?? "",
    displayName: p.display_name ?? p.product_id,
    productType: p.product_type ?? "UNKNOWN",
    status: p.status ?? "unknown",
    price: p.price ?? null,
    pctChange24h: p.price_percentage_change_24h ?? null,
    volume24hBase: p.volume_24h ?? null,
    volume24hQuote:
      p.approximate_quote_24h_volume ??
      (p.volume_24h !== undefined && p.price !== undefined ? p.volume_24h * p.price : null),
    baseMinSize: p.base_min_size ?? null,
    quoteMinSize: p.quote_min_size ?? null,
    baseIncrement: p.base_increment ?? null,
    quoteIncrement: p.quote_increment ?? null,
    priceIncrement: p.price_increment ?? null,
    flags: {
      tradingDisabled: p.trading_disabled ?? false,
      isDisabled: p.is_disabled ?? false,
      cancelOnly: p.cancel_only ?? false,
      limitOnly: p.limit_only ?? false,
      postOnly: p.post_only ?? false,
      viewOnly: p.view_only ?? false,
      auctionMode: p.auction_mode ?? false,
      isNew: p.new ?? false,
    },
    alias: p.alias ? p.alias : null,
    aliasTo: p.alias_to ?? [],
    tradabilityVerified: false,
  };
}

export interface ParsedProductsPage {
  products: Product[];
  rawCount: number;
  invalid: number;
}

/** Parse one page of `GET /market/products`. Invalid items are counted, not thrown. */
export function parseProductsPage(json: unknown): ParsedProductsPage {
  const page = ListProductsResponseSchema.parse(json);
  const products: Product[] = [];
  let invalid = 0;
  for (const item of page.products) {
    const r = RestProductSchema.safeParse(item);
    if (r.success) products.push(normalizeProduct(r.data));
    else invalid++;
  }
  return { products, rawCount: page.products.length, invalid };
}

export type ProductRejectReason =
  | "not_spot"
  | "not_online"
  | "disabled"
  | "cancel_only"
  | "view_only"
  | "auction_mode"
  | "quote_not_allowed"
  | "alias_duplicate";

export interface ProductFilterOptions {
  /** Allowed quote currencies, e.g. ["EUR", "USDC"]. Empty = all. */
  quoteCurrencies: string[];
  /** Keep at most N products, ranked by 24h quote volume. 0 = unlimited. */
  maxProducts: number;
  /** Always included when eligible, even outside quoteCurrencies or the cap (e.g. BTC-EUR for valuation). */
  required?: string[];
}

export interface ProductFilterResult {
  selected: Product[];
  rejected: Record<ProductRejectReason, number>;
  eligibleBeforeCap: number;
}

/**
 * Select products that are plausibly tradable from public data alone.
 *
 * Note: real account/region tradability can only be confirmed by the
 * authenticated endpoint (`get_tradability_status`), not in phase 1.
 *
 * Alias handling (heuristic, documented): a product whose `alias` names
 * another product that is also selected is skipped, to avoid subscribing
 * twice to the same underlying book.
 */
export function filterRadarProducts(products: Product[], opts: ProductFilterOptions): ProductFilterResult {
  const rejected: Record<ProductRejectReason, number> = {
    not_spot: 0,
    not_online: 0,
    disabled: 0,
    cancel_only: 0,
    view_only: 0,
    auction_mode: 0,
    quote_not_allowed: 0,
    alias_duplicate: 0,
  };
  const quotes = new Set(opts.quoteCurrencies.map((q) => q.toUpperCase()));
  const required = new Set(opts.required ?? []);
  const eligible: Product[] = [];
  const requiredEligible: Product[] = [];
  for (const p of products) {
    let reason: ProductRejectReason | null = null;
    if (p.productType !== "SPOT") reason = "not_spot";
    else if (p.status.toLowerCase() !== "online") reason = "not_online";
    else if (p.flags.tradingDisabled || p.flags.isDisabled) reason = "disabled";
    else if (p.flags.cancelOnly) reason = "cancel_only";
    else if (p.flags.viewOnly) reason = "view_only";
    else if (p.flags.auctionMode) reason = "auction_mode";
    else if (quotes.size > 0 && !quotes.has(p.quoteCurrency.toUpperCase())) reason = "quote_not_allowed";
    if (reason === "quote_not_allowed" && required.has(p.productId)) requiredEligible.push(p);
    else if (reason) rejected[reason]++;
    else eligible.push(p);
  }

  const byId = new Map(eligible.map((p) => [p.productId, p]));
  const deduped = eligible.filter((p) => {
    const target = p.alias && p.alias !== p.productId ? byId.get(p.alias) : undefined;
    // Skip only if the target does not itself point back (avoid dropping both).
    if (target && target.alias !== p.productId) {
      rejected.alias_duplicate++;
      return false;
    }
    return true;
  });

  deduped.sort((a, b) => (b.volume24hQuote ?? 0) - (a.volume24hQuote ?? 0));
  const selected = opts.maxProducts > 0 ? deduped.slice(0, opts.maxProducts) : deduped;
  for (const p of [...deduped, ...requiredEligible]) {
    if (required.has(p.productId) && !selected.includes(p)) selected.push(p);
  }
  return { selected, rejected, eligibleBeforeCap: deduped.length };
}
