// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * 内置告警码字典(SPEC_playback_alarm_lane.md 决策 #3 修订,2026-08-20):
 * 构建期打包的同目录 alarms.json 提供告警码 → 多语言描述/处理意见的映射,
 * 用于把采样记录的 alarm_message 派生为中文 alarm_text 与 alarm_hint。
 *
 * 注意区分同名异物:导出包包内的 alarms.json 条目(SPEC_robot_export_package.md §12.1)
 * 是机器人状态采样的原始响应;本模块引用的是仓库内静态码表数据源。
 */

import alarmCodeTableJson from "./alarms.json";

/** 单条多语言记录;desc 为告警描述,hint 为处理意见 */
type AlarmCodeRecord = { locale?: string; desc?: string; hint?: string };
/** 单个告警码的码表条目;数组元素允许 undefined 以支撑对畸形数据的防御性读取 */
type AlarmCodeEntry = { alarmCode?: string; alarmCodeRecords?: (AlarmCodeRecord | undefined)[] };
/** 码表接口响应的最小结构(其余字段不关心) */
type AlarmCodeTableResponse = { data?: { records?: (AlarmCodeEntry | undefined)[] } };

const alarmCodeTable = alarmCodeTableJson as AlarmCodeTableResponse;

/** 选定 locale 记录后取出的描述与处理意见;hint 可为空串(码表未提供处理意见) */
type AlarmCodeTexts = { desc: string; hint: string };

/**
 * 告警码 → 描述与处理意见。locale 记录整体选定:zh_CN 优先、缺失回退 en_US,
 * 描述与处理意见取自同一条记录以保证语言一致;desc 缺失的条目不收录。
 */
const textsByCode = new Map<string, AlarmCodeTexts>();
for (const entry of alarmCodeTable.data?.records ?? []) {
  if (entry == undefined || typeof entry.alarmCode !== "string") {
    continue;
  }
  const records = entry.alarmCodeRecords ?? [];
  const localized =
    records.find((record) => record?.locale === "zh_CN") ??
    records.find((record) => record?.locale === "en_US");
  if (localized?.desc == undefined) {
    continue;
  }
  textsByCode.set(entry.alarmCode, { desc: localized.desc, hint: localized.hint ?? "" });
}

/**
 * 把解析后的告警码数组翻译为中文描述串:已知码取码表描述,未知码保留原始码
 * (用户可对照原始码自行排查),分号 + 空格连接。空数组返回空串。
 * `["261", "262"]` → `"IMU频率低于设置阈值; 前导航激光频率低于设置阈值"`。
 */
export function translateAlarmCodes(codes: readonly string[]): string {
  return codes.map((code) => textsByCode.get(code)?.desc ?? code).join("; ");
}

/**
 * 把解析后的告警码数组翻译为处理意见串:取各码码表 hint,分号 + 空格连接。
 * 无处理意见的码(码表 hint 为空或码未收录)不产生片段——处理意见对未知码
 * 无意义,原始码已由 alarm_text 保留对照;全部无意见时返回空串。
 * `["3", "261"]` → `"操作人员将周围障碍物清除,并按下复位按钮"`。
 */
export function translateAlarmHints(codes: readonly string[]): string {
  return codes
    .map((code) => textsByCode.get(code)?.hint ?? "")
    .filter((hint) => hint !== "")
    .join("; ");
}
