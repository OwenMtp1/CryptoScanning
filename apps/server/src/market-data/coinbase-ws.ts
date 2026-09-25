import type { FeedConnectionState, FeedStatus } from "@radar/core";
import type { FrameSink, LogFn } from "./source.js";

/** Minimal WebSocket surface used by the feed (Node 22 global WebSocket fits). */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WsFactory = (url: string) => WsLike;

const OPEN = 1;

export interface CoinbaseWsFeedOptions {
  url: string;
  /** Market channels subscribed per product (heartbeats is always added). */
  channels?: string[];
  productsPerConnection: number;
  maxSubscribeMsgPerSec: number;
  /** Reconnect a connection that received nothing for this long. */
  watchdogMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  wsFactory?: WsFactory;
  log: LogFn;
  now?: () => number;
  random?: () => number;
}

interface Conn {
  id: string;
  productIds: string[];
  ws: WsLike | null;
  state: FeedConnectionState;
  attempts: number;
  lastMessageAt: number | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Transport for wss://advanced-trade-ws.coinbase.com (public market data, no JWT).
 *
 * - products are sharded over several connections;
 * - subscribe messages are rate-limited globally (documented limit: 8/s/IP);
 * - `heartbeats` is subscribed on every connection to keep it open;
 * - a watchdog reconnects silent connections, with exponential backoff + jitter.
 *
 * Frames are passed raw to the sink; decoding is done by the MarketDataEngine.
 */
export class CoinbaseWsFeed {
  readonly kind = "coinbase" as const;
  private conns: Conn[] = [];
  private sink: FrameSink | null = null;
  private sendQueue: { conn: Conn; msg: string }[] = [];
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private reconnects = 0;
  private lastMessageAt: number | null = null;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly wsFactory: WsFactory;

  constructor(private readonly opts: CoinbaseWsFeedOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);
  }

  start(productIds: string[], sink: FrameSink) {
    this.stop();
    this.stopped = false;
    this.sink = sink;
    const size = this.opts.productsPerConnection;
    this.conns = [];
    for (let i = 0; i < productIds.length; i += size) {
      this.conns.push({ id: `ws${this.conns.length + 1}`, productIds: productIds.slice(i, i + size), ws: null, state: "idle", attempts: 0, lastMessageAt: null, reconnectTimer: null });
    }
    const interval = Math.ceil(1000 / this.opts.maxSubscribeMsgPerSec);
    this.sendTimer = setInterval(() => this.flushOne(), interval);
    const watchdogMs = this.opts.watchdogMs ?? 15_000;
    this.watchdogTimer = setInterval(() => this.watchdog(watchdogMs), Math.min(5000, watchdogMs));
    for (const c of this.conns) this.connect(c);
  }

  stop() {
    this.stopped = true;
    if (this.sendTimer) clearInterval(this.sendTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.sendTimer = this.watchdogTimer = null;
    this.sendQueue = [];
    for (const c of this.conns) {
      if (c.reconnectTimer) clearTimeout(c.reconnectTimer);
      c.reconnectTimer = null;
      const ws = c.ws;
      c.ws = null;
      c.state = "closed";
      try {
        ws?.close(1000, "stop");
      } catch {
        // ignore
      }
    }
  }

  private connect(c: Conn) {
    if (this.stopped) return;
    c.state = c.attempts === 0 ? "connecting" : "reconnecting";
    this.opts.log({ type: "WS_CONNECTING", level: "debug", message: `${c.id} connexion à ${this.opts.url} (${c.productIds.length} produits)` });
    let ws: WsLike;
    try {
      ws = this.wsFactory(this.opts.url);
    } catch (err) {
      this.opts.log({ type: "API_ERROR", level: "error", success: false, message: `${c.id} impossible de créer le WebSocket : ${(err as Error).message}` });
      this.scheduleReconnect(c);
      return;
    }
    c.ws = ws;
    c.lastMessageAt = this.now();
    ws.onopen = () => {
      if (c.ws !== ws) return;
      c.state = "open";
      this.opts.log({ type: "WS_CONNECTED", level: "info", success: true, message: `${c.id} connecté (${c.productIds.length} produits)` });
      this.enqueue(c, { type: "subscribe", product_ids: [], channel: "heartbeats" });
      for (const channel of this.opts.channels ?? ["ticker", "market_trades"]) {
        this.enqueue(c, { type: "subscribe", product_ids: c.productIds, channel });
      }
    };
    ws.onmessage = (ev) => {
      if (c.ws !== ws) return;
      const t = this.now();
      c.lastMessageAt = t;
      this.lastMessageAt = t;
      c.attempts = 0;
      const raw = typeof ev.data === "string" ? ev.data : ev.data instanceof ArrayBuffer ? new TextDecoder().decode(ev.data) : String(ev.data);
      this.sink?.onFrame(raw, t, c.id);
    };
    ws.onerror = () => {
      // onclose follows; details are not exposed by the WebSocket API.
    };
    ws.onclose = (ev) => {
      if (c.ws !== ws) return;
      c.ws = null;
      this.sendQueue = this.sendQueue.filter((q) => q.conn !== c);
      if (this.stopped) return;
      this.opts.log({ type: "WS_DISCONNECTED", level: "warn", success: false, message: `${c.id} déconnecté (code ${ev.code ?? "?"}${ev.reason ? `, ${ev.reason}` : ""})` });
      this.scheduleReconnect(c);
    };
  }

  private scheduleReconnect(c: Conn) {
    if (this.stopped || c.reconnectTimer) return;
    c.state = "reconnecting";
    const base = this.opts.backoffBaseMs ?? 1000;
    const max = this.opts.backoffMaxMs ?? 60_000;
    const delay = Math.min(max, base * 2 ** c.attempts) * (0.75 + this.random() * 0.5);
    c.attempts++;
    this.reconnects++;
    c.reconnectTimer = setTimeout(() => {
      c.reconnectTimer = null;
      this.connect(c);
    }, delay);
  }

  private enqueue(conn: Conn, msg: Record<string, unknown>) {
    this.sendQueue.push({ conn, msg: JSON.stringify(msg) });
  }

  private flushOne() {
    const item = this.sendQueue.shift();
    if (!item) return;
    const ws = item.conn.ws;
    if (!ws || ws.readyState !== OPEN) return;
    ws.send(item.msg);
    const parsed = JSON.parse(item.msg) as { channel: string; product_ids: string[] };
    this.opts.log({ type: "WS_SUBSCRIBED", level: "info", success: true, message: `${item.conn.id} abonnement ${parsed.channel} (${parsed.product_ids.length} produits)` });
  }

  private watchdog(limitMs: number) {
    const t = this.now();
    for (const c of this.conns) {
      if (c.ws && c.state === "open" && c.lastMessageAt !== null && t - c.lastMessageAt > limitMs) {
        this.opts.log({ type: "DATA_STALE", level: "warn", success: false, message: `${c.id} aucun message depuis ${Math.round((t - c.lastMessageAt) / 1000)} s, reconnexion` });
        const ws = c.ws;
        c.ws = null;
        try {
          ws.close(4000, "watchdog");
        } catch {
          // ignore
        }
        this.scheduleReconnect(c);
      }
    }
  }

  status(): Omit<FeedStatus, "lastHeartbeatAt" | "sequenceGaps" | "decodeErrors"> {
    const open = this.conns.filter((c) => c.state === "open").length;
    const state: FeedConnectionState = this.stopped
      ? "closed"
      : open === this.conns.length && open > 0
        ? "open"
        : this.conns.some((c) => c.state === "reconnecting")
          ? "reconnecting"
          : "connecting";
    return {
      source: "coinbase",
      state,
      connections: this.conns.length,
      openConnections: open,
      subscribedProducts: this.conns.reduce((n, c) => n + c.productIds.length, 0),
      lastMessageAt: this.lastMessageAt,
      reconnects: this.reconnects,
    };
  }
}
