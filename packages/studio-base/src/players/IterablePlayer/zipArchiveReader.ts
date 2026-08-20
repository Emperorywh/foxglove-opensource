// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * zip 归档随机访问读取器(docs/SPEC_robot_export_package.md §11.1)。
 *
 * 导入机器人导出包时,zip 内的每个 bag 条目被包装为区间视图按需读取——Store
 * 条目即原始字节,解析中央目录后无需解压、零额外磁盘占用。与 §8 的 writer
 * 格式对称:经典 + zip64 + 数据描述符(描述符不进随机访问路径——一切以中央
 * 目录为准)。
 *
 * 本模块纯逻辑、不依赖 React,worker 内可用;单测见 zipArchiveReader.test.ts。
 */

import { Filelike } from "@foxglove/rosbag";
import BrowserHttpReader from "@foxglove/studio-base/util/BrowserHttpReader";
import CachedFilelike from "@foxglove/studio-base/util/CachedFilelike";

/** 统一的随机读抽象(与 @foxglove/rosbag 的 Filelike 同形,size 为同步)。 */
export interface RandomAccessReader {
  size(): number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Web 输入文件/懒加载 File:Blob.slice().arrayBuffer(),worker 内可用。 */
export class BlobRandomAccessReader implements RandomAccessReader {
  readonly #blob: Blob;

  public constructor(blob: Blob) {
    this.#blob = blob;
  }

  public size(): number {
    return this.#blob.size;
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    const slice = this.#blob.slice(offset, offset + length);
    if (typeof slice.arrayBuffer === "function") {
      return new Uint8Array(await slice.arrayBuffer());
    }
    // jsdom 等环境的 Blob 没有 arrayBuffer():退回 FileReader(浏览器/worker 均可用)。
    return await new Promise<Uint8Array>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(new Uint8Array(reader.result as ArrayBuffer));
      };
      reader.onerror = () => {
        reject(reader.error ?? new Error("blob read failed"));
      };
      reader.readAsArrayBuffer(slice);
    });
  }
}

/**
 * 桌面闭环 URL(§13):包装既有 CachedFilelike。须在 `open()` 成功后构造
 * (size() 在打开前不可用);`openUrlReader` 是便捷工厂,镜像 BagIterableSource
 * 的 remote 形态装配。
 */
export class CachedFilelikeRandomAccessReader implements RandomAccessReader {
  readonly #filelike: CachedFilelike;

  public constructor(filelike: CachedFilelike) {
    this.#filelike = filelike;
  }

  public size(): number {
    return this.#filelike.size();
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    return await this.#filelike.read(offset, length);
  }
}

/** 打开一个远程 zip(BrowserHttpReader + 200MiB 缓存的 CachedFilelike)。 */
export async function openUrlReader(url: string): Promise<CachedFilelikeRandomAccessReader> {
  const fileReader = new BrowserHttpReader(url);
  const remoteReader = new CachedFilelike({
    fileReader,
    cacheSizeInBytes: 1024 * 1024 * 200, // 200MiB
    keepReconnectingCallback: (_reconnecting) => {
      // 与 BagIterableSource 的 remote 形态一致:不额外处理重连提示。
    },
  });
  await remoteReader.open();
  return new CachedFilelikeRandomAccessReader(remoteReader);
}

export type ZipEntry = {
  name: string;
  /** 条目数据字节数(Store:压缩=未压缩)。 */
  size: number;
  /** 条目数据起始偏移(本地头现算,§11.1)。 */
  dataOffset: number;
  mtimeMs: number;
};

export type ZipArchive = {
  entries: ZipEntry[];
  /** 小条目便捷读取(manifest/alarms.json)。 */
  readEntryText(entry: ZipEntry): Promise<string>;
  /** 区间视图 `{ size, read }`(offset 平移),供 bag Filelike 适配器使用。 */
  openEntryReader(entry: ZipEntry): { size: number; read(offset: number, length: number): Promise<Uint8Array> };
};

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_EXTRA_ID = 0x0001;
const FLAG_ENCRYPTED = 0x0001;
/** EOCD 最多允许 64KiB 的尾部注释。 */
const MAX_EOCD_COMMENT = 0xffff;
/** 单个本地头的读取窗口:覆盖 30 字节固定头 + 任意现实的 name/extra。 */
const LOCAL_HEADER_WINDOW = 2048;

const decoder = new TextDecoder("utf-8");

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}
function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}
function u64(view: DataView, offset: number): number {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x100000000;
}

/** DOS date/time → 本地时间 ms(与 writer 的编码口径一致)。 */
function dosToMs(time: number, date: number): number {
  const seconds = (time & 0x1f) * 2;
  const minutes = (time >> 5) & 0x3f;
  const hours = (time >> 11) & 0x1f;
  const day = date & 0x1f;
  const month = ((date >> 5) & 0x0f) - 1;
  const year = 1980 + (date >> 9);
  return new Date(year, month, day, hours, minutes, seconds).getTime();
}

type RawCentralEntry = {
  name: string;
  flags: number;
  method: number;
  size: number;
  offset: number;
  mtimeMs: number;
};

/**
 * 打开 zip 归档:定位 EOCD(尾部 64KiB+22 扫描)→ 哨兵经 ZIP64 locator →
 * ZIP64 EOCD → 解析中央目录 → 逐条目读本地头现算 dataOffset(§11.1)。
 *
 * 拒绝并给出明确错误:压缩方法 ≠ 0(非 Store)、加密标志、多分卷、中央目录
 * 越界/截断、找不到 EOCD(不是 zip)。
 */
export async function openZipArchive(reader: RandomAccessReader): Promise<ZipArchive> {
  const totalSize = reader.size();

  const tailLength = Math.min(totalSize, MAX_EOCD_COMMENT + 22);
  const tail = await reader.read(totalSize - tailLength, tailLength);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  // 从尾部向前找 EOCD 签名(注释可能包含同值字节,取最靠后的候选)。
  let eocdOffsetInTail = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tailView, i) === EOCD_SIG) {
      eocdOffsetInTail = i;
      break;
    }
  }
  if (eocdOffsetInTail < 0) {
    throw new Error("not a zip archive (no end-of-central-directory record)");
  }
  const eocd = new DataView(tail.buffer, tail.byteOffset + eocdOffsetInTail, 22);
  if (u16(eocd, 4) !== 0 || u16(eocd, 6) !== 0) {
    throw new Error("multi-disk zip archives are not supported");
  }
  let entryCount = u16(eocd, 8);
  let centralSize = u32(eocd, 12);
  let centralOffset = u32(eocd, 16);

  // 哨兵(条目数 0xFFFF 或 size/offset 0xFFFFFFFF)→ ZIP64 locator → ZIP64 EOCD。
  const needsZip64 = entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff;
  if (needsZip64) {
    const locatorOffsetInTail = eocdOffsetInTail - 20;
    if (locatorOffsetInTail < 0 || u32(tailView, locatorOffsetInTail) !== ZIP64_LOCATOR_SIG) {
      throw new Error("zip64 end-of-central-directory locator is missing or corrupt");
    }
    const locator = new DataView(tail.buffer, tail.byteOffset + locatorOffsetInTail, 20);
    const zip64EocdOffset = u64(locator, 8);
    if (zip64EocdOffset + 56 > totalSize) {
      throw new Error("zip64 end-of-central-directory record is out of bounds");
    }
    const zip64EocdBytes = await reader.read(zip64EocdOffset, 56);
    const zip64Eocd = new DataView(zip64EocdBytes.buffer, zip64EocdBytes.byteOffset, 56);
    if (u32(zip64Eocd, 0) !== ZIP64_EOCD_SIG) {
      throw new Error("zip64 end-of-central-directory record is corrupt");
    }
    if (u32(zip64Eocd, 16) !== 0 || u32(zip64Eocd, 20) !== 0) {
      throw new Error("multi-disk zip archives are not supported");
    }
    entryCount = u64(zip64Eocd, 24);
    centralSize = u64(zip64Eocd, 40);
    centralOffset = u64(zip64Eocd, 48);
  }

  if (centralOffset + centralSize > totalSize) {
    throw new Error("central directory is truncated or corrupt");
  }
  const centralBytes = await reader.read(centralOffset, centralSize);
  const central = new DataView(centralBytes.buffer, centralBytes.byteOffset, centralBytes.byteLength);

  const rawEntries: RawCentralEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralBytes.byteLength) {
      throw new Error("central directory is truncated or corrupt");
    }
    if (u32(central, cursor) !== CENTRAL_SIG) {
      throw new Error("central directory is corrupt (bad entry signature)");
    }
    const flags = u16(central, cursor + 8);
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new Error("encrypted zip entries are not supported");
    }
    const method = u16(central, cursor + 10);
    if (method !== 0) {
      throw new Error("compressed zip entries are not supported (only Store)");
    }
    if (u16(central, cursor + 34) !== 0) {
      throw new Error("multi-disk zip archives are not supported");
    }
    let size = u32(central, cursor + 24);
    let offset = u32(central, cursor + 42);
    const nameLength = u16(central, cursor + 28);
    const extraLength = u16(central, cursor + 30);
    const commentLength = u16(central, cursor + 32);
    const nameBytes = centralBytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = decoder.decode(nameBytes);

    // 中央目录 extra:zip64 extra(0x0001)按"哪些 32 位字段是哨兵"决定包含哪些
    // 8 字节字段(顺序:未压缩、压缩、本地头偏移)。
    const extraStart = cursor + 46 + nameLength;
    const extraEnd = extraStart + extraLength;
    let extraCursor = extraStart;
    while (extraCursor + 4 <= extraEnd) {
      const extraId = u16(central, extraCursor);
      const extraSize = u16(central, extraCursor + 2);
      if (extraId === ZIP64_EXTRA_ID) {
        let fieldCursor = extraCursor + 4;
        if (u32(central, cursor + 24) === 0xffffffff && fieldCursor + 8 <= extraEnd) {
          size = u64(central, fieldCursor);
          fieldCursor += 8;
        }
        if (u32(central, cursor + 20) === 0xffffffff && fieldCursor + 8 <= extraEnd) {
          fieldCursor += 8; // Store 下压缩=未压缩,size 已取值,跳过同值字段
        }
        if (offset === 0xffffffff && fieldCursor + 8 <= extraEnd) {
          offset = u64(central, fieldCursor);
        }
        break;
      }
      extraCursor += 4 + extraSize;
    }

    rawEntries.push({
      name,
      flags,
      method,
      size,
      offset,
      mtimeMs: dosToMs(u16(central, cursor + 12), u16(central, cursor + 14)),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  // dataOffset 由条目本地头现算:读 30 字节固定头取 name/extra 长度(§11.1)。
  const entries: ZipEntry[] = [];
  for (const raw of rawEntries) {
    if (raw.offset + LOCAL_HEADER_WINDOW > totalSize && raw.offset + 30 > totalSize) {
      throw new Error(`local header for ${raw.name} is out of bounds`);
    }
    const windowLength = Math.min(LOCAL_HEADER_WINDOW, totalSize - raw.offset);
    const headerBytes = await reader.read(raw.offset, windowLength);
    const header = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
    if (headerBytes.byteLength < 30 || u32(header, 0) !== LOCAL_SIG) {
      throw new Error(`local header for ${raw.name} is corrupt`);
    }
    const nameLength = u16(header, 26);
    const extraLength = u16(header, 28);
    const dataOffset = raw.offset + 30 + nameLength + extraLength;
    if (dataOffset + raw.size > totalSize) {
      throw new Error(`entry data for ${raw.name} is out of bounds`);
    }
    entries.push({
      name: raw.name,
      size: raw.size,
      dataOffset,
      mtimeMs: raw.mtimeMs,
    });
  }

  return {
    entries,
    async readEntryText(entry: ZipEntry): Promise<string> {
      const bytes = await reader.read(entry.dataOffset, entry.size);
      return decoder.decode(bytes);
    },
    openEntryReader(entry: ZipEntry) {
      return {
        size: entry.size,
        async read(offset: number, length: number): Promise<Uint8Array> {
          return await reader.read(entry.dataOffset + offset, length);
        },
      };
    },
  };
}

/**
 * bag 条目的 Filelike 适配(§11.2):`@foxglove/rosbag` 的 `Bag` 接受任意
 * Filelike(CachedFilelike 即先例)。每个 bag 条目一个实例,把条目区间视图的
 * offset 平移到归档绝对偏移。
 */
export class RangedFilelike implements Filelike {
  readonly #reader: RandomAccessReader;
  readonly #dataOffset: number;
  readonly #size: number;

  public constructor(reader: RandomAccessReader, entry: ZipEntry) {
    this.#reader = reader;
    this.#dataOffset = entry.dataOffset;
    this.#size = entry.size;
  }

  public size(): number {
    return this.#size;
  }

  public async read(offset: number, length: number): Promise<Uint8Array> {
    return await this.#reader.read(this.#dataOffset + offset, length);
  }
}
