"use client";

import type { LogEvent, RadarSnapshot, StatusResponse, TradingView } from "@radar/core";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { API_URL, demoBackend, getJson } from "./api";

export type StreamState = "connecting" | "open" | "error";

interface RadarStream {
  state: StreamState;
  snapshot: RadarSnapshot | null;
  status: StatusResponse | null;
  trading: TradingView | null;
  /** Most recent live events (newest first). */
  events: LogEvent[];
}

const MAX_EVENTS = 300;
const Ctx = createContext<RadarStream>({ state: "connecting", snapshot: null, status: null, trading: null, events: [] });

/** One shared Server-Sent Events connection to the local API for all pages. */
export function RadarStreamProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StreamState>("connecting");
  const [snapshot, setSnapshot] = useState<RadarSnapshot | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [trading, setTrading] = useState<TradingView | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const pending = useRef<LogEvent[]>([]);

  useEffect(() => {
    // Seed with recent history so panels are not empty after a page load.
    getJson<LogEvent[]>(`/api/logs?level=info&limit=${MAX_EVENTS}`)
      .then((history) =>
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          return [...prev, ...history.filter((e) => !seen.has(e.id))].slice(0, MAX_EVENTS);
        }),
      )
      .catch(() => {});
    const handlers: Record<string, (data: unknown) => void> = {
      snapshot: (d) => setSnapshot(d as RadarSnapshot),
      status: (d) => setStatus(d as StatusResponse),
      trading: (d) => setTrading(d as TradingView),
      log: (d) => pending.current.push(d as LogEvent),
    };
    let close: () => void;
    const demo = demoBackend();
    if (demo) {
      setState("open");
      close = demo.subscribe((event, data) => handlers[event]?.(data));
    } else {
      const es = new EventSource(`${API_URL}/api/stream`);
      es.onopen = () => setState("open");
      es.onerror = () => setState("error"); // EventSource reconnects automatically
      for (const [name, h] of Object.entries(handlers)) es.addEventListener(name, (e) => h(JSON.parse((e as MessageEvent).data)));
      close = () => es.close();
    }
    // Batch log updates to avoid re-rendering on every event.
    const flush = setInterval(() => {
      if (!pending.current.length) return;
      const batch = pending.current.reverse();
      pending.current = [];
      setEvents((prev) => [...batch, ...prev].slice(0, MAX_EVENTS));
    }, 500);
    return () => {
      clearInterval(flush);
      close();
    };
  }, []);

  return <Ctx.Provider value={{ state, snapshot, status, trading, events }}>{children}</Ctx.Provider>;
}

export function useRadarStream(): RadarStream {
  return useContext(Ctx);
}
