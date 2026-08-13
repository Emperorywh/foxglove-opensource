// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useCallback, useEffect, useState } from "react";

import { AppSetting } from "@foxglove/studio-base/AppSetting";
import {
  AppConfigurationValue,
  ChangeHandler,
  useAppConfiguration,
} from "@foxglove/studio-base/context/AppConfigurationContext";

/** 告警服务默认地址(仅当底层配置为 undefined 时使用;已持久化的空串不回退默认值) */
export const DEFAULT_ROBOT_ALARM_HOST = "10.11.2.208";
export const DEFAULT_ROBOT_ALARM_PORT = "50004";

/**
 * 校验端口号:非空时必须是 1–65535 的十进制整数(设置页校验与状态机 enabled 判定共用)。
 * 空串返回 false——空串 = 禁用功能(决策 #17),不是合法端口。
 */
export function isValidRobotAlarmPort(port: string): boolean {
  if (!/^\d+$/.test(port)) {
    return false;
  }
  const value = parseInt(port, 10);
  return value >= 1 && value <= 65535;
}

/**
 * 把底层配置值映射为字符串语义:
 * - undefined(从未设置)→ 默认值;
 * - 字符串 → 原样返回(空串必须保留,"清空即禁用"才跨重挂载/重启生效);
 * - 其他类型(持久化数据损坏)→ 字符串化,交由端口/host 校验拒绝。
 */
function rawToString(raw: AppConfigurationValue, defaultValue: string): string {
  if (raw == undefined) {
    return defaultValue;
  }
  if (typeof raw === "string") {
    return raw;
  }
  return String(raw);
}

/**
 * 读取单个配置 key 的原始字符串值(保留空串)。
 *
 * 不能直接复用 useAppConfigurationValue——它会把空字符串归一成 undefined,
 * 导致"清空即禁用"在重挂载/重启后失效(§6.5)。
 */
function useRawConfigurationString(
  key: string,
  defaultValue: string,
): [value: string, setter: (value: string) => Promise<void>] {
  const appConfiguration = useAppConfiguration();

  const [rawValue, setRawValue] = useState<AppConfigurationValue>(() => appConfiguration.get(key));

  // 订阅外部变更(其他组件/设置页修改同一 key 时同步)
  useEffect(() => {
    const handler: ChangeHandler = (newValue) => {
      setRawValue(newValue);
    };
    appConfiguration.addChangeListener(key, handler);
    return () => {
      appConfiguration.removeChangeListener(key, handler);
    };
  }, [appConfiguration, key]);

  const setter = useCallback(
    async (value: string) => {
      setRawValue(value);
      await appConfiguration.set(key, value);
    },
    [appConfiguration, key],
  );

  return [rawToString(rawValue, defaultValue), setter];
}

/**
 * 告警服务配置(SPEC §6.5/§10):host + port,AppConfiguration 持久化。
 * 任一字段为空串即禁用整个功能(不查询、不渲染、不 toast)。
 * 联动(2026-08-13):host 与"从服务器导出"(SSH) 连接表单的主机共用同一份配置,
 * 任一处提交后另一处跟随;port 为告警服务专用,不与 SSH 端口联动。
 */
export function useRobotAlarmConfiguration(): {
  host: string;
  port: string;
  setHost: (value: string) => Promise<void>;
  setPort: (value: string) => Promise<void>;
} {
  const [host, setHost] = useRawConfigurationString(
    AppSetting.ROBOT_ALARM_HOST,
    DEFAULT_ROBOT_ALARM_HOST,
  );
  const [port, setPort] = useRawConfigurationString(
    AppSetting.ROBOT_ALARM_PORT,
    DEFAULT_ROBOT_ALARM_PORT,
  );
  return { host, port, setHost, setPort };
}
