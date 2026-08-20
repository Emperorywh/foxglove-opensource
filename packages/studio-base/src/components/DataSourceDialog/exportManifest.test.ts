// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  EXPORT_PACKAGE_FORMAT,
  EXPORT_PACKAGE_FORMAT_VERSION,
  buildExportManifest,
  parseExportManifest,
  serializeExportManifest,
} from "./exportManifest";

const baseArgs = {
  generatorVersion: "1.86.0-dev",
  source: { host: "10.11.2.208", bagPath: "/home/rxx/bkbagfiles", logPath: "/var/log/robot" },
  range: {
    startLocal: "2026-08-20 09:00:00",
    endLocal: "2026-08-20 10:00:00",
    tzOffsetMinutes: 480,
    tzSource: "server" as const,
    startUnixMs: 1787187600000,
    endUnixMs: 1787191200000,
  },
  bags: [
    {
      name: "2026-08-20-08-57-32_0.bag",
      size: 524288000,
      timeLocal: "2026-08-20 08:57:32",
      seq: 0,
      role: "predecessor" as const,
    },
  ],
  logs: { included: true, count: 42, bytes: 314572800 },
  alarms: {
    status: "ok" as const,
    query: { startUnixMs: 1787187600000, stopUnixMs: 1787191200000 },
  },
};

describe("buildExportManifest", () => {
  it("stamps format identity and creation time", () => {
    const manifest = buildExportManifest({ ...baseArgs, nowMs: 1787191264652 });
    expect(manifest.format).toBe(EXPORT_PACKAGE_FORMAT);
    expect(manifest.formatVersion).toBe(EXPORT_PACKAGE_FORMAT_VERSION);
    expect(manifest.createdAtUnixMs).toBe(1787191264652);
    expect(manifest.generator).toEqual({ app: "foxglove-studio", version: "1.86.0-dev" });
  });

  it("omits the alarms error field unless failed (spec §7.3)", () => {
    expect(
      buildExportManifest({ ...baseArgs, alarms: { ...baseArgs.alarms, status: "ok" } }).alarms
        .error,
    ).toBeUndefined();
    expect(
      buildExportManifest({
        ...baseArgs,
        alarms: { ...baseArgs.alarms, status: "failed", error: "connect timeout" },
      }).alarms.error,
    ).toBe("connect timeout");
  });
});

describe("parseExportManifest (strict, decision #22)", () => {
  it("round-trips build → serialize → parse", () => {
    const manifest = buildExportManifest({ ...baseArgs, nowMs: 1787191264652 });
    expect(parseExportManifest(serializeExportManifest(manifest))).toEqual(manifest);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseExportManifest("{not json")).toThrow("not valid JSON");
  });

  it("rejects a non-object root", () => {
    expect(() => parseExportManifest("42")).toThrow("not an object");
  });

  it("rejects a foreign format (not a robot export package)", () => {
    expect(() =>
      parseExportManifest(JSON.stringify({ format: "something-else" }) ?? ""),
    ).toThrow("not a robot export package");
  });

  it("rejects a missing formatVersion", () => {
    expect(() =>
      parseExportManifest(JSON.stringify({ format: EXPORT_PACKAGE_FORMAT }) ?? ""),
    ).toThrow("missing formatVersion");
  });

  it("rejects a newer formatVersion with an upgrade hint (edge #18)", () => {
    expect(() =>
      parseExportManifest(
        JSON.stringify({ format: EXPORT_PACKAGE_FORMAT, formatVersion: 2 }) ?? "",
      ),
    ).toThrow(/upgrade the app/);
  });
});
