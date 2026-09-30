import { createRoot } from "react-dom/client";
import { useEffect, useState, type ComponentType } from "react";
import FluxPage from "../app/page";
import PerformancePage from "../app/performance/page";
import SourcesPage from "../app/sources/page";
import LevierPage from "../app/levier/page";
import DiscordPage from "../app/discord/page";
import UniversPage from "../app/univers/page";
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
  "/discord": DiscordPage,
};
const NAV = [
  ["/", "Flux"],
  ["/univers", "Univers"],
  ["/performance", "Performance"],
  ["/levier", "Levier"],
  ["/discord", "Discord"],
  ["/sources", "Sources"],
] as const;

function WebHeader({ path }: { path: string }) {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-800 bg-[#070b14]/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-lg font-bold tracking-widest text-slate-100">CRYPTO RADAR</span>
          <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-300">● LIVE</span>
        </div>
        <nav className="-mx-1 flex w-full gap-1 overflow-x-auto px-1 md:w-auto">
          {NAV.map(([href, label]) => (
            <a key={href} href={`#${href.slice(1)}`} className={`shrink-0 whitespace-nowrap rounded px-3 py-1.5 text-sm ${path === href ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-900 hover:text-slate-200"}`}>
              {label}
            </a>
          ))}
        </nav>
        <span className="ml-auto text-[11px] text-slate-500">Données réelles · analyse dans ton navigateur · pas des conseils d&apos;investissement</span>
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
          <main className="mx-auto max-w-[1600px] px-4 py-6">
            <Page />
          </main>
          <footer className="mx-auto max-w-[1600px] px-4 pb-8 text-[11px] text-slate-600">
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
