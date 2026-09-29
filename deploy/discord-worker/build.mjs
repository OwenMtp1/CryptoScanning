// Bundles the worker into dist/worker.js (committed, so Cloudflare needs no build step).
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const { build } = createRequire(path.join(root, "apps/dashboard/package.json"))("esbuild");
await build({
  entryPoints: [path.join(here, "src/worker.ts")],
  outfile: path.join(here, "dist/worker.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["worker", "browser"],
  alias: { "@radar/core": path.join(root, "packages/core/src/index.ts") },
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});
console.log("worker → deploy/discord-worker/dist/worker.js");
