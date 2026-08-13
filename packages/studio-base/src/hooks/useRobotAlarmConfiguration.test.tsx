/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { act, renderHook } from "@testing-library/react";
import { PropsWithChildren } from "react";

import { AppSetting } from "@foxglove/studio-base/AppSetting";
import AppConfigurationContext, {
  AppConfigurationValue,
  ChangeHandler,
  IAppConfiguration,
} from "@foxglove/studio-base/context/AppConfigurationContext";
import {
  DEFAULT_ROBOT_ALARM_HOST,
  DEFAULT_ROBOT_ALARM_PORT,
  isValidRobotAlarmPort,
  useRobotAlarmConfiguration,
} from "@foxglove/studio-base/hooks/useRobotAlarmConfiguration";

/** 真实存储值的假配置实现(区别于只返回 key 的 FakeProvider) */
class FakeAppConfiguration implements IAppConfiguration {
  #values = new Map<string, AppConfigurationValue>();
  #listeners = new Map<string, Set<ChangeHandler>>();

  public get(key: string): AppConfigurationValue {
    return this.#values.get(key);
  }
  public async set(key: string, value: AppConfigurationValue): Promise<void> {
    if (value == undefined) {
      this.#values.delete(key);
    } else {
      this.#values.set(key, value);
    }
    [...(this.#listeners.get(key) ?? [])].forEach((listener) => {
      listener(value);
    });
  }
  public addChangeListener(key: string, cb: ChangeHandler): void {
    let listeners = this.#listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(key, listeners);
    }
    listeners.add(cb);
  }
  public removeChangeListener(key: string, cb: ChangeHandler): void {
    this.#listeners.get(key)?.delete(cb);
  }
}

function makeWrapper(config: IAppConfiguration) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <AppConfigurationContext.Provider value={config}>{children}</AppConfigurationContext.Provider>
    );
  };
}

describe("isValidRobotAlarmPort", () => {
  it("校验 1–65535 的十进制整数", () => {
    expect(isValidRobotAlarmPort("50004")).toBe(true);
    expect(isValidRobotAlarmPort("1")).toBe(true);
    expect(isValidRobotAlarmPort("65535")).toBe(true);
    expect(isValidRobotAlarmPort("")).toBe(false);
    expect(isValidRobotAlarmPort("0")).toBe(false);
    expect(isValidRobotAlarmPort("65536")).toBe(false);
    expect(isValidRobotAlarmPort("abc")).toBe(false);
    expect(isValidRobotAlarmPort("50.5")).toBe(false);
    expect(isValidRobotAlarmPort(" 50004")).toBe(false);
  });
});

describe("useRobotAlarmConfiguration", () => {
  it("底层为 undefined 时使用默认值", () => {
    const config = new FakeAppConfiguration();
    const { result } = renderHook(() => useRobotAlarmConfiguration(), {
      wrapper: makeWrapper(config),
    });
    expect(result.current.host).toBe(DEFAULT_ROBOT_ALARM_HOST);
    expect(result.current.port).toBe(DEFAULT_ROBOT_ALARM_PORT);
  });

  it("保存合法值后返回新值并写入底层配置", async () => {
    const config = new FakeAppConfiguration();
    const { result } = renderHook(() => useRobotAlarmConfiguration(), {
      wrapper: makeWrapper(config),
    });
    await act(async () => {
      await result.current.setHost("192.168.1.100");
      await result.current.setPort("12345");
    });
    expect(result.current.host).toBe("192.168.1.100");
    expect(result.current.port).toBe("12345");
    expect(config.get(AppSetting.ROBOT_ALARM_HOST)).toBe("192.168.1.100");
    expect(config.get(AppSetting.ROBOT_ALARM_PORT)).toBe("12345");
  });

  it("保存空串后跨重挂载仍返回空串(清空即禁用,不回退默认值)", async () => {
    const config = new FakeAppConfiguration();
    const wrapper = makeWrapper(config);

    const first = renderHook(() => useRobotAlarmConfiguration(), { wrapper });
    await act(async () => {
      await first.result.current.setHost("");
      await first.result.current.setPort("");
    });
    expect(first.result.current.host).toBe("");
    first.unmount();

    // 重新挂载(模拟组件重挂载/应用重启后从持久化读取)
    const second = renderHook(() => useRobotAlarmConfiguration(), { wrapper });
    expect(second.result.current.host).toBe("");
    expect(second.result.current.port).toBe("");
  });

  it("外部 change listener 更新会同步到 hook 返回值", async () => {
    const config = new FakeAppConfiguration();
    const { result } = renderHook(() => useRobotAlarmConfiguration(), {
      wrapper: makeWrapper(config),
    });
    await act(async () => {
      await config.set(AppSetting.ROBOT_ALARM_HOST, "10.0.0.2");
    });
    expect(result.current.host).toBe("10.0.0.2");
  });
});
