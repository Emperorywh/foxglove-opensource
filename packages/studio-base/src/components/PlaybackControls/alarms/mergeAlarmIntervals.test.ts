// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { formatLocalTime, mergeAlarmIntervals, parseAlarmCodes } from "./mergeAlarmIntervals";
import { RobotStatusRecord } from "./robotAlarmTypes";

// 构造 1Hz 周期采样记录的便捷函数
function alarmAt(timeMs: number, codes: string = "261"): RobotStatusRecord {
  return { time: timeMs, alarm_message: codes };
}
function clearAt(timeMs: number): RobotStatusRecord {
  return { time: timeMs, alarm_message: "" };
}

describe("parseAlarmCodes", () => {
  it("解析分号分隔的告警码并容忍末尾多余分号", () => {
    expect(parseAlarmCodes("261;262;")).toEqual(["261", "262"]);
  });

  it("逐段 trim 并滤空", () => {
    expect(parseAlarmCodes(" 261 ; 262 ")).toEqual(["261", "262"]);
  });

  it("空串 / 仅分号 / 缺失 / 非字符串均视为无告警", () => {
    expect(parseAlarmCodes("")).toEqual([]);
    expect(parseAlarmCodes(";;;")).toEqual([]);
    expect(parseAlarmCodes(" ; ")).toEqual([]);
    expect(parseAlarmCodes(undefined)).toEqual([]);
    expect(parseAlarmCodes(123)).toEqual([]);
  });
});

describe("formatLocalTime", () => {
  it("格式化为本地时间 YYYY-MM-DD HH:mm:ss", () => {
    // 用同一时刻的 Date 本地分量手工拼期望值,断言与时区无关
    const timeMs = 1786419879030;
    const date = new Date(timeMs);
    const pad = (value: number): string => String(value).padStart(2, "0");
    const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
      date.getDate(),
    )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    expect(formatLocalTime(timeMs)).toBe(expected);
    expect(formatLocalTime(timeMs)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("单位数的月日时分秒补零", () => {
    // 2026-01-02T03:04:05 本地时刻对应的时间戳
    const timeMs = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(formatLocalTime(timeMs)).toBe("2026-01-02 03:04:05");
  });
});

describe("mergeAlarmIntervals", () => {
  it("空输入返回空区间", () => {
    expect(mergeAlarmIntervals([], 0, 10000)).toEqual([]);
  });

  it("起止时间非有限值或 stopMs <= startMs 时返回空区间", () => {
    const records = [alarmAt(0)];
    expect(mergeAlarmIntervals(records, 10000, 10000)).toEqual([]);
    expect(mergeAlarmIntervals(records, 10000, 0)).toEqual([]);
    expect(mergeAlarmIntervals(records, NaN, 10000)).toEqual([]);
    expect(mergeAlarmIntervals(records, 0, Infinity)).toEqual([]);
  });

  it("全无告警采样返回空区间", () => {
    const records = [clearAt(0), clearAt(1000), { time: 2000 }];
    expect(mergeAlarmIntervals(records, 0, 10000)).toEqual([]);
  });

  it("单条告警采样生成一个区间(无相邻差时采样周期回退 1000ms)", () => {
    const [interval] = mergeAlarmIntervals([alarmAt(5000)], 0, 10000);
    expect(interval?.startMs).toBe(5000);
    expect(interval?.endMs).toBe(6000);
    expect(interval?.samples).toHaveLength(1);
    expect(interval?.samples[0]?.alarmCodes).toEqual(["261"]);
  });

  it("相邻告警采样合并为一个连续区间", () => {
    const intervals = mergeAlarmIntervals([alarmAt(0), alarmAt(1000), alarmAt(2000)], 0, 10000);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.startMs).toBe(0);
    // 末告警采样 2000 + 采样间隔 1000
    expect(intervals[0]?.endMs).toBe(3000);
    expect(intervals[0]?.samples).toHaveLength(3);
  });

  it("缺采样的偶发空洞在容差内仍然合并", () => {
    // 1Hz 采样,2000ms 处丢了一个点;相邻差 2000 <= max(2*1000, 2000)
    const intervals = mergeAlarmIntervals(
      [alarmAt(0), alarmAt(1000), alarmAt(3000), alarmAt(4000)],
      0,
      10000,
    );
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.endMs).toBe(5000);
  });

  it("缺采样间隔超过阈值时断开为两个区间", () => {
    const intervals = mergeAlarmIntervals(
      [alarmAt(0), alarmAt(1000), alarmAt(2000), alarmAt(10000), alarmAt(11000), alarmAt(12000)],
      0,
      20000,
    );
    expect(intervals).toHaveLength(2);
    expect(intervals[0]?.startMs).toBe(0);
    expect(intervals[0]?.endMs).toBe(3000);
    expect(intervals[1]?.startMs).toBe(10000);
    expect(intervals[1]?.endMs).toBe(13000);
  });

  it("告警 → 明确无告警 → 告警 必须断开为两个区间,不应用缺采样容差", () => {
    const intervals = mergeAlarmIntervals([alarmAt(0), clearAt(1000), alarmAt(2000)], 0, 10000);
    expect(intervals).toHaveLength(2);
    // 无告警采样在容差内,endMs 取该无告警记录的时刻
    expect(intervals[0]?.startMs).toBe(0);
    expect(intervals[0]?.endMs).toBe(1000);
    expect(intervals[1]?.startMs).toBe(2000);
    expect(intervals[1]?.endMs).toBe(3000);
  });

  it("无告警采样与末告警采样间隔超过阈值时按末告警采样 + intervalMs 收尾", () => {
    const intervals = mergeAlarmIntervals(
      [alarmAt(0), alarmAt(1000), alarmAt(2000), clearAt(10000)],
      0,
      20000,
    );
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.startMs).toBe(0);
    expect(intervals[0]?.endMs).toBe(3000);
  });

  it("乱序记录按 time 排序后处理", () => {
    const intervals = mergeAlarmIntervals(
      [alarmAt(2000, "262"), alarmAt(0), clearAt(1000)],
      0,
      10000,
    );
    expect(intervals).toHaveLength(2);
    expect(intervals[0]?.startMs).toBe(0);
    expect(intervals[1]?.samples[0]?.alarmCodes).toEqual(["262"]);
  });

  it("重复时间的记录保持原相对顺序,0 差值不参与采样周期估计", () => {
    const first = { time: 0, alarm_message: "261", id: "first" };
    const second = { time: 0, alarm_message: "262", id: "second" };
    const intervals = mergeAlarmIntervals([first, second, alarmAt(1000)], 0, 10000);
    expect(intervals).toHaveLength(1);
    // intervalMs 由正差值 1000 估计,而非被 0 差值拉低
    expect(intervals[0]?.endMs).toBe(2000);
    expect(intervals[0]?.samples.map((s) => s.id)).toEqual(["first", "second", undefined]);
  });

  it("丢弃 time 非数值 / NaN / 无穷值的记录,继续处理其余", () => {
    const records: RobotStatusRecord[] = [
      { time: NaN, alarm_message: "261" },
      { time: Infinity, alarm_message: "261" },
      { time: "123" as unknown as number, alarm_message: "261" },
      alarmAt(1000),
    ];
    const intervals = mergeAlarmIntervals(records, 0, 10000);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.startMs).toBe(1000);
  });

  it("丢弃查询范围外的记录", () => {
    const intervals = mergeAlarmIntervals(
      [alarmAt(-1000), clearAt(5000), alarmAt(999999)],
      0,
      10000,
    );
    expect(intervals).toEqual([]);
  });

  it("time 恰好等于 bag 起止边界的记录保留(闭区间)", () => {
    const intervals = mergeAlarmIntervals([alarmAt(1000), alarmAt(2000)], 1000, 2000);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.startMs).toBe(1000);
    expect(intervals[0]?.endMs).toBe(2000);
  });

  it("告警持续到 bag 末尾时末区间 endMs 封顶 stopMs", () => {
    const intervals = mergeAlarmIntervals([alarmAt(9000), alarmAt(9500)], 0, 10000);
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.endMs).toBe(10000);
  });

  it("裁剪后零长度的区间被丢弃", () => {
    // 唯一告警采样恰好在 stopMs 上:endMs 封顶后等于 startMs
    expect(mergeAlarmIntervals([alarmAt(10000)], 0, 10000)).toEqual([]);
  });

  it("不原地排序或修改输入记录", () => {
    const records: readonly RobotStatusRecord[] = Object.freeze([
      Object.freeze({ time: 2000, alarm_message: "262" }),
      Object.freeze({ time: 0, alarm_message: "261" }),
      Object.freeze({ time: 1000, alarm_message: "" }),
    ]);
    const intervals = mergeAlarmIntervals(records, 0, 10000);
    expect(intervals).toHaveLength(2);
    // 输入数组顺序与记录字段均未被修改
    expect(records.map((r) => r.time)).toEqual([2000, 0, 1000]);
    expect(records[0]).toEqual({ time: 2000, alarm_message: "262" });
  });

  it("区间 samples 附带解析后的告警码", () => {
    const intervals = mergeAlarmIntervals([{ time: 0, alarm_message: " 261 ; 262;" }], 0, 10000);
    expect(intervals[0]?.samples[0]?.alarmCodes).toEqual(["261", "262"]);
  });

  it("区间 samples 附带由 time 派生的本地时间串 localTime", () => {
    const intervals = mergeAlarmIntervals([alarmAt(5000)], 0, 10000);
    expect(intervals[0]?.samples[0]?.localTime).toBe(formatLocalTime(5000));
  });
});
