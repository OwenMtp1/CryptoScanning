import { createRoot } from "react-dom/client";
import { useEffect, useState, type ComponentType } from "react";
import FluxPage from "../app/page";
import PerformancePage from "../app/performance/page";
import SourcesPage from "../app/sources/page";
import LevierPage from "../app/levier/page";
import DiscordPage from "../app/discord/page";
import UniversPage from "../app/univers/page";
import CourbePage from "../app/courbe/page";
import SetupsPage from "../app/setups/page";
import { DialogProvider } from "../components/Dialogs";
import { CoinDrawerProvider } from "../components/Intel";
import { RadarStreamProvider } from "../lib/stream";
import { currentPath } from "../demo/shims/next-navigation";
import { startWeb } from "./runtime";

const ROUTES: Record<string, ComponentType> = {
  "/": FluxPage,
  "/univers": UniversPage,
  "/performance": PerformancePage,
  "/sources": SourcesPage,
  "/levier": LevierPage,
  "/courbe": CourbePage,
  "/setups": SetupsPage,
  "/discord": DiscordPage,
};
const NAV = [
  ["/", "Flux"],
  ["/univers", "Univers"],
  ["/performance", "Performance"],
  ["/setups", "Setups"],
  ["/courbe", "Courbe"],
  ["/levier", "Levier"],
  ["/discord", "Discord"],
  ["/sources", "Sources"],
] as const;

/** Phone tab bar: the 4 most used pages + « Plus » for the others. */
const TABS = [
  ["/", "📡", "Flux"],
  ["/setups", "🎯", "Setups"],
  ["/courbe", "📈", "Courbe"],
  ["/levier", "⚖️", "Levier"],
] as const;
const MORE = NAV.filter(([h]) => !TABS.some(([t]) => t === h));

function MobileTabs({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const moreActive = MORE.some(([h]) => h === path);
  return (
    <>
      {open && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setOpen(false)}>
          <div className="pb-safe absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-slate-700 bg-slate-900 p-3 pb-20" onClick={(e) => e.stopPropagation()}>
            <div className="grid grid-cols-2 gap-2">
              {MORE.map(([href, label]) => (
                <a key={href} href={`#${href.slice(1)}`} className={`rounded-lg px-4 py-3 text-center text-base ${path === href ? "bg-sky-700 text-white" : "bg-slate-800 text-slate-200"}`}>
                  {label}
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
      <nav className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-slate-800 bg-[#070b14]/95 backdrop-blur md:hidden" aria-label="Navigation">
        <div className="grid grid-cols-5">
          {TABS.map(([href, icon, label]) => (
            <a key={href} href={`#${href.slice(1)}`} className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${path === href ? "text-sky-300" : "text-slate-400"}`} aria-current={path === href ? "page" : undefined}>
              <span className="text-lg leading-none">{icon}</span>
              {label}
            </a>
          ))}
          <button type="button" onClick={() => setOpen((x) => !x)} className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${open || moreActive ? "text-sky-300" : "text-slate-400"}`} aria-expanded={open}>
            <span className="text-lg leading-none">☰</span>
            Plus
          </button>
        </div>
      </nav>
    </>
  );
}

function WebHeader({ path }: { path: string }) {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-800 bg-[#070b14]/95 backdrop-blur" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5 md:px-4 md:py-3">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold tracking-widest text-slate-100 md:text-lg">CRYPTO RADAR</span>
          <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-300">● LIVE</span>
          <span className="text-xs text-slate-400 md:hidden">· {NAV.find(([h]) => h === path)?.[1]}</span>
        </div>
        <nav className="hidden gap-1 md:flex">
          {NAV.map(([href, label]) => (
            <a key={href} href={`#${href.slice(1)}`} className={`shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-sm ${path === href ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}>
              {label}
            </a>
          ))}
        </nav>
        <span className="ml-auto hidden text-[11px] text-slate-500 lg:inline">Données réelles · analyse dans ton navigateur · pas des conseils d&apos;investissement</span>
      </div>
    </header>
  );
}

function App() {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const on = () => {
      setPath(currentPath());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const Page = ROUTES[path] ?? FluxPage;
  return (
    <RadarStreamProvider>
      <DialogProvider>
        <CoinDrawerProvider>
          <WebHeader path={ROUTES[path] ? path : "/"} />
          <main className="mx-auto max-w-[1600px] px-3 py-4 md:px-4 md:py-6">
            <Page />
          </main>
          <MobileTabs path={ROUTES[path] ? path : "/"} />
          <footer className="mx-auto max-w-[1600px] px-3 pb-28 md:px-4 md:pb-8 text-[11px] text-slate-600">
            L&apos;analyse ne tourne que lorsque cette page est ouverte ; l&apos;historique est gardé dans ce navigateur. Sources : Binance, CoinGecko, GeckoTerminal et médias crypto (RSS). Signaux
            statistiques, pas des prédictions : aucune garantie, aucun ordre n&apos;est passé.
          </footer>
        </CoinDrawerProvider>
      </DialogProvider>
    </RadarStreamProvider>
  );
}

async function boot() {
  const root = createRoot(document.getElementById("root") as HTMLElement);
  try {
    (globalThis as { __RADAR_DEMO__?: unknown }).__RADAR_DEMO__ = await startWeb();
    root.render(<App />);
  } catch (err) {
    const el = document.getElementById("boot");
    if (el) el.textContent = `Démarrage impossible : ${(err as Error).message}`;
  }
}
void boot();
