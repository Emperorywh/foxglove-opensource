// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Stats } from "ssh2";

import { entryTypeFromAttrs } from "./ssh2Connector";

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
