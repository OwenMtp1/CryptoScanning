/**
 * Binance all-market live feed (public market data, no key).
 *
 * From github.com/binance/binance-spot-api-docs:
 * - market-data-only endpoints: REST https://data-api.binance.vision, WS wss://data-stream.binance.vision
 * - combined streams: /stream?streams=a/b → frames {"stream": "...", "data": ...}
 * - `!miniTicker@arr` (24 h rolling, changed symbols only, ~1 s) and
 *   `!ticker_1h@arr` (1 h rolling window). `!ticker@arr` was retired on 2026-03-26.
 * - a connection is valid 24 h (we rotate after 23 h); the server pings
 *   every 20 s and the WebSocket runtime answers pongs automatically.
 * - GET /api/v3/exchangeInfo (weight 20) lists the trading pairs.
 */
import { BinanceExchangeInfoSchema, BinanceMiniTickerSchema, BinanceWindowTickerSchema, LiveTracker } from "@radar/core";
import type { WsFactory, WsLike } from "../market-data/coinbase-ws.js";
import type { FetchText } from "./http.js";

export interface BinanceFeedOptions {
  restUrl: string;
  wsUrl: string;
  quotes: string[];
  fetchText: FetchText;
  wsFactory?: WsFactory;
  /** Called every tickMs with the coins updated since the last call. */
  onTick(tracker: LiveTracker, changed: Set<string>, now: number): void;
  onState(state: "connecting" | "ok" | "down", message: string | null, now: number): void;
  tickMs?: number;
  watchdogMs?: number;
  rotateMs?: number;
  now?: () => number;
}

const OPEN = 1;

export class BinanceFeed {
  private ws: WsLike | null = null;
  private tracker: LiveTracker | null = null;
  private changed = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private attempts = 0;
  private connectedAt = 0;
  private lastMessageAt = 0;
  private pairs = 0;
  private messages = 0;
  private decodeErrors = 0;
  private readonly now: () => number;
  private readonly wsFactory: WsFactory;

  constructor(private readonly o: BinanceFeedOptions) {
    this.now = o.now ?? Date.now;
    this.wsFactory = o.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);
  }

  async start() {
    this.stop();
    this.stopped = false;
    await this.loadPairs();
    if (this.stopped) return;
    this.connect();
    this.timers.push(setInterval(() => this.flush(), this.o.tickMs ?? 2000));
    this.timers.push(setInterval(() => this.watchdog(), 15_000));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.closeWs();
  }

  private async loadPairs() {
    for (;;) {
      try {
        const res = await this.o.fetchText(`${this.o.restUrl}/api/v3/exchangeInfo?permissions=SPOT`, { timeoutMs: 20_000 });
        if (res.status !== 200) throw new Error(`exchangeInfo HTTP ${res.status}`);
        const info = BinanceExchangeInfoSchema.parse(JSON.parse(res.text));
        const map = new Map<string, { base: string; quote: string }>();
        for (const s of info.symbols) if (s.status === "TRADING" && s.isSpotTradingAllowed !== false && this.o.quotes.includes(s.quoteAsset)) map.set(s.symbol, { base: s.baseAsset, quote: s.quoteAsset });
        this.tracker = new LiveTracker(map, this.o.quotes);
        this.pairs = this.tracker.coins().length;
        return;
      } catch (err) {
        this.o.onState("down", `liste des paires Binance indisponible : ${(err as Error).message}`, this.now());
        if (this.stopped) return;
        await new Promise((r) => setTimeout(r, Math.min(300_000, 10_000 * 2 ** this.attempts++)));
        if (this.stopped) return;
      }
    }
  }

  private closeWs() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, "rotate");
      } catch {
        // ignore
      }
    }
  }

  private connect() {
    if (this.stopped) return;
    this.closeWs();
    this.o.onState("connecting", null, this.now());
    const ws = this.wsFactory(`${this.o.wsUrl}/stream?streams=!miniTicker@arr/!ticker_1h@arr`);
    this.ws = ws;
    ws.onopen = () => {
      this.connectedAt = this.now();
      this.lastMessageAt = this.connectedAt;
      this.attempts = 0;
      this.o.onState("ok", `${this.pairs} cryptos suivies en temps réel`, this.now());
    };
    ws.onmessage = (ev) => this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data));
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.o.onState("down", `connexion fermée (${ev.code ?? "?"})`, this.now());
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows
    };
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(60_000, 1000 * 2 ** this.attempts++) * (0.8 + Math.random() * 0.4);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private watchdog() {
    const now = this.now();
    if (!this.ws || this.ws.readyState !== OPEN) return;
    if (now - this.lastMessageAt > (this.o.watchdogMs ?? 60_000)) {
      this.o.onState("down", "aucune donnée depuis 60 s, reconnexion", now);
      this.connect();
    } else if (now - this.connectedAt > (this.o.rotateMs ?? 23 * 3_600_000)) {
      this.connect(); // Binance closes connections after 24 h
    }
  }

  /** Exposed for tests. */
  onMessage(text: string) {
    const now = this.now();
    this.lastMessageAt = now;
    this.messages++;
    const t = this.tracker;
    if (!t) return;
    let msg: { stream?: string; data?: unknown };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      this.decodeErrors++;
      return;
    }
    if (!Array.isArray(msg.data)) return;
    if (msg.stream === "!miniTicker@arr") {
      for (const d of msg.data) {
        const x = BinanceMiniTickerSchema.safeParse(d);
        if (!x.success) {
          this.decodeErrors++;
          continue;
        }
        const coin = t.applyMini(x.data, now);
        if (coin) this.changed.add(coin);
      }
    } else if (msg.stream === "!ticker_1h@arr") {
      for (const d of msg.data) {
        const x = BinanceWindowTickerSchema.safeParse(d);
        if (x.success) t.applyWindow(x.data, now);
        else this.decodeErrors++;
      }
    }
  }

  /** Exposed for tests. */
  flush() {
    if (!this.tracker || !this.changed.size) return;
    const changed = this.changed;
    this.changed = new Set();
    this.o.onTick(this.tracker, changed, this.now());
  }

  status() {
    return { pairs: this.pairs, messages: this.messages, decodeErrors: this.decodeErrors, connected: this.ws?.readyState === OPEN, lastMessageAt: this.lastMessageAt || null };
  }
}
