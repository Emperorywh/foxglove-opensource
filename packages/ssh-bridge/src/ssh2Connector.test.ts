// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Client, SFTPWrapper, Stats } from "ssh2";
import { Readable } from "stream";


import { SshError } from "./SshSession";
import { SERVER_TIME_COMMAND, Ssh2Session, entryTypeFromAttrs, parseServerTimeOutput } from "./ssh2Connector";

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
