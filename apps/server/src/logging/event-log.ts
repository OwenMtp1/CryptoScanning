import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import path from "node:path";
import { filterEvents, redact, redactString, type LogEvent, type LogQuery } from "@radar/core";

export type EmitInput = Omit<LogEvent, "id" | "ts">;
type Listener = (e: LogEvent) => void;

export interface EventLogOptions {
  /** Directory for JSONL files; null disables persistence (tests). */
  dir: string | null;
  bufferSize?: number;
  console?: boolean;
  now?: () => Date;
}

/**
 * Append-only event journal: every event is timestamped, redacted, kept in
 * a memory ring buffer for the dashboard and appended to a daily JSONL file.
 */
export class EventLog {
  private readonly buffer: LogEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly bufferSize: number;
  private readonly now: () => Date;
  private stream: WriteStream | null = null;
  private streamDay: string | null = null;

  constructor(private readonly opts: EventLogOptions) {
    this.bufferSize = opts.bufferSize ?? 5000;
    this.now = opts.now ?? (() => new Date());
    if (opts.dir) {
      mkdirSync(opts.dir, { recursive: true });
      this.loadToday();
    }
  }

  private fileFor(day: string) {
    return path.join(this.opts.dir as string, `events-${day}.jsonl`);
  }

  /** Reload today's events so the activity log survives restarts. */
  private loadToday() {
    const file = this.fileFor(this.now().toISOString().slice(0, 10));
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-this.bufferSize);
    for (const line of lines) {
      try {
        this.buffer.push(JSON.parse(line) as LogEvent);
      } catch {
        // skip corrupted line
      }
    }
  }

  emit(input: EmitInput): LogEvent {
    const event: LogEvent = redact({ id: randomUUID(), ts: this.now().toISOString(), ...input, message: redactString(input.message) });
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    if (event.level !== "debug") this.persist(event);
    if (this.opts.console !== false && event.level !== "debug") {
      const tag = event.level === "error" ? "ERR " : event.level === "warn" ? "WARN" : "INFO";
      console.log(`${event.ts} ${tag} ${event.type.padEnd(20)} ${event.message}`);
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // a faulty listener must not break logging
      }
    }
    return event;
  }

  private persist(e: LogEvent) {
    if (!this.opts.dir) return;
    const day = e.ts.slice(0, 10);
    if (day !== this.streamDay) {
      this.stream?.end();
      this.stream = createWriteStream(this.fileFor(day), { flags: "a" });
      this.streamDay = day;
    }
    this.stream?.write(`${JSON.stringify(e)}\n`);
  }

  query(q: LogQuery): LogEvent[] {
    return filterEvents(this.buffer, q);
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async close(): Promise<void> {
    const s = this.stream;
    this.stream = null;
    if (s) await new Promise<void>((resolve) => s.end(resolve));
  }
}
