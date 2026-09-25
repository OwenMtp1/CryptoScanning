import { filterEvents, redact, redactString, type LogEvent, type LogQuery } from "@radar/core";
import { randomUUID } from "./shims/node-crypto";

type EmitInput = Omit<LogEvent, "id" | "ts">;

/** In-browser event journal (same contract as the server EventLog, without files). */
export class BrowserEventLog {
  private readonly buffer: LogEvent[] = [];
  private readonly listeners = new Set<(e: LogEvent) => void>();

  constructor(initial: LogEvent[] = [], private readonly max = 3000) {
    this.buffer.push(...initial.slice(-max));
  }

  emit(input: EmitInput): LogEvent {
    const e: LogEvent = redact({ id: randomUUID(), ts: new Date().toISOString(), ...input, message: redactString(input.message) });
    this.buffer.push(e);
    if (this.buffer.length > this.max) this.buffer.splice(0, this.buffer.length - this.max);
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // ignore
      }
    }
    return e;
  }

  query(q: LogQuery): LogEvent[] {
    return filterEvents(this.buffer, q);
  }

  subscribe(l: (e: LogEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Recent non-debug events, for persistence. */
  recent(n: number): LogEvent[] {
    return this.buffer.filter((e) => e.level !== "debug").slice(-n);
  }
}
