/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { act, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react";
import { PropsWithChildren, ReactNode } from "react";

import { Time } from "@foxglove/rostime";
import { AppSetting } from "@foxglove/studio-base/AppSetting";
import MockMessagePipelineProvider from "@foxglove/studio-base/components/MessagePipeline/MockMessagePipelineProvider";
import { useRobotAlarms } from "@foxglove/studio-base/components/PlaybackControls/alarms/useRobotAlarms";
import AppConfigurationContext, {
  AppConfigurationValue,
  ChangeHandler,
  IAppConfiguration,
} from "@foxglove/studio-base/context/AppConfigurationContext";
import PlayerSelectionContext, {
  IDataSourceFactory,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import { PlayerPresence } from "@foxglove/studio-base/players/types";

// mock notistack 的 useSnackbar 以断言 toast 行为
jest.mock("notistack", () => {
  const actual = jest.requireActual("notistack");
  return {
    ...actual,
    useSnackbar: () => ({ enqueueSnackbar: mockEnqueueSnackbar }),
  };
});
const mockEnqueueSnackbar = jest.fn();

const ROS1_BAG_SOURCE: IDataSourceFactory = {
  id: "ros1-local-bagfile",
  type: "file",
  displayName: "ROS 1 Bag",
  initialize: () => undefined,
};
const MCAP_SOURCE: IDataSourceFactory = {
  id: "mcap-local-file",
  type: "file",
  displayName: "MCAP",
  initialize: () => undefined,
};
const ROSBRIDGE_SOURCE: IDataSourceFactory = {
  id: "rosbridge-websocket",
  type: "connection",
  displayName: "Rosbridge",
  initialize: () => undefined,
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

type MockRequest = {
  url: string;
  body: unknown;
  aborted: boolean;
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
};

/** 安装手动控制的 fetch mock:不自动 resolve,abort 只记录不拒绝(用于迟到响应测试) */
function installManualFetch(requests: MockRequest[]): jest.Mock {
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    return await new Promise<Response>((resolve, reject) => {
      const request: MockRequest = {
        url,
        body: init?.body != undefined ? JSON.parse(init.body as string) : undefined,
        aborted: false,
        resolve,
        reject,
      };
      init?.signal?.addEventListener("abort", () => {
        request.aborted = true;
      });
      requests.push(request);
    });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** 真实存储值的假配置实现 */
class FakeAppConfiguration implements IAppConfiguration {
  #values = new Map<string, AppConfigurationValue>();
  #listeners = new Map<string, Set<ChangeHandler>>();

  public seed(key: string, value: AppConfigurationValue): void {
    this.#values.set(key, value);
  }
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

type Harness = {
  presence: PlayerPresence;
  playerId: string;
  startTime?: Time;
  endTime?: Time;
  noActiveData?: boolean;
  source?: IDataSourceFactory;
};

function setup(harnessOverrides?: Partial<Harness>, seed?: Record<string, string>) {
  const config = new FakeAppConfiguration();
  for (const [key, value] of Object.entries(seed ?? {})) {
    config.seed(key, value);
  }

  // 默认:合格的 ROS1 本地 bag 数据源、PRESENT、100s–200s 的起止时间
  const harness: Harness = {
    presence: PlayerPresence.PRESENT,
    playerId: "player-1",
    startTime: { sec: 100, nsec: 0 },
    endTime: { sec: 200, nsec: 0 },
    source: ROS1_BAG_SOURCE,
    ...harnessOverrides,
  };

  const requests: MockRequest[] = [];
  const fetchMock = installManualFetch(requests);

  function Wrapper({ children }: PropsWithChildren) {
    return (
      <AppConfigurationContext.Provider value={config}>
        <PlayerSelectionContext.Provider
          value={{
            selectSource: () => {},
            selectRecent: () => {},
            availableSources: [],
            recentSources: [],
            selectedSource: harness.source,
          }}
        >
          <MockMessagePipelineProvider
            presence={harness.presence}
            playerId={harness.playerId}
            startTime={harness.startTime}
            endTime={harness.endTime}
            noActiveData={harness.noActiveData}
          >
            {children}
          </MockMessagePipelineProvider>
        </PlayerSelectionContext.Provider>
      </AppConfigurationContext.Provider>
    );
  }

  const view = renderHook(() => useRobotAlarms(), { wrapper: Wrapper });
  return { ...view, config, harness, requests, fetchMock };
}

const ALARM_RECORDS = [
  { time: 110000, alarm_message: "261;262;" },
  { time: 111000, alarm_message: "261" },
  { time: 112000, alarm_message: "" },
];

describe("useRobotAlarms", () => {
  beforeEach(() => {
    mockEnqueueSnackbar.mockClear();
  });

  afterEach(() => {
    global.fetch = async () => {
      throw new Error("not available");
    };
  });

  it("合格数据源(ros1-local-bagfile)首次进入 PRESENT 后按配置地址查询一次", async () => {
    const { requests, fetchMock, result, rerender } = setup();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(requests[0]?.url).toBe(
      "http://10.11.2.208:50004/rbrainrobot/data/get_robot_status_list",
    );
    expect(requests[0]?.body).toEqual({ data: { start_time: 100000, stop_time: 200000 } });

    requests[0]?.resolve(jsonResponse({ status_code: 200, data: ALARM_RECORDS }));
    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(result.current.intervals).toHaveLength(1);
    expect(result.current.intervals[0]?.startMs).toBe(110000);
    expect(result.current.intervals[0]?.endMs).toBe(112000);
    expect(result.current.intervals[0]?.samples).toHaveLength(2);

    // 同样的输入重复渲染不会重查
    rerender();
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("首次到达 PRESENT 前(INITIALIZING)只等待不查询", async () => {
    const { harness, fetchMock, rerender } = setup({ presence: PlayerPresence.INITIALIZING });
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();

    harness.presence = PlayerPresence.PRESENT;
    rerender();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("非 ros1-local-bagfile 的文件 / 连接数据源不查询、不提示", async () => {
    for (const source of [MCAP_SOURCE, ROSBRIDGE_SOURCE]) {
      const { fetchMock, result, unmount } = setup({ source });
      await act(async () => {});
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.status).toBe("idle");
      unmount();
    }
    expect(mockEnqueueSnackbar).not.toHaveBeenCalled();
  });

  it("起止时间缺失或 stopMs <= startMs 时不查询", async () => {
    const noActiveData = setup({ noActiveData: true });
    await act(async () => {});
    expect(noActiveData.fetchMock).not.toHaveBeenCalled();
    noActiveData.unmount();

    const zeroLength = setup({
      startTime: { sec: 100, nsec: 0 },
      endTime: { sec: 100, nsec: 0 },
    });
    await act(async () => {});
    expect(zeroLength.fetchMock).not.toHaveBeenCalled();
  });

  it("host 或 port 为空(禁用)时不查询、不 toast", async () => {
    const noHost = setup(undefined, { [AppSetting.ROBOT_ALARM_HOST]: "" });
    await act(async () => {});
    expect(noHost.fetchMock).not.toHaveBeenCalled();
    expect(noHost.result.current.status).toBe("idle");
    noHost.unmount();

    const noPort = setup(undefined, { [AppSetting.ROBOT_ALARM_PORT]: "" });
    await act(async () => {});
    expect(noPort.fetchMock).not.toHaveBeenCalled();
    expect(noPort.result.current.status).toBe("idle");

    expect(mockEnqueueSnackbar).not.toHaveBeenCalled();
  });

  it("查询进行中同 key 短暂 BUFFERING 不 abort、不重查;成功后 BUFFERING 保持结果", async () => {
    const { harness, requests, fetchMock, result, rerender } = setup();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // loading 中进入 BUFFERING:不 abort 在途请求
    harness.presence = PlayerPresence.BUFFERING;
    rerender();
    expect(requests[0]?.aborted).toBe(false);
    expect(result.current.status).toBe("loading");

    // 恢复 PRESENT 后不重查,在途请求正常完成
    harness.presence = PlayerPresence.PRESENT;
    rerender();
    requests[0]?.resolve(jsonResponse({ status_code: 200, data: ALARM_RECORDS }));
    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 成功后短暂 BUFFERING:保持泳道结果
    harness.presence = PlayerPresence.BUFFERING;
    rerender();
    expect(result.current.status).toBe("success");
    expect(result.current.intervals).toHaveLength(1);

    harness.presence = PlayerPresence.PRESENT;
    rerender();
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("切换 player(queryKey 变化)abort 在途请求并按新 key 重查", async () => {
    const { harness, requests, fetchMock, result, rerender } = setup();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    harness.playerId = "player-2";
    rerender();

    // 旧请求被 abort;新 key 发起新查询,旧结果不再展示
    expect(requests[0]?.aborted).toBe(true);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(result.current.status).toBe("loading");

    requests[1]?.resolve(jsonResponse({ status_code: 200, data: [] }));
    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(result.current.intervals).toHaveLength(0);
  });

  it("旧请求的迟到响应不得写入新 player 的结果", async () => {
    const { harness, requests, fetchMock, result, rerender } = setup();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    harness.playerId = "player-2";
    rerender();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // 旧请求在 abort 竞态中迟到返回带告警的数据:不得 setState、不得 toast
    await act(async () => {
      requests[0]?.resolve(jsonResponse({ status_code: 200, data: ALARM_RECORDS }));
    });
    expect(result.current.status).toBe("loading");
    expect(result.current.intervals).toHaveLength(0);
    expect(mockEnqueueSnackbar).not.toHaveBeenCalled();

    // 新 player 的响应正常生效
    await act(async () => {
      requests[1]?.resolve(jsonResponse({ status_code: 200, data: ALARM_RECORDS }));
    });
    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(result.current.intervals).toHaveLength(1);
  });

  it("查询成功但无告警(data null / 空数组 / 全部无告警)时弹绿色成功 toast,不报错(决策 #22)", async () => {
    // data 为 null 是线上无告警时的真实响应;用 JSON.parse 复现 JSON null(仓库 lint 禁 null 字面量)
    const nullDataBody = JSON.parse('{"status_code":200,"message":"成功","data":null}') as unknown;
    const bodies: unknown[] = [
      nullDataBody,
      { status_code: 200, data: [] },
      { status_code: 200, data: [{ time: 110000, alarm_message: "" }] },
    ];
    for (const body of bodies) {
      mockEnqueueSnackbar.mockClear();
      const { requests, fetchMock, result, unmount } = setup();
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      requests[0]?.resolve(jsonResponse(body));
      await waitFor(() => {
        expect(result.current.status).toBe("success");
      });
      expect(result.current.intervals).toHaveLength(0);
      // 仅一次绿色成功 toast,无红色报错
      expect(mockEnqueueSnackbar).toHaveBeenCalledTimes(1);
      expect(mockEnqueueSnackbar).toHaveBeenCalledWith("No alarms", { variant: "success" });
      unmount();
    }
  });

  it("查询成功且有告警时不弹 toast", async () => {
    const { requests, fetchMock, result } = setup();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    requests[0]?.resolve(jsonResponse({ status_code: 200, data: ALARM_RECORDS }));
    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(result.current.intervals).toHaveLength(1);
    expect(mockEnqueueSnackbar).not.toHaveBeenCalled();
  });

  it("查询失败 toast 一次;同 key BUFFERING → PRESENT 波动不重复 toast、不重查", async () => {
    const { harness, requests, fetchMock, result, rerender } = setup();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    requests[0]?.reject(new Error("HTTP 500"));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(mockEnqueueSnackbar).toHaveBeenCalledTimes(1);
    expect(mockEnqueueSnackbar).toHaveBeenCalledWith(
      "Alarm query failed: HTTP 500",
      expect.objectContaining({ variant: "error" }),
    );

    // presence 波动不使去重记录失效,也不重查
    harness.presence = PlayerPresence.BUFFERING;
    rerender();
    harness.presence = PlayerPresence.PRESENT;
    rerender();
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockEnqueueSnackbar).toHaveBeenCalledTimes(1);
  });

  it("进入 NOT_PRESENT 时 abort 在途请求并隐藏泳道", async () => {
    const { harness, requests, fetchMock, result, rerender } = setup();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    harness.presence = PlayerPresence.NOT_PRESENT;
    harness.noActiveData = true;
    rerender();
    expect(requests[0]?.aborted).toBe(true);
    expect(result.current.status).toBe("idle");
    expect(result.current.intervals).toHaveLength(0);
  });

  /** 取出最近一次 toast 的 action(重试按钮)并渲染出可点击的按钮 */
  function renderToastRetryButton() {
    const options = mockEnqueueSnackbar.mock.calls.at(-1)?.[1] as
      | { action?: ReactNode }
      | undefined;
    const utils = render(<>{options?.action}</>);
    // render 返回的查询默认绑定整个 document,需用 within 限定到本次渲染的容器,
    // 否则前几次渲染遗留的按钮会造成重复命中
    return within(utils.container).getByRole("button", { name: "Retry" });
  }

  it("失败 toast 的【重试】按钮按同一查询键重新查询;再次失败可再次 toast 并重试", async () => {
    const { requests, fetchMock, result } = setup();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    requests[0]?.reject(new Error("HTTP 500"));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(mockEnqueueSnackbar).toHaveBeenCalledTimes(1);

    // 点击重试:同一 key 再次发起查询(地址、时间段不变)
    fireEvent.click(renderToastRetryButton());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(requests[1]?.url).toBe(requests[0]?.url);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
    expect(result.current.status).toBe("loading");

    // 重试请求在途时重复点击不产生并发请求
    fireEvent.click(renderToastRetryButton());
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 重试再次失败:去重记录已被重试移除,可以再次 toast
    requests[1]?.reject(new Error("HTTP 502"));
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(mockEnqueueSnackbar).toHaveBeenCalledTimes(2);

    // 再次重试后成功:泳道数据正常返回
    fireEvent.click(renderToastRetryButton());
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    requests[2]?.resolve(jsonResponse({ status_code: 200, data: ALARM_RECORDS }));
    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(result.current.intervals).toHaveLength(1);
  });
});
