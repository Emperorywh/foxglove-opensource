// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { TypeOptions } from "i18next";

export const appSettings: Partial<TypeOptions["resources"]["appSettings"]> = {
  about: "关于",
  advanced: undefined,
  askEachTime: "每次询问",
  colorScheme: "配色方案",
  dark: "暗色",
  debugModeDescription: undefined,
  desktopApp: "桌面应用",
  displayTimestampsIn: "显示时间戳在",
  experimentalFeatures: "实验性功能",
  experimentalFeaturesDescription: "这些功能不稳定，不建议日常使用。",
  extensions: "扩展",
  followSystem: "跟随系统",
  general: "通用",
  language: "语言",
  layoutDebugging: "布局调试",
  layoutDebuggingDescription: "显示用于开发和调试布局存储的额外控件。",
  light: "亮色",
  messageRate: "消息速率",
  noExperimentalFeatures: "目前没有实验性的功能。",
  openLinksIn: "打开链接",
  robotAlarmHost: "主机",
  robotAlarmPort: "端口",
  robotAlarmPortInvalid: "端口必须是 1 到 65535 之间的整数",
  robotAlarmServer: "告警服务",
  robotAlarmServerDescription:
    "播放本地 ROS 1 bag 文件时,在播放进度条下方显示告警泳道。主机与「从服务器导出」(SSH) 连接联动共用,端口为告警服务专用。清空主机或端口即可禁用此功能。",
  ros: "ROS",
  settings: "设置",
  timestampFormat: "时间戳格式",
  webApp: "网页应用",
};
