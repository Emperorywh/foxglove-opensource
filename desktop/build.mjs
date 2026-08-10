// Bundles the Electron main process and stages the web build for packaging.
//
//   1. esbuild bundles src/main.ts + src/preload.ts -> dist/ (including the ssh-bridge
//      sources and the ws/ssh2 dependencies), so the packaged app needs no
//      node_modules at all.
//   2. The production web build (web/.webpack, produced by `yarn web:build:prod`)
//      is copied to web-dist/ so electron-builder can pick it up via `files`.

import * as esbuild from "esbuild";
import { cpSync, existsSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopDir, "..");
const webBuildDir = path.join(repoRoot, "web", ".webpack");

if (!existsSync(path.join(webBuildDir, "index.html"))) {
  console.error(`web build not found at ${webBuildDir} — run "yarn web:build:prod" first`);
  process.exit(1);
}

await esbuild.build({
  entryPoints: [
    path.join(desktopDir, "src", "main.ts"),
    path.join(desktopDir, "src", "preload.ts"),
  ],
  outdir: path.join(desktopDir, "dist"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  external: ["electron", "cpu-features"],
  alias: {
    "@foxglove/ssh-bridge/server": path.join(repoRoot, "packages", "ssh-bridge", "src", "server.ts"),
  },
});

const webDistDir = path.join(desktopDir, "web-dist");
rmSync(webDistDir, { recursive: true, force: true });
cpSync(webBuildDir, webDistDir, { recursive: true });

console.log("desktop bundle ready: dist/ + web-dist/");
