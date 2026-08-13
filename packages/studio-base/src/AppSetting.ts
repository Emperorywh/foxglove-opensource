// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export enum AppSetting {
  // General
  COLOR_SCHEME = "colorScheme",
  TIMEZONE = "timezone",
  TIME_FORMAT = "time.format",
  MESSAGE_RATE = "messageRate",
  UPDATES_ENABLED = "updates.enabled",
  LANGUAGE = "language",

  // ROS
  ROS_PACKAGE_PATH = "ros.ros_package_path",

  // 告警服务(播放进度条告警泳道,空串 = 禁用);host 与"从服务器导出"(SSH) 的主机联动共用
  ROBOT_ALARM_HOST = "robotAlarm.host",
  ROBOT_ALARM_PORT = "robotAlarm.port",

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
