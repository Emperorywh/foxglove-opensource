// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Local export destination for the server-file export flow.
 *
 * The browser build writes through the File System Access API. The desktop app cannot:
 * Electron implements only the read half of that API — write grants are denied, so
 * createWritable() rejects with NotAllowedError ("The request is not allowed by the
 * user agent or the platform in the current context"). Instead the Electron preload
 * injects `globalThis.serverExportFs`, an IPC bridge to Node fs in the main process
 * (desktop/src/preload.ts mirrors these types). Both backends expose the same minimal
 * surface used by the single-file and zip export flows.
 */

/** Minimal sequential-write sink — the subset of FileSystemWritableFileStream the exporters use. */
export type ServerExportWritable = {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};

export type ServerExportTarget = {
  /** UI label — the bare directory name in the browser, the full path on desktop. */
  displayName: string;
  /** True when a filesystem entry with this bare name already exists (conflict probe). */
  exists(name: string): Promise<boolean>;
  /** Create/truncate a file and open a stream for sequential writes. */
  createWritable(name: string): Promise<ServerExportWritable>;
  /** Delete a partial product (a missing entry must surface so leftovers can be reported). */
  removeEntry(name: string): Promise<void>;
  /** Read a finished file back — "export and open" re-ingests it as a local bag. */
  readFile(name: string): Promise<File>;
};

/** IPC surface exposed by the desktop preload as `globalThis.serverExportFs`. */
type DesktopExportFs = {
  /** Native directory picker; resolves the absolute path, or undefined when dismissed. */
  chooseDirectory(): Promise<string | undefined>;
  exists(dir: string, name: string): Promise<boolean>;
  /** Create/truncate dir/name and return a handle id for the write/close/abort calls. */
  createFile(dir: string, name: string): Promise<number>;
  write(id: number, chunk: Uint8Array): Promise<void>;
  close(id: number): Promise<void>;
  abort(id: number): Promise<void>;
  remove(dir: string, name: string): Promise<void>;
  readFile(dir: string, name: string): Promise<Uint8Array>;
};

/** The desktop fs bridge, or undefined in the browser build. */
export function desktopExportFs(): DesktopExportFs | undefined {
  return (globalThis as { serverExportFs?: DesktopExportFs }).serverExportFs;
}

class FileSystemAccessTarget implements ServerExportTarget {
  readonly #handle: FileSystemDirectoryHandle;
  public readonly displayName: string;

  public constructor(handle: FileSystemDirectoryHandle) {
    this.#handle = handle;
    // The File System Access API only exposes the directory name, not its full path.
    this.displayName = handle.name;
  }

  public async exists(name: string): Promise<boolean> {
    try {
      await this.#handle.getFileHandle(name);
      return true;
    } catch {
      return false; // NotFoundError: no conflict
    }
  }

  public async createWritable(name: string): Promise<ServerExportWritable> {
    const fileHandle = await this.#handle.getFileHandle(name, { create: true });
    return await fileHandle.createWritable();
  }

  public async removeEntry(name: string): Promise<void> {
    await this.#handle.removeEntry(name);
  }

  public async readFile(name: string): Promise<File> {
    const fileHandle = await this.#handle.getFileHandle(name);
    return await fileHandle.getFile();
  }
}

class DesktopExportTarget implements ServerExportTarget {
  readonly #fs: DesktopExportFs;
  readonly #dir: string;
  public readonly displayName: string;

  public constructor(fs: DesktopExportFs, dir: string) {
    this.#fs = fs;
    this.#dir = dir;
    // The native picker knows the absolute path — show it instead of the bare name.
    this.displayName = dir;
  }

  public async exists(name: string): Promise<boolean> {
    return await this.#fs.exists(this.#dir, name);
  }

  public async createWritable(name: string): Promise<ServerExportWritable> {
    const fs = this.#fs;
    const id = await fs.createFile(this.#dir, name);
    return {
      write: async (chunk) => {
        await fs.write(id, chunk);
      },
      close: async () => {
        await fs.close(id);
      },
      abort: async () => {
        await fs.abort(id);
      },
    };
  }

  public async removeEntry(name: string): Promise<void> {
    await this.#fs.remove(this.#dir, name);
  }

  public async readFile(name: string): Promise<File> {
    const bytes = await this.#fs.readFile(this.#dir, name);
    return new File([bytes], name);
  }
}

/**
 * Ask the user for an export directory — native dialog on desktop, File System Access
 * picker in the browser. Resolves undefined when the picker is dismissed; real failures
 * (permissions, IPC) are thrown for the caller to surface.
 */
export async function pickExportTarget(): Promise<ServerExportTarget | undefined> {
  const desktop = desktopExportFs();
  if (desktop != undefined) {
    const dir = await desktop.chooseDirectory();
    return dir == undefined ? undefined : new DesktopExportTarget(desktop, dir);
  }
  try {
    const handle = await showDirectoryPicker({ mode: "readwrite" });
    return new FileSystemAccessTarget(handle);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return undefined; // user dismissed the picker
    }
    throw err;
  }
}
