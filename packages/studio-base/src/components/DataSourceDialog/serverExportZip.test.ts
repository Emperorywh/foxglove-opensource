// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { unzipSync } from "fflate";

import {
  MAX_ZIP_BYTES,
  ZipSizeLimitExceededError,
  createZipWriter,
  resolveZipNameConflict,
  zipFileName,
  zipSelectionTooLarge,
} from "./serverExportZip";

/** In-memory FileSystemWritableFileStream capturing every write call in order. */
class MockWritable {
  public chunks: Uint8Array[] = [];
  public closed = false;
  public aborted = false;
  /** When set, writes block until release() is called (back-pressure testing). */
  #gate: { promise: Promise<void>; release: () => void } | undefined;

  public gateWrites(): void {
    let release: () => void = () => {};
    this.#gate = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release,
    };
  }

  public release(): void {
    this.#gate?.release();
  }

  public async write(data: Uint8Array): Promise<void> {
    await this.#gate?.promise;
    this.chunks.push(new Uint8Array(data));
  }

  public async close(): Promise<void> {
    await this.#gate?.promise;
    this.closed = true;
  }

  public async abort(): Promise<void> {
    this.aborted = true;
  }

  public bytes(): Uint8Array {
    const total = this.chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  public asStream(): FileSystemWritableFileStream {
    return this as unknown as FileSystemWritableFileStream;
  }
}

/** Offsets of every local file header signature (PK\x03\x04) in the container. */
function localHeaderOffsets(bytes: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x03 &&
      bytes[i + 3] === 0x04
    ) {
      offsets.push(i);
    }
  }
  return offsets;
}

function hasEndOfCentralDirectory(bytes: Uint8Array): boolean {
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      return true;
    }
  }
  return false;
}

/** Decode the DOS date field of the local header at `offset` into calendar components. */
function localHeaderDosDate(
  bytes: Uint8Array,
  offset: number,
): { year: number; month: number; day: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
  const date = view.getUint16(12, true);
  return { year: (date >> 9) + 1980, month: (date >> 5) & 0xf, day: date & 0x1f };
}

describe("createZipWriter", () => {
  it("round-trips stored entries in write order (fflate unzipSync)", async () => {
    const writable = new MockWritable();
    const writer = createZipWriter(writable.asStream());

    const first = new TextEncoder().encode("hello bag contents");
    const secondA = new TextEncoder().encode("part one —");
    const secondB = new TextEncoder().encode("part two");

    writer.beginEntry("a.bag", Date.parse("2026-08-06T13:14:16Z"));
    await writer.pushEntryChunk(first);
    await writer.endEntry();
    writer.beginEntry("日志.txt", Date.parse("2026-01-02T03:04:06Z"));
    await writer.pushEntryChunk(secondA);
    await writer.pushEntryChunk(secondB);
    await writer.endEntry();
    await writer.finalize();

    expect(writable.closed).toBe(true);
    const unzipped = unzipSync(writable.bytes());
    expect(Object.keys(unzipped)).toEqual(["a.bag", "日志.txt"]);
    expect(unzipped["a.bag"]).toEqual(first);
    const merged = new Uint8Array(secondA.byteLength + secondB.byteLength);
    merged.set(secondA, 0);
    merged.set(secondB, secondA.byteLength);
    expect(unzipped["日志.txt"]).toEqual(merged);
  });

  it("sets the UTF-8 flag only for non-ASCII entry names", async () => {
    const writable = new MockWritable();
    const writer = createZipWriter(writable.asStream());
    writer.beginEntry("ascii.bag", Date.parse("2026-08-06T00:00:00Z"));
    await writer.endEntry();
    writer.beginEntry("中文名.log", Date.parse("2026-08-06T00:00:00Z"));
    await writer.endEntry();
    await writer.finalize();

    const bytes = writable.bytes();
    const offsets = localHeaderOffsets(bytes);
    expect(offsets.length).toBe(2);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const UTF8_FLAG = 0x0800;
    expect(view.getUint16(offsets[0]! + 6, true) & UTF8_FLAG).toBe(0);
    expect(view.getUint16(offsets[1]! + 6, true) & UTF8_FLAG).toBe(UTF8_FLAG);
  });

  it("preserves the entry mtime (DOS encoding, local time)", async () => {
    const writable = new MockWritable();
    const writer = createZipWriter(writable.asStream());
    // Local-time construction matches fflate's local-time DOS encoding.
    writer.beginEntry("a.bag", new Date(2026, 7, 6, 13, 14, 16).getTime());
    await writer.endEntry();
    await writer.finalize();

    const bytes = writable.bytes();
    const offsets = localHeaderOffsets(bytes);
    expect(localHeaderDosDate(bytes, offsets[0]!)).toEqual({ year: 2026, month: 8, day: 6 });
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const time = view.getUint16(offsets[0]! + 10, true);
    expect({ hours: time >> 11, minutes: (time >> 5) & 0x3f, seconds: (time & 0x1f) * 2 }).toEqual({
      hours: 13,
      minutes: 14,
      seconds: 16,
    });
  });

  it("clamps out-of-range entry mtimes to the DOS date bounds", async () => {
    const writable = new MockWritable();
    const writer = createZipWriter(writable.asStream());
    writer.beginEntry("epoch0.bag", 0); // 1970 → clamped to 1980-01-01
    await writer.endEntry();
    writer.beginEntry("future.bag", new Date(3000, 0, 1).getTime()); // → 2099-12-31
    await writer.endEntry();
    await writer.finalize();

    const bytes = writable.bytes();
    const offsets = localHeaderOffsets(bytes);
    expect(offsets.length).toBe(2);
    expect(localHeaderDosDate(bytes, offsets[0]!)).toEqual({ year: 1980, month: 1, day: 1 });
    expect(localHeaderDosDate(bytes, offsets[1]!)).toEqual({ year: 2099, month: 12, day: 31 });
    // The result stays a valid zip.
    expect(Object.keys(unzipSync(bytes))).toEqual(["epoch0.bag", "future.bag"]);
  });

  it("serializes writes: pushEntryChunk resolves only after its bytes hit the writable", async () => {
    const writable = new MockWritable();
    writable.gateWrites();
    const writer = createZipWriter(writable.asStream());
    writer.beginEntry("a.bag", Date.parse("2026-08-06T00:00:00Z"));

    let pushed = false;
    const pushPromise = writer.pushEntryChunk(new Uint8Array([1, 2, 3])).then(() => {
      pushed = true;
    });
    await Promise.resolve();
    expect(pushed).toBe(false);
    expect(writable.chunks.length).toBe(0);

    writable.release();
    await pushPromise;
    expect(pushed).toBe(true);
    // Local header + data were written in order once the gate opened.
    expect(writable.chunks.length).toBeGreaterThan(0);
    const bytes = writable.bytes();
    const offsets = localHeaderOffsets(bytes);
    expect(offsets.length).toBe(1);
  });

  it("abort() discards the package: no central directory, writable aborted, cleanup called", async () => {
    const writable = new MockWritable();
    const onAbort = jest.fn(async () => {});
    const writer = createZipWriter(writable.asStream(), { onAbort });

    writer.beginEntry("a.bag", Date.parse("2026-08-06T00:00:00Z"));
    await writer.pushEntryChunk(new Uint8Array([1, 2, 3]));
    await writer.abort();

    expect(writable.aborted).toBe(true);
    expect(writable.closed).toBe(false);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(hasEndOfCentralDirectory(writable.bytes())).toBe(false);

    // Entry methods are no-ops after abort — late frames are dropped silently.
    const chunksBefore = writable.chunks.length;
    writer.beginEntry("late.bag", 0);
    await writer.pushEntryChunk(new Uint8Array([9, 9]));
    await writer.endEntry();
    expect(writable.chunks.length).toBe(chunksBefore);
  });

  it("abort() tolerates a NotFoundError from the partial-zip cleanup", async () => {
    const writable = new MockWritable();
    const writer = createZipWriter(writable.asStream(), {
      onAbort: async () => {
        throw new DOMException("not found", "NotFoundError");
      },
    });
    writer.beginEntry("a.bag", Date.parse("2026-08-06T00:00:00Z"));
    await writer.pushEntryChunk(new Uint8Array([1]));
    await expect(writer.abort()).resolves.toBeUndefined();
    expect(writable.aborted).toBe(true);
  });

  it("aborts the package when container bytes exceed the (injected) size limit", async () => {
    const writable = new MockWritable();
    const writer = createZipWriter(writable.asStream(), { maxBytes: 40 });

    writer.beginEntry("a.bag", Date.parse("2026-08-06T00:00:00Z"));
    // The 35-byte local header fits; the next chunk pushes the container over 40 bytes.
    await writer.pushEntryChunk(new Uint8Array(2));
    await expect(writer.pushEntryChunk(new Uint8Array(16))).rejects.toBeInstanceOf(
      ZipSizeLimitExceededError,
    );

    await writer.abort();
    expect(writable.aborted).toBe(true);
    expect(hasEndOfCentralDirectory(writable.bytes())).toBe(false);
  });

  it("finalize() refuses to land a package whose central directory crosses the limit", async () => {
    const writable = new MockWritable();
    // Entry "a" (30 + 1 name bytes header + 16 descriptor + 4 data = 51) fits under 60,
    // but the central directory (~47 + 22 EOCD) does not.
    const writer = createZipWriter(writable.asStream(), { maxBytes: 60 });
    writer.beginEntry("a", Date.parse("2026-08-06T00:00:00Z"));
    await writer.pushEntryChunk(new Uint8Array(4));
    await writer.endEntry();
    await expect(writer.finalize()).rejects.toBeInstanceOf(ZipSizeLimitExceededError);
    expect(writable.closed).toBe(false);
    await writer.abort();
    expect(writable.aborted).toBe(true);
  });

  it("supports 0-byte entries", async () => {
    const writable = new MockWritable();
    const writer = createZipWriter(writable.asStream());
    writer.beginEntry("empty.bag", Date.parse("2026-08-06T00:00:00Z"));
    await writer.endEntry();
    await writer.finalize();
    const unzipped = unzipSync(writable.bytes());
    expect(Object.keys(unzipped)).toEqual(["empty.bag"]);
    expect(unzipped["empty.bag"]?.byteLength).toBe(0);
  });
});

describe("zipFileName", () => {
  it("formats export-YYYYMMDD-HHmmss.zip in local time", () => {
    expect(zipFileName(new Date(2026, 7, 6, 13, 14, 15))).toBe("export-20260806-131415.zip");
    expect(zipFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe("export-20260102-030405.zip");
  });
});

describe("resolveZipNameConflict", () => {
  const existsWith = (existing: ReadonlySet<string>) => async (name: string) => existing.has(name);

  it("keeps the base name when there is no conflict", async () => {
    await expect(resolveZipNameConflict("export-a.zip", existsWith(new Set()))).resolves.toBe(
      "export-a.zip",
    );
  });

  it("appends an incrementing suffix until the name is free", async () => {
    await expect(
      resolveZipNameConflict("export-a.zip", existsWith(new Set(["export-a.zip"]))),
    ).resolves.toBe("export-a (1).zip");
    await expect(
      resolveZipNameConflict(
        "export-a.zip",
        existsWith(new Set(["export-a.zip", "export-a (1).zip", "export-a (2).zip"])),
      ),
    ).resolves.toBe("export-a (3).zip");
  });
});

describe("zipSelectionTooLarge", () => {
  it("rejects selections at or above the limit", () => {
    expect(zipSelectionTooLarge(MAX_ZIP_BYTES - 1)).toBe(false);
    expect(zipSelectionTooLarge(MAX_ZIP_BYTES)).toBe(true);
    expect(zipSelectionTooLarge(MAX_ZIP_BYTES + 1)).toBe(true);
    expect(zipSelectionTooLarge(10, 10)).toBe(true);
  });
});
