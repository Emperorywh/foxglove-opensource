// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  BagDirEntry,
  browserTzOffsetMinutes,
  formatNaiveDisplay,
  formatNaiveZipSegment,
  naiveToUnixMs,
  normalizeNaiveTime,
  parseBagFilename,
  selectBagsForExport,
  unixMsToNaiveKey,
} from "./selectBagsForExport";

function entry(name: string, kind: BagDirEntry["kind"] = "bag", size = 1000): BagDirEntry {
  return { name, kind, size, mtimeMs: 0 };
}

describe("normalizeNaiveTime", () => {
  it("normalizes filename-form and datetime-local form to the same key", () => {
    expect(normalizeNaiveTime("2026-08-20-09-27-32")).toEqual(normalizeNaiveTime("2026-08-20T09:27:32"));
    expect(normalizeNaiveTime("2026-08-20 09:27:32")).toEqual("20260820092732");
  });

  it("accepts minute-precision values (datetime-local dropdown/paste; seconds default to 00)", () => {
    expect(normalizeNaiveTime("2026-08-20T13:19")).toEqual("20260820131900");
    expect(normalizeNaiveTime("2026-08-20 13:31")).toEqual("20260820133100");
    // 分钟精度开始时间必须能通过与秒精度结束时间的比较(回归:此前误报"开始时间必须早于结束时间")。
    expect(
      normalizeNaiveTime("2026-08-20T13:19")! < normalizeNaiveTime("2026-08-20T13:31:07")!,
    ).toBe(true);
  });

  it("rejects malformed and out-of-range fields", () => {
    expect(normalizeNaiveTime("2026-08-20T09")).toBeUndefined();
    expect(normalizeNaiveTime("2026-13-20T09:27:32")).toBeUndefined();
    expect(normalizeNaiveTime("2026-08-32T09:27:32")).toBeUndefined();
    expect(normalizeNaiveTime("2026-08-20T24:27:32")).toBeUndefined();
    expect(normalizeNaiveTime("2026-08-20T09:60:32")).toBeUndefined();
    expect(normalizeNaiveTime("")).toBeUndefined();
  });

  it("produces keys that order like time (spec §5 comparison domain)", () => {
    expect(normalizeNaiveTime("2026-08-20T09:00:00")!).toBe("20260820090000");
    expect(normalizeNaiveTime("2026-08-20T09:00:00")! < normalizeNaiveTime("2026-08-20T10:00:00")!).toBe(
      true,
    );
  });
});

describe("parseBagFilename", () => {
  it("parses name time and rotation sequence", () => {
    expect(parseBagFilename("2026-08-20-09-27-32_1.bag")).toEqual({
      naiveKey: "20260820092732",
      seq: 1,
    });
    expect(parseBagFilename("2026-08-20-09-27-32_0.BAG")).toEqual({
      naiveKey: "20260820092732",
      seq: 0,
    });
  });

  it("rejects unrecognized names", () => {
    expect(parseBagFilename("2026-08-20-09-27-32.bag")).toBeUndefined();
    expect(parseBagFilename("2026-08-20-09-27-32_1.bag.active")).toBeUndefined();
    expect(parseBagFilename("notes.txt")).toBeUndefined();
    expect(parseBagFilename("2026-13-20-09-27-32_1.bag")).toBeUndefined();
    expect(parseBagFilename("2026-08-20-09-27-32_x.bag")).toBeUndefined();
  });
});

describe("naive ⇄ Unix ms conversions (spec §5)", () => {
  it("converts with a positive offset (UTC+8 → +480)", () => {
    expect(naiveToUnixMs("20260820090000", 480)).toBe(Date.UTC(2026, 7, 20, 1, 0, 0));
  });

  it("converts with a negative offset (UTC−5 → −300)", () => {
    expect(naiveToUnixMs("20260820090000", -300)).toBe(Date.UTC(2026, 7, 20, 14, 0, 0));
  });

  it("round-trips through unixMsToNaiveKey in both offset signs", () => {
    for (const tz of [480, -300, 330, 0]) {
      const key = "20260820092732";
      expect(unixMsToNaiveKey(naiveToUnixMs(key, tz), tz)).toBe(key);
    }
  });

  it("folds robotNowNaive = unixMs + tz without touching the browser timezone", () => {
    // 机器人时钟 2026-08-20T09:27:32+08:00 对应的 naive 折算,与浏览器时区无关。
    const unixMs = Date.UTC(2026, 7, 20, 1, 27, 32);
    expect(unixMsToNaiveKey(unixMs, 480)).toBe("20260820092732");
  });

  it("browser fallback takes the NEGATIVE of getTimezoneOffset (decision #27, 2×tz guard)", () => {
    expect(browserTzOffsetMinutes()).toBe(-new Date().getTimezoneOffset());
  });
});

describe("naive display formatting", () => {
  it("formats manifest timeLocal with spaces", () => {
    expect(formatNaiveDisplay("20260820085732")).toBe("2026-08-20 08:57:32");
  });

  it("formats zip name segments", () => {
    expect(formatNaiveZipSegment("20260820090000")).toBe("20260820-090000");
  });
});

describe("selectBagsForExport (spec §6)", () => {
  it("selects in-range bags on a closed interval (boundary inclusive)", () => {
    const result = selectBagsForExport({
      entries: [
        entry("2026-08-20-08-00-00_0.bag"),
        entry("2026-08-20-09-00-00_1.bag"),
        entry("2026-08-20-10-00-00_2.bag"),
        entry("2026-08-20-11-00-00_3.bag"),
      ],
      startNaive: "2026-08-20T09:00:00",
      endNaive: "2026-08-20T10:00:00",
    });
    // 08:00 是 start 前的相邻分片 → predecessor;09:00/10:00 恰在闭区间边界上。
    expect(result.selected.map((bag) => bag.name)).toEqual([
      "2026-08-20-08-00-00_0.bag",
      "2026-08-20-09-00-00_1.bag",
      "2026-08-20-10-00-00_2.bag",
    ]);
    expect(result.selected[0]?.role).toBe("predecessor");
    expect(result.selected.slice(1).every((bag) => bag.role === "in-range")).toBe(true);
    expect(result.skippedActive).toBe(0);
    expect(result.skippedUnrecognized).toBe(0);
  });

  it("has no predecessor when the range starts before every bag", () => {
    const result = selectBagsForExport({
      entries: [entry("2026-08-20-09-00-00_0.bag")],
      startNaive: "2026-08-20T08:00:00",
      endNaive: "2026-08-20T10:00:00",
    });
    expect(result.selected.map((bag) => bag.role)).toEqual(["in-range"]);
  });

  it("skips active shards and never treats one as the predecessor", () => {
    const result = selectBagsForExport({
      entries: [
        entry("2026-08-20-08-00-00_0.bag.active", "active"),
        entry("2026-08-20-07-00-00_0.bag"),
        entry("2026-08-20-09-00-00_1.bag"),
      ],
      startNaive: "2026-08-20T09:00:00",
      endNaive: "2026-08-20T10:00:00",
    });
    expect(result.skippedActive).toBe(1);
    // predecessor 是 07:00 的常规分片,active 的 08:00 被跳过。
    expect(result.selected.map((bag) => bag.name)).toEqual([
      "2026-08-20-07-00-00_0.bag",
      "2026-08-20-09-00-00_1.bag",
    ]);
  });

  it("counts unrecognized .bag names and ignores non-bag entries", () => {
    const result = selectBagsForExport({
      entries: [
        entry("run42.bag"),
        entry("2026-08-20-09-00-00_1.bag"),
        entry("notes.txt", "file"),
        entry("subdir", "dir"),
        entry("2026-08-20-09-30-00_2.bag.active", "active"),
      ],
      startNaive: "2026-08-20T09:00:00",
      endNaive: "2026-08-20T10:00:00",
    });
    expect(result.skippedUnrecognized).toBe(1);
    expect(result.skippedActive).toBe(1);
    expect(result.selected.map((bag) => bag.name)).toEqual(["2026-08-20-09-00-00_1.bag"]);
  });

  it("sorts same-instant shards by seq (name as final tiebreak)", () => {
    const result = selectBagsForExport({
      entries: [
        entry("2026-08-20-09-00-00_3.bag"),
        entry("2026-08-20-09-00-00_1.bag"),
        entry("2026-08-20-09-30-00_4.bag"),
        entry("2026-08-20-09-00-00_2.bag"),
      ],
      startNaive: "2026-08-20T09:00:00",
      endNaive: "2026-08-20T10:00:00",
    });
    expect(result.selected.map((bag) => bag.seq)).toEqual([1, 2, 3, 4]);
  });

  it("treats a lone predecessor as non-zero (decision #16 counting)", () => {
    const result = selectBagsForExport({
      entries: [entry("2026-08-20-08-00-00_0.bag")],
      startNaive: "2026-08-20T09:00:00",
      endNaive: "2026-08-20T10:00:00",
    });
    expect(result.selected.length).toBe(1);
    expect(result.selected[0]?.role).toBe("predecessor");
  });

  it("returns an empty selection when only active/unrecognized bags exist", () => {
    const result = selectBagsForExport({
      entries: [
        entry("2026-08-20-09-00-00_1.bag.active", "active"),
        entry("junk.bag"),
      ],
      startNaive: "2026-08-20T09:00:00",
      endNaive: "2026-08-20T10:00:00",
    });
    expect(result.selected).toEqual([]);
    expect(result.skippedActive).toBe(1);
    expect(result.skippedUnrecognized).toBe(1);
  });

  it("throws on an invalid range", () => {
    expect(() =>
      selectBagsForExport({
        entries: [],
        startNaive: "2026-08-20T11:00:00",
        endNaive: "2026-08-20T10:00:00",
      }),
    ).toThrow();
    expect(() =>
      selectBagsForExport({
        entries: [],
        startNaive: "garbage",
        endNaive: "2026-08-20T10:00:00",
      }),
    ).toThrow();
  });
});
