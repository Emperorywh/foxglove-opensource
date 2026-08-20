// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * 机器人导出包的 bag 筛选与时间换算纯函数(docs/SPEC_robot_export_package.md §5/§6)。
 *
 * 时间语义:bag 文件名时间是机器人本地墙钟(naive,无时区);用户输入同样按机器
 * 人本地时间解释。二者的比较全程在 naive 本地时间域内进行——先归一为同一串格式
 * (`YYYYMMDDHHmmss`)再按字符串比较,无需任何时区偏移。只有告警接口查询需要
 * Unix ms,届时才用 `tzOffsetMinutes` 折算。
 *
 * 本模块纯逻辑、不依赖 React,单测见 selectBagsForExport.test.ts。
 */

/**
 * bag 分片文件名:`YYYY-MM-DD-HH-mm-ss_seq.bag`(决策 #1:时间=该分片开始录制
 * 时刻,后缀=轮转序号)。大小写不敏感。
 */
const BAG_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})_(\d+)\.bag$/i;

/**
 * 解析 bag 分片文件名(SPEC §5)。逐字段范围校验(月 1–12、日 1–31、时 0–23、
 * 分/秒 0–59);任一不满足即返回 undefined(调用方按"未识别"跳过计数)。
 *
 * 返回的 naiveKey 是归一化比较键 `YYYYMMDDHHmmss`(见 normalizeNaiveTime)。
 */
export function parseBagFilename(name: string): { naiveKey: string; seq: number } | undefined {
  const match = BAG_NAME_RE.exec(name);
  if (match == undefined) {
    return undefined;
  }
  const [year, month, day, hour, minute, second, seqText] = match.slice(1) ;
  const monthNum = Number(month);
  const dayNum = Number(day);
  const hourNum = Number(hour);
  const minuteNum = Number(minute);
  const secondNum = Number(second);
  if (
    monthNum < 1 ||
    monthNum > 12 ||
    dayNum < 1 ||
    dayNum > 31 ||
    hourNum > 23 ||
    minuteNum > 59 ||
    secondNum > 59
  ) {
    return undefined;
  }
  return { naiveKey: `${year}${month}${day}${hour}${minute}${second}`, seq: Number(seqText) };
}

/**
 * 归一化 naive 本地时间为比较键 `YYYYMMDDHHmmss`(SPEC §5):文件名格式
 * `YYYY-MM-DD-HH-mm-ss` 与 `datetime-local` 输出 `YYYY-MM-DDTHH:mm:ss` 分隔符
 * 不同,统一为可字符串比较的同构串;空格分隔(`YYYY-MM-DD HH:mm:ss`)亦接受。
 * 秒段可省略(Chromium datetime-local 下拉面板/粘贴值常为分钟精度)——缺省按
 * `:00` 解析。字段范围非法返回 undefined。
 */
export function normalizeNaiveTime(input: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[-T ](\d{2})[-:](\d{2})(?:[-:](\d{2}))?$/.exec(
    input.trim(),
  );
  if (match == undefined) {
    return undefined;
  }
  const [year, month, day, hour, minute, second = "00"] = match.slice(1, 8) ;
  const validation = parseBagFilename(
    `${year}-${month}-${day}-${hour}-${minute}-${second}_0.bag`,
  );
  if (validation == undefined) {
    return undefined;
  }
  return `${year}${month}${day}${hour}${minute}${second}`;
}

/**
 * naive 本地时间 → Unix ms(SPEC §5):`startUnixMs = naive − tzOffset`。
 * naiveKey 按纯 UTC 字段构造(不涉及时区),再减去偏移得真实 Unix 时间。
 * `tzOffsetMinutes` 语义为本地时间超前 UTC 的分钟数(UTC+8 → +480)。
 */
export function naiveToUnixMs(naiveKey: string, tzOffsetMinutes: number): number {
  const year = Number(naiveKey.slice(0, 4));
  const month = Number(naiveKey.slice(4, 6));
  const day = Number(naiveKey.slice(6, 8));
  const hour = Number(naiveKey.slice(8, 10));
  const minute = Number(naiveKey.slice(10, 12));
  const second = Number(naiveKey.slice(12, 14));
  return (
    Date.UTC(year, month - 1, day, hour, minute, second) - tzOffsetMinutes * 60_000
  );
}

/**
 * Unix ms → naive 本地时间比较键(SPEC §5 的 `robotNowNaive = (unixMs + tzOffset)`
 * 折本地)。用 UTC getter 读回,全程不经过浏览器本地时区。
 */
export function unixMsToNaiveKey(unixMs: number, tzOffsetMinutes: number): string {
  const shifted = new Date(unixMs + tzOffsetMinutes * 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}` +
    `${pad(shifted.getUTCDate())}${pad(shifted.getUTCHours())}` +
    `${pad(shifted.getUTCMinutes())}${pad(shifted.getUTCSeconds())}`
  );
}

/**
 * 浏览器时区回退(SPEC §5/决策 #27):`serverTime` 失败时以浏览器时区假定。
 * `getTimezoneOffset()` 的符号与 `tzOffsetMinutes` 语义相反(UTC+8 返回 −480),
 * **必须取负**,否则告警窗口会偏 2×tz。
 */
export function browserTzOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/** 比较键 → 展示格式 `YYYY-MM-DD HH:mm:ss`(manifest 的 timeLocal 等)。 */
export function formatNaiveDisplay(naiveKey: string): string {
  return `${naiveKey.slice(0, 4)}-${naiveKey.slice(4, 6)}-${naiveKey.slice(6, 8)} ${naiveKey.slice(8, 10)}:${naiveKey.slice(10, 12)}:${naiveKey.slice(12, 14)}`;
}

/** 比较键 → zip 文件名片段 `YYYYMMDD-HHmmss`(SPEC §7.1)。 */
export function formatNaiveZipSegment(naiveKey: string): string {
  return `${naiveKey.slice(0, 8)}-${naiveKey.slice(8)}`;
}

/** bag 目录 list 条目的最小形状(与 ServerExportBridgeClient 的条目类型同构)。 */
export type BagDirEntry = {
  name: string;
  size: number;
  mtimeMs: number;
  kind: "bag" | "active" | "file" | "dir";
};

/** 通过筛选的 bag 候选(SPEC §6)。 */
export type BagCandidate = {
  name: string;
  size: number;
  mtimeMs: number;
  naiveKey: string;
  seq: number;
  role: "in-range" | "predecessor";
};

export type SelectBagsResult = {
  /** 下载顺序 = 排序后顺序(predecessor 在最前)。 */
  selected: BagCandidate[];
  skippedActive: number;
  skippedUnrecognized: number;
};

/**
 * bag 筛选算法(SPEC §6,纯函数):
 *
 * 1. `kind === "active"` 或 `.bag.active` 名 → 跳过计数(决策 #23:录制中分片不导出);
 * 2. 不能按 §5 正则解析的 `.bag` → 跳过计数(决策边界 #5);非 bag 文件/目录不参与;
 * 3. 其余按 `(naiveKey, seq)` 升序(seq 重复按名称兜底);
 * 4. `role = "in-range"`:`startNaive <= naiveTime <= endNaive`(闭区间);
 * 5. 前一个相邻分片(决策 #2):排序集合中 `naiveTime < startNaive` 的最大者,
 *    以 `role = "predecessor"` 追加到队首;in-range 为 0 时仍可选出 predecessor。
 */
export function selectBagsForExport(args: {
  entries: readonly BagDirEntry[];
  startNaive: string;
  endNaive: string;
}): SelectBagsResult {
  const { entries, startNaive, endNaive } = args;
  const startKey = normalizeNaiveTime(startNaive);
  const endKey = normalizeNaiveTime(endNaive);
  if (startKey == undefined || endKey == undefined || startKey > endKey) {
    throw new Error("invalid naive time range");
  }

  const skippedActive = entries.filter((entry) => entry.kind === "active").length;
  let skippedUnrecognized = 0;
  const parsed: BagCandidate[] = [];
  for (const entry of entries) {
    // 非 bag 条目(日志、目录等)不参与 bag 筛选,也不计入任何跳过计数。
    if (entry.kind === "active") {
      continue;
    }
    if (entry.kind !== "bag") {
      continue;
    }
    const parsedName = parseBagFilename(entry.name);
    if (parsedName == undefined) {
      skippedUnrecognized += 1;
      continue;
    }
    parsed.push({
      name: entry.name,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      naiveKey: parsedName.naiveKey,
      seq: parsedName.seq,
      role: "in-range",
    });
  }

  parsed.sort((a, b) =>
    a.naiveKey !== b.naiveKey
      ? a.naiveKey < b.naiveKey
        ? -1
        : 1
      : a.seq !== b.seq
        ? a.seq - b.seq
        : a.name < b.name
          ? -1
          : 1,
  );

  const inRange = parsed.filter(
    (candidate) => candidate.naiveKey >= startKey && candidate.naiveKey <= endKey,
  );
  // predecessor:排序集合中 naiveKey < startKey 的最大者(升序数组里的最后一个)。
  let predecessor: BagCandidate | undefined;
  for (const candidate of parsed) {
    if (candidate.naiveKey < startKey) {
      predecessor = candidate;
    }
  }

  const selected =
    predecessor != undefined
      ? [{ ...predecessor, role: "predecessor" as const }, ...inRange]
      : inRange;
  return { selected, skippedActive, skippedUnrecognized };
}
