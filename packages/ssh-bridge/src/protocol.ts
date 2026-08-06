// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Wire protocol v2 between the browser (Foxglove Studio server-export view) and the
 * local SSH bridge. See docs/SPEC_server_bag_export.md §4.3 and
 * docs/SPEC_server_file_export_zip.md §4.
 *
 * Client → bridge messages are JSON text frames. Bridge → client messages are JSON text
 * frames plus binary frames carrying file contents between `fileStart` and the terminal
 * message (`fileEnd` / `canceled` / `error`) of a download.
 */

export const PROTOCOL_VERSION = 2;

/** Maximum size of a single binary frame carrying file data. */
export const MAX_BINARY_FRAME_BYTES = 1024 * 1024;

/** Flow control window: bridge stops reading from SFTP when unacknowledged bytes exceed this. */
export const WINDOW_BYTES = 8 * 1024 * 1024;

/** SSH connect timeout. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** Close the SSH session after this much inactivity (no client messages). */
export const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export const ERROR_CODES = [
  "AUTH_FAILED",
  "HOST_UNREACHABLE",
  "TIMEOUT",
  "NO_SUCH_PATH",
  "NOT_A_DIRECTORY",
  "PERMISSION_DENIED",
  "IO_ERROR",
  "DISCONNECTED",
  "BAD_REQUEST",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ListEntryKind = "bag" | "active" | "file";

export type ListEntry = {
  name: string;
  size: number;
  /** Epoch milliseconds (server clock). */
  mtimeMs: number;
  kind: ListEntryKind;
};

export type ClientMessage =
  | { type: "hello"; version: number }
  | {
      type: "connect";
      requestId: string;
      host: string;
      port: number;
      username: string;
      password: string;
    }
  | { type: "list"; requestId: string; path: string }
  | { type: "download"; requestId: string; path: string }
  | { type: "ack"; target: string; bytes: number }
  | { type: "cancel"; target: string }
  | { type: "disconnect" };

export type ServerMessage =
  | { type: "hello"; version: number }
  | { type: "connected"; requestId: string }
  | { type: "list"; requestId: string; entries: ListEntry[] }
  | { type: "fileStart"; requestId: string; name: string; size: number }
  | { type: "fileEnd"; requestId: string; bytes: number }
  | { type: "canceled"; requestId: string }
  | { type: "error"; requestId?: string; code: ErrorCode; message: string }
  | { type: "sshClosed"; reason: "idle" | "error"; message: string };

/**
 * Classify a file name per SPEC_server_file_export_zip.md §4.1: `.bag.active`
 * (case-insensitive) → "active", `.bag` → "bag", anything else → "file" (v2 lists and
 * downloads regular files of any name; only `.bag.active` stays non-downloadable).
 */
export function kindForName(name: string): ListEntryKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(".bag.active")) {
    return "active";
  }
  if (lower.endsWith(".bag")) {
    return "bag";
  }
  return "file";
}

/**
 * Validate a client-supplied download path against the directory of the most recent
 * successful `list` (SPEC §4.3: the bridge never trusts arbitrary client paths).
 * Returns the bare file name on success.
 *
 * v2 (SPEC_server_file_export_zip.md §4.3): any listed non-`.bag.active` name may be
 * downloaded. Only `/` is rejected as a path separator — a backslash is a legal file
 * name character on Linux.
 */
export function validateDownloadPath(
  path: string,
  listDir: string,
): { name: string } | { error: string } {
  const prefix = listDir.endsWith("/") ? listDir : `${listDir}/`;
  if (!path.startsWith(prefix)) {
    return { error: `path must be inside the last listed directory ${listDir}` };
  }
  const name = path.slice(prefix.length);
  if (name.length === 0 || name.includes("/")) {
    return { error: "file name must not contain path separators" };
  }
  if (kindForName(name) === "active") {
    return { error: ".bag.active files may not be downloaded" };
  }
  return { name };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Parse and validate a JSON text frame from the client. Returns undefined for frames
 * that are not well-formed protocol messages (caller responds with BAD_REQUEST).
 */
export function parseClientMessage(data: string): ClientMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isString(parsed.type)) {
    return undefined;
  }
  switch (parsed.type) {
    case "hello":
      if (typeof parsed.version === "number") {
        return { type: "hello", version: parsed.version };
      }
      return undefined;
    case "connect":
      if (
        isString(parsed.requestId) &&
        isString(parsed.host) &&
        typeof parsed.port === "number" &&
        isString(parsed.username) &&
        isString(parsed.password)
      ) {
        return {
          type: "connect",
          requestId: parsed.requestId,
          host: parsed.host,
          port: parsed.port,
          username: parsed.username,
          password: parsed.password,
        };
      }
      return undefined;
    case "list":
      if (isString(parsed.requestId) && isString(parsed.path)) {
        return { type: "list", requestId: parsed.requestId, path: parsed.path };
      }
      return undefined;
    case "download":
      if (isString(parsed.requestId) && isString(parsed.path)) {
        return { type: "download", requestId: parsed.requestId, path: parsed.path };
      }
      return undefined;
    case "ack":
      if (isString(parsed.target) && typeof parsed.bytes === "number") {
        return { type: "ack", target: parsed.target, bytes: parsed.bytes };
      }
      return undefined;
    case "cancel":
      if (isString(parsed.target)) {
        return { type: "cancel", target: parsed.target };
      }
      return undefined;
    case "disconnect":
      return { type: "disconnect" };
    default:
      return undefined;
  }
}
