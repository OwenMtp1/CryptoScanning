"use client";

/**
 * TradingView chart (official embed, in its own sandboxed iframe: no TradingView script runs on this
 * site). Covers almost every crypto on every exchange, with TradingView's own tools and indicators.
 */
export const TV_MARKETS = [
  ["auto", "Toutes plateformes (indice TradingView)"],
  ["binance", "Binance"],
  ["coinbase", "Coinbase"],
  ["okx", "OKX"],
  ["bybit", "Bybit"],
  ["kucoin", "KuCoin"],
  ["mexc", "MEXC"],
  ["gate", "Gate.io"],
  ["perp", "Binance perpétuel (levier)"],
] as const;
export type TvMarket = (typeof TV_MARKETS)[number][0];

export function tvSymbol(coin: string, market: TvMarket): string {
  const c = coin.toUpperCase().replace(/[^A-Z0-9]/g, "");
  switch (market) {
    case "binance":
      return `BINANCE:${c}USDT`;
    case "coinbase":
      return `COINBASE:${c}USD`;
    case "okx":
      return `OKX:${c}USDT`;
    case "bybit":
      return `BYBIT:${c}USDT`;
    case "kucoin":
      return `KUCOIN:${c}USDT`;
    case "mexc":
      return `MEXC:${c}USDT`;
    case "gate":
      return `GATEIO:${c}USDT`;
    case "perp":
      return `BINANCE:${c}USDT.P`;
    default:
      return `CRYPTO:${c}USD`;
  }
}

/** Period of the page → candle size in TradingView. */
const TV_INTERVAL: Record<string, string> = { "1h": "1", "1d": "5", "1w": "60", "1m": "240", "1y": "D" };

export function TradingViewChart({ coin, market = "auto", range = "1d", height = 480 }: { coin: string; market?: TvMarket; range?: string; height?: number }) {
  const q = new URLSearchParams({
    frameElementId: "tv-chart",
    symbol: tvSymbol(coin, market),
    interval: TV_INTERVAL[range] ?? "60",
    hidesidetoolbar: "0",
    symboledit: "1",
    saveimage: "0",
    toolbarbg: "0b1220",
    studies: "[]",
    theme: "dark",
    style: "1",
    timezone: "Europe/Paris",
    withdateranges: "1",
    locale: "fr",
  });
  return (
    <iframe
      key={`${coin}-${market}-${range}`}
      title={`Courbe TradingView de ${coin}`}
      src={`https://s.tradingview.com/widgetembed/?${q.toString()}`}
      className="w-full rounded border border-slate-800 bg-[#0b1220]"
      style={{ height }}
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
      referrerPolicy="no-referrer"
      loading="lazy"
      allowFullScreen
    />
  );
}
