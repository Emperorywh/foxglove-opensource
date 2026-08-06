// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Browser-side streaming ZIP assembly for the server-export view
 * (docs/SPEC_server_file_export_zip.md §5).
 *
 * Entries are stored uncompressed (fflate ZipPassThrough): the zip is purely a
 * container, so memory usage stays at roughly one flow-control ack window. fflate's
 * streaming write path has no ZIP64 support (sizes/offsets are truncated to 32 bits
 * silently), so a hard byte guard aborts the package before it can overflow.
 *
 * This module is pure logic — no React — and is unit-tested in serverExportZip.test.ts.
 */

import { Zip, ZipPassThrough } from "fflate";

/**
 * Maximum zip container bytes: 4 GiB − 64 MiB. The headroom covers the central
 * directory and in-flight entry overhead (SPEC §5.6).
 */
export const MAX_ZIP_BYTES = 0xfc000000;

// fflate encodes entry mtimes as DOS timestamps read through *local-time* Date getters
// and throws for years outside 1980–2099, so entry mtimes are clamped to this range
// (SPEC §5.2). The bounds are constructed as local dates to match fflate's getters.
const DOS_TIME_MIN_MS = new Date(1980, 0, 1, 0, 0, 0).getTime();
const DOS_TIME_MAX_MS = new Date(2099, 11, 31, 23, 59, 58).getTime();

/** The zip container grew past the byte limit — the package must be discarded. */
export class ZipSizeLimitExceededError extends Error {
  public readonly bytesWritten: number;
  public readonly maxBytes: number;

  public constructor(bytesWritten: number, maxBytes: number) {
    super(
      `zip container exceeded the limit (${bytesWritten} > ${maxBytes} bytes); ZIP64 is not supported`,
    );
    this.name = "ZipSizeLimitExceededError";
    this.bytesWritten = bytesWritten;
    this.maxBytes = maxBytes;
  }
}

/** Pre-export selection check (SPEC §5.6): Σ list sizes at or above the limit is rejected. */
export function zipSelectionTooLarge(
  totalBytes: number,
  maxBytes: number = MAX_ZIP_BYTES,
): boolean {
  return totalBytes >= maxBytes;
}

/** `export-YYYYMMDD-HHmmss.zip` in the local time zone (SPEC §5.4). Pure function. */
export function zipFileName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `export-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.zip`
  );
}

/**
 * Resolve a zip name conflict by appending ` (n)` until `exists` reports no conflict
 * (SPEC §5.4). `exists` is injected for testability.
 */
export async function resolveZipNameConflict(
  baseName: string,
  exists: (name: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(baseName))) {
    return baseName;
  }
  const stem = baseName.endsWith(".zip") ? baseName.slice(0, -".zip".length) : baseName;
  for (let index = 1; ; index++) {
    const candidate = `${stem} (${index}).zip`;
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
}

export type ServerExportZipWriter = {
  /**
   * Start a new entry. The mtime is clamped to the DOS-encodable range. Never throws:
   * a tripped size guard or write failure is surfaced by pushEntryChunk/endEntry.
   */
  beginEntry(name: string, mtimeMs: number): void;
  /**
   * Append file bytes to the current entry. Resolves once the container bytes produced
   * by this chunk (local header / data / data descriptor) have been written to the
   * underlying writable — callers gate their flow-control ack on this (SPEC §5.3).
   */
  pushEntryChunk(chunk: Uint8Array): Promise<void>;
  /** Finish the current entry (writes its data descriptor). */
  endEntry(): Promise<void>;
  /** Write the central directory and close the writable. Throws past the size limit. */
  finalize(): Promise<void>;
  /**
   * Failure/cancel path: entry methods become no-ops, the Zip instance is discarded
   * without writing a central directory, in-flight writes are awaited, the writable is
   * aborted, and the partial zip is best-effort removed via the onAbort callback.
   */
  abort(): Promise<void>;
};

export function createZipWriter(
  writable: FileSystemWritableFileStream,
  opts?: {
    /** Defaults to MAX_ZIP_BYTES; tests inject a small limit. */
    maxBytes?: number;
    /** Best-effort cleanup of the partial zip (e.g. dirHandle.removeEntry). Errors are ignored. */
    onAbort?: () => Promise<void>;
  },
): ServerExportZipWriter {
  const maxBytes = opts?.maxBytes ?? MAX_ZIP_BYTES;
  const onAbort = opts?.onAbort;

  let aborted = false;
  let bytesWritten = 0;
  let sizeError: ZipSizeLimitExceededError | undefined;
  let writeError: unknown;
  let entry: ZipPassThrough | undefined;

  // fflate invokes the Zip callback synchronously during push(), while writable.write
  // is async — writes are serialized through this chain to preserve chunk order. The
  // chain never rejects; failures are recorded in writeError and surfaced at the next
  // await point.
  let chain: Promise<void> = Promise.resolve();

  const zip = new Zip((err: unknown, data: Uint8Array) => {
    if (aborted) {
      return;
    }
    if (err != undefined) {
      writeError ??= err;
      return;
    }
    if (sizeError != undefined) {
      return; // already past the limit — drop further container bytes
    }
    bytesWritten += data.byteLength;
    if (bytesWritten > maxBytes) {
      sizeError = new ZipSizeLimitExceededError(bytesWritten, maxBytes);
      return;
    }
    chain = chain
      .then(async () => {
        await writable.write(data);
      })
      .catch((writeErr: unknown) => {
        writeError ??= writeErr;
      });
  });

  const throwIfFailed = (): void => {
    if (sizeError != undefined) {
      throw sizeError;
    }
    if (writeError != undefined) {
      throw writeError instanceof Error ? writeError : new Error(String(writeError));
    }
  };

  return {
    beginEntry(name: string, mtimeMs: number): void {
      if (aborted || sizeError != undefined || writeError != undefined) {
        // Stay inert; the failure surfaces at the next pushEntryChunk/endEntry await.
        return;
      }
      const clamped = Math.min(Math.max(mtimeMs, DOS_TIME_MIN_MS), DOS_TIME_MAX_MS);
      const passthrough = new ZipPassThrough(name);
      passthrough.mtime = new Date(clamped);
      zip.add(passthrough);
      entry = passthrough;
    },

    async pushEntryChunk(chunk: Uint8Array): Promise<void> {
      if (aborted) {
        return;
      }
      throwIfFailed();
      if (entry == undefined) {
        throw new Error("beginEntry must be called before pushEntryChunk");
      }
      entry.push(chunk);
      throwIfFailed();
      await chain;
      throwIfFailed();
    },

    async endEntry(): Promise<void> {
      if (aborted) {
        return;
      }
      throwIfFailed();
      const current = entry;
      entry = undefined;
      if (current != undefined) {
        current.push(new Uint8Array(0), true);
      }
      throwIfFailed();
      await chain;
      throwIfFailed();
    },

    async finalize(): Promise<void> {
      if (aborted) {
        throw new Error("cannot finalize an aborted zip writer");
      }
      throwIfFailed();
      zip.end();
      // The central directory may itself trip the size guard — check before landing
      // the file (SPEC §5.6).
      throwIfFailed();
      await chain;
      throwIfFailed();
      await writable.close();
    },

    async abort(): Promise<void> {
      if (aborted) {
        return;
      }
      aborted = true;
      entry = undefined;
      // The Zip instance is discarded without end(); late chunks are dropped by the
      // no-op entry methods above, so no central directory is ever emitted.
      await chain;
      await writable.abort().catch(() => undefined);
      if (onAbort != undefined) {
        await onAbort().catch(() => undefined);
      }
    },
  };
}
