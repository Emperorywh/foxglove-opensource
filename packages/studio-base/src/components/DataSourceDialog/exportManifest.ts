// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * 机器人导出包 manifest.json 的构建与解析(docs/SPEC_robot_export_package.md §7.3)。
 *
 * manifest 是导出包的身份与元数据,最后写入(决策 #29):需记录告警终态与最终
 * 文件清单。导入侧(§11.3)对 manifest **严格校验**(决策 #22):format/
 * formatVersion 不受支持即拒绝导入;bags/ 内容宽容(缺失容忍)。
 *
 * 本模块纯逻辑、不依赖 React,worker 内可用(解析侧在 MergedBagIterableSource 中
 * 调用)。
 */

/** 导出包格式标识与当前版本(§7.3)。 */
export const EXPORT_PACKAGE_FORMAT = "robot-export-package";
export const EXPORT_PACKAGE_FORMAT_VERSION = 1;

export type ExportManifestRange = {
  /** 机器人时区 naive,空格分隔单行格式(已按 §5 钳制)。 */
  startLocal: string;
  endLocal: string;
  /** 本地时间超前 UTC 的分钟数(UTC+8 → +480)。 */
  tzOffsetMinutes: number;
  tzSource: "server" | "browser-assumed";
  startUnixMs: number;
  endUnixMs: number;
};

export type ExportManifestBag = {
  name: string;
  size: number;
  timeLocal: string;
  seq: number;
  role: "in-range" | "predecessor";
};

export type ExportManifestAlarms = {
  status: "ok" | "empty" | "failed";
  /** 键名对齐告警接口请求体 start_time/stop_time;数值 = 钳制后的 range.endUnixMs。 */
  query: { startUnixMs: number; stopUnixMs: number };
  /** 仅 failed 时存在,其余状态省略该字段。 */
  error?: string;
};

export type RobotExportManifest = {
  format: typeof EXPORT_PACKAGE_FORMAT;
  formatVersion: number;
  createdAtUnixMs: number;
  generator: { app: string; version: string };
  source: { host: string; bagPath: string; logPath: string };
  range: ExportManifestRange;
  bags: ExportManifestBag[];
  logs: { included: boolean; count: number; bytes: number };
  alarms: ExportManifestAlarms;
};

/** 构建 manifest(§7.3)。字段语义与示例严格一致;序列化用 2 空格缩进便于排查。 */
export function buildExportManifest(args: {
  generatorVersion: string;
  source: { host: string; bagPath: string; logPath: string };
  range: ExportManifestRange;
  bags: ExportManifestBag[];
  logs: { included: boolean; count: number; bytes: number };
  alarms: ExportManifestAlarms;
  nowMs?: number;
}): RobotExportManifest {
  return {
    format: EXPORT_PACKAGE_FORMAT,
    formatVersion: EXPORT_PACKAGE_FORMAT_VERSION,
    createdAtUnixMs: args.nowMs ?? Date.now(),
    generator: { app: "foxglove-studio", version: args.generatorVersion },
    source: args.source,
    range: args.range,
    bags: args.bags,
    logs: args.logs,
    alarms: args.alarms,
  };
}

export function serializeExportManifest(manifest: RobotExportManifest): string {
  // JSON.stringify 在本仓库 lib 定义下可返回 undefined;manifest 恒为对象,?? "" 仅收窄类型。
  return JSON.stringify(manifest, undefined, 2) ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != undefined;
}

/**
 * 严格解析 manifest(决策 #22,SPEC §11.3):必须存在且 format/formatVersion 受支
 * 持,否则抛带用户可读文案的 Error(调用方原样呈现给用户)。其余字段宽松——
 * bags/logs/alarms 缺失由各自的消费方宽容处理。
 */
export function parseExportManifest(text: string): RobotExportManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("manifest.json is not valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("manifest.json is not an object");
  }
  if (parsed.format !== EXPORT_PACKAGE_FORMAT) {
    throw new Error("not a robot export package");
  }
  if (typeof parsed.formatVersion !== "number") {
    throw new Error("manifest.json is missing formatVersion");
  }
  if (parsed.formatVersion > EXPORT_PACKAGE_FORMAT_VERSION) {
    throw new Error(
      `export package format version ${String(parsed.formatVersion)} is newer than this app supports (${String(EXPORT_PACKAGE_FORMAT_VERSION)}); please upgrade the app`,
    );
  }
  if (parsed.formatVersion < EXPORT_PACKAGE_FORMAT_VERSION) {
    throw new Error(
      `export package format version ${String(parsed.formatVersion)} is no longer supported`,
    );
  }
  // 结构已知合法;bags 等细节字段由消费方宽容读取,这里只透传解析结果。
  return parsed as RobotExportManifest;
}
