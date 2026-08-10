// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { AddressInfo } from "net";

import { app, BrowserWindow, dialog, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { createServer } from "http";
import path from "path";

import { DEFAULT_PORT, startBridgeServer } from "@foxglove/ssh-bridge/server";

/**
 * The renderer is served over http://127.0.0.1 by a tiny static server instead of
 * file:// so that webpack code-split chunks, web workers and .wasm assets load
 * exactly as they do in the browser build.
 */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".bin": "application/octet-stream",
  ".bag": "application/octet-stream",
  ".mcap": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
};

/** Built web assets, copied next to dist/ by build.mjs (same layout inside the asar). */
function webRoot(): string {
  return path.join(__dirname, "..", "web-dist");
}

/** Serve the web build on an ephemeral loopback port. Returns the bound port. */
async function startStaticServer(root: string): Promise<number> {
  const server = createServer((req, res) => {
    void (async () => {
      const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
      let filePath = path.normalize(path.join(root, urlPath));
      // Reject path traversal outside the web root.
      if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      let info = await stat(filePath).catch(() => undefined);
      if (info?.isDirectory()) {
        filePath = path.join(filePath, "index.html");
        info = await stat(filePath).catch(() => undefined);
      }
      if (info == undefined) {
        // SPA fallback: unknown paths load the app shell.
        filePath = path.join(root, "index.html");
        info = await stat(filePath).catch(() => undefined);
        if (info == undefined) {
          res.writeHead(404);
          res.end();
          return;
        }
      }
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": info.size,
        "Cache-Control": "no-cache",
      });
      createReadStream(filePath).pipe(res);
    })().catch((err: unknown) => {
      console.warn(`[static-server] ${String(err)}`);
      res.writeHead(500);
      res.end();
    });
  });

  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/**
 * Embed the SSH bridge in the main process so users don't run it separately.
 * Tries the well-known port 8765 first; if it is occupied (a standalone bridge or
 * an unrelated program), falls back to an ephemeral port. The renderer learns the
 * resolved URL through the preload script, so the SSH export feature works either way.
 */
async function startBridge(): Promise<string> {
  for (const port of [DEFAULT_PORT, 0]) {
    const wss = startBridgeServer(port);
    const boundPort = await new Promise<number>((resolve, reject) => {
      wss.once("listening", () => {
        resolve((wss.address() as AddressInfo).port);
      });
      wss.once("error", reject);
    }).catch((err: unknown) => {
      console.warn(`[ssh-bridge] port ${port === 0 ? "auto" : port} unavailable: ${String(err)}`);
      return undefined;
    });
    if (boundPort != undefined) {
      return `ws://127.0.0.1:${boundPort}`;
    }
  }
  // Both attempts failed — let the renderer use its default URL (e.g. a standalone
  // bridge started with `yarn bridge:serve`).
  return `ws://127.0.0.1:${DEFAULT_PORT}`;
}

const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Check GitHub Releases for updates (configured via the `publish` field in package.json).
 * Downloads in the background; when a new version is ready, asks the user to restart.
 * Only runs in the packaged app — dev builds have no app-update.yml.
 */
function setupAutoUpdates(): void {
  if (!app.isPackaged) {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.on("error", (err) => {
    console.warn(`[updater] ${String(err)}`);
  });
  autoUpdater.on("update-downloaded", (info) => {
    void (async () => {
      const { response } = await dialog.showMessageBox({
        type: "info",
        title: "更新已就绪",
        message: `新版本 ${info.version} 已下载完成`,
        detail: "重启应用以完成更新。",
        buttons: ["立即重启", "稍后"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        autoUpdater.quitAndInstall();
      }
    })();
  });
  const check = (): void => {
    void autoUpdater.checkForUpdates().catch((err: unknown) => {
      console.warn(`[updater] check failed: ${String(err)}`);
    });
  };
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

async function createMainWindow(bridgeUrl: string): Promise<void> {
  const port = await startStaticServer(webRoot());

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: "#121218",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
      additionalArguments: [`--ssh-bridge-url=${bridgeUrl}`],
    },
  });

  // Open external links in the system browser instead of new app windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Set FOXGLOVE_DEV_SERVER_URL=http://localhost:8080 to develop against
  // `yarn web:serve` instead of the bundled build.
  const devServerUrl = process.env.FOXGLOVE_DEV_SERVER_URL;
  await win.loadURL(devServerUrl ?? `http://127.0.0.1:${port}/`);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | undefined;

  app.on("second-instance", () => {
    if (mainWindow != undefined) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    const bridgeUrl = await startBridge();
    await createMainWindow(bridgeUrl);
    mainWindow = BrowserWindow.getAllWindows()[0];
    setupAutoUpdates();

    app.on("activate", () => {
      // macOS: re-create the window when the dock icon is clicked.
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow(bridgeUrl);
      }
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
