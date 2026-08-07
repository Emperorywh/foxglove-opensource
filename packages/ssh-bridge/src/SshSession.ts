// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Readable } from "stream";

import { ErrorCode } from "./protocol";

/**
 * Directory entry type derived from SFTP attrs permission bits
 * (SPEC_server_file_export_zip.md §4.2). Servers that omit the type bits are reported
 * as "file" — genuinely unreadable entries then fail in the download phase instead.
 */
export type SshEntryType = "file" | "directory" | "symlink" | "other";

/** A file as reported by the SSH layer, before protocol-level kind filtering. */
export type SshFileInfo = {
  name: string;
  size: number;
  mtimeMs: number;
  entryType: SshEntryType;
};

/** Error with a protocol-level error code already mapped (see protocol.ts ERROR_CODES). */
export class SshError extends Error {
  public readonly code: ErrorCode;

  public constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "SshError";
    this.code = code;
  }
}

/**
 * One SSH/SFTP session. Implemented by ssh2Connector.ts in production and by fakes in
 * tests. Methods throw SshError for expected failure modes.
 */
export interface SshSession {
  /** List directory entries (flat, single level). */
  list(dir: string): Promise<SshFileInfo[]>;
  /** Size of a single file, for the fileStart message. */
  fileSize(path: string): Promise<number>;
  /**
   * Canonicalize a path (resolves `.`, `..` and symlink components). Throws SshError
   * (SPEC_server_file_browser.md §4.2).
   */
  realpath(path: string): Promise<string>;
  /**
   * stat following symlinks; used to classify symlink entries at list time
   * (SPEC_server_file_browser.md §4.3). Under follow semantics the returned entryType is
   * never "symlink" (a symlink loop resolves to a stat failure).
   */
  statFollow(path: string): Promise<{ size: number; mtimeMs: number; entryType: SshEntryType }>;
  /** Read stream for a file. Stream errors are SshErrors where mappable. */
  openReadStream(path: string): Readable;
  /** Close the session. Subsequent onClose callbacks still fire but are ignored by the bridge. */
  close(): void;
  /** Register a callback for session teardown (expected or unexpected). */
  onClose(callback: () => void): void;
}

export type ConnectOptions = {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs: number;
};

export type Connector = (opts: ConnectOptions) => Promise<SshSession>;
