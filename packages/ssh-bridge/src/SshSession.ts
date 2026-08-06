// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Readable } from "stream";

import { ErrorCode } from "./protocol";

/** A file as reported by the SSH layer, before protocol-level kind filtering. */
export type SshFileInfo = {
  name: string;
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
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
