"use client";

import type { LogEvent, RadarSnapshot, StatusResponse } from "@radar/core";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { API_URL, getJson } from "./api";

export type StreamState = "connecting" | "open" | "error";

interface RadarStream {
  state: StreamState;
  snapshot: RadarSnapshot | null;
  status: StatusResponse | null;
  /** Most recent live events (newest first). */
  events: LogEvent[];
}

const MAX_EVENTS = 300;
const Ctx = createContext<RadarStream>({ state: "connecting", snapshot: null, status: null, events: [] });

/** One shared Server-Sent Events connection to the local API for all pages. */
export function RadarStreamProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StreamState>("connecting");
  const [snapshot, setSnapshot] = useState<RadarSnapshot | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
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
    const es = new EventSource(`${API_URL}/api/stream`);
    es.onopen = () => setState("open");
    es.onerror = () => setState("error"); // EventSource reconnects automatically
    es.addEventListener("snapshot", (e) => setSnapshot(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("status", (e) => setStatus(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("log", (e) => pending.current.push(JSON.parse((e as MessageEvent).data)));
    // Batch log updates to avoid re-rendering on every event.
    const flush = setInterval(() => {
      if (!pending.current.length) return;
      const batch = pending.current.reverse();
      pending.current = [];
      setEvents((prev) => [...batch, ...prev].slice(0, MAX_EVENTS));
    }, 500);
    return () => {
      clearInterval(flush);
      es.close();
    };
  }, []);

  return <Ctx.Provider value={{ state, snapshot, status, events }}>{children}</Ctx.Provider>;
}

export function useRadarStream(): RadarStream {
  return useContext(Ctx);
}
