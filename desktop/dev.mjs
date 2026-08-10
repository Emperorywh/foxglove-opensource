// Development runner: esbuild --watch for the main/preload bundle + auto-restart Electron.
//
//   yarn web:serve          # terminal 1 (renderer HMR)
//   yarn desktop:dev        # terminal 2
//
// The runner probes the webpack-dev-server at http://localhost:8080: when it is up the
// Electron window loads it (renderer changes hot-reload); otherwise the window loads
// the staged production build in web-dist/. Saving src/main.ts or src/preload.ts
// rebuilds in ~100ms and restarts Electron either way (preload scripts cannot be
// swapped into a running window, so a restart is the honest answer).

import * as esbuild from "esbuild";
import { spawn } from "child_process";
import electronPath from "electron";
import { cpSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(desktopDir, "..");

/**
 * Renderer target: an explicitly set FOXGLOVE_DEV_SERVER_URL wins; otherwise probe the
 * webpack-dev-server default port and use it when up. Electron inherits the variable
 * through process.env. Returns undefined when the window should load web-dist/.
 */
async function resolveDevServerUrl() {
  const explicit = process.env.FOXGLOVE_DEV_SERVER_URL;
  const candidate = explicit ?? "http://localhost:8080";
  const reachable = await fetch(candidate, { signal: AbortSignal.timeout(1500) }).then(
    () => true,
    () => false,
  );
  if (reachable) {
    process.env.FOXGLOVE_DEV_SERVER_URL = candidate;
    console.log(`[dev] renderer: ${candidate} (webpack-dev-server — HMR enabled)`);
    return candidate;
  }
  if (explicit != undefined) {
    console.warn(`[dev] warning: ${explicit} is unreachable — run "yarn web:serve" first`);
    return explicit;
  }
  return undefined;
}

const devServerUrl = await resolveDevServerUrl();
if (devServerUrl == undefined) {
  console.log('[dev] renderer: web-dist (run "yarn web:serve" first for HMR)');
  const webBuildDir = path.join(repoRoot, "web", ".webpack");
  if (existsSync(path.join(webBuildDir, "index.html"))) {
    cpSync(webBuildDir, path.join(desktopDir, "web-dist"), { recursive: true });
  } else {
    console.warn('web build not found — run "yarn web:build:prod" once first');
  }
}

/** @type {import("child_process").ChildProcess | undefined} */
let electronProcess;
let quitting = false;

/** Kill the whole Electron process tree and wait for the root to exit. */
async function stopElectron(proc) {
  if (proc.exitCode != undefined) {
    return;
  }
  await new Promise((resolve) => {
    proc.once("exit", resolve);
    proc.once("error", resolve);
    if (process.platform === "win32") {
      // TerminateProcess only hits the root — taskkill takes the renderer/GPU tree too.
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  });
}

async function restartElectron() {
  const old = electronProcess;
  electronProcess = undefined;
  if (old != undefined) {
    // The single-instance lock requires the old process to be fully gone first.
    await stopElectron(old);
  }
  if (quitting) {
    return;
  }
  const proc = spawn(String(electronPath), ["."], {
    cwd: desktopDir,
    stdio: "inherit",
    env: process.env,
  });
  electronProcess = proc;
  proc.once("exit", (code) => {
    if (electronProcess === proc) {
      // The app quit on its own (window closed) — end the dev session too.
      quitting = true;
      process.exit(code ?? 0);
    }
  });
}

// Restarts are serialized: a rebuild arriving mid-restart queues behind it.
let restartQueue = Promise.resolve();
function queueRestart() {
  restartQueue = restartQueue.then(restartElectron).catch((err) => {
    console.error(err);
  });
}

const context = await esbuild.context({
  // Keep these options in sync with build.mjs (no web-dist staging here).
  entryPoints: [path.join(desktopDir, "src", "main.ts"), path.join(desktopDir, "src", "preload.ts")],
  outdir: path.join(desktopDir, "dist"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  logLevel: "info",
  external: ["electron", "cpu-features"],
  alias: {
    "@foxglove/ssh-bridge/server": path.join(repoRoot, "packages", "ssh-bridge", "src", "server.ts"),
  },
  plugins: [
    {
      name: "restart-electron",
      setup(build) {
        build.onEnd((result) => {
          // A failed build keeps the previous (working) Electron instance running.
          if (result.errors.length === 0) {
            queueRestart();
          }
        });
      },
    },
  ],
});
await context.watch();

async function shutdown() {
  quitting = true;
  if (electronProcess != undefined) {
    await stopElectron(electronProcess);
  }
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
