// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { translateAlarmCodes, translateAlarmHints } from "./alarmDictionary";

// 期望值取自内置码表 alarms.json 的 zh_CN 描述
describe("translateAlarmCodes", () => {
  it("已知码翻译为中文描述", () => {
    expect(translateAlarmCodes(["14"])).toBe("导航激光避障触发");
    expect(translateAlarmCodes(["261"])).toBe("IMU频率低于设置阈值");
  });

  it("多码按输入顺序以分号加空格连接", () => {
    expect(translateAlarmCodes(["261", "262"])).toBe(
      "IMU频率低于设置阈值; 前导航激光频率低于设置阈值",
    );
  });

  it("码表缺失的码保留原始码,可与其余译文混排", () => {
    expect(translateAlarmCodes(["999999"])).toBe("999999");
    expect(translateAlarmCodes(["999999", "14"])).toBe("999999; 导航激光避障触发");
  });

  it("空数组返回空串", () => {
    expect(translateAlarmCodes([])).toBe("");
  });
});

// 期望值取自内置码表 alarms.json 的 zh_CN 处理意见(码 3/14 有意见,1000 无意见)
describe("translateAlarmHints", () => {
  it("已知码取 zh_CN 处理意见", () => {
    expect(translateAlarmHints(["3"])).toBe("操作人员将周围障碍物清除,并按下复位按钮");
  });

  it("多码以分号加空格连接", () => {
    expect(translateAlarmHints(["3", "14"])).toBe(
      "操作人员将周围障碍物清除,并按下复位按钮; 操作人员将周围障碍物清除",
    );
  });

  it("码表未提供处理意见的码不产生片段", () => {
    expect(translateAlarmHints(["3", "1000"])).toBe("操作人员将周围障碍物清除,并按下复位按钮");
    expect(translateAlarmHints(["1000"])).toBe("");
  });

  it("未知码不产生片段,可与有意见的码混排;空数组返回空串", () => {
    expect(translateAlarmHints(["999999", "14"])).toBe("操作人员将周围障碍物清除");
    expect(translateAlarmHints([])).toBe("");
  });
});
