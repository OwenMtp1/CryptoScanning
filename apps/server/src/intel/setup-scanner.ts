/**
 * Runs the trader setup engine on one coin: 1 h candles (one request; the 4 h view is built from them),
 * derivatives context from the leveraged-markets board, Bitcoin regime.
 */
import { aggregateCandles, analyzeSetup, trendOf, type TradeSetup } from "@radar/core";
import { loadCandles } from "./candles.js";
import type { IntelService } from "./intel-service.js";

export interface SetupRunOptions {
  /** Bitcoin trend −1…+1 (null = unknown). */
  btcTrend: number | null;
  emit?: boolean;
  skipBinance?: boolean;
  /** Binance host that answers from this server (the bot rotates between several). */
  binanceBase?: string;
  /** Base URL of the site's `/api/candles` (other exchanges); unset = Binance and Coinbase only. */
  extraBase?: string;
  now?: number;
}

/** Analyse `coin` and hand the result to the service. Returns the setup and the Bitcoin trend when coin = BTC. */
export async function runSetup(get: (url: string) => Promise<string>, svc: IntelService, coin: string, o: SetupRunOptions): Promise<{ setup: TradeSetup | null; trend: number | null; source: string }> {
  const r = await loadCandles(get, coin, "1h", 300, { skipBinance: o.skipBinance, now: o.now, binanceBase: o.binanceBase, extraBase: o.extraBase });
  const higher = aggregateCandles(r.candles, 4);
  const trend = trendOf(higher.length >= 60 ? higher : r.candles)?.value ?? null;
  const setup = analyzeSetup(r.candles, higher, { ...svc.setupContext(coin), btcTrend: coin === "BTC" ? null : o.btcTrend }, { timeframe: "1 h" });
  const url = r.source === "Binance" ? `https://www.binance.com/fr/trade/${r.pair.replace("/", "_")}` : r.source === "Coinbase" ? `https://www.coinbase.com/advanced-trade/spot/${r.pair}` : null;
  if (setup) svc.onSetup(coin, setup, o.now, url, o.emit ?? true);
  return { setup, trend, source: r.source };
}
