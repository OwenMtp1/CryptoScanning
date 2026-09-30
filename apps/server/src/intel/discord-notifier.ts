/**
 * Discord alerts through an incoming webhook (POST /webhooks/{id}/{token}).
 *
 * From discord/discord-api-docs: ≤ 10 embeds per message, 6000 chars of
 * embed text, 429 responses carry `retry_after` (seconds, JSON body) and
 * the `X-RateLimit-*` headers; `allowed_mentions` controls pings.
 *
 * The webhook URL is a secret (it contains the token): it comes only from
 * the environment, is never logged and never sent to the dashboard.
 */
import { packMessages, signalEmbed, type DiscordEmbed, type DiscordMessage, type IntelConfig, type IntelSignal } from "@radar/core";
import type { LogFn } from "../market-data/source.js";
import type { FetchText } from "./http.js";

const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/;

export const isDiscordWebhookUrl = (u: string) => WEBHOOK_RE.test(u);

export interface DiscordView {
  configured: boolean;
  enabled: boolean;
  state: "ok" | "error" | "disabled" | "idle" | "paused";
  lastSentAt: number | null;
  sentLastHour: number;
  maxPerHour: number;
  queued: number;
  digestPending: number;
  nextDigestAt: number | null;
  lastError: string | null;
  pausedUntil: number | null;
  minStrength: number;
}

export interface DiscordNotifierOptions {
  webhookUrl: string | null;
  cfg: IntelConfig["discord"];
  fetchText: FetchText;
  log: LogFn;
  /** Historical 1 h hit rate of a signal kind × direction (null = not enough data). */
  hitRateOf(s: IntelSignal): number | null;
  now?: () => number;
}

export class DiscordNotifier {
  private readonly url: string | null;
  private readonly queue: DiscordMessage[] = [];
  private urgent: IntelSignal[] = [];
  private digest: IntelSignal[] = [];
  private readonly lastCoinAt = new Map<string, number>();
  private readonly sentAt: number[] = [];
  private lastSentAt: number | null = null;
  private lastError: string | null = null;
  private pausedUntil = 0;
  private lastDigestAt: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending = false;
  private readonly now: () => number;

  constructor(private readonly o: DiscordNotifierOptions) {
    this.now = o.now ?? Date.now;
    this.lastDigestAt = this.now();
    const u = o.webhookUrl?.trim() || null;
    if (u && !isDiscordWebhookUrl(u)) {
      this.url = null;
      this.lastError = "DISCORD_WEBHOOK_URL invalide (attendu : https://discord.com/api/webhooks/<id>/<token>)";
    } else this.url = u;
  }

  get active() {
    return this.url !== null && this.o.cfg.enabled;
  }

  start() {
    this.stop();
    if (!this.active) return;
    this.timer = setInterval(() => void this.pump(), 5000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Decide what happens to a new signal: immediate alert, digest, or nothing. */
  consider(s: IntelSignal): "urgent" | "digest" | "skip" {
    const c = this.o.cfg;
    if (!this.active) return "skip";
    if (!c.directions.includes(s.direction)) return "skip";
    if (c.kinds.length && !c.kinds.includes(s.kind)) return "skip";
    if (!c.includeNews && (s.kind === "NEWS_BULLISH" || s.kind === "NEWS_BEARISH")) return "skip";
    const now = this.now();
    if (s.strength >= c.minStrength) {
      const key = `${s.coin}:${s.direction}`;
      const last = this.lastCoinAt.get(key);
      // A confluence always goes through: it is the strongest evidence we have.
      if (s.kind !== "CONFLUENCE" && last !== undefined && now - last < c.perCoinCooldownMin * 60_000) {
        if (c.digestMin > 0) this.digest.push(s);
        return c.digestMin > 0 ? "digest" : "skip";
      }
      this.lastCoinAt.set(key, now);
      this.urgent.push(s);
      return "urgent";
    }
    if (c.digestMin > 0 && s.strength >= c.minStrength - 15) {
      this.digest.push(s);
      if (this.digest.length > 500) this.digest.splice(0, this.digest.length - 500);
      return "digest";
    }
    return "skip";
  }

  private sentLastHour(now: number) {
    while (this.sentAt.length && (this.sentAt[0] as number) <= now - 3_600_000) this.sentAt.shift();
    return this.sentAt.length;
  }

  private buildUrgent(now: number) {
    if (!this.urgent.length) return;
    const list = this.urgent.sort((a, b) => b.strength - a.strength);
    this.urgent = [];
    const c = this.o.cfg;
    const mentionFor = (group: IntelSignal[]) => (c.mentionRoleId && group.some((s) => s.strength >= c.mentionMinStrength) ? c.mentionRoleId : null);
    if (c.onePerMessage) {
      // One notification per signal; only when a big backlog builds up (market going wild, Discord
      // limits ~30 messages/min per channel) are up to 5 signals grouped so alerts stay within a minute.
      const per = this.queue.length + list.length > 25 ? 5 : 1;
      for (let i = 0; i < list.length; i += per) {
        const group = list.slice(i, i + per);
        const mention = mentionFor(group);
        this.queue.push(...packMessages(group.map((s) => signalEmbed(s, this.o.hitRateOf(s))), { mentionRole: mention, content: mention ? "Signal fort" : undefined }));
      }
      if (this.queue.length > 3000) this.queue.splice(0, this.queue.length - 3000);
      return;
    }
    if (this.sentLastHour(now) + this.queue.length >= c.maxMessagesPerHour) {
      // Over the hourly cap: fold into the digest instead of spamming.
      if (c.digestMin > 0) this.digest.push(...list);
      return;
    }
    const mention = mentionFor(list);
    const embeds = list.slice(0, 10).map((s) => signalEmbed(s, this.o.hitRateOf(s)));
    if (list.length > 10 && c.digestMin > 0) this.digest.push(...list.slice(10));
    this.queue.push(...packMessages(embeds, { mentionRole: mention, content: mention ? "Signal fort" : undefined }));
  }

  private buildDigest(now: number) {
    const c = this.o.cfg;
    if (c.digestMin <= 0 || now - this.lastDigestAt < c.digestMin * 60_000) return;
    this.lastDigestAt = now;
    if (!this.digest.length) return;
    const seen = new Set<string>();
    const top = this.digest
      .sort((a, b) => b.strength - a.strength)
      .filter((s) => (seen.has(`${s.coin}:${s.kind}`) ? false : (seen.add(`${s.coin}:${s.kind}`), true)))
      .slice(0, 25);
    const total = this.digest.length;
    this.digest = [];
    const line = (s: IntelSignal) => `${s.direction === "bullish" ? "🟢" : "🔴"} **${s.coin}** · ${s.strength} · ${s.title.replace(/^\S+\s/, "").slice(0, 110)}`;
    let desc = "";
    for (const s of top) {
      const l = `${line(s)}\n`;
      if (desc.length + l.length > 3900) break;
      desc += l;
    }
    const embed: DiscordEmbed = {
      title: `Résumé : ${total} signal(s) en ${c.digestMin} min`,
      description: desc,
      color: 0x64748b,
      footer: { text: "signaux sous le seuil d'alerte immédiate · pas un conseil d'investissement" },
      timestamp: new Date(now).toISOString(),
    };
    this.queue.push(...packMessages([embed]));
  }

  /** Build messages and send what the rate limits allow. Exposed for tests. */
  /**
   * Build and send messages. `maxPosts` bounds the HTTP calls of this call (a Cloudflare Worker has a
   * budget of outgoing requests per run): what is left stays queued for the next call. Returns the
   * number of HTTP calls made.
   */
  async pump(maxPosts = Number.POSITIVE_INFINITY): Promise<number> {
    const now = this.now();
    if (!this.url || this.sending) return 0;
    this.buildUrgent(now);
    this.buildDigest(now);
    if (now < this.pausedUntil) return 0;
    this.sending = true;
    let posts = 0;
    try {
      while (this.queue.length && posts < maxPosts && this.sentLastHour(this.now()) < this.o.cfg.maxMessagesPerHour) {
        const msg = this.queue[0] as DiscordMessage;
        posts++;
        const r = await this.post(msg);
        if (r === "retry") break;
        this.queue.shift();
        if (r === "ok") {
          this.sentAt.push(this.now());
          this.lastSentAt = this.now();
        }
      }
    } finally {
      this.sending = false;
    }
    return posts;
  }

  private async post(msg: DiscordMessage): Promise<"ok" | "retry" | "drop"> {
    const url = this.url as string;
    try {
      const res = await this.o.fetchText(`${url}?wait=true`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg), timeoutMs: 15_000 });
      if (res.status === 200 || res.status === 204) {
        this.lastError = null;
        this.o.log({ type: "DISCORD_SENT", level: "debug", success: true, message: `Discord : ${msg.embeds?.length ?? 0} embed(s) envoyé(s)` });
        return "ok";
      }
      if (res.status === 429) {
        let after = Number(res.headers.get("retry-after") ?? 5);
        try {
          const b = JSON.parse(res.text) as { retry_after?: number };
          if (typeof b.retry_after === "number") after = b.retry_after;
        } catch {
          // keep header value
        }
        this.pausedUntil = this.now() + Math.max(1, after) * 1000;
        this.lastError = `limite Discord (429), pause ${Math.ceil(after)} s`;
        return "retry";
      }
      if (res.status >= 500) {
        this.pausedUntil = this.now() + 30_000;
        this.lastError = `Discord indisponible (HTTP ${res.status})`;
        return "retry";
      }
      // 4xx: bad payload or webhook deleted — do not retry the same message.
      this.lastError = res.status === 401 || res.status === 404 ? `webhook refusé (HTTP ${res.status}) : supprimé ou URL incorrecte` : `message refusé par Discord (HTTP ${res.status})`;
      this.o.log({ type: "DISCORD_ERROR", level: "error", success: false, message: this.lastError });
      return "drop";
    } catch (err) {
      this.pausedUntil = this.now() + 30_000;
      this.lastError = `envoi Discord impossible : ${(err as Error).message.replace(/https?:\/\/\S+/g, "[url]")}`;
      this.o.log({ type: "DISCORD_ERROR", level: "warn", success: false, message: this.lastError });
      return "retry";
    }
  }

  /** Persistable state (for a scheduled worker that restarts between runs). */
  exportState() {
    const dayAgo = this.now() - 86_400_000;
    return { lastCoinAt: Object.fromEntries([...this.lastCoinAt].filter(([, t]) => t > dayAgo)), sentAt: [...this.sentAt], lastSentAt: this.lastSentAt, lastDigestAt: this.lastDigestAt, digest: this.digest.slice(-200), queue: this.queue.slice(0, 1500), lastError: this.lastError, pausedUntil: this.pausedUntil };
  }

  importState(s: Partial<ReturnType<DiscordNotifier["exportState"]>> | null | undefined) {
    if (!s) return;
    for (const [k, v] of Object.entries(s.lastCoinAt ?? {})) this.lastCoinAt.set(k, v);
    this.sentAt.push(...(s.sentAt ?? []));
    this.lastSentAt = s.lastSentAt ?? null;
    if (s.lastDigestAt) this.lastDigestAt = s.lastDigestAt;
    this.digest.push(...(s.digest ?? []));
    this.queue.push(...(s.queue ?? []));
    this.lastError = s.lastError ?? this.lastError;
    this.pausedUntil = s.pausedUntil ?? 0;
  }

  /** Send a test message right away (dashboard button). */
  async test(note?: string): Promise<{ ok: boolean; message: string }> {
    if (!this.url) return { ok: false, message: this.lastError ?? "DISCORD_WEBHOOK_URL non configurée (fichier .env)" };
    const [msg] = packMessages([
      { title: "✅ Crypto Radar connecté", description: `${note ? `${note}\n\n` : ""}Les alertes de signaux arriveront ici. Aucun ordre n'est jamais passé : ce sont des informations, pas des conseils d'investissement.`, color: 0x22c55e, timestamp: new Date(this.now()).toISOString() },
    ]);
    const r = await this.post(msg as DiscordMessage);
    if (r === "ok") {
      this.sentAt.push(this.now());
      this.lastSentAt = this.now();
    }
    return r === "ok" ? { ok: true, message: "Message de test envoyé." } : { ok: false, message: this.lastError ?? "échec" };
  }

  view(): DiscordView {
    const now = this.now();
    const c = this.o.cfg;
    return {
      configured: this.url !== null,
      enabled: c.enabled,
      state: !this.url || !c.enabled ? "disabled" : now < this.pausedUntil ? "paused" : this.lastError ? "error" : this.lastSentAt ? "ok" : "idle",
      lastSentAt: this.lastSentAt,
      sentLastHour: this.sentLastHour(now),
      maxPerHour: c.maxMessagesPerHour,
      queued: this.queue.length + this.urgent.length,
      digestPending: this.digest.length,
      nextDigestAt: c.digestMin > 0 ? this.lastDigestAt + c.digestMin * 60_000 : null,
      lastError: this.lastError,
      pausedUntil: this.pausedUntil > now ? this.pausedUntil : null,
      minStrength: c.minStrength,
    };
  }
}
