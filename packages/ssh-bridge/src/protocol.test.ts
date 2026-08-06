// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { kindForName, parseClientMessage, validateDownloadPath } from "./protocol";

describe("kindForName", () => {
  it("classifies .bag files", () => {
    expect(kindForName("2026-08-06-04-54-43.bag")).toBe("bag");
  });

  it("classifies .bag.active files", () => {
    expect(kindForName("2026-08-06-11-15-32.bag.active")).toBe("active");
  });

  it("is case-insensitive", () => {
    expect(kindForName("RUN.BAG")).toBe("bag");
    expect(kindForName("RUN.BAG.ACTIVE")).toBe("active");
    expect(kindForName("run.Bag.Active")).toBe("active");
  });

  it("rejects other files", () => {
    expect(kindForName("notes.txt")).toBeUndefined();
    expect(kindForName("bag")).toBeUndefined();
    expect(kindForName("x.bag.zip")).toBeUndefined();
    expect(kindForName(".bag")).toBe("bag");
  });
});

describe("validateDownloadPath", () => {
  it("accepts a .bag inside the listed directory", () => {
    expect(validateDownloadPath("/data/bags/a.bag", "/data/bags")).toEqual({ name: "a.bag" });
  });

  it("accepts the root directory", () => {
    expect(validateDownloadPath("/a.bag", "/")).toEqual({ name: "a.bag" });
  });

  it("rejects paths outside the listed directory", () => {
    expect(validateDownloadPath("/etc/passwd.bag", "/data/bags")).toHaveProperty("error");
    expect(validateDownloadPath("/data/bags-other/a.bag", "/data/bags")).toHaveProperty("error");
  });

  it("rejects subdirectory traversal", () => {
    expect(validateDownloadPath("/data/bags/sub/a.bag", "/data/bags")).toHaveProperty("error");
    expect(validateDownloadPath("/data/bags/../secret.bag", "/data/bags")).toHaveProperty("error");
  });

  it("rejects backslashes in the file name", () => {
    expect(validateDownloadPath("/data/bags/a\\b.bag", "/data/bags")).toHaveProperty("error");
  });

  it("rejects .bag.active downloads", () => {
    expect(validateDownloadPath("/data/bags/a.bag.active", "/data/bags")).toHaveProperty("error");
  });

  it("accepts case-insensitive .bag", () => {
    expect(validateDownloadPath("/data/bags/A.BAG", "/data/bags")).toEqual({ name: "A.BAG" });
  });

  it("rejects a bare directory path", () => {
    expect(validateDownloadPath("/data/bags/", "/data/bags")).toHaveProperty("error");
  });
});

describe("parseClientMessage", () => {
  it("parses hello", () => {
    expect(parseClientMessage(JSON.stringify({ type: "hello", version: 1 }))).toEqual({
      type: "hello",
      version: 1,
    });
  });

  it("parses connect", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "connect",
          requestId: "1",
          host: "192.168.1.10",
          port: 22,
          username: "nvidia",
          password: "secret",
        }),
      ),
    ).toEqual({
      type: "connect",
      requestId: "1",
      host: "192.168.1.10",
      port: 22,
      username: "nvidia",
      password: "secret",
    });
  });

  it("parses list and download", () => {
    expect(parseClientMessage(JSON.stringify({ type: "list", requestId: "2", path: "/d" }))).toEqual({
      type: "list",
      requestId: "2",
      path: "/d",
    });
    expect(
      parseClientMessage(JSON.stringify({ type: "download", requestId: "4", path: "/d/a.bag" })),
    ).toEqual({ type: "download", requestId: "4", path: "/d/a.bag" });
  });

  it("parses ack and cancel (target, no own requestId)", () => {
    expect(parseClientMessage(JSON.stringify({ type: "ack", target: "4", bytes: 100 }))).toEqual({
      type: "ack",
      target: "4",
      bytes: 100,
    });
    expect(parseClientMessage(JSON.stringify({ type: "cancel", target: "4" }))).toEqual({
      type: "cancel",
      target: "4",
    });
  });

  it("parses disconnect", () => {
    expect(parseClientMessage(JSON.stringify({ type: "disconnect" }))).toEqual({
      type: "disconnect",
    });
  });

  it("rejects malformed frames", () => {
    expect(parseClientMessage("not json")).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({}))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: 42 }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "unknown" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "hello" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "list", requestId: "1" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify({ type: "ack", target: "1" }))).toBeUndefined();
    expect(parseClientMessage(JSON.stringify("just a string"))).toBeUndefined();
  });
});
