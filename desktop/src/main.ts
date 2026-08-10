// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { WriteStream, createReadStream, createWriteStream } from "fs";
import { readFile, stat, unlink } from "fs/promises";
import { createServer } from "http";
import { AddressInfo } from "net";
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
      if (info?.isDirectory() === true) {
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
 * Server-file export: the renderer cannot use the File System Access API's write path —
 * Electron denies write grants, so createWritable() always rejects with NotAllowedError.
 * These handlers stream the bytes to Node fs instead (consumed via the serverExportFs
 * preload bridge). File names are validated as bare names and resolved inside the chosen
 * directory, so a compromised renderer cannot escape it through this channel.
 */
type OpenExportFile = {
  stream: WriteStream;
  /** First async stream error, replayed to the next write/close call. */
  failure?: Error;
};

let nextExportFileId = 1;
const openExportFiles = new Map<number, OpenExportFile>();

function exportFilePath(dir: unknown, name: unknown): string {
  if (typeof dir !== "string" || dir === "") {
    throw new Error("invalid export directory");
  }
  if (
    typeof name !== "string" ||
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error(`invalid export file name: ${String(name)}`);
  }
  return path.join(dir, name);
}

function openExportFile(id: unknown): { id: number; entry: OpenExportFile } {
  const entry = typeof id === "number" ? openExportFiles.get(id) : undefined;
  if (entry == undefined) {
    throw new Error(`unknown export file id: ${String(id)}`);
  }
  return { id: id as number, entry };
}

function setupServerExportIpc(): void {
  ipcMain.handle("serverExport:chooseDirectory", async (event) => {
    const options = {
      title: "选择导出目录",
      buttonLabel: "选择此目录",
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
    };
    const win = BrowserWindow.fromWebContents(event.sender);
    const result =
      win == undefined
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(win, options);
    const dir = result.filePaths[0];
    return result.canceled || dir == undefined ? undefined : dir;
  });

  ipcMain.handle("serverExport:exists", async (_event, dir: unknown, name: unknown) => {
    try {
      await stat(exportFilePath(dir, name));
      return true;
    } catch {
      return false; // missing (or unreadable) — treated as "no conflict"
    }
  });

  ipcMain.handle("serverExport:createFile", async (_event, dir: unknown, name: unknown) => {
    const filePath = exportFilePath(dir, name);
    const stream = createWriteStream(filePath, { flags: "w" });
    // Surface open-time failures (EACCES, ENOSPC, …) to the caller synchronously.
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        stream.removeListener("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        stream.removeListener("open", onOpen);
        reject(err);
      };
      stream.once("open", onOpen);
      stream.once("error", onError);
    });
    const id = nextExportFileId++;
    const entry: OpenExportFile = { stream };
    openExportFiles.set(id, entry);
    // Errors after a successful open are recorded and replayed by write/close — without
    // a listener the process would crash on an unhandled 'error' event.
    stream.on("error", (err) => {
      entry.failure ??= err;
    });
    return id;
  });

  ipcMain.handle("serverExport:write", async (_event, id: unknown, chunk: unknown) => {
    const { entry } = openExportFile(id);
    if (entry.failure != undefined) {
      throw entry.failure;
    }
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("export write chunk must be a Uint8Array");
    }
    if (entry.stream.write(chunk)) {
      return;
    }
    // Kernel buffer full — apply back-pressure until drain (or a deferred error).
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => {
        entry.stream.removeListener("error", onError);
        resolve();
      };
      const onError = (err: Error): void => {
        entry.stream.removeListener("drain", onDrain);
        reject(err);
      };
      entry.stream.once("drain", onDrain);
      entry.stream.once("error", onError);
    });
  });

  ipcMain.handle("serverExport:close", async (_event, id: unknown) => {
    const { id: fileId, entry } = openExportFile(id);
    openExportFiles.delete(fileId);
    await new Promise<void>((resolve, reject) => {
      entry.stream.once("error", reject);
      entry.stream.end(() => {
        resolve();
      });
    });
    // A deferred mid-stream failure still voids the file even when the flush succeeded.
    if (entry.failure != undefined) {
      throw entry.failure;
    }
  });

  ipcMain.handle("serverExport:abort", async (_event, id: unknown) => {
    const { id: fileId, entry } = openExportFile(id);
    openExportFiles.delete(fileId);
    entry.stream.destroy();
    // On Windows, unlinking right after destroy races the handle release — wait for
    // close. Deleting the partial file is the renderer's job (serverExport:remove).
    if (!entry.stream.closed) {
      await new Promise<void>((resolve) => {
        entry.stream.once("close", () => {
          resolve();
        });
      });
    }
  });

  ipcMain.handle("serverExport:remove", async (_event, dir: unknown, name: unknown) => {
    try {
      await unlink(exportFilePath(dir, name));
    } catch (err) {
      // Already gone is the desired end state; real failures (EPERM, EBUSY) must surface
      // so the renderer can report the leftover partial file.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  });

  ipcMain.handle("serverExport:readFile", async (_event, dir: unknown, name: unknown) => {
    // "Export and open" re-ingests the finished file as a local bag in the renderer.
    return await readFile(exportFilePath(dir, name));
  });

  app.on("will-quit", () => {
    for (const { stream } of openExportFiles.values()) {
      stream.destroy();
    }
    openExportFiles.clear();
  });
}

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
    setupServerExportIpc();
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
