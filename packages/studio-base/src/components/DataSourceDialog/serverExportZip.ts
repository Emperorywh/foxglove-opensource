// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * 浏览器侧流式 ZIP(ZIP64)容器写出(docs/SPEC_robot_export_package.md §8)。
 *
 * fflate 的流式写路径没有 ZIP64 支持,因此这里自写容器层:Store(不压缩,沿用
 * 决策 Z2)之下 zip 只是"本地头 + 原始字节 + 中央目录"的薄格式。要点:
 *
 * - 每个条目置 bit 3(数据描述符),本地头的 CRC/size 写 0 或哨兵,实际值在
 *   数据之后的描述符里落盘——SFTP 对增长/缩水文件的实际字节数只有在 fileEnd
 *   才确定,描述符路径容忍体积变化(§8.1);
 * - ZIP64 判定按值惰性升级:任何 32 位字段(条目 size、本地头偏移、条目计数、
 *   中央目录大小/偏移)装不下时写哨兵,真实值进 zip64 extra(0x0001);
 * - 全部装得下时只写经典 EOCD——小导出包保持最朴素的经典格式(§8.1);
 * - 单测用注入式阈值 `__testMaxFieldValue` 把 32 位边界压到 KB 级(§8.2)。
 *
 * 本模块纯逻辑、不依赖 React,单测见 serverExportZip.test.ts。
 */

import { ServerExportWritable } from "./serverExportTarget";

/** CRC-32(IEEE 802.3,反射多项式)查表实现。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      // 位测试显式比较(strict-boolean-expressions)。
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(current: number, data: Uint8Array): number {
  let crc = current ^ 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// 与旧实现一致的 DOS 时间钳制范围(1980-01-01 ~ 2099-12-31);边界按本地时间构造,
// DOS 时间本身也按本地时间读取(与 fflate 产物一致)。
const DOS_TIME_MIN_MS = new Date(1980, 0, 1, 0, 0, 0).getTime();
const DOS_TIME_MAX_MS = new Date(2099, 11, 31, 23, 59, 58).getTime();

/** 条目 mtime → DOS date/time 双字段,钳制到 DOS 可编码范围。 */
function dosDateTime(mtimeMs: number): { time: number; date: number } {
  const clamped = Math.min(Math.max(mtimeMs, DOS_TIME_MIN_MS), DOS_TIME_MAX_MS);
  const d = new Date(clamped);
  const dosTime =
    (Math.floor(d.getSeconds() / 2) & 0x1f) | ((d.getMinutes() & 0x3f) << 5) | ((d.getHours() & 0x1f) << 11);
  const dosDate =
    (d.getDate() & 0x1f) | (((d.getMonth() + 1) & 0x0f) << 5) | ((d.getFullYear() - 1980) << 9);
  return { time: dosTime, date: dosDate };
}

const encoder = new TextEncoder();

/** 本地文件头固定 30 字节;中央目录头固定 46 字节。 */
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const DESCRIPTOR_SIG = 0x08074b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;
/** bit 3 = 数据描述符;bit 11 = UTF-8 文件名。 */
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;

type CentralRecord = {
  nameBytes: Uint8Array;
  utf8: boolean;
  mtimeMs: number;
  crc: number;
  /** fileEnd 的实际字节数(Store 下压缩/未压缩同值)。 */
  size: number;
  /** 本地头起始偏移。 */
  offset: number;
  /** beginEntry 时即升级为 zip64(本地头已带哨兵 + extra)。 */
  headerZip64: boolean;
  /** 描述符按 8 字节 size 落盘(headerZip64 或实际 size 越界)。 */
  descriptorZip64: boolean;
};

export type ServerExportZipWriter = {
  /**
   * 开始一个新条目。立即写本地头(bit 3,CRC/size 为 0 或哨兵)。`expectedSize`
   * 来自 fileStart/list——预知超界时本地头直接以 zip64 形态写出(哨兵 + extra);
   * 实际超界但未预知的条目由描述符与中央目录兜底(§8.1)。mtime 钳制 DOS 范围。
   */
  beginEntry(name: string, mtimeMs: number, expectedSize?: number): void;
  /**
   * 追加条目数据。容器字节经串行 promise 链按序写入 ServerExportWritable;返回值
   * 在本块数据落盘后 resolve——调用方以此为流控 ack 的门槛(沿用原 §5.3 语义)。
   */
  pushEntryChunk(chunk: Uint8Array): Promise<void>;
  /**
   * 结束当前条目,写数据描述符(带签名 0x08074b50)。`actualSize` 来自
   * `fileEnd.bytes`:与预期不符时以 actualSize 落盘(§8.1)。
   */
  endEntry(actualSize: number): Promise<void>;
  /** 写中央目录(含按需的 ZIP64 EOCD + locator)并关闭 writable。 */
  finalize(): Promise<void>;
  /**
   * 失败/取消路径:条目方法 no-op 化、不写中央目录、在途写入 await、
   * `writable.abort()`、尽力 `removeEntry`(§8.2)。
   */
  abort(): Promise<void>;
};

export function createZipWriter(
  writable: ServerExportWritable,
  opts?: {
    /** 尽力清理部分 zip(如 dirHandle.removeEntry);错误忽略。 */
    onAbort?: () => Promise<void>;
    /**
     * 测试专用:把 32 位字段边界压到 KB 级,无需 4GB 夹具即可覆盖 zip64 分支
     * (§8.2 注入式阈值)。同时作为 16 位条目计数的边界。
     */
    // eslint-disable-next-line no-underscore-dangle -- 规格命名(SPEC §8.2)
    __testMaxFieldValue?: number;
  },
): ServerExportZipWriter {
  // 32 位字段的默认边界 0xFFFFFFFF;16 位条目计数的默认边界 0xFFFF。
  // 注入阈值后两者同值——单一边界即可驱动全部哨兵分支。
  // eslint-disable-next-line no-underscore-dangle -- 规格命名(SPEC §8.2)
  const injectedMax = opts?.__testMaxFieldValue;
  const max32 = injectedMax ?? 0xffffffff;
  const max16 = injectedMax ?? 0xffff;
  const fits32 = (value: number) => value <= max32;
  const fits16 = (value: number) => value <= max16;
  const onAbort = opts?.onAbort;

  let aborted = false;
  let finalized = false;
  let bytesWritten = 0;
  let writeError: unknown;
  /** 当前打开的条目(beginEntry → endEntry 之间)。 */
  let current: {
    nameBytes: Uint8Array;
    utf8: boolean;
    mtimeMs: number;
    crc: number;
    pushed: number;
    offset: number;
    headerZip64: boolean;
  } | undefined;
  const records: CentralRecord[] = [];

  // 容器字节经串行 promise 链按序写入;链不 reject,失败记入 writeError 并在下一个
  // await 点抛出(与旧实现的纪律一致)。
  let chain: Promise<void> = Promise.resolve();
  const write = (data: Uint8Array): void => {
    bytesWritten += data.byteLength;
    chain = chain
      .then(async () => {
        await writable.write(data);
      })
      .catch((err: unknown) => {
        writeError ??= err;
      });
  };

  const throwIfFailed = (): void => {
    if (writeError != undefined) {
      throw writeError instanceof Error ? writeError : new Error(String(writeError));
    }
  };

  const u16 = (view: DataView, offset: number, value: number): void => {
    view.setUint16(offset, value, true);
  };
  const u32 = (view: DataView, offset: number, value: number): void => {
    view.setUint32(offset, value, true);
  };
  const u64 = (view: DataView, offset: number, value: number): void => {
    // 偏移/size 超 2^53 才丢精度,实际不可能;按小端双字写入。
    view.setUint32(offset, value % 0x100000000, true);
    view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
  };

  return {
    beginEntry(name: string, mtimeMs: number, expectedSize?: number): void {
      if (aborted || finalized || writeError != undefined) {
        return; // 失败后保持惰性,错误在下个 await 点 surfaced
      }
      if (current != undefined) {
        throw new Error("endEntry must be called before beginEntry");
      }
      const nameBytes = encoder.encode(name);
      if (nameBytes.length > 0xffff) {
        throw new Error("entry name too long");
      }
      const utf8 = nameBytes.length !== name.length;
      // 预知超界(fileStart/list 的 size)→ 本地头直接 zip64:哨兵 + 双 size extra。
      const headerZip64 = expectedSize != undefined && expectedSize > max32;

      const extraLength = headerZip64 ? 4 + 16 : 0;
      const header = new Uint8Array(LOCAL_HEADER_SIZE + nameBytes.length + extraLength);
      const view = new DataView(header.buffer);
      u32(view, 0, LOCAL_SIG);
      u16(view, 4, headerZip64 ? 45 : 20);
      u16(view, 6, FLAG_DESCRIPTOR | (utf8 ? FLAG_UTF8 : 0));
      u16(view, 8, 0); // Store
      const { time, date } = dosDateTime(mtimeMs);
      u16(view, 10, time);
      u16(view, 12, date);
      u32(view, 14, 0); // CRC(bit 3:数据后描述符)
      u32(view, 18, headerZip64 ? 0xffffffff : 0);
      u32(view, 22, headerZip64 ? 0xffffffff : 0);
      u16(view, 26, nameBytes.length);
      u16(view, 28, extraLength);
      header.set(nameBytes, LOCAL_HEADER_SIZE);
      if (headerZip64) {
        const extra = new DataView(header.buffer, LOCAL_HEADER_SIZE + nameBytes.length);
        u16(extra, 0, ZIP64_EXTRA_ID);
        u16(extra, 2, 16);
        u64(extra, 4, expectedSize);
        u64(extra, 12, expectedSize);
      }
      current = {
        nameBytes,
        utf8,
        mtimeMs,
        crc: 0,
        pushed: 0,
        offset: bytesWritten,
        headerZip64,
      };
      write(header);
    },

    async pushEntryChunk(chunk: Uint8Array): Promise<void> {
      if (aborted || current == undefined) {
        return;
      }
      throwIfFailed();
      current.crc = crc32(current.crc, chunk);
      current.pushed += chunk.byteLength;
      write(chunk);
      await chain;
      throwIfFailed();
    },

    async endEntry(actualSize: number): Promise<void> {
      const entry = current;
      if (aborted || entry == undefined) {
        return;
      }
      current = undefined;
      throwIfFailed();
      // 描述符宽度:头部已升级,或实际 size 越界(容忍体积变化,§8.1)。
      const descriptorZip64 = entry.headerZip64 || actualSize > max32;
      const descriptor = new Uint8Array(descriptorZip64 ? 24 : 16);
      const view = new DataView(descriptor.buffer);
      u32(view, 0, DESCRIPTOR_SIG);
      u32(view, 4, entry.crc);
      if (descriptorZip64) {
        u64(view, 8, actualSize);
        u64(view, 16, actualSize);
      } else {
        u32(view, 8, actualSize);
        u32(view, 12, actualSize);
      }
      write(descriptor);
      records.push({
        nameBytes: entry.nameBytes,
        utf8: entry.utf8,
        mtimeMs: entry.mtimeMs,
        crc: entry.crc,
        size: actualSize,
        offset: entry.offset,
        headerZip64: entry.headerZip64,
        descriptorZip64,
      });
      await chain;
      throwIfFailed();
    },

    async finalize(): Promise<void> {
      if (aborted) {
        throw new Error("cannot finalize an aborted zip writer");
      }
      if (current != undefined) {
        throw new Error("endEntry must be called before finalize");
      }
      throwIfFailed();
      finalized = true;

      const centralOffset = bytesWritten;
      for (const record of records) {
        // 中央目录 extra 按需写:条目 size 越界或本地头偏移越界,含哪些字段写哪些
        // (§8.1);两头均不越界的条目不写 extra(经典形态)。
        const sizeOverflow = record.size > max32;
        const offsetOverflow = record.offset > max32;
        const extraLength = sizeOverflow || offsetOverflow ? 4 + (sizeOverflow ? 16 : 0) + (offsetOverflow ? 8 : 0) : 0;
        const header = new Uint8Array(CENTRAL_HEADER_SIZE + record.nameBytes.length + extraLength);
        const view = new DataView(header.buffer);
        const entryIsZip64 = record.headerZip64 || sizeOverflow || offsetOverflow;
        u32(view, 0, CENTRAL_SIG);
        u16(view, 4, entryIsZip64 ? 45 : 20); // version made by
        u16(view, 6, entryIsZip64 ? 45 : 20); // version needed
        u16(view, 8, FLAG_DESCRIPTOR | (record.utf8 ? FLAG_UTF8 : 0));
        u16(view, 10, 0); // Store
        const { time, date } = dosDateTime(record.mtimeMs);
        u16(view, 12, time);
        u16(view, 14, date);
        u32(view, 16, record.crc);
        u32(view, 20, sizeOverflow ? 0xffffffff : record.size);
        u32(view, 24, sizeOverflow ? 0xffffffff : record.size);
        u16(view, 28, record.nameBytes.length);
        u16(view, 30, extraLength);
        u16(view, 32, 0); // comment length
        u16(view, 34, 0); // disk number start
        u16(view, 36, 0); // internal attrs
        u32(view, 38, 0); // external attrs
        u32(view, 42, offsetOverflow ? 0xffffffff : record.offset);
        header.set(record.nameBytes, CENTRAL_HEADER_SIZE);
        if (extraLength > 0) {
          const extra = new DataView(header.buffer, CENTRAL_HEADER_SIZE + record.nameBytes.length);
          u16(extra, 0, ZIP64_EXTRA_ID);
          u16(extra, 2, extraLength - 4);
          let cursor = 4;
          if (sizeOverflow) {
            u64(extra, cursor, record.size);
            u64(extra, cursor + 8, record.size);
            cursor += 16;
          }
          if (offsetOverflow) {
            u64(extra, cursor, record.offset);
          }
        }
        write(header);
      }
      const centralSize = bytesWritten - centralOffset;

      // 收尾:任一值越界即写 ZIP64 EOCD record + locator,再写经典 EOCD(越界字段
      // 哨兵);全部装得下时只写经典 EOCD(§8.1)。
      const countOverflow = !fits16(records.length);
      const centralSizeOverflow = !fits32(centralSize);
      const centralOffsetOverflow = !fits32(centralOffset);
      const needZip64 =
        countOverflow || centralSizeOverflow || centralOffsetOverflow ||
        records.some((record) => record.size > max32 || record.offset > max32);

      if (needZip64) {
        const zip64EocdOffset = bytesWritten;
        const zip64Eocd = new Uint8Array(56);
        const view = new DataView(zip64Eocd.buffer);
        u32(view, 0, ZIP64_EOCD_SIG);
        u64(view, 4, 44); // 本记录大小减去头 12 字节
        u16(view, 12, 45); // version made by
        u16(view, 14, 45); // version needed
        u32(view, 16, 0); // 盘号
        u32(view, 20, 0); // 中央目录所在盘
        u64(view, 24, records.length);
        u64(view, 32, records.length);
        u64(view, 40, centralSize);
        u64(view, 48, centralOffset);
        write(zip64Eocd);

        const locator = new Uint8Array(20);
        const locatorView = new DataView(locator.buffer);
        u32(locatorView, 0, ZIP64_LOCATOR_SIG);
        u32(locatorView, 4, 0);
        u64(locatorView, 8, zip64EocdOffset);
        u32(locatorView, 16, 1);
        write(locator);
      }

      const eocd = new Uint8Array(22);
      const eocdView = new DataView(eocd.buffer);
      u32(eocdView, 0, EOCD_SIG);
      u16(eocdView, 4, 0);
      u16(eocdView, 6, 0);
      u16(eocdView, 8, countOverflow ? 0xffff : records.length);
      u16(eocdView, 10, countOverflow ? 0xffff : records.length);
      u32(eocdView, 12, centralSizeOverflow ? 0xffffffff : centralSize);
      u32(eocdView, 16, centralOffsetOverflow ? 0xffffffff : centralOffset);
      u16(eocdView, 20, 0);
      write(eocd);

      await chain;
      throwIfFailed();
      await writable.close();
    },

    async abort(): Promise<void> {
      if (aborted) {
        return;
      }
      aborted = true;
      current = undefined;
      // 中央目录永不写出;迟到的条目调用被上面的 no-op 守卫丢弃。
      await chain;
      await writable.abort().catch(() => undefined);
      if (onAbort != undefined) {
        await onAbort().catch(() => undefined);
      }
    },
  };
}

/**
 * `robot-export-<startLocal>-<endLocal>.zip`(SPEC §7.1):机器人时区 naive 起止
 * (钳制后的 end),形如 `robot-export-20260820-090000-20260820-100000.zip`。
 */
export function robotExportZipFileName(
  startKey: string,
  endKey: string,
): string {
  const seg = (key: string) => `${key.slice(0, 8)}-${key.slice(8)}`;
  return `robot-export-${seg(startKey)}-${seg(endKey)}.zip`;
}

/**
 * 解析 zip 名冲突:自动追加 ` (n)` 直到 `exists` 报告无冲突(SPEC §7.1,沿用原
 * 逻辑)。`exists` 注入以便测试。同一会话重试沿用同一 zip 名(决策 Z14)。
 */
export async function resolveZipNameConflict(
  baseName: string,
  exists: (name: string) => Promise<boolean>,
): Promise<string> {
  if (!(await exists(baseName))) {
    return baseName;
  }
  const stem = baseName.endsWith(".zip") ? baseName.slice(0, -".zip".length) : baseName;
  for (let index = 1; ; index++) {
    const candidate = `${stem} (${index}).zip`;
    if (!(await exists(candidate))) {
      return candidate;
    }
  }
}
