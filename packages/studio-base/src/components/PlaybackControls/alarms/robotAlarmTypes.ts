// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * 播放进度条告警泳道的数据类型定义(见 docs/SPEC_playback_alarm_lane.md §4/§5)。
 *
 * 告警数据来自机器人上的 HTTP 服务(POST /rbrainrobot/data/get_robot_status_list),
 * 返回约 1Hz 的周期状态采样;`alarm_message` 非空的采样表示该时刻存在激活告警。
 */

/** 告警服务单条状态采样记录。除 time(必需)与 alarm_message 外,其余字段原样透传用于展示 */
export type RobotStatusRecord = {
  /** 采样时刻,Unix 毫秒时间戳 */
  time: number;
  /** 分号分隔的告警码原始串,空串表示无告警(注意末尾可能有多余分号) */
  alarm_message?: string;
  /** 其余字段不做类型假设,原样透传 */
  [key: string]: unknown;
};

/** 告警服务接口的响应体结构 */
export type RobotStatusResponse = {
  status_code?: number;
  message?: string;
  data?: unknown;
};

/** 经过 mergeAlarmIntervals 解析后的采样:附带解析出的告警码数组与本地时间串 */
export type AlarmSample = RobotStatusRecord & {
  /** 由 alarm_message 解析出的告警码(§4.4:split(";") → trim → 滤空) */
  alarmCodes: string[];
  /** 由 time 派生的本地时间串,格式 YYYY-MM-DD HH:mm:ss(用于 tooltip 展示) */
  localTime: string;
};

/** 相邻告警采样合并后的连续告警区间 */
export type AlarmInterval = {
  /** 区间内首个告警采样的 time(ms) */
  startMs: number;
  /** 区间内最末告警采样的 time + 采样间隔,封顶 bag stopMs */
  endMs: number;
  /** 区间内的告警采样(按 time 升序) */
  samples: AlarmSample[];
};
