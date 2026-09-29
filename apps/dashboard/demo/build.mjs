// Builds the standalone demo: one HTML file (inline JS + CSS), React from cdnjs.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboard = path.resolve(here, "..");
// `--web`: the live website (real market data, deployed on Cloudflare Pages) instead of the simulated demo.
const WEB = process.argv.includes("--web");
const outFile = WEB ? path.resolve(dashboard, "../../deploy/cloudflare/public/index.html") : path.join(here, "dist", "crypto-radar-demo.html");
mkdirSync(path.dirname(outFile), { recursive: true });

const shim = (f) => path.join(here, "shims", f);
const aliasPlugin = {
  name: "demo-aliases",
  setup(b) {
    const map = {
      react: shim("react.cjs"),
      "react-dom/client": shim("react-dom-client.cjs"),
      "next/link": shim("next-link.tsx"),
      "next/navigation": shim("next-navigation.ts"),
      "node:crypto": shim("node-crypto.ts"),
      "react/jsx-runtime": shim("jsx-runtime.cjs"),
      "react/jsx-dev-runtime": shim("jsx-runtime.cjs"),
    };
    b.onResolve({ filter: /^(react|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime|next\/link|next\/navigation|node:crypto)$/ }, (a) => ({ path: map[a.path] }));
  },
};

const js = await build({
  entryPoints: [WEB ? path.join(dashboard, "web", "main.tsx") : path.join(here, "main.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  define: { "process.env.NEXT_PUBLIC_API_URL": "undefined", "process.env.NODE_ENV": '"production"' },
  tsconfig: path.join(dashboard, "tsconfig.json"),
  plugins: [aliasPlugin],
  logLevel: "warning",
});
const bundle = js.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const cssInput = `${readFileSync(path.join(dashboard, "app/globals.css"), "utf8")}
@source "../components";
@source "../demo";
@source "../web";
@source "../app";`;
const css = await postcss([tailwind({ base: dashboard, optimize: { minify: true } })]).process(cssInput, { from: path.join(dashboard, "app/globals.css") });

const REACT = "https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js";
const REACT_DOM = "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js";
const head = WEB
  ? `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Crypto Radar — live</title><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='7' fill='%2322c55e'/></svg>"></head><body>`
  : `<title>Crypto Radar</title>`;
const html = `${head}
<style>${css.css}
html,body{background:#070b14;color:#e2e8f0}
#boot{font:14px ui-sans-serif,system-ui,sans-serif;color:#94a3b8;padding:48px 16px;text-align:center}
</style>
<div id="root"><div id="boot">${WEB ? "Connexion au marché…" : "Démarrage du moteur de la démo…"}</div></div>
<script src="${REACT}"></script>
<script src="${REACT_DOM}"></script>
<script>${bundle}</script>
${WEB ? "</body></html>" : ""}`;
writeFileSync(outFile, html);
console.log(`${WEB ? "web" : "demo"}: ${(html.length / 1024).toFixed(0)} KiB → ${outFile}`);
