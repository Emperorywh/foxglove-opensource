// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { contextBridge, ipcRenderer } from "electron";

// The main process passes the resolved bridge URL via additionalArguments
// (--ssh-bridge-url=ws://...). The renderer reads it in defaultBridgeUrl()
// (ServerExportBridgeClient.ts). Deliberately NOT named "desktopBridge" — that
// global gates closed-source desktop features in isDesktopApp().
const PREFIX = "--ssh-bridge-url=";
const arg = process.argv.find((entry) => entry.startsWith(PREFIX));
const url = arg?.slice(PREFIX.length);
if (url != undefined) {
  contextBridge.exposeInMainWorld("sshBridgeUrl", url);
}

/**
 * IPC bridge to Node fs in the main process for the server-file export feature
 * (consumed via desktopExportFs() in studio-base's serverExportTarget.ts, which mirrors
 * these types). Electron implements only the read half of the File System Access API —
 * write grants are denied, so createWritable() always rejects — which is why the export
 * streams its bytes through these calls instead.
 */
const CHANNELS = {
  chooseDirectory: "serverExport:chooseDirectory",
  exists: "serverExport:exists",
  createFile: "serverExport:createFile",
  write: "serverExport:write",
  close: "serverExport:close",
  abort: "serverExport:abort",
  remove: "serverExport:remove",
  readFile: "serverExport:readFile",
  readFileUrl: "serverExport:readFileUrl",
} as const;

/**
 * Electron prefixes invoke() rejections with the channel name ("Error invoking remote
 * method '…': Error: ENOSPC: …") — strip the wrapper so the renderer surfaces the
 * original fs error message in the export summary.
 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      message.replace(/^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/, ""),
    );
  }
}

contextBridge.exposeInMainWorld("serverExportFs", {
  chooseDirectory: async (): Promise<string | undefined> => await invoke(CHANNELS.chooseDirectory),
  exists: async (dir: string, name: string): Promise<boolean> => await invoke(CHANNELS.exists, dir, name),
  createFile: async (dir: string, name: string): Promise<number> =>
    await invoke(CHANNELS.createFile, dir, name),
  write: async (id: number, chunk: Uint8Array): Promise<void> => { await invoke(CHANNELS.write, id, chunk); },
  close: async (id: number): Promise<void> => { await invoke(CHANNELS.close, id); },
  abort: async (id: number): Promise<void> => { await invoke(CHANNELS.abort, id); },
  remove: async (dir: string, name: string): Promise<void> => { await invoke(CHANNELS.remove, dir, name); },
  readFile: async (dir: string, name: string): Promise<Uint8Array> =>
    await invoke(CHANNELS.readFile, dir, name),
  // 闭环 Range 路由 URL(SPEC_robot_export_package.md §13):主进程拼装 token,
  // 渲染进程据此经 CachedFilelike 随机访问导出包 zip。
  readFileUrl: async (dir: string, name: string): Promise<string> =>
    await invoke(CHANNELS.readFileUrl, dir, name),
});
