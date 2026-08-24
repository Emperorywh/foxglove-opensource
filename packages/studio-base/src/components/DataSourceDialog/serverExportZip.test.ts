// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { unzipSync } from "fflate";

import {
  BlobRandomAccessReader,
  openZipArchive,
} from "@foxglove/studio-base/players/IterablePlayer/zipArchiveReader";

import { ServerExportWritable } from "./serverExportTarget";
import { createZipWriter, resolveZipNameConflict, robotExportZipFileName } from "./serverExportZip";

/** 内存版 ServerExportWritable:收集字节,模拟本地写盘。 */
class MemoryWritable implements ServerExportWritable {
  public chunks: Uint8Array[] = [];
  public closed = false;
  public aborted = false;
  public failWrites = false;

  public async write(chunk: Uint8Array): Promise<void> {
    if (this.failWrites) {
      throw new Error("disk full");
    }
    this.chunks.push(chunk);
  }

  public async close(): Promise<void> {
    this.closed = true;
  }

  public async abort(): Promise<void> {
    this.aborted = true;
  }

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

function textBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 在缓冲里查找小端 32 位签名,返回全部命中偏移。 */
function findSignature(bytes: Uint8Array, signature: number): number[] {
  const hits: number[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 4 <= bytes.byteLength; i++) {
    if (view.getUint32(i, true) === signature) {
      hits.push(i);
    }
  }
  return hits;
}

const DESCRIPTOR_SIG = 0x08074b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

async function writeArchive(
  entries: { name: string; mtimeMs: number; data: Uint8Array; expectedSize?: number; actualSize?: number }[],
  opts?: { __testMaxFieldValue?: number },
): Promise<Uint8Array> {
  const writable = new MemoryWritable();
  const writer = createZipWriter(writable, opts);
  for (const entry of entries) {
    writer.beginEntry(entry.name, entry.mtimeMs, entry.expectedSize ?? entry.data.byteLength);
    await writer.pushEntryChunk(entry.data);
    await writer.endEntry(entry.actualSize ?? entry.data.byteLength);
  }
  await writer.finalize();
  return writable.bytes();
}

describe("createZipWriter — classic path", () => {
  it("round-trips through fflate unzipSync with entry order preserved", async () => {
    const bytes = await writeArchive([
      { name: "bags/a.bag", mtimeMs: Date.UTC(2026, 7, 20, 1, 2, 3), data: textBytes("bag-bytes") },
      { name: "logs/robot.log", mtimeMs: Date.UTC(2026, 7, 20, 1, 2, 3), data: textBytes("log-line\n") },
      { name: "manifest.json", mtimeMs: Date.UTC(2026, 7, 20, 1, 2, 3), data: textBytes("{}") },
    ]);
    const unzipped = unzipSync(bytes);
    expect(Object.keys(unzipped)).toEqual(["bags/a.bag", "logs/robot.log", "manifest.json"]);
    expect(Buffer.from(unzipped["bags/a.bag"]! as Uint8Array).toString()).toBe("bag-bytes");
    expect(Buffer.from(unzipped["logs/robot.log"]! as Uint8Array).toString()).toBe("log-line\n");
    expect(Buffer.from(unzipped["manifest.json"]! as Uint8Array).toString()).toBe("{}");
  });

  it("writes a signed data descriptor after each entry (bit 3, spec §8.1)", async () => {
    const data = textBytes("hello world");
    const bytes = await writeArchive([
      { name: "a.txt", mtimeMs: Date.UTC(2026, 7, 20), data },
    ]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(6, true) & 0x0008).toBe(0x0008); // 本地头 bit 3
    // 数据之后紧跟带签名 0x08074b50 的描述符(签名 4 + CRC 4 + 双 size 各 4)。
    const descriptorOffset = 30 + "a.txt".length + data.byteLength;
    expect(view.getUint32(descriptorOffset, true)).toBe(DESCRIPTOR_SIG);
    expect(view.getUint32(descriptorOffset + 4, true)).toBe(0x0d4a1185); // "hello world" 的 CRC-32
    expect(view.getUint32(descriptorOffset + 8, true)).toBe(data.byteLength);
    expect(view.getUint32(descriptorOffset + 12, true)).toBe(data.byteLength);
    expect(findSignature(bytes, DESCRIPTOR_SIG)).toHaveLength(1);
    // 全部值装得下 → 只写经典 EOCD,不写 zip64 结构。
    expect(findSignature(bytes, ZIP64_EOCD_SIG)).toHaveLength(0);
    expect(findSignature(bytes, ZIP64_LOCATOR_SIG)).toHaveLength(0);
    expect(findSignature(bytes, EOCD_SIG)).toHaveLength(1);
  });

  it("sets the UTF-8 flag for non-ASCII entry names", async () => {
    const bytes = await writeArchive([
      { name: "logs/机器人.log", mtimeMs: Date.UTC(2026, 7, 20), data: textBytes("x") },
    ]);
    const localView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(localView.getUint16(6, true) & 0x0800).toBe(0x0800);
    const centralOffset = 30 + localView.getUint16(26, true) + 1 + 16;
    const centralView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(centralView.getUint16(centralOffset + 8, true) & 0x0800).toBe(0x0800);
    expect(Buffer.from(unzipSync(bytes)["logs/机器人.log"]! as Uint8Array).toString()).toBe("x");
  });

  it("clamps entry mtimes into the DOS range (1980-01-01 ~ 2099-12-31)", async () => {
    const bytes = await writeArchive([
      { name: "old.txt", mtimeMs: Date.UTC(1970, 0, 1), data: textBytes("x") },
      { name: "new.txt", mtimeMs: Date.UTC(2200, 0, 1), data: textBytes("x") },
    ]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // 1970 → 钳到 1980-01-01 00:00:00;2200 → 钳到 2099-12-31 23:59:58。
    expect(view.getUint16(10, true)).toBe(0); // DOS time 00:00:00
    expect(view.getUint16(12, true)).toBe((1 << 5) | 1); // 1980-01-01
    const unzipped = unzipSync(bytes);
    expect(Object.keys(unzipped).sort()).toEqual(["new.txt", "old.txt"]);
  });
});

describe("createZipWriter — zip64 paths (injected threshold, spec §8.2/§16)", () => {
  // 把 32 位边界压到 KB 级:超过 4KiB 的值即"越界"。
  const THRESHOLD = 4096;
  const big = (size: number): Uint8Array => new Uint8Array(size).fill(0xab);

  it("upgrades a single oversized entry: local sentinel + extra + 8-byte descriptor", async () => {
    const data = big(5000);
    const bytes = await writeArchive(
      [{ name: "bags/big.bag", mtimeMs: Date.UTC(2026, 7, 20), data }],
      { __testMaxFieldValue: THRESHOLD },
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint16(4, true)).toBe(45); // version needed(zip64 条目)
    expect(view.getUint32(18, true)).toBe(0xffffffff); // 本地头哨兵
    expect(view.getUint32(22, true)).toBe(0xffffffff);
    // 本地头 extra:0x0001 + 16 字节双 size(Store 下两值相等)。
    const extraOffset = 30 + "bags/big.bag".length;
    expect(view.getUint16(extraOffset, true)).toBe(0x0001);
    expect(view.getUint16(extraOffset + 2, true)).toBe(16);
    expect(view.getUint32(extraOffset + 4, true)).toBe(5000);
    expect(view.getUint32(extraOffset + 12, true)).toBe(5000);
    // 8 字节 size 的数据描述符(总长 24)。
    const descriptorOffset = extraOffset + 20 + data.byteLength;
    expect(view.getUint32(descriptorOffset, true)).toBe(DESCRIPTOR_SIG);
    expect(view.getUint32(descriptorOffset + 8, true)).toBe(5000);
    expect(view.getUint32(descriptorOffset + 16, true)).toBe(5000);
    // 中央目录同样带哨兵 + extra,并升级为 zip64 EOCD。
    expect(findSignature(bytes, ZIP64_EOCD_SIG)).toHaveLength(1);
    expect(findSignature(bytes, ZIP64_LOCATOR_SIG)).toHaveLength(1);
    expect(findSignature(bytes, EOCD_SIG)).toHaveLength(1);
  });

  it("upgrades cumulative offsets: central sentinel + zip64 EOCD + locator", async () => {
    // 第一个条目 5KB → 第二个条目的本地头偏移 > 阈值 → 中央目录偏移哨兵。
    const bytes = await writeArchive(
      [
        { name: "a.bag", mtimeMs: Date.UTC(2026, 7, 20), data: big(5000) },
        { name: "b.bag", mtimeMs: Date.UTC(2026, 7, 20), data: textBytes("b") },
      ],
      { __testMaxFieldValue: THRESHOLD },
    );
    const archive = await openZipArchive(new BlobRandomAccessReader(new Blob([bytes])));
    const entry = archive.entries.find((candidate) => candidate.name === "b.bag");
    expect(entry).toBeDefined();
    expect(entry!.size).toBe(1);
    expect(entry!.dataOffset).toBeGreaterThan(THRESHOLD);
    expect(archive.entries.map((candidate) => candidate.name)).toEqual(["a.bag", "b.bag"]);
  });

  it("upgrades the entry count when it overflows the threshold", async () => {
    const bytes = await writeArchive(
      [1, 2, 3].map((i) => ({
        name: `f${i}.txt`,
        mtimeMs: Date.UTC(2026, 7, 20),
        data: textBytes(`x${i}`),
      })),
      { __testMaxFieldValue: 2 },
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(findSignature(bytes, ZIP64_EOCD_SIG)).toHaveLength(1);
    expect(findSignature(bytes, ZIP64_LOCATOR_SIG)).toHaveLength(1);
    const eocdOffset = bytes.byteLength - 22;
    expect(view.getUint16(eocdOffset + 8, true)).toBe(0xffff); // 计数哨兵
    expect(view.getUint16(eocdOffset + 10, true)).toBe(0xffff);
    const archive = await openZipArchive(new BlobRandomAccessReader(new Blob([bytes])));
    expect(archive.entries).toHaveLength(3);
  });

  it("reads zip64 archives back through the §11.1 reader (round-trip)", async () => {
    const bytes = await writeArchive(
      [
        { name: "bags/one.bag", mtimeMs: Date.UTC(2026, 7, 20), data: big(5000) },
        { name: "bags/two.bag", mtimeMs: Date.UTC(2026, 7, 20), data: big(6000) },
        { name: "manifest.json", mtimeMs: Date.UTC(2026, 7, 20), data: textBytes("{\"format\":1}") },
      ],
      { __testMaxFieldValue: THRESHOLD },
    );
    const archive = await openZipArchive(new BlobRandomAccessReader(new Blob([bytes])));
    const manifest = archive.entries.find((entry) => entry.name === "manifest.json");
    expect(manifest).toBeDefined();
    expect(await archive.readEntryText(manifest!)).toBe("{\"format\":1}");
    const one = archive.entries.find((entry) => entry.name === "bags/one.bag")!;
    const reader = archive.openEntryReader(one);
    expect(reader.size).toBe(5000);
    const head = await reader.read(0, 8);
    expect(head).toEqual(bytes.subarray(one.dataOffset, one.dataOffset + 8));
    const tail = await reader.read(4992, 8);
    expect(tail).toEqual(bytes.subarray(one.dataOffset + 4992, one.dataOffset + 5000));
  });
});

describe("createZipWriter — descriptor tolerates size changes (spec §8.1)", () => {
  it("writes actualSize from endEntry when it differs from the announced size", async () => {
    const writable = new MemoryWritable();
    const writer = createZipWriter(writable);
    const data = textBytes("0123456789");
    writer.beginEntry("a.bag", Date.UTC(2026, 7, 20), 4096);
    await writer.pushEntryChunk(data);
    await writer.endEntry(data.byteLength); // fileEnd 报了不同的字节数
    await writer.finalize();
    const bytes = writable.bytes();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const descriptorOffset = 30 + "a.bag".length + data.byteLength;
    expect(view.getUint32(descriptorOffset + 8, true)).toBe(data.byteLength);
    // 中央目录以 actualSize 落盘,fflate 按此读回完整条目。
    expect(Buffer.from(unzipSync(bytes)["a.bag"]! as Uint8Array).toString()).toBe("0123456789");
  });
});

describe("createZipWriter — abort", () => {
  it("never writes a central directory, no-ops later calls, and removes the partial zip", async () => {
    const writable = new MemoryWritable();
    let removed = false;
    const writer = createZipWriter(writable, {
      onAbort: async () => {
        removed = true;
      },
    });
    writer.beginEntry("a.bag", Date.UTC(2026, 7, 20));
    await writer.pushEntryChunk(textBytes("partial"));
    await writer.abort();
    // abort 后 push/begin/end 均 no-op,finalize 拒绝。
    writer.beginEntry("b.bag", Date.UTC(2026, 7, 20));
    await writer.pushEntryChunk(textBytes("late"));
    await writer.endEntry(4);
    await expect(writer.finalize()).rejects.toThrow();
    const bytes = writable.bytes();
    expect(findSignature(bytes, EOCD_SIG)).toHaveLength(0);
    expect(findSignature(bytes, 0x02014b50)).toHaveLength(0); // 无中央目录头
    expect(writable.aborted).toBe(true);
    expect(removed).toBe(true);
  });

  it("surfaces local write failures at the next await point", async () => {
    const writable = new MemoryWritable();
    const writer = createZipWriter(writable);
    writer.beginEntry("a.bag", Date.UTC(2026, 7, 20));
    writable.failWrites = true;
    await expect(writer.pushEntryChunk(textBytes("x"))).rejects.toThrow("disk full");
    await writer.abort();
  });
});

describe("robotExportZipFileName (spec §7.1)", () => {
  it("derives the name from host and naive start/end keys", () => {
    expect(robotExportZipFileName("192.168.1.100", "20260820090000", "20260820100000")).toBe(
      "robot-export-192.168.1.100-20260820-090000-20260820-100000.zip",
    );
  });
});

describe("resolveZipNameConflict (spec §7.1)", () => {
  it("appends (n) until the name is free", async () => {
    const existing = new Set(["a.zip", "a (1).zip"]);
    const name = await resolveZipNameConflict("a.zip", async (candidate) => existing.has(candidate));
    expect(name).toBe("a (2).zip");
  });

  it("keeps the base name when free", async () => {
    expect(await resolveZipNameConflict("a.zip", async () => false)).toBe("a.zip");
  });
});
