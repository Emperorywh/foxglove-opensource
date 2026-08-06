// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Readable } from "stream";

import { BridgeTransport, ClientSession, SshBridge } from "./SshBridge";
import { SshError, SshFileInfo, SshSession } from "./SshSession";
import {
  IDLE_TIMEOUT_MS,
  MAX_BINARY_FRAME_BYTES,
  PROTOCOL_VERSION,
  ServerMessage,
  WINDOW_BYTES,
} from "./protocol";

class FakeTransport implements BridgeTransport {
  public textMessages: ServerMessage[] = [];
  public binaryFrames: Buffer[] = [];
  public closed = false;

  public sendText(message: ServerMessage): void {
    this.textMessages.push(message);
  }
  public sendBinary(data: Buffer): void {
    this.binaryFrames.push(data);
  }
  public close(): void {
    this.closed = true;
  }

  public messagesOfType<T extends ServerMessage["type"]>(
    type: T,
  ): Extract<ServerMessage, { type: T }>[] {
    return this.textMessages.filter((msg) => msg.type === type) as Extract<
      ServerMessage,
      { type: T }
    >[];
  }
}

class FakeSshSession implements SshSession {
  public files: SshFileInfo[] = [];
  public fileData = new Map<string, Buffer>();
  public fileSizes = new Map<string, number>();
  public listError: SshError | undefined;
  public closed = false;
  /** When set, openReadStream returns this controllable stream instead of one from fileData. */
  public nextStream: Readable | undefined;

  #closeCallbacks: (() => void)[] = [];

  public async list(_dir: string): Promise<SshFileInfo[]> {
    if (this.listError != undefined) {
      throw this.listError;
    }
    return this.files;
  }

  public async fileSize(path: string): Promise<number> {
    const size = this.fileSizes.get(path) ?? this.fileData.get(path)?.length;
    if (size == undefined) {
      throw new SshError("NO_SUCH_PATH", `${path}: no such file`);
    }
    return size;
  }

  public openReadStream(path: string): Readable {
    if (this.nextStream != undefined) {
      const stream = this.nextStream;
      this.nextStream = undefined;
      return stream;
    }
    const data = this.fileData.get(path);
    if (data == undefined) {
      throw new Error(`no fake data for ${path}`);
    }
    return Readable.from([data]);
  }

  public close(): void {
    this.closed = true;
    for (const callback of this.#closeCallbacks) {
      callback();
    }
  }

  public onClose(callback: () => void): void {
    this.#closeCallbacks.push(callback);
  }

  /** Simulate an unexpected SSH drop (network failure). */
  public simulateUnexpectedClose(): void {
    for (const callback of this.#closeCallbacks) {
      callback();
    }
  }
}

/**
 * Flush pending promise chains and stream emissions. Streams schedule data/end events
 * through nextTick, which only drains once the current macrotask yields — hence the
 * setImmediate at the end (only usable while real timers are active).
 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

type Fixture = {
  transport: FakeTransport;
  session: ClientSession;
  ssh: FakeSshSession;
  bridge: SshBridge;
};

function makeFixture(): Fixture & { connectAndList: () => Promise<void> } {
  const transport = new FakeTransport();
  const ssh = new FakeSshSession();
  const bridge = new SshBridge({
    connect: async () => {
      return await Promise.resolve(ssh);
    },
  });
  const session = bridge.handleConnection(transport);

  const send = (msg: unknown) => {
    session.handleText(JSON.stringify(msg));
  };

  const connectAndList = async () => {
    send({ type: "hello", version: PROTOCOL_VERSION });
    send({
      type: "connect",
      requestId: "c1",
      host: "192.168.1.10",
      port: 22,
      username: "nvidia",
      password: "secret",
    });
    await flushAsync();
    send({ type: "list", requestId: "l1", path: "/data/bags/" });
    await flushAsync();
  };

  return { transport, session, ssh, bridge, connectAndList };
}

describe("SshBridge frame state machine", () => {
  it("sends hello immediately on connection", () => {
    const { transport } = makeFixture();
    expect(transport.textMessages).toEqual([{ type: "hello", version: PROTOCOL_VERSION }]);
  });

  it("rejects a non-hello first message and closes", () => {
    const { transport, session } = makeFixture();
    session.handleText(JSON.stringify({ type: "disconnect" }));
    expect(transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ code: "BAD_REQUEST" }),
    ]);
    expect(transport.closed).toBe(true);
  });

  it("rejects an unsupported protocol version and closes", () => {
    const { transport, session } = makeFixture();
    session.handleText(JSON.stringify({ type: "hello", version: 99 }));
    expect(transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ code: "BAD_REQUEST" }),
    ]);
    expect(transport.closed).toBe(true);
  });

  it("rejects a duplicate hello and closes", () => {
    const { transport, session } = makeFixture();
    session.handleText(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION }));
    session.handleText(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION }));
    expect(transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ code: "BAD_REQUEST" }),
    ]);
    expect(transport.closed).toBe(true);
  });

  it("rejects malformed JSON with BAD_REQUEST", () => {
    const { transport, session } = makeFixture();
    session.handleText(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION }));
    session.handleText("{not json");
    expect(transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ code: "BAD_REQUEST", message: "malformed message" }),
    ]);
  });

  it("rejects binary frames from the client", () => {
    const { transport, session } = makeFixture();
    session.handleBinary(Buffer.from([1, 2, 3]));
    expect(transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ code: "BAD_REQUEST" }),
    ]);
  });

  it("rejects list before connect with DISCONNECTED", async () => {
    const { transport, session } = makeFixture();
    session.handleText(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION }));
    session.handleText(JSON.stringify({ type: "list", requestId: "l1", path: "/data/bags" }));
    await flushAsync();
    expect(transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ requestId: "l1", code: "DISCONNECTED" }),
    ]);
  });
});

describe("SshBridge connect and list", () => {
  it("lists regular files and symlinks of any kind, case-insensitively (v2)", async () => {
    const fixture = makeFixture();
    fixture.ssh.files = [
      { name: "a.bag", size: 10, mtimeMs: 1000, entryType: "file" },
      { name: "B.BAG", size: 20, mtimeMs: 2000, entryType: "file" },
      { name: "c.bag.active", size: 30, mtimeMs: 3000, entryType: "file" },
      { name: "D.BAG.ACTIVE", size: 40, mtimeMs: 4000, entryType: "file" },
      { name: "notes.txt", size: 50, mtimeMs: 5000, entryType: "file" },
      { name: ".env", size: 60, mtimeMs: 6000, entryType: "file" },
      // Symlinks are classified by name only; the target is never stat'ed.
      { name: "latest.bag", size: 70, mtimeMs: 7000, entryType: "symlink" },
      { name: "linked-log", size: 80, mtimeMs: 8000, entryType: "symlink" },
    ];
    await fixture.connectAndList();
    expect(fixture.transport.messagesOfType("connected")).toEqual([
      { type: "connected", requestId: "c1" },
    ]);
    expect(fixture.transport.messagesOfType("list")).toEqual([
      {
        type: "list",
        requestId: "l1",
        entries: [
          { name: "a.bag", size: 10, mtimeMs: 1000, kind: "bag" },
          { name: "B.BAG", size: 20, mtimeMs: 2000, kind: "bag" },
          { name: "c.bag.active", size: 30, mtimeMs: 3000, kind: "active" },
          { name: "D.BAG.ACTIVE", size: 40, mtimeMs: 4000, kind: "active" },
          { name: "notes.txt", size: 50, mtimeMs: 5000, kind: "file" },
          { name: ".env", size: 60, mtimeMs: 6000, kind: "file" },
          { name: "latest.bag", size: 70, mtimeMs: 7000, kind: "bag" },
          { name: "linked-log", size: 80, mtimeMs: 8000, kind: "file" },
        ],
      },
    ]);
  });

  it("does not list subdirectories or socket/fifo/device entries", async () => {
    const fixture = makeFixture();
    fixture.ssh.files = [
      { name: "dir.bag", size: 0, mtimeMs: 1000, entryType: "directory" },
      { name: "sub", size: 0, mtimeMs: 2000, entryType: "directory" },
      { name: "app.sock", size: 0, mtimeMs: 3000, entryType: "other" },
      { name: "pipe", size: 0, mtimeMs: 4000, entryType: "other" },
      { name: "a.bag", size: 10, mtimeMs: 5000, entryType: "file" },
    ];
    await fixture.connectAndList();
    expect(fixture.transport.messagesOfType("list")).toEqual([
      {
        type: "list",
        requestId: "l1",
        entries: [{ name: "a.bag", size: 10, mtimeMs: 5000, kind: "bag" }],
      },
    ]);
  });

  it("maps list errors to protocol error codes", async () => {
    const fixture = makeFixture();
    fixture.ssh.listError = new SshError("PERMISSION_DENIED", "denied");
    await fixture.connectAndList();
    expect(fixture.transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ requestId: "l1", code: "PERMISSION_DENIED" }),
    ]);
  });

  it("maps connect failures to protocol error codes", async () => {
    const transport = new FakeTransport();
    const bridge = new SshBridge({
      connect: async () => {
        throw new SshError("AUTH_FAILED", "bad credentials");
      },
    });
    const session = bridge.handleConnection(transport);
    session.handleText(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION }));
    session.handleText(
      JSON.stringify({
        type: "connect",
        requestId: "c1",
        host: "h",
        port: 22,
        username: "u",
        password: "p",
      }),
    );
    await flushAsync();
    expect(transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ requestId: "c1", code: "AUTH_FAILED" }),
    ]);
  });

  it("a repeated connect on the same socket closes the previous SSH session", async () => {
    const fixture = makeFixture();
    await fixture.connectAndList();
    const firstSsh = fixture.ssh;
    fixture.session.handleText(
      JSON.stringify({
        type: "connect",
        requestId: "c2",
        host: "other",
        port: 22,
        username: "u",
        password: "p",
      }),
    );
    await flushAsync();
    expect(firstSsh.closed).toBe(true);
    expect(fixture.transport.messagesOfType("connected")).toEqual([
      { type: "connected", requestId: "c1" },
      { type: "connected", requestId: "c2" },
    ]);
    // An expected close must not produce an sshClosed push.
    expect(fixture.transport.messagesOfType("sshClosed")).toEqual([]);
  });

  it("kicks the previous client when a new one connects", () => {
    const { bridge, transport } = makeFixture();
    const second = new FakeTransport();
    bridge.handleConnection(second);
    expect(transport.closed).toBe(true);
    expect(second.messagesOfType("hello")).toEqual([{ type: "hello", version: PROTOCOL_VERSION }]);
  });
});

describe("SshBridge download", () => {
  const MB = 1024 * 1024;

  it("rejects downloads outside the last listed directory", async () => {
    const fixture = makeFixture();
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/etc/passwd.bag" }),
    );
    expect(fixture.transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ requestId: "d1", code: "BAD_REQUEST" }),
    ]);
  });

  it("rejects downloads of .bag.active files", async () => {
    const fixture = makeFixture();
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/a.bag.active" }),
    );
    expect(fixture.transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ requestId: "d1", code: "BAD_REQUEST" }),
    ]);
  });

  it("allows downloading regular files and names with backslashes (v2)", async () => {
    const fixture = makeFixture();
    fixture.ssh.fileData.set("/data/bags/notes.txt", Buffer.from("notes"));
    fixture.ssh.fileData.set("/data/bags/a\\b.bag", Buffer.from("backslash"));
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/notes.txt" }),
    );
    await flushAsync();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d2", path: "/data/bags/a\\b.bag" }),
    );
    await flushAsync();
    expect(fixture.transport.messagesOfType("error")).toEqual([]);
    expect(fixture.transport.messagesOfType("fileStart")).toEqual([
      { type: "fileStart", requestId: "d1", name: "notes.txt", size: 5 },
      { type: "fileStart", requestId: "d2", name: "a\\b.bag", size: 9 },
    ]);
    expect(fixture.transport.messagesOfType("fileEnd")).toEqual([
      { type: "fileEnd", requestId: "d1", bytes: 5 },
      { type: "fileEnd", requestId: "d2", bytes: 9 },
    ]);
  });

  it("rejects downloads before any list", async () => {
    const fixture = makeFixture();
    fixture.session.handleText(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION }));
    fixture.session.handleText(
      JSON.stringify({
        type: "connect",
        requestId: "c1",
        host: "h",
        port: 22,
        username: "u",
        password: "p",
      }),
    );
    await flushAsync();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/a.bag" }),
    );
    expect(fixture.transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ requestId: "d1", code: "BAD_REQUEST" }),
    ]);
  });

  it("rejects a second concurrent download", async () => {
    const fixture = makeFixture();
    fixture.ssh.fileData.set("/data/bags/a.bag", Buffer.alloc(10));
    fixture.ssh.nextStream = new Readable({ read: () => {} });
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/a.bag" }),
    );
    await flushAsync();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d2", path: "/data/bags/a.bag" }),
    );
    expect(fixture.transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ requestId: "d2", code: "BAD_REQUEST" }),
    ]);
  });

  it("streams file data in binary frames bounded by MAX_BINARY_FRAME_BYTES and ends with fileEnd", async () => {
    const fixture = makeFixture();
    const size = 2 * MAX_BINARY_FRAME_BYTES + 123;
    fixture.ssh.fileData.set("/data/bags/big.bag", Buffer.alloc(size, 7));
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/big.bag" }),
    );
    await flushAsync();
    expect(fixture.transport.messagesOfType("fileStart")).toEqual([
      { type: "fileStart", requestId: "d1", name: "big.bag", size },
    ]);
    for (const frame of fixture.transport.binaryFrames) {
      expect(frame.length).toBeLessThanOrEqual(MAX_BINARY_FRAME_BYTES);
    }
    expect(Buffer.concat(fixture.transport.binaryFrames).length).toBe(size);
    expect(fixture.transport.messagesOfType("fileEnd")).toEqual([
      { type: "fileEnd", requestId: "d1", bytes: size },
    ]);
  });

  it("handles 0-byte files", async () => {
    const fixture = makeFixture();
    fixture.ssh.fileData.set("/data/bags/empty.bag", Buffer.alloc(0));
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/empty.bag" }),
    );
    await flushAsync();
    expect(fixture.transport.messagesOfType("fileEnd")).toEqual([
      { type: "fileEnd", requestId: "d1", bytes: 0 },
    ]);
  });

  it("pauses the stream when the ack window is exceeded and resumes on ack", async () => {
    const fixture = makeFixture();
    const stream = new Readable({ read: () => {} });
    fixture.ssh.fileData.set("/data/bags/a.bag", Buffer.alloc(0));
    fixture.ssh.fileSizes.set("/data/bags/a.bag", 16 * MB);
    fixture.ssh.nextStream = stream;
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/a.bag" }),
    );
    await flushAsync();

    // Fill the 8MB window; the stream must be paused once sent - acked >= WINDOW_BYTES.
    for (let i = 0; i < WINDOW_BYTES / MB; i++) {
      stream.push(Buffer.alloc(MB));
    }
    await flushAsync();
    expect(stream.isPaused()).toBe(true);
    expect(fixture.transport.binaryFrames.length).toBe(WINDOW_BYTES / MB);

    // Ack half of it — the stream resumes.
    fixture.session.handleText(
      JSON.stringify({ type: "ack", target: "d1", bytes: WINDOW_BYTES / 2 }),
    );
    expect(stream.isPaused()).toBe(false);

    // Late acks for unknown targets are ignored without crashing.
    fixture.session.handleText(
      JSON.stringify({ type: "ack", target: "unknown", bytes: 1 }),
    );
    stream.destroy();
    await flushAsync();
  });

  it("cancel during download produces exactly one canceled message and ignores late acks", async () => {
    const fixture = makeFixture();
    const stream = new Readable({ read: () => {} });
    fixture.ssh.fileSizes.set("/data/bags/a.bag", 16 * MB);
    fixture.ssh.nextStream = stream;
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/a.bag" }),
    );
    await flushAsync();
    stream.push(Buffer.alloc(MB));
    await flushAsync();
    fixture.session.handleText(JSON.stringify({ type: "cancel", target: "d1" }));
    expect(fixture.transport.messagesOfType("canceled")).toEqual([
      { type: "canceled", requestId: "d1" },
    ]);
    expect(fixture.transport.messagesOfType("fileEnd")).toEqual([]);

    // Late ack/cancel after the terminal message are ignored.
    fixture.session.handleText(JSON.stringify({ type: "ack", target: "d1", bytes: MB }));
    fixture.session.handleText(JSON.stringify({ type: "cancel", target: "d1" }));
    expect(fixture.transport.messagesOfType("canceled").length).toBe(1);

    // Stream events after cancellation produce no further messages.
    stream.push(Buffer.alloc(MB));
    stream.emit("error", new Error("boom"));
    expect(fixture.transport.messagesOfType("error")).toEqual([]);
    expect(fixture.transport.messagesOfType("fileEnd")).toEqual([]);
  });

  it("cancel racing fileEnd loses: fileEnd stands, no canceled message", async () => {
    const fixture = makeFixture();
    fixture.ssh.fileData.set("/data/bags/a.bag", Buffer.alloc(100, 1));
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/a.bag" }),
    );
    await flushAsync();
    // Download already terminated with fileEnd; a cancel arriving now must be ignored.
    expect(fixture.transport.messagesOfType("fileEnd").length).toBe(1);
    fixture.session.handleText(JSON.stringify({ type: "cancel", target: "d1" }));
    expect(fixture.transport.messagesOfType("canceled")).toEqual([]);
  });

  it("stream errors terminate the download with a mapped error code", async () => {
    const fixture = makeFixture();
    const stream = new Readable({ read: () => {} });
    fixture.ssh.fileSizes.set("/data/bags/a.bag", 16 * MB);
    fixture.ssh.nextStream = stream;
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/a.bag" }),
    );
    await flushAsync();
    stream.emit("error", new SshError("IO_ERROR", "disk failure"));
    expect(fixture.transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ requestId: "d1", code: "IO_ERROR", message: "disk failure" }),
    ]);
    expect(fixture.transport.messagesOfType("fileEnd")).toEqual([]);
  });

  it("fileSize failure (deleted file) produces NO_SUCH_PATH and no fileStart", async () => {
    const fixture = makeFixture();
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/gone.bag" }),
    );
    await flushAsync();
    expect(fixture.transport.messagesOfType("fileStart")).toEqual([]);
    expect(fixture.transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ requestId: "d1", code: "NO_SUCH_PATH" }),
    ]);
  });
});

describe("SshBridge session lifecycle", () => {
  it("disconnect message closes SSH and the transport", async () => {
    const fixture = makeFixture();
    await fixture.connectAndList();
    fixture.session.handleText(JSON.stringify({ type: "disconnect" }));
    expect(fixture.ssh.closed).toBe(true);
    expect(fixture.transport.closed).toBe(true);
    expect(fixture.transport.messagesOfType("sshClosed")).toEqual([]);
  });

  it("unexpected SSH close terminates the download with DISCONNECTED and pushes sshClosed", async () => {
    const fixture = makeFixture();
    const stream = new Readable({ read: () => {} });
    fixture.ssh.fileSizes.set("/data/bags/a.bag", 100);
    fixture.ssh.nextStream = stream;
    await fixture.connectAndList();
    fixture.session.handleText(
      JSON.stringify({ type: "download", requestId: "d1", path: "/data/bags/a.bag" }),
    );
    await flushAsync();
    fixture.ssh.simulateUnexpectedClose();
    expect(fixture.transport.messagesOfType("error")).toEqual([
      expect.objectContaining({ requestId: "d1", code: "DISCONNECTED" }),
    ]);
    expect(fixture.transport.messagesOfType("sshClosed")).toEqual([
      expect.objectContaining({ reason: "error" }),
    ]);
  });

  it("closes the SSH session and pushes sshClosed after the idle timeout", async () => {
    const fixture = makeFixture();
    await fixture.connectAndList();
    jest.useFakeTimers();
    try {
      // Re-arm the idle timer under fake timers (any client message resets it).
      fixture.session.handleText(
        JSON.stringify({ type: "list", requestId: "l2", path: "/data/bags" }),
      );
      jest.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
      expect(fixture.ssh.closed).toBe(false);
      jest.advanceTimersByTime(1);
      expect(fixture.ssh.closed).toBe(true);
      expect(fixture.transport.messagesOfType("sshClosed")).toEqual([
        expect.objectContaining({ reason: "idle" }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("activity resets the idle timer", async () => {
    const fixture = makeFixture();
    await fixture.connectAndList();
    jest.useFakeTimers();
    try {
      fixture.session.handleText(
        JSON.stringify({ type: "list", requestId: "l2", path: "/data/bags" }),
      );
      jest.advanceTimersByTime(IDLE_TIMEOUT_MS - 1000);
      fixture.session.handleText(
        JSON.stringify({ type: "list", requestId: "l3", path: "/data/bags" }),
      );
      jest.advanceTimersByTime(IDLE_TIMEOUT_MS - 1000);
      expect(fixture.ssh.closed).toBe(false);
      jest.advanceTimersByTime(1000);
      expect(fixture.ssh.closed).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
