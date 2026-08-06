// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Connector, SshSession } from "./SshSession";
import {
  ClientMessage,
  CONNECT_TIMEOUT_MS,
  ErrorCode,
  IDLE_TIMEOUT_MS,
  MAX_BINARY_FRAME_BYTES,
  PROTOCOL_VERSION,
  ServerMessage,
  WINDOW_BYTES,
  kindForName,
  parseClientMessage,
  validateDownloadPath,
} from "./protocol";

/** Output side of one client connection. Implemented by the ws wrapper and by test fakes. */
export interface BridgeTransport {
  sendText(message: ServerMessage): void;
  sendBinary(data: Buffer): void;
  close(): void;
}

export type BridgeLogger = {
  info(message: string): void;
  error(message: string): void;
};

const nullLogger: BridgeLogger = {
  info: () => {},
  error: () => {},
};

type ActiveDownload = {
  requestId: string;
  sentBytes: number;
  ackedBytes: number;
  canceled: boolean;
  /** Terminal message (fileEnd / canceled / error) sent — late messages for this id are ignored. */
  terminalSent: boolean;
  stream: {
    pause(): void;
    resume(): void;
    destroy(): void;
    isPaused(): boolean;
  };
};

/**
 * Protocol state machine for one attached client. Constructed by SshBridge per connection;
 * driven via handleText/handleBinary and torn down via destroy.
 */
export class ClientSession {
  #bridge: SshBridge;
  #transport: BridgeTransport;
  #log: BridgeLogger;
  #helloReceived = false;
  #ssh: SshSession | undefined;
  /** True once we initiated the SSH close ourselves (disconnect / re-connect / idle). */
  #sshCloseExpected = false;
  #lastListDir: string | undefined;
  #download: ActiveDownload | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #destroyed = false;

  public constructor(bridge: SshBridge, transport: BridgeTransport) {
    this.#bridge = bridge;
    this.#transport = transport;
    this.#log = bridge.logger;
  }

  public begin(): void {
    this.#resetIdleTimer();
    this.#send({ type: "hello", version: PROTOCOL_VERSION });
  }

  public handleText(data: string): void {
    if (this.#destroyed) {
      return;
    }
    this.#resetIdleTimer();
    const message = parseClientMessage(data);
    if (message == undefined) {
      this.#send({ type: "error", code: "BAD_REQUEST", message: "malformed message" });
      return;
    }
    this.#dispatch(message);
  }

  public handleBinary(_data: Buffer): void {
    if (this.#destroyed) {
      return;
    }
    // The client never sends binary frames in protocol v1.
    this.#send({ type: "error", code: "BAD_REQUEST", message: "unexpected binary frame" });
  }

  /** Transport closed or replaced by a newer client: tear everything down without sending. */
  public destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    if (this.#idleTimer != undefined) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    const download = this.#download;
    if (download != undefined && !download.terminalSent) {
      download.stream.destroy();
    }
    this.#download = undefined;
    this.#closeSsh();
  }

  /** Single-session policy: tear down and close the client connection. */
  public kick(): void {
    this.destroy();
    this.#transport.close();
  }

  #dispatch(message: ClientMessage): void {
    if (!this.#helloReceived) {
      if (message.type !== "hello") {
        this.#send({ type: "error", code: "BAD_REQUEST", message: "expected hello" });
        this.#transport.close();
        return;
      }
      if (message.version !== PROTOCOL_VERSION) {
        this.#send({
          type: "error",
          code: "BAD_REQUEST",
          message: `unsupported protocol version ${message.version}`,
        });
        this.#transport.close();
        return;
      }
      this.#helloReceived = true;
      return;
    }
    switch (message.type) {
      case "hello":
        this.#send({ type: "error", code: "BAD_REQUEST", message: "duplicate hello" });
        this.#transport.close();
        return;
      case "connect":
        this.#handleConnect(message);
        return;
      case "list":
        void this.#handleList(message);
        return;
      case "download":
        this.#handleDownload(message);
        return;
      case "ack":
        this.#handleAck(message.target, message.bytes);
        return;
      case "cancel":
        this.#handleCancel(message.target);
        return;
      case "disconnect":
        this.#closeSsh();
        this.#transport.close();
        return;
    }
  }

  #handleConnect(message: Extract<ClientMessage, { type: "connect" }>): void {
    // Repeated connect on the same socket: drop the old SSH session and reconnect (SPEC §13.22).
    this.#closeSsh();
    this.#lastListDir = undefined;
    this.#log.info(`connect ${message.username}@${message.host}:${message.port}`);
    this.#bridge
      .connect({
        host: message.host,
        port: message.port,
        username: message.username,
        password: message.password,
        timeoutMs: CONNECT_TIMEOUT_MS,
      })
      .then(
        (session) => {
          if (this.#destroyed) {
            session.close();
            return;
          }
          this.#ssh = session;
          this.#sshCloseExpected = false;
          session.onClose(() => { this.#handleSshClosed(); });
          this.#send({ type: "connected", requestId: message.requestId });
        },
        (err: unknown) => {
          this.#sendError(message.requestId, err);
        },
      );
  }

  async #handleList(message: Extract<ClientMessage, { type: "list" }>): Promise<void> {
    const ssh = this.#ssh;
    if (ssh == undefined) {
      this.#send({ type: "error", requestId: message.requestId, code: "DISCONNECTED", message: "not connected" });
      return;
    }
    // Normalize: strip trailing slashes (root "/" stays as-is).
    const path = message.path.length > 1 ? message.path.replace(/\/+$/, "") : message.path;
    try {
      const files = await ssh.list(path);
      const entries = [];
      for (const file of files) {
        if (file.isDirectory) {
          continue;
        }
        const kind = kindForName(file.name);
        if (kind == undefined) {
          continue;
        }
        entries.push({ name: file.name, size: file.size, mtimeMs: file.mtimeMs, kind });
      }
      this.#lastListDir = path;
      this.#send({ type: "list", requestId: message.requestId, entries });
    } catch (err: unknown) {
      this.#sendError(message.requestId, err);
    }
  }

  #handleDownload(message: Extract<ClientMessage, { type: "download" }>): void {
    const ssh = this.#ssh;
    if (ssh == undefined) {
      this.#send({ type: "error", requestId: message.requestId, code: "DISCONNECTED", message: "not connected" });
      return;
    }
    if (this.#download != undefined) {
      this.#send({
        type: "error",
        requestId: message.requestId,
        code: "BAD_REQUEST",
        message: "another download is already in progress",
      });
      return;
    }
    if (this.#lastListDir == undefined) {
      this.#send({
        type: "error",
        requestId: message.requestId,
        code: "BAD_REQUEST",
        message: "no directory has been listed yet",
      });
      return;
    }
    const validated = validateDownloadPath(message.path, this.#lastListDir);
    if ("error" in validated) {
      this.#send({
        type: "error",
        requestId: message.requestId,
        code: "BAD_REQUEST",
        message: validated.error,
      });
      return;
    }
    const path = `${this.#lastListDir === "/" ? "" : this.#lastListDir}/${validated.name}`;
    this.#log.info(`download ${path}`);
    ssh.fileSize(path).then(
      (size) => {
        if (this.#destroyed) {
          return;
        }
        this.#send({ type: "fileStart", requestId: message.requestId, name: validated.name, size });
        this.#startStream(message.requestId, ssh, path);
      },
      (err: unknown) => {
        this.#sendError(message.requestId, err);
      },
    );
  }

  #startStream(requestId: string, ssh: SshSession, path: string): void {
    const stream = ssh.openReadStream(path);
    const download: ActiveDownload = {
      requestId,
      sentBytes: 0,
      ackedBytes: 0,
      canceled: false,
      terminalSent: false,
      stream,
    };
    this.#download = download;

    stream.on("data", (chunk: Buffer | string) => {
      if (download.terminalSent || this.#destroyed) {
        return;
      }
      let buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      while (buffer.length > 0) {
        const frame = buffer.subarray(0, MAX_BINARY_FRAME_BYTES);
        buffer = buffer.subarray(frame.length);
        this.#transport.sendBinary(frame);
        download.sentBytes += frame.length;
      }
      if (download.sentBytes - download.ackedBytes >= WINDOW_BYTES && !stream.isPaused()) {
        stream.pause();
      }
    });
    stream.on("end", () => {
      if (download.terminalSent || this.#destroyed) {
        return;
      }
      download.terminalSent = true;
      this.#download = undefined;
      this.#send({ type: "fileEnd", requestId, bytes: download.sentBytes });
    });
    stream.on("error", (err: unknown) => {
      this.#terminateDownload(download, err);
    });
  }

  /** Send the terminal message for a failed/canceled download exactly once. */
  #terminateDownload(download: ActiveDownload, err: unknown): void {
    if (download.terminalSent || this.#destroyed) {
      return;
    }
    download.terminalSent = true;
    download.stream.destroy();
    this.#download = undefined;
    if (download.canceled) {
      this.#send({ type: "canceled", requestId: download.requestId });
    } else {
      this.#sendError(download.requestId, err);
    }
  }

  #handleAck(target: string, bytes: number): void {
    const download = this.#download;
    // Late acks for finished downloads are ignored (SPEC §4.3).
    if (download == undefined || download.requestId !== target || download.terminalSent) {
      return;
    }
    download.ackedBytes = Math.max(download.ackedBytes, bytes);
    if (
      download.sentBytes - download.ackedBytes < WINDOW_BYTES &&
      download.stream.isPaused()
    ) {
      download.stream.resume();
    }
  }

  #handleCancel(target: string): void {
    const download = this.#download;
    // Cancel racing a completed download loses: fileEnd was already sent (SPEC §4.3).
    if (download == undefined || download.requestId !== target || download.terminalSent) {
      return;
    }
    download.canceled = true;
    this.#terminateDownload(download, undefined);
  }

  /** SSH session ended (idle close, peer disconnect, or network failure). */
  #handleSshClosed(): void {
    if (this.#destroyed) {
      return;
    }
    const expected = this.#sshCloseExpected;
    this.#ssh = undefined;
    this.#lastListDir = undefined;
    const download = this.#download;
    if (download != undefined && !download.terminalSent) {
      download.terminalSent = true;
      download.stream.destroy();
      this.#download = undefined;
      this.#send({
        type: "error",
        requestId: download.requestId,
        code: "DISCONNECTED",
        message: "SSH session closed during download",
      });
    }
    if (!expected) {
      this.#log.error("ssh session closed unexpectedly");
      this.#send({ type: "sshClosed", reason: "error", message: "SSH session closed" });
    }
  }

  #closeSsh(): void {
    const ssh = this.#ssh;
    if (ssh != undefined) {
      this.#sshCloseExpected = true;
      this.#ssh = undefined;
      ssh.close();
    }
  }

  #resetIdleTimer(): void {
    if (this.#idleTimer != undefined) {
      clearTimeout(this.#idleTimer);
    }
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = undefined;
      if (this.#destroyed || this.#ssh == undefined) {
        return;
      }
      this.#log.info("ssh session idle, closing");
      this.#closeSsh();
      // An in-flight download cannot survive the SSH close.
      const download = this.#download;
      if (download != undefined && !download.terminalSent) {
        download.terminalSent = true;
        download.stream.destroy();
        this.#download = undefined;
        this.#send({
          type: "error",
          requestId: download.requestId,
          code: "DISCONNECTED",
          message: "SSH session closed due to inactivity",
        });
      }
      this.#send({ type: "sshClosed", reason: "idle", message: "SSH session closed due to inactivity" });
    }, IDLE_TIMEOUT_MS);
    // The idle timer alone must not keep the process alive.
    this.#idleTimer.unref();
  }

  #send(message: ServerMessage): void {
    if (this.#destroyed) {
      return;
    }
    this.#transport.sendText(message);
  }

  #sendError(requestId: string, err: unknown): void {
    const code: ErrorCode =
      err != undefined && typeof err === "object" && "code" in err &&
      typeof (err as { code: unknown }).code === "string"
        ? ((err as { code: string }).code as ErrorCode)
        : "IO_ERROR";
    const message = err instanceof Error ? err.message : String(err);
    this.#log.error(`request ${requestId} failed: ${code}: ${message}`);
    this.#send({ type: "error", requestId, code, message });
  }
}

/**
 * Bridge entry point: enforces the single-client policy (SPEC §4.2) and owns the
 * per-connection protocol state machines.
 */
export class SshBridge {
  public readonly connect: Connector;
  public readonly logger: BridgeLogger;
  #session: ClientSession | undefined;

  public constructor(opts: { connect: Connector; logger?: BridgeLogger }) {
    this.connect = opts.connect;
    this.logger = opts.logger ?? nullLogger;
  }

  /** Attach a new client, kicking any existing one (single-session policy). */
  public handleConnection(transport: BridgeTransport): ClientSession {
    if (this.#session != undefined) {
      this.logger.info("new client connected, dropping previous client");
      const previous = this.#session;
      this.#session = undefined;
      previous.kick();
    }
    const session = new ClientSession(this, transport);
    this.#session = session;
    session.begin();
    return session;
  }

  /** Called by ClientSession when its transport closes. */
  public detach(session: ClientSession): void {
    if (this.#session === session) {
      this.#session = undefined;
    }
  }
}
