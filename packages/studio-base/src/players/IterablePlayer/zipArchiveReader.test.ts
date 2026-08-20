// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { unzipSync, zipSync } from "fflate";

import { ServerExportWritable } from "@foxglove/studio-base/components/DataSourceDialog/serverExportTarget";
import { createZipWriter } from "@foxglove/studio-base/components/DataSourceDialog/serverExportZip";

import {
  BlobRandomAccessReader,
  RandomAccessReader,
  RangedFilelike,
  openZipArchive,
} from "./zipArchiveReader";

/** 内存版随机读 + 内存版 writable(测试夹具)。 */
class MemoryReader implements RandomAccessReader {
  readonly #bytes: Uint8Array;

  public constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  public size(): number {
    return this.#bytes.byteLength;
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    return this.#bytes.slice(offset, offset + length);
  }
}

class MemoryWritable implements ServerExportWritable {
  public chunks: Uint8Array[] = [];
  public async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk);
  }
  public async close(): Promise<void> {}
  public async abort(): Promise<void> {}
  public bytes(): Uint8Array {
    const total = this.chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return out;
  }
}

async function writerZip(
  entries: { name: string; data: Uint8Array }[],
  opts?: { __testMaxFieldValue?: number },
): Promise<Uint8Array> {
  const writable = new MemoryWritable();
  const writer = createZipWriter(writable, opts);
  for (const entry of entries) {
    writer.beginEntry(entry.name, Date.UTC(2026, 7, 20, 1, 2, 3), entry.data.byteLength);
    await writer.pushEntryChunk(entry.data);
    await writer.endEntry(entry.data.byteLength);
  }
  await writer.finalize();
  return writable.bytes();
}

/**
 * 手工构造一个最小经典 zip(单条目,Store,无描述符),供拒绝路径与 EOCD 注释
 * 测试使用——writer 产物恒带描述符/哨兵,覆盖不了这些形态。
 */
function buildManualZip(opts: {
  name?: string;
  data?: Uint8Array;
  method?: number;
  flags?: number;
  comment?: Uint8Array;
}): Uint8Array {
  const nameBytes = new TextEncoder().encode(opts.name ?? "a.txt");
  const data = opts.data ?? new TextEncoder().encode("manual");
  const local = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(6, opts.flags ?? 0, true);
  lv.setUint16(8, opts.method ?? 0, true);
  lv.setUint16(10, 0, true);
  lv.setUint16(12, 0x21, true);
  lv.setUint32(14, 0, true); // CRC(拒绝路径不校验内容)
  lv.setUint32(18, data.byteLength, true);
  lv.setUint32(22, data.byteLength, true);
  lv.setUint16(26, nameBytes.length, true);
  lv.setUint16(28, 0, true);
  local.set(nameBytes, 30);

  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint16(8, opts.flags ?? 0, true);
  cv.setUint16(10, opts.method ?? 0, true);
  cv.setUint16(12, 0, true);
  cv.setUint16(14, 0x21, true);
  cv.setUint32(16, 0, true);
  cv.setUint32(20, data.byteLength, true);
  cv.setUint32(24, data.byteLength, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint16(30, 0, true);
  cv.setUint16(32, 0, true);
  cv.setUint16(34, 0, true);
  cv.setUint16(36, 0, true);
  cv.setUint32(38, 0, true);
  cv.setUint32(42, 0, true); // 本地头偏移 0
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22 + (opts.comment?.byteLength ?? 0));
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint32(12, central.byteLength, true);
  ev.setUint32(16, local.byteLength + data.byteLength, true);
  ev.setUint16(20, opts.comment?.byteLength ?? 0, true);
  if (opts.comment != undefined) {
    eocd.set(opts.comment, 22);
  }

  const out = new Uint8Array(local.byteLength + data.byteLength + central.byteLength + eocd.byteLength);
  out.set(local, 0);
  out.set(data, local.byteLength);
  out.set(central, local.byteLength + data.byteLength);
  out.set(eocd, out.byteLength - eocd.byteLength);
  return out;
}

describe("openZipArchive — EOCD location", () => {
  it("locates the EOCD despite trailing comment noise", async () => {
    const bytes = buildManualZip({ comment: new Uint8Array(1024).fill(0x42) });
    const archive = await openZipArchive(new MemoryReader(bytes));
    expect(archive.entries.map((entry) => entry.name)).toEqual(["a.txt"]);
    expect(await archive.readEntryText(archive.entries[0]!)).toBe("manual");
  });

  it("rejects a buffer with no EOCD", async () => {
    await expect(openZipArchive(new MemoryReader(new Uint8Array(64)))).rejects.toThrow(
      /not a zip archive/,
    );
  });
});

describe("openZipArchive — classic archives", () => {
  it("parses entries, sizes, and data offsets computed from local headers", async () => {
    const bytes = await writerZip([
      { name: "bags/one.bag", data: new Uint8Array(100).fill(1) },
      { name: "bags/two.bag", data: new Uint8Array(50).fill(2) },
      { name: "manifest.json", data: new TextEncoder().encode("{}") },
    ]);
    const archive = await openZipArchive(new BlobRandomAccessReader(new Blob([bytes])));
    expect(archive.entries.map((entry) => entry.name)).toEqual([
      "bags/one.bag",
      "bags/two.bag",
      "manifest.json",
    ]);
    const one = archive.entries[0]!;
    expect(one.size).toBe(100);
    expect(one.dataOffset).toBe(30 + "bags/one.bag".length);
    const text = await archive.readEntryText(archive.entries[2]!);
    expect(text).toBe("{}");
  });

  it("parses an fflate-produced archive (interop with existing zips)", async () => {
    const zipped = zipSync(
      {
        "manifest.json": new TextEncoder().encode("{\"hello\":1}"),
        "bags/x.bag": new Uint8Array(10).fill(7),
      },
      { level: 0 }, // Store——读取器只接受不压缩条目
    );
    const archive = await openZipArchive(new MemoryReader(zipped as Uint8Array));
    expect(await archive.readEntryText(archive.entries[0]!)).toBe("{\"hello\":1}");
    expect(archive.entries[1]!.size).toBe(10);
    // unzipSync 回读交叉校验(dataOffset 平移正确)。
    const roundTripped = unzipSync(zipped as Uint8Array);
    const ranged = archive.openEntryReader(archive.entries[1]!);
    const read = await ranged.read(0, 10);
    expect(read).toEqual(roundTripped["bags/x.bag"]!);
  });

  it("translates offsets in the entry range view", async () => {
    const bytes = await writerZip([
      { name: "skip.bin", data: new Uint8Array(16).fill(9) },
      { name: "target.bin", data: new Uint8Array(8).fill(3) },
    ]);
    const archive = await openZipArchive(new MemoryReader(bytes));
    const entry = archive.entries[1]!;
    const view = archive.openEntryReader(entry);
    expect(view.size).toBe(8);
    const middle = await view.read(4, 2);
    expect(middle).toEqual(bytes.subarray(entry.dataOffset + 4, entry.dataOffset + 6));
    expect(middle).toEqual(new Uint8Array([3, 3]));
  });
});

describe("openZipArchive — zip64 archives", () => {
  it("resolves sentinels through the locator and zip64 EOCD", async () => {
    const bytes = await writerZip(
      [
        { name: "bags/big.bag", data: new Uint8Array(5000).fill(5) },
        { name: "bags/bigger.bag", data: new Uint8Array(6000).fill(6) },
      ],
      { __testMaxFieldValue: 4096 },
    );
    const archive = await openZipArchive(new MemoryReader(bytes));
    expect(archive.entries.map((entry) => entry.name)).toEqual(["bags/big.bag", "bags/bigger.bag"]);
    expect(archive.entries[0]!.size).toBe(5000);
    expect(archive.entries[1]!.size).toBe(6000);
    const view = archive.openEntryReader(archive.entries[1]!);
    const sample = await view.read(5990, 10);
    expect(sample).toEqual(bytes.subarray(archive.entries[1]!.dataOffset + 5990, archive.entries[1]!.dataOffset + 6000));
  });
});

describe("openZipArchive — rejection paths (spec §11.1)", () => {
  it("rejects compressed (deflate) entries", async () => {
    const bytes = buildManualZip({ method: 8 });
    await expect(openZipArchive(new MemoryReader(bytes))).rejects.toThrow(/only Store/);
  });

  it("rejects encrypted entries", async () => {
    const bytes = buildManualZip({ flags: 0x0001 });
    await expect(openZipArchive(new MemoryReader(bytes))).rejects.toThrow(/encrypted/);
  });

  it("rejects a truncated central directory", async () => {
    const bytes = buildManualZip({});
    // 砍掉末尾:EOCD 声称的中央目录区间越过文件尾。
    const truncated = bytes.subarray(0, bytes.byteLength - 22 - 10);
    await expect(openZipArchive(new MemoryReader(truncated))).rejects.toThrow(
      /truncated|not a zip/,
    );
  });

  it("rejects when the central directory points past the file", async () => {
    const bytes = buildManualZip({});
    // 篡改 EOCD 的中央目录偏移指向文件外。
    const tampered = new Uint8Array(bytes);
    const view = new DataView(tampered.buffer);
    view.setUint32(tampered.byteLength - 6, 0x7fff0000, true);
    await expect(openZipArchive(new MemoryReader(tampered))).rejects.toThrow(/truncated|corrupt/);
  });
});

describe("RangedFilelike (spec §11.2)", () => {
  it("adapts an entry to the rosbag Filelike shape", async () => {
    const bytes = await writerZip([
      { name: "head.bin", data: new Uint8Array(4).fill(1) },
      { name: "bag.bin", data: new Uint8Array(32).fill(2) },
    ]);
    const archive = await openZipArchive(new MemoryReader(bytes));
    const filelike = new RangedFilelike(new MemoryReader(bytes), archive.entries[1]!);
    expect(filelike.size()).toBe(32);
    const chunk = await filelike.read(8, 4);
    expect(chunk).toEqual(new Uint8Array([2, 2, 2, 2]));
    const head = await filelike.read(0, 4);
    expect(head).toEqual(new Uint8Array([2, 2, 2, 2]));
  });
});
