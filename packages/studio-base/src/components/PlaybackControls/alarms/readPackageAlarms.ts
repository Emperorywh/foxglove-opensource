// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * 从机器人导出包读取 alarms.json(docs/SPEC_robot_export_package.md §12.1)。
 *
 * 两形态:
 * - file(Web 闭环/文件选择/拖拽):zip File 经 BlobRandomAccessReader 读取;
 * - remote(桌面闭环,File 不可得):selectedParams.url 经 CachedFilelike 包装
 *   (openUrlReader)读取。
 *
 * alarms.json 缺失(导出时告警失败,决策 #12)返回 `{ status: "missing" }`——
 * 调用方按成功空数据处理并给出一次 info 提示;存在则返回原始文本,校验交给
 * parseRobotStatusBody。
 */

import {
  BlobRandomAccessReader,
  openUrlReader,
  openZipArchive,
} from "@foxglove/studio-base/players/IterablePlayer/zipArchiveReader";

export type PackageAlarmsResult =
  | { status: "ok"; rawText: string }
  | { status: "missing" };

export async function readPackageAlarms(input: {
  file?: File;
  url?: string;
}): Promise<PackageAlarmsResult> {
  if (input.file == undefined && input.url == undefined) {
    throw new Error("file or url required");
  }
  const reader =
    input.url != undefined
      ? await openUrlReader(input.url)
      : new BlobRandomAccessReader(input.file!);
  const archive = await openZipArchive(reader);
  const entry = archive.entries.find((candidate) => candidate.name === "alarms.json");
  if (entry == undefined) {
    return { status: "missing" };
  }
  return { status: "ok", rawText: await archive.readEntryText(entry) };
}
