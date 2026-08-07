// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Browser client for the local SSH bridge (packages/ssh-bridge), protocol v3.
 * See docs/SPEC_server_bag_export.md §4.3, docs/SPEC_server_file_export_zip.md §4 and
 * docs/SPEC_server_file_browser.md §4.
 *
 * The protocol types are mirrored here (rather than imported from the bridge package)
 * because the bridge package targets Node.js; the two sides are version-checked at
 * runtime via the hello handshake.
 */

export const BRIDGE_URL = "ws://127.0.0.1:8765";

const PROTOCOL_VERSION = 3;
const HELLO_TIMEOUT_MS = 5000;

export type ServerExportListEntry = {
  name: string;
  size: number;
  mtimeMs: number;
  kind: "bag" | "active" | "file" | "dir";
};

/** Error codes sent by the bridge, plus client-local failures. */
export type ServerExportErrorCode =
  | "AUTH_FAILED"
  | "HOST_UNREACHABLE"
  | "TIMEOUT"
  | "NO_SUCH_PATH"
  | "NOT_A_DIRECTORY"
  | "PERMISSION_DENIED"
  | "IO_ERROR"
  | "DISCONNECTED"
  | "BAD_REQUEST"
  | "BRIDGE_UNREACHABLE"
  | "BRIDGE_INVALID_HELLO"
  | "BRIDGE_VERSION_MISMATCH"
  | "LOCAL_WRITE_ERROR";

export class ServerExportError extends Error {
  public readonly code: ServerExportErrorCode;

  public constructor(code: ServerExportErrorCode, message: string) {
    super(message);
    this.name = "ServerExportError";
    this.code = code;
  }
}

export type ServerExportDownloadHandlers = {
  /** Called when the bridge confirms the download (fileStart). */
  onStart?: (name: string, size: number) => void;
  /**
   * Called once per binary frame, in order. The next frame is not delivered until the
   * returned promise settles; after each successful write the client sends the bridge a
   * cumulative ack (flow-control window, SPEC §4.3). A rejection is treated as a local
   * write failure: the download fails with LOCAL_WRITE_ERROR and the bridge is told to
   * stop streaming.
   */
  onData: (chunk: Uint8Array) => Promise<void>;
};

export type ServerExportDownloadOutcome =
  | { status: "completed"; bytes: number }
  | { status: "canceled" };

type PendingRequest = {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: ServerExportError) => void;
};

type ActiveDownload = {
  requestId: string;
  handlers: ServerExportDownloadHandlers;
  ackedBytes: number;
  /** Serializes onData writes so frames land on disk in arrival order. */
  writeChain: Promise<void>;
  settled: boolean;
  resolve: (outcome: ServerExportDownloadOutcome) => void;
  reject: (error: ServerExportError) => void;
};

export class ServerExportBridgeClient {
  #ws: WebSocket | undefined;
  #nextRequestId = 1;
  #pending = new Map<string, PendingRequest>();
  #download: ActiveDownload | undefined;
  /** Set by disconnect() so the resulting close event is not reported as a failure. */
  #intentionalClose = false;

  /** SSH session ended (idle timeout or unexpected drop), as pushed by the bridge. */
  public onSshClosed: ((reason: "idle" | "error", message: string) => void) | undefined;
  /** The WebSocket itself closed (bridge process exited, machine sleep, …). */
  public onBridgeDisconnected: (() => void) | undefined;

  /**
   * Open the WebSocket and perform the hello handshake (SPEC §5 Step A):
   * 5s timeout, version check. Resolves once the bridge is ready for requests.
   */
  public async open(url: string = BRIDGE_URL): Promise<void> {
    this.#intentionalClose = false;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new ServerExportError(
              "BRIDGE_INVALID_HELLO",
              "no hello received within 5s — the port is likely used by another program",
            ),
          );
        }, HELLO_TIMEOUT_MS);
        ws.onopen = () => {
          this.#sendRaw({ type: "hello", version: PROTOCOL_VERSION });
        };
        ws.onmessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") {
            return;
          }
          const message = this.#parseMessage(event.data);
          if (message?.type !== "hello") {
            reject(
              new ServerExportError(
                "BRIDGE_INVALID_HELLO",
                "peer did not identify as an ssh-bridge",
              ),
            );
            return;
          }
          if (message.version !== PROTOCOL_VERSION) {
            reject(
              new ServerExportError(
                "BRIDGE_VERSION_MISMATCH",
                `bridge speaks protocol version ${String(message.version)}`,
              ),
            );
            return;
          }
          resolve();
        };
        ws.onerror = () => {
          reject(
            new ServerExportError(
              "BRIDGE_UNREACHABLE",
              `could not connect to the bridge at ${url}`,
            ),
          );
        };
        ws.onclose = () => {
          reject(
            new ServerExportError(
              "BRIDGE_UNREACHABLE",
              `connection to the bridge at ${url} closed before the handshake`,
            ),
          );
        };
      });
    } catch (err) {
      this.#ws = undefined;
      ws.close();
      throw err;
    } finally {
      if (timer != undefined) {
        clearTimeout(timer);
      }
    }
    this.#installHandlers(ws);
  }

  /** SSH connect (10s timeout enforced bridge-side). Resolves with the login user's
   *  home directory — the browse start directory (SPEC_server_file_browser.md §4.1). */
  public async connectSsh(opts: {
    host: string;
    port: number;
    username: string;
    password: string;
  }): Promise<{ home: string }> {
    const message = await this.#request({
      type: "connect",
      requestId: this.#allocRequestId(),
      ...opts,
    });
    if (message.type !== "connected" || typeof message.home !== "string") {
      throw new ServerExportError("BAD_REQUEST", "unexpected response to connect");
    }
    return { home: message.home };
  }

  /**
   * List a remote directory. Resolves with the canonical (bridge-realpath'ed) path and
   * its entries — regular files, symlinks classified by their target, and directories
   * (v3, SPEC_server_file_browser.md §4.2/§4.3).
   */
  public async list(path: string): Promise<{ path: string; entries: ServerExportListEntry[] }> {
    const message = await this.#request({
      type: "list",
      requestId: this.#allocRequestId(),
      path,
    });
    if (
      message.type !== "list" ||
      !Array.isArray(message.entries) ||
      typeof message.path !== "string"
    ) {
      throw new ServerExportError("BAD_REQUEST", "unexpected response to list");
    }
    return { path: message.path, entries: message.entries as ServerExportListEntry[] };
  }

  /**
   * Download one file. Resolves with the outcome once the bridge sends the terminal
   * message; rejects with ServerExportError on protocol/IO/local-write failure.
   * Cancel race ordering follows the bridge's send order (SPEC §4.3): a fileEnd that
   * beats our cancel means the file completed and must be kept.
   */
  public async download(
    path: string,
    handlers: ServerExportDownloadHandlers,
  ): Promise<ServerExportDownloadOutcome> {
    if (this.#download != undefined) {
      throw new ServerExportError("BAD_REQUEST", "a download is already in progress");
    }
    const requestId = this.#allocRequestId();
    return await new Promise<ServerExportDownloadOutcome>((resolve, reject) => {
      this.#download = {
        requestId,
        handlers,
        ackedBytes: 0,
        writeChain: Promise.resolve(),
        settled: false,
        resolve,
        reject,
      };
      this.#sendRaw({ type: "download", requestId, path });
    });
  }

  /** Cancel the in-flight download (no-op if none). The outcome resolves as "canceled". */
  public cancelDownload(): void {
    const download = this.#download;
    if (download == undefined || download.settled) {
      return;
    }
    this.#sendRaw({ type: "cancel", target: download.requestId });
  }

  /** Graceful teardown: close SSH (bridge-side) and the WebSocket. */
  public disconnect(): void {
    this.#intentionalClose = true;
    const ws = this.#ws;
    this.#ws = undefined;
    if (ws != undefined) {
      try {
        this.#sendRawOn(ws, { type: "disconnect" });
      } catch {
        // best effort — the socket may already be closing
      }
      ws.close();
    }
    this.#failAllPending(new ServerExportError("DISCONNECTED", "client disconnected"));
  }

  #installHandlers(ws: WebSocket): void {
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        const message = this.#parseMessage(event.data);
        if (message == undefined) {
          return;
        }
        this.#dispatch(message);
      } else if (event.data instanceof ArrayBuffer) {
        this.#handleBinaryFrame(new Uint8Array(event.data));
      }
    };
    ws.onclose = () => {
      this.#ws = undefined;
      this.#failAllPending(
        new ServerExportError("DISCONNECTED", "connection to the bridge was lost"),
      );
      if (!this.#intentionalClose) {
        this.onBridgeDisconnected?.();
      }
    };
    ws.onerror = () => {
      // onclose follows and performs the teardown.
    };
  }

  #dispatch(message: Record<string, unknown>): void {
    switch (message.type) {
      case "connected":
      case "list":
        this.#resolvePending(message);
        return;
      case "fileStart":
        this.#handleFileStart(message);
        return;
      case "fileEnd":
        this.#handleFileEnd(message);
        return;
      case "canceled":
        this.#handleCanceled(message);
        return;
      case "error":
        this.#handleError(message);
        return;
      case "sshClosed":
        this.onSshClosed?.(
          message.reason === "idle" ? "idle" : "error",
          typeof message.message === "string" ? message.message : "",
        );
        return;
      default:
        return;
    }
  }

  #handleFileStart(message: Record<string, unknown>): void {
    const download = this.#download;
    if (download == undefined || message.requestId !== download.requestId || download.settled) {
      return;
    }
    download.handlers.onStart?.(
      typeof message.name === "string" ? message.name : "",
      typeof message.size === "number" ? message.size : 0,
    );
  }

  #handleFileEnd(message: Record<string, unknown>): void {
    const download = this.#download;
    if (download == undefined || message.requestId !== download.requestId || download.settled) {
      return;
    }
    // Wait for queued writes to land on disk before reporting completion.
    download.settled = true;
    this.#download = undefined;
    const bytes = typeof message.bytes === "number" ? message.bytes : download.ackedBytes;
    download.writeChain.then(
      () => {
        download.resolve({ status: "completed", bytes });
      },
      (err: unknown) => {
        download.reject(this.#localWriteError(err));
      },
    );
  }

  #handleCanceled(message: Record<string, unknown>): void {
    const download = this.#download;
    if (download == undefined || message.requestId !== download.requestId || download.settled) {
      return;
    }
    download.settled = true;
    this.#download = undefined;
    download.resolve({ status: "canceled" });
  }

  #handleError(message: Record<string, unknown>): void {
    const code = typeof message.code === "string" ? message.code : "IO_ERROR";
    const text = typeof message.message === "string" ? message.message : "unknown bridge error";
    const error = new ServerExportError(code as ServerExportErrorCode, text);
    const download = this.#download;
    if (download != undefined && message.requestId === download.requestId && !download.settled) {
      download.settled = true;
      this.#download = undefined;
      download.reject(error);
      return;
    }
    this.#rejectPending(message, error);
  }

  #handleBinaryFrame(chunk: Uint8Array): void {
    const download = this.#download;
    // Binary frames are only valid between fileStart and the terminal message (SPEC §4.3);
    // late frames for a settled download are dropped.
    if (download == undefined || download.settled) {
      return;
    }
    download.writeChain = download.writeChain.then(
      async () => {
        // Frames that were already queued when the terminal message arrived must still be
        // written — the write queue is drained before the download resolves (fileEnd may
        // overtake slow disk writes on the message channel, but never on the wire).
        await download.handlers.onData(chunk);
        download.ackedBytes += chunk.byteLength;
        this.#sendRaw({ type: "ack", target: download.requestId, bytes: download.ackedBytes });
      },
      (err: unknown) => {
        // A failed write aborts the chain; the catch below surfaces it exactly once.
        throw err;
      },
    );
    // Local write failures (disk full, revoked handle) fail the download regardless of
    // the bridge-side state; tell the bridge to stop streaming.
    download.writeChain.catch((err: unknown) => {
      if (download.settled) {
        return;
      }
      download.settled = true;
      this.#download = undefined;
      this.#sendRaw({ type: "cancel", target: download.requestId });
      download.reject(this.#localWriteError(err));
    });
  }

  #localWriteError(err: unknown): ServerExportError {
    if (err instanceof ServerExportError) {
      return err;
    }
    return new ServerExportError(
      "LOCAL_WRITE_ERROR",
      err instanceof Error ? err.message : String(err),
    );
  }

  #resolvePending(message: Record<string, unknown>): void {
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    if (requestId == undefined) {
      return;
    }
    const pending = this.#pending.get(requestId);
    if (pending == undefined) {
      return;
    }
    this.#pending.delete(requestId);
    pending.resolve(message);
  }

  #rejectPending(message: Record<string, unknown>, error: ServerExportError): void {
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    if (requestId == undefined) {
      return;
    }
    const pending = this.#pending.get(requestId);
    if (pending == undefined) {
      return;
    }
    this.#pending.delete(requestId);
    pending.reject(error);
  }

  #failAllPending(error: ServerExportError): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) {
      entry.reject(error);
    }
    const download = this.#download;
    if (download != undefined && !download.settled) {
      download.settled = true;
      this.#download = undefined;
      download.reject(error);
    }
  }

  async #request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
    if (requestId == undefined) {
      throw new ServerExportError("BAD_REQUEST", "request without requestId");
    }
    if (this.#ws == undefined || this.#ws.readyState !== WebSocket.OPEN) {
      throw new ServerExportError("DISCONNECTED", "not connected to the bridge");
    }
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      this.#sendRaw(message);
    });
  }

  #allocRequestId(): string {
    return String(this.#nextRequestId++);
  }

  #sendRaw(message: Record<string, unknown>): void {
    const ws = this.#ws;
    if (ws == undefined) {
      return;
    }
    this.#sendRawOn(ws, message);
  }

  #sendRawOn(ws: WebSocket, message: Record<string, unknown>): void {
    // JSON.stringify cannot actually return undefined here (message is always an object).
    ws.send(JSON.stringify(message) ?? "");
  }

  #parseMessage(data: string): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === "object" && parsed != undefined) {
        return parsed as Record<string, unknown>;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
