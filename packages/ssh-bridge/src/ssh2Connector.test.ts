// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Client, SFTPWrapper, Stats } from "ssh2";
import { Readable } from "stream";

import { SshError } from "./SshSession";
import {
  SERVER_TIME_COMMAND,
  ParallelPrefetchReadStream,
  Ssh2Session,
  entryTypeFromAttrs,
  parseServerTimeOutput,
} from "./ssh2Connector";

// POSIX file-type bits (the same constants ssh2's Stats methods compare against).
const S_IFMT = 0o170000;
const S_IFIFO = 0o010000;
const S_IFCHR = 0o020000;
const S_IFDIR = 0o040000;
const S_IFBLK = 0o060000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;

/** Build a Stats stand-in whose is*() methods mirror ssh2's mode-bit checks. */
function fakeStats(mode: number | undefined): Stats {
  const fmt = mode == undefined ? 0 : mode & S_IFMT;
  return {
    mode: mode!,
    uid: 0,
    gid: 0,
    size: 0,
    atime: 0,
    mtime: 0,
    isDirectory: () => fmt === S_IFDIR,
    isFile: () => fmt === S_IFREG,
    isBlockDevice: () => fmt === S_IFBLK,
    isCharacterDevice: () => fmt === S_IFCHR,
    isSymbolicLink: () => fmt === S_IFLNK,
    isFIFO: () => fmt === S_IFIFO,
    isSocket: () => fmt === S_IFSOCK,
  };
}

describe("entryTypeFromAttrs", () => {
  it("treats entries without type bits as regular files (SPEC §4.2)", () => {
    expect(entryTypeFromAttrs(fakeStats(undefined))).toBe("file");
  });

  it("maps regular files to file", () => {
    expect(entryTypeFromAttrs(fakeStats(S_IFREG | 0o644))).toBe("file");
  });

  it("maps directories to directory", () => {
    expect(entryTypeFromAttrs(fakeStats(S_IFDIR | 0o755))).toBe("directory");
  });

  it("maps symlinks to symlink", () => {
    expect(entryTypeFromAttrs(fakeStats(S_IFLNK | 0o777))).toBe("symlink");
  });

  it("maps sockets, fifos, and device files to other", () => {
    expect(entryTypeFromAttrs(fakeStats(S_IFSOCK))).toBe("other");
    expect(entryTypeFromAttrs(fakeStats(S_IFIFO))).toBe("other");
    expect(entryTypeFromAttrs(fakeStats(S_IFBLK | 0o660))).toBe("other");
    expect(entryTypeFromAttrs(fakeStats(S_IFCHR | 0o660))).toBe("other");
  });
});

describe("SERVER_TIME_COMMAND", () => {
  it("is the fixed literal date command — no parameterized exec surface (§4.2)", () => {
    expect(SERVER_TIME_COMMAND).toBe("date '+%s %z'");
  });
});

describe("parseServerTimeOutput", () => {
  it("parses a positive offset (UTC+8 → +480)", () => {
    expect(parseServerTimeOutput("1787191264 +0800\n")).toEqual({
      unixMs: 1787191264000,
      tzOffsetMinutes: 480,
    });
  });

  it("parses a negative offset (UTC−5 → −300)", () => {
    expect(parseServerTimeOutput("1787191264 -0500\n")).toEqual({
      unixMs: 1787191264000,
      tzOffsetMinutes: -300,
    });
  });

  it("parses half-hour offsets", () => {
    expect(parseServerTimeOutput("1787191264 +0530\n")).toEqual({
      unixMs: 1787191264000,
      tzOffsetMinutes: 330,
    });
  });

  it("rejects unparseable output", () => {
    expect(() => parseServerTimeOutput("some shell banner")).toThrow(SshError);
    expect(() => parseServerTimeOutput("")).toThrow(SshError);
    expect(() => parseServerTimeOutput("+0800")).toThrow(SshError);
  });

  it("rejects unreasonable unix times (pre-2001)", () => {
    expect(() => parseServerTimeOutput("999999999 +0800")).toThrow(SshError);
  });
});

/** 伪造只实现 exec 的 ssh2 Client:getServerTime 单测注入(§16)。 */
function fakeClient(
  execImpl: (command: string, callback: (err: Error | undefined, stream: Readable) => void) => void,
): Client {
  return { exec: execImpl } as unknown as Client;
}

function sessionWith(client: Client): Ssh2Session {
  return new Ssh2Session(client, {} as SFTPWrapper);
}

describe("Ssh2Session.getServerTime", () => {
  it("execs the fixed command and resolves with the parsed time", async () => {
    const commands: string[] = [];
    const session = sessionWith(
      fakeClient((command, callback) => {
        commands.push(command);
        callback(undefined, Readable.from(["1787191264 +0800\n"]));
      }),
    );
    await expect(session.getServerTime()).resolves.toEqual({
      unixMs: 1787191264000,
      tzOffsetMinutes: 480,
    });
    expect(commands).toEqual([SERVER_TIME_COMMAND]);
  });

  it("rejects on exec error", async () => {
    const session = sessionWith(
      fakeClient((_command, callback) => {
        callback(new Error("exec denied"), Readable.from([]));
      }),
    );
    await expect(session.getServerTime()).rejects.toThrow("exec denied");
  });

  it("rejects on stream error", async () => {
    const stream = new Readable({ read() {} });
    const session = sessionWith(
      fakeClient((_command, callback) => {
        callback(undefined, stream);
      }),
    );
    const promise = session.getServerTime();
    stream.emit("error", new Error("stream blew up"));
    await expect(promise).rejects.toThrow("stream blew up");
  });

  it("times out after 5s when the command never completes", async () => {
    jest.useFakeTimers();
    try {
      const session = sessionWith(
        fakeClient((_command, _callback) => {
          // 永不回调:命令挂起
        }),
      );
      const promise = session.getServerTime();
      // await Promise.resolve() 把 exec 同步段走完,再推进定时器
      await Promise.resolve();
      jest.advanceTimersByTime(5_000);
      await expect(promise).rejects.toThrow(SshError);
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * 伪造 SFTPWrapper:按 file 内容应答 read/fstat;完成延迟由 delayMs 控制(用于制造
 * 乱序完成),failAt 注入按 offset 的失败,sizeOverride 让 fstat 谎报大小(驱动
 * 短读/零读兜底路径)。open/close 即时回调,统计供断言。
 */
function fakeSftp(
  file: Buffer,
  opts?: {
    delayMs?: (offset: number) => number;
    failAt?: (offset: number) => Error | undefined;
    sizeOverride?: number;
  },
): {
  wrapper: SFTPWrapper;
  stats: { opens: number; closes: number; reads: { offset: number; length: number }[]; peakOutstanding: number };
} {
  const stats = { opens: 0, closes: 0, reads: [] as { offset: number; length: number }[], peakOutstanding: 0 };
  let outstanding = 0;
  const wrapper = {
    open: (_path: string, _mode: unknown, cb: (err: Error | undefined, handle: Buffer) => void) => {
      stats.opens += 1;
      setImmediate(() => {
        cb(undefined, Buffer.from("handle"));
      });
    },
    fstat: (_handle: Buffer, cb: (err: Error | undefined, stats: Stats) => void) => {
      setImmediate(() => {
        cb(undefined, { size: opts?.sizeOverride ?? file.length } as Stats);
      });
    },
    read: (
      _handle: Buffer,
      buffer: Buffer,
      _offset: number,
      length: number,
      position: number,
      cb: (err: Error | undefined, bytesRead: number, buffer: Buffer, position: number) => void,
    ) => {
      stats.reads.push({ offset: position, length });
      outstanding += 1;
      stats.peakOutstanding = Math.max(stats.peakOutstanding, outstanding);
      const err = opts?.failAt?.(position);
      const delay = opts?.delayMs?.(position) ?? 0;
      setTimeout(() => {
        outstanding -= 1;
        if (err != undefined) {
          cb(err, 0, buffer, position);
          return;
        }
        const got = Math.max(0, Math.min(length, file.length - position));
        if (got > 0) {
          file.copy(buffer, 0, position, position + got);
        }
        cb(undefined, got, buffer, position);
      }, delay);
    },
    close: (_handle: Buffer, cb: () => void) => {
      stats.closes += 1;
      cb();
    },
  } as unknown as SFTPWrapper;
  return { wrapper, stats };
}

/** 收集流上全部数据直到 end;error 时 reject 该错误。 */
async function collectStream(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => {
    parts.push(chunk);
  });
  await new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return Buffer.concat(parts);
}

function testFile(bytes: number): Buffer {
  return Buffer.from(Array.from({ length: bytes }, (_, index) => index % 251));
}

describe("ParallelPrefetchReadStream", () => {
  it("delivers bytes in order when reads complete out of order", async () => {
    const file = testFile(40);
    // offset 越大延迟越小 → 高 offset 先完成,pending 表被迫乱序暂存。
    const { wrapper, stats } = fakeSftp(file, { delayMs: (offset) => Math.max(0, 40 - offset) });
    const stream = new ParallelPrefetchReadStream(wrapper, "/f.bag", { chunkBytes: 4, concurrency: 3 });
    await expect(collectStream(stream)).resolves.toEqual(file);
    expect(stats.opens).toBe(1);
    expect(stats.closes).toBe(1);
  });

  it("bounds reads by the fstat size and ends at a short final chunk", async () => {
    const file = testFile(14); // 3×4 + 2:末块短读
    const { wrapper, stats } = fakeSftp(file);
    const stream = new ParallelPrefetchReadStream(wrapper, "/f.bag", { chunkBytes: 4, concurrency: 2 });
    await expect(collectStream(stream)).resolves.toEqual(file);
    // fstat 定界:不向 EOF 之外发投机读(最大 offset = 12)。
    expect(stats.reads.every((read) => read.offset < 16)).toBe(true);
  });

  it("falls back to zero-byte EOF when the file shrinks below the fstat size", async () => {
    const file = testFile(8); // 恰好 2 块;fstat 谎报 12 → offset 8 的读返回 0
    const { wrapper, stats } = fakeSftp(file, { sizeOverride: 12 });
    const stream = new ParallelPrefetchReadStream(wrapper, "/f.bag", { chunkBytes: 4, concurrency: 4 });
    await expect(collectStream(stream)).resolves.toEqual(file);
    expect(stats.reads.some((read) => read.offset === 8)).toBe(true);
  });

  it("maps a mid-stream read failure to SshError exactly once and closes the handle", async () => {
    const file = testFile(40);
    const failure = Object.assign(new Error("sftp blew up"), { code: 2 }); // SSH_FX_NO_SUCH_FILE
    const { wrapper, stats } = fakeSftp(file, { failAt: (offset) => (offset >= 8 ? failure : undefined) });
    const stream = new ParallelPrefetchReadStream(wrapper, "/f.bag", { chunkBytes: 4, concurrency: 3 });
    let observed: unknown;
    try {
      await collectStream(stream);
    } catch (err) {
      observed = err;
    }
    expect(observed).toBeInstanceOf(SshError);
    expect((observed as SshError).code).toBe("NO_SUCH_PATH");
    // 迟到的失败完成被忽略:close 恰好一次,且此后不再发起新读。
    const readsAtFailure = stats.reads.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stats.closes).toBe(1);
    expect(stats.reads.length).toBe(readsAtFailure);
  });

  it("caps outstanding reads at the configured concurrency", async () => {
    const file = testFile(200);
    const { wrapper, stats } = fakeSftp(file, { delayMs: () => 5 });
    const stream = new ParallelPrefetchReadStream(wrapper, "/f.bag", { chunkBytes: 4, concurrency: 3 });
    await expect(collectStream(stream)).resolves.toEqual(file);
    // 首轮 pump 立即满发 3 路,5ms 延迟保证它们确曾同时在飞。
    expect(stats.peakOutstanding).toBe(3);
  });

  it("stops issuing reads and closes the handle after destroy", async () => {
    const file = testFile(1000);
    const { wrapper, stats } = fakeSftp(file, { delayMs: () => 5 });
    const stream = new ParallelPrefetchReadStream(wrapper, "/f.bag", { chunkBytes: 4, concurrency: 2 });
    const firstChunk = new Promise<void>((resolve) => {
      stream.once("data", () => {
        resolve();
      });
    });
    await firstChunk;
    stream.destroy();
    const readsAtDestroy = stats.reads.length;
    expect(readsAtDestroy).toBeGreaterThan(0);
    expect(readsAtDestroy).toBeLessThan(file.length / 4);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stats.reads.length).toBe(readsAtDestroy);
    expect(stats.closes).toBe(1);
  });
});
