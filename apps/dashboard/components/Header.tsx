"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRadarStream } from "@/lib/stream";

const NAV = [
  { href: "/", label: "Radar" },
  { href: "/opportunities", label: "Opportunités" },
  { href: "/logs", label: "Journal" },
  { href: "/settings", label: "Paramètres" },
];

export function Header() {
  const path = usePathname();
  const { state, status } = useRadarStream();
  const simulated = status?.feed.source === "simulated";
  const healthy = state === "open" && status?.health.healthy;

  return (
    <header className="sticky top-0 z-20 border-b border-slate-800 bg-[#070b14]/95 backdrop-blur">
      {simulated && (
        <div className="bg-amber-500/15 py-1 text-center text-xs font-semibold tracking-wide text-amber-300">
          DONNÉES SIMULÉES — prix et volumes fictifs, aucune connexion à Coinbase
        </div>
      )}
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold tracking-widest text-slate-100">CRYPTO RADAR</span>
          <span className="rounded bg-sky-500/15 px-2 py-0.5 text-xs font-semibold text-sky-300">MODE RADAR</span>
        </div>
        <nav className="flex gap-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`rounded px-3 py-1.5 text-sm ${path === n.href ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs text-slate-400">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${healthy ? "bg-emerald-400" : state === "open" ? "bg-amber-400" : "bg-rose-500"}`} />
          {state !== "open"
            ? "API locale injoignable"
            : healthy
              ? `Flux ${status?.feed.source === "simulated" ? "simulé" : "Coinbase"} OK`
              : `Flux dégradé : ${status?.health.reason ?? "…"}`}
        </div>
      </div>
    </header>
  );
}
