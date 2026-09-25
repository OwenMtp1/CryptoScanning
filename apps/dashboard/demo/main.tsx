import { createRoot } from "react-dom/client";
import { useEffect, useState, type ComponentType } from "react";
import LogsPage from "../app/logs/page";
import OpportunitiesPage from "../app/opportunities/page";
import RadarPage from "../app/page";
import PortfolioPage from "../app/portfolio/page";
import PositionsPage from "../app/positions/page";
import SettingsPage from "../app/settings/page";
import StrategiesPage from "../app/strategies/page";
import { DialogProvider, useDialogs } from "../components/Dialogs";
import { Header } from "../components/Header";
import { RadarStreamProvider } from "../lib/stream";
import { resetDemo, startDemo, type DemoInfo } from "./runtime";
import type { DemoStorage } from "./storage";
import { currentPath } from "./shims/next-navigation";

const ROUTES: Record<string, ComponentType> = {
  "/": RadarPage,
  "/radar": RadarPage,
  "/opportunities": OpportunitiesPage,
  "/positions": PositionsPage,
  "/portfolio": PortfolioPage,
  "/strategies": StrategiesPage,
  "/logs": LogsPage,
  "/settings": SettingsPage,
};

function DemoBar({ info, storage }: { info: DemoInfo; storage: DemoStorage }) {
  const { confirm } = useDialogs();
  const reset = async () => {
    const r = await confirm({
      title: "Recommencer la démo à zéro ?",
      message: "Portefeuille paper, trades, stratégies modifiées et journal de cette démo seront effacés.",
      confirmLabel: "Tout effacer",
      tone: "danger",
      requireText: "RESET",
    });
    if (!r.ok) return;
    await resetDemo(storage);
    location.reload();
  };
  return (
    <div className="border-b border-sky-900/60 bg-sky-950/60 px-4 py-2 text-xs text-sky-100">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-1">
        <strong className="tracking-wide">DÉMO</strong>
        <span>
          Le moteur complet tourne dans ton navigateur. Le marché simulé avance tant que la page est ouverte. Sauvegarde : <strong>{storage.kind}</strong>
          {info.resumed && info.savedAt ? ` · session reprise (état du ${new Date(info.savedAt).toLocaleString("fr-FR")})` : ""}.
        </span>
        <button id="demo-reset" onClick={reset} className="ml-auto rounded border border-sky-700 px-2 py-0.5 hover:bg-sky-900">
          Recommencer à zéro
        </button>
      </div>
    </div>
  );
}

function App({ info, storage }: { info: DemoInfo; storage: DemoStorage }) {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const on = () => {
      setPath(currentPath());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const Page = ROUTES[path] ?? RadarPage;
  return (
    <RadarStreamProvider>
      <DialogProvider>
        <DemoBar info={info} storage={storage} />
        <Header />
        <main className="mx-auto max-w-[1600px] px-4 py-6">
          <Page />
        </main>
      </DialogProvider>
    </RadarStreamProvider>
  );
}

async function boot() {
  const root = createRoot(document.getElementById("root") as HTMLElement);
  try {
    const { backend, info, storage } = await startDemo();
    (globalThis as { __RADAR_DEMO__?: unknown }).__RADAR_DEMO__ = backend;
    root.render(<App info={info} storage={storage} />);
  } catch (err) {
    const el = document.getElementById("boot");
    if (el) el.textContent = `Démarrage impossible : ${(err as Error).message}`;
  }
}
void boot();
