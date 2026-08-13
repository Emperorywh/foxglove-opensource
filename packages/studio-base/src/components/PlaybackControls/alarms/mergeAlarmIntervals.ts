// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { AlarmInterval, AlarmSample, RobotStatusRecord } from "./robotAlarmTypes";

/**
 * 解析 alarm_message 原始串为告警码数组(§4.4)。
 * `"261;262;"` → `["261", "262"]`;空串 / 非字符串 / 仅含分号空格 → `[]`(无告警)。
 */
export function parseAlarmCodes(alarmMessage: unknown): string[] {
  if (typeof alarmMessage !== "string") {
    return [];
  }
  return alarmMessage
    .split(";")
    .map((code) => code.trim())
    .filter((code) => code.length > 0);
}

/**
 * 将 Unix 毫秒时间戳格式化为本地时间串 `YYYY-MM-DD HH:mm:ss`(年月日时分秒)。
 * 调用方需保证 timeMs 为有限数值(mergeAlarmIntervals 已在范围过滤时排除非法 time)。
 */
export function formatLocalTime(timeMs: number): string {
  const date = new Date(timeMs);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${ymd} ${hms}`;
}

/**
 * 取数组中位数;偶数长度取中间两值平均。空数组返回 undefined。
 */
function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid];
  }
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (lower == undefined || upper == undefined) {
    return undefined;
  }
  return (lower + upper) / 2;
}

/**
 * 告警区间合并纯函数(SPEC §5):输入接口采样记录与 bag 起止 ms,输出合并后的告警区间。
 *
 * 语义要点:
 * - 明确的空 alarm_message 永远表示告警已恢复,立即断开区间;
 *   容差(gapThresholdMs)只用于"没有采样"的偶发空洞。
 * - 采样周期 intervalMs 取相邻正时间差的中位数(0 差值不参与),无正差时回退 1000ms。
 * - 输入数组不被原地排序/修改;非数值 time、越界记录被丢弃。
 */
export function mergeAlarmIntervals(
  records: readonly RobotStatusRecord[],
  bagStartMs: number,
  bagStopMs: number,
): AlarmInterval[] {
  // §4.4:起止时间非有限值或 stopMs <= startMs 时直接返回空区间(调用方也不应发起请求)
  if (!Number.isFinite(bagStartMs) || !Number.isFinite(bagStopMs) || bagStopMs <= bagStartMs) {
    return [];
  }

  // 步骤 1:解析、范围过滤([startMs, stopMs] 闭区间),并按 time 稳定升序排序全部有效采样。
  // 注意不能在合并前丢弃无告警采样——它们是"告警已恢复"的明确信号。复制数组排序,不改动输入。
  const validSamples = [...records]
    .filter(
      (record) =>
        typeof record.time === "number" &&
        Number.isFinite(record.time) &&
        record.time >= bagStartMs &&
        record.time <= bagStopMs,
    )
    .sort((a, b) => a.time - b.time);

  if (validSamples.length === 0) {
    return [];
  }

  // 步骤 2:由相邻采样的正时间差中位数估计采样周期;重复时间产生的 0 差值不参与估计
  const diffs: number[] = [];
  for (let i = 1; i < validSamples.length; i++) {
    const diff = validSamples[i]!.time - validSamples[i - 1]!.time;
    if (diff > 0) {
      diffs.push(diff);
    }
  }
  const intervalMs = median(diffs) ?? 1000;

  // 步骤 3:缺采样容差 = max(2 × 采样周期, 2000ms)
  const gapThresholdMs = Math.max(2 * intervalMs, 2000);

  // 步骤 4/5:顺序扫描,维护"活动区间";扫描结束仍未关闭的区间按末告警采样 + intervalMs 收尾
  const intervals: AlarmInterval[] = [];
  let active: AlarmInterval | undefined;
  let prevTime: number | undefined;

  const closeActive = (endMs: number): void => {
    if (active) {
      intervals.push({ startMs: active.startMs, endMs, samples: active.samples });
      active = undefined;
    }
  };

  for (const record of validSamples) {
    const alarmCodes = parseAlarmCodes(record.alarm_message);
    if (alarmCodes.length > 0) {
      const sample: AlarmSample = { ...record, alarmCodes, localTime: formatLocalTime(record.time) };
      if (!active) {
        // 无活动区间:以当前告警采样开启新区间
        active = { startMs: record.time, endMs: record.time, samples: [sample] };
      } else if (prevTime != undefined && record.time - prevTime <= gapThresholdMs) {
        // 与上一条有效记录间隔在容差内:追加到活动区间
        active.samples.push(sample);
      } else {
        // 间隔超过容差(中间丢采样):关闭旧区间并开启新区间
        const lastAlarm = active.samples.at(-1);
        closeActive((lastAlarm?.time ?? record.time) + intervalMs);
        active = { startMs: record.time, endMs: record.time, samples: [sample] };
      }
    } else if (active) {
      // 明确无告警采样:立即关闭活动区间。与末告警采样间隔在容差内时,
      // endMs 取该无告警记录的时刻;否则说明中间存在大空洞,按末告警采样 + intervalMs 收尾。
      const lastAlarm = active.samples.at(-1);
      const lastAlarmTime = lastAlarm?.time ?? record.time;
      const endMs =
        record.time - lastAlarmTime <= gapThresholdMs ? record.time : lastAlarmTime + intervalMs;
      closeActive(endMs);
    }
    prevTime = record.time;
  }

  if (active) {
    const lastAlarm = active.samples.at(-1);
    closeActive((lastAlarm?.time ?? bagStartMs) + intervalMs);
  }

  // 步骤 6:双端裁剪到 bag 范围,丢弃裁剪后零/负长度的区间
  return intervals
    .map((interval) => ({
      ...interval,
      startMs: Math.max(interval.startMs, bagStartMs),
      endMs: Math.min(interval.endMs, bagStopMs),
    }))
    .filter((interval) => interval.endMs > interval.startMs);
}
