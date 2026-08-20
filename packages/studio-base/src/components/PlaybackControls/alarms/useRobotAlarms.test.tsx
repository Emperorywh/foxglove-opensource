/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { act, fireEvent, render, renderHook, waitFor, within } from "@testing-library/react";
import { PropsWithChildren, ReactNode } from "react";

import { Time } from "@foxglove/rostime";
import { AppSetting } from "@foxglove/studio-base/AppSetting";
import { ServerExportWritable } from "@foxglove/studio-base/components/DataSourceDialog/serverExportTarget";
import { createZipWriter } from "@foxglove/studio-base/components/DataSourceDialog/serverExportZip";
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
  // 双输出签名先读 text() 再内部 JSON.parse(§10):mock 提供 text() 即可
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
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
  /** §11.5 通道:文件型选择的 File 列表(包内 file 形态)。 */
  selectedFiles?: File[];
  /** §11.5 通道:连接型选择的参数(包内 remote 形态,携带 url)。 */
  selectedParams?: Record<string, string | undefined>;
};

function setup(
  harnessOverrides?: Partial<Harness>,
  seed?: Record<string, string>,
  opts?: { installFetch?: (requests: MockRequest[]) => jest.Mock },
) {
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
  // fetch 安装发生在 renderHook 之前——remote 形态的包内读取在挂载 effect 里即刻发起。
  const fetchMock = (opts?.installFetch ?? installManualFetch)(requests);

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
            selectedFiles: harness.selectedFiles,
            selectedParams: harness.selectedParams,
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

// ---------------------------------------------------------------------------
// 包内路径(SPEC_robot_export_package.md §12,robot-export-package 数据源)
// ---------------------------------------------------------------------------

const EXPORT_PACKAGE_SOURCE: IDataSourceFactory = {
  id: "robot-export-package",
  type: "file",
  displayName: "Robot Export Package",
  initialize: () => undefined,
};

/** 内存 writable 夹具:拼出 writer 产物。 */
class MemoryWritable implements ServerExportWritable {
  public chunks: Uint8Array[] = [];
  public async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk);
  }
  public async close(): Promise<void> {}
  public async abort(): Promise<void> {}
  public bytes(): Uint8Array {
    const total = this.chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return out;
  }
}

/** 构造一个带 alarms.json 的导出包 zip(可选缺失);返回 File 与原始字节。 */
async function buildPackageZip(
  alarms: { rawText: string } | undefined,
): Promise<{ file: File; bytes: Uint8Array }> {
  const writable = new MemoryWritable();
  const writer = createZipWriter(writable);
  writer.beginEntry("bags/2026-08-20-09-00-00_0.bag", Date.UTC(2026, 7, 20), 4);
  await writer.pushEntryChunk(new Uint8Array(4));
  await writer.endEntry(4);
  if (alarms != undefined) {
    writer.beginEntry("alarms.json", Date.UTC(2026, 7, 20), alarms.rawText.length);
    await writer.pushEntryChunk(new TextEncoder().encode(alarms.rawText));
    await writer.endEntry(alarms.rawText.length);
  }
  await writer.finalize();
  const bytes = writable.bytes();
  return { file: new File([bytes as BlobPart], "robot-export.zip"), bytes };
}

// JSON.stringify 在本仓库 lib 定义下可返回 undefined;?? "" 收窄类型
const PACKAGE_ALARM_BODY =
  JSON.stringify({
    status_code: 200,
    data: [
      { time: 110000, alarm_message: "261;262;" },
      { time: 111000, alarm_message: "261" },
      { time: 112000, alarm_message: "" },
    ],
  }) ?? "";

/**
 * 构造最小 Response 假体:jsdom 环境没有 Response/ReadableStream 全局,BrowserHttpReader/
 * FetchReader 只需要 ok/status/headers.get/body.getReader().read 这一小块表面。
 */
function fakeResponse(payload: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    statusText: "",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "accept-ranges"
          ? "bytes"
          : name.toLowerCase() === "content-length"
            ? String(payload.byteLength)
            : undefined,
    },
    body: {
      getReader: () => {
        let index = 0;
        return {
          read: async () => {
            if (index === 0) {
              index += 1;
              return { done: false, value: payload };
            }
            return { done: true, value: undefined };
          },
        };
      },
    },
  } as unknown as Response;
}

/** 安装按 Range 请求切片服务 zip 字节的 fetch mock(remote 形态,§11.1 CachedFilelike)。 */
function installRangeFetch(bytes: Uint8Array): jest.Mock {
  const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as { get(name: string): string | undefined } | undefined)?.get(
      "range",
    );
    const match = range != undefined ? /bytes=(\d+)-(\d+)/.exec(range) : undefined;
    if (match != undefined) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      return fakeResponse(bytes.subarray(start, end + 1));
    }
    // open() 探测:返回元信息(随即被 abort,不影响已 resolve 的响应)
    return fakeResponse(bytes);
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("useRobotAlarms — robot-export-package 包内路径(§12)", () => {
  beforeEach(() => {
    mockEnqueueSnackbar.mockClear();
  });

  afterEach(() => {
    global.fetch = async () => {
      throw new Error("not available");
    };
  });

  it("file 形态:不查网络,从 zip 内 alarms.json 成功出区间", async () => {
    const { file } = await buildPackageZip({ rawText: PACKAGE_ALARM_BODY });
    const { fetchMock, result } = setup({ source: EXPORT_PACKAGE_SOURCE, selectedFiles: [file] });
    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    // 裁剪到 bag 起止(100s–200s)的逻辑复用,区间与在线路径一致
    expect(result.current.intervals).toHaveLength(1);
    expect(result.current.intervals[0]?.startMs).toBe(110000);
    expect(result.current.intervals[0]?.endMs).toBe(112000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockEnqueueSnackbar).not.toHaveBeenCalled();
  });

  it("不受 host/port 配置门控(空 host/port 仍可用)", async () => {
    const { file } = await buildPackageZip({ rawText: PACKAGE_ALARM_BODY });
    const { result } = setup(
      { source: EXPORT_PACKAGE_SOURCE, selectedFiles: [file] },
      { [AppSetting.ROBOT_ALARM_HOST]: "", [AppSetting.ROBOT_ALARM_PORT]: "" },
    );
    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(result.current.intervals).toHaveLength(1);
  });

  it("remote 形态(selectedParams.url):经 Range fetch 读包内 alarms.json 成功出区间", async () => {
    const { bytes } = await buildPackageZip({ rawText: PACKAGE_ALARM_BODY });
    const view = setup(
      {
        source: EXPORT_PACKAGE_SOURCE,
        selectedParams: { url: "http://127.0.0.1:1234/exported-file/token/robot-export.zip" },
      },
      undefined,
      // Range 服务必须在挂载前就位:包内读取在 effect 里同步发起首个 fetch。
      { installFetch: () => installRangeFetch(bytes) },
    );
    await waitFor(() => {
      expect(view.result.current.status).toBe("success");
    });
    expect(view.result.current.intervals).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalled();
  });

  it("alarms.json 缺失:成功空数据 + 泳道隐藏 + 一次 info 提示,无重试按钮", async () => {
    const { file } = await buildPackageZip(undefined);
    const { result } = setup({ source: EXPORT_PACKAGE_SOURCE, selectedFiles: [file] });
    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(result.current.intervals).toHaveLength(0);
    expect(mockEnqueueSnackbar).toHaveBeenCalledTimes(1);
    expect(mockEnqueueSnackbar).toHaveBeenCalledWith("Export package contains no alarm data", {
      variant: "info",
    });
    const options = mockEnqueueSnackbar.mock.calls.at(-1)?.[1] as { action?: ReactNode };
    expect(options.action).toBeUndefined();
  });

  it("alarms.json 损坏:error toast(包内失败文案)+ 重试按钮重读 zip 后成功", async () => {
    const corrupt = await buildPackageZip({ rawText: "{not json" });
    const { harness, result, rerender } = setup({
      source: EXPORT_PACKAGE_SOURCE,
      selectedFiles: [corrupt.file],
    });
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(mockEnqueueSnackbar).toHaveBeenCalledTimes(1);
    expect(mockEnqueueSnackbar).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read alarms from the export package"),
      expect.objectContaining({ variant: "error" }),
    );

    // 换上完好内容后点重试(重试 = 重读 zip,§12.2):同一状态机重跑并成功
    const fixed = await buildPackageZip({ rawText: PACKAGE_ALARM_BODY });
    harness.selectedFiles = [fixed.file];
    rerender();
    const options = mockEnqueueSnackbar.mock.calls.at(-1)?.[1] as { action?: ReactNode };
    const utils = render(<>{options.action}</>);
    fireEvent.click(within(utils.container).getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    expect(result.current.intervals).toHaveLength(1);
  });

  it("selectedFiles/selectedParams 缺失:隐藏不报错(边界 #24)", async () => {
    const { fetchMock, result } = setup({ source: EXPORT_PACKAGE_SOURCE });
    await act(async () => {});
    expect(result.current.status).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockEnqueueSnackbar).not.toHaveBeenCalled();
  });
});
