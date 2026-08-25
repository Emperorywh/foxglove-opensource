// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export enum AppSetting {
  // General
  COLOR_SCHEME = "colorScheme",
  TIMEZONE = "timezone",
  TIME_FORMAT = "time.format",
  MESSAGE_RATE = "messageRate",
  LANGUAGE = "language",

  // ROS
  ROS_PACKAGE_PATH = "ros.ros_package_path",

  // 告警服务(播放进度条告警泳道,空串 = 禁用);host 与"从服务器导出"(SSH) 的主机联动共用
  ROBOT_ALARM_HOST = "robotAlarm.host",
  ROBOT_ALARM_PORT = "robotAlarm.port",

  // 机器人数据导出包(SPEC_robot_export_package.md §9.1):连接成功时写回(决策 #10);
  // 账号/密码不持久化(改为授权分组,凭据在组件内固定映射);host 无默认值、输入即
  // 缓存;包含日志不持久化——每次默认勾选;port 与告警服务的 host/port 联动(§3)
  ROBOT_EXPORT_SSH_PORT = "robotExport.sshPort",
  ROBOT_EXPORT_AUTH_GROUP = "robotExport.authGroup",
  ROBOT_EXPORT_HOST = "robotExport.host",
  ROBOT_EXPORT_BAG_PATH = "robotExport.bagPath",
  ROBOT_EXPORT_LOG_PATH = "robotExport.logPath",

  // Experimental features
  SHOW_DEBUG_PANELS = "showDebugPanels",

  // Miscellaneous
  HIDE_SIGN_IN_PROMPT = "hideSignInPrompt",
  LAUNCH_PREFERENCE = "launchPreference",
  SHOW_OPEN_DIALOG_ON_STARTUP = "ui.open-dialog-startup",
  ENABLE_UNIFIED_NAVIGATION = "ui.new-app-menu",

  // Dev only
  ENABLE_LAYOUT_DEBUGGING = "enableLayoutDebugging",
}
