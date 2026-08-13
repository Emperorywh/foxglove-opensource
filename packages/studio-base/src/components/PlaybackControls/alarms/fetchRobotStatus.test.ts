// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { fetchRobotStatus } from "./fetchRobotStatus";

/** 构造一个监听 abort 信号、永不主动 resolve 的 fetch(用于 abort/超时测试) */
function neverResolvingFetch(): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The user aborted a request.", "AbortError"));
      });
    });
  }) as typeof fetch;
}

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
  } as Response;
}

const ARGS = { host: "10.11.2.208", port: "50004", startMs: 1000, stopMs: 2000 };

describe("fetchRobotStatus", () => {
  let clearTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    clearTimeoutSpy = jest.spyOn(global, "clearTimeout");
  });

  afterEach(() => {
    clearTimeoutSpy.mockRestore();
    global.fetch = async () => {
      throw new Error("not available");
    };
  });

  it("发送正确的 URL、method、headers 与 JSON body,并返回记录", async () => {
    const records = [{ time: 1500, alarm_message: "261;" }];
    const fetchMock = jest.fn(async () => jsonResponse({ status_code: 200, data: records }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchRobotStatus(ARGS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://10.11.2.208:50004/rbrainrobot/data/get_robot_status_list");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      data: { start_time: 1000, stop_time: 2000 },
    });
    expect(result).toEqual(records);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("development 构建走 dev server 同源代理路径(规避浏览器 CORS)", async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const fetchMock = jest.fn(async () => jsonResponse({ status_code: 200, data: [] }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await fetchRobotStatus(ARGS);

      const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(
        "/robot-alarm-proxy/10.11.2.208/50004/rbrainrobot/data/get_robot_status_list",
      );
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("HTTP 非 2xx 抛出带状态码的错误", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({}, { ok: false, status: 500 }),
    ) as unknown as typeof fetch;
    await expect(fetchRobotStatus(ARGS)).rejects.toThrow("HTTP 500");
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("status_code 非 200 抛出错误", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ status_code: 400, data: [] }),
    ) as unknown as typeof fetch;
    await expect(fetchRobotStatus(ARGS)).rejects.toThrow("status_code 400");
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("data 非数组抛出错误", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ status_code: 200, data: { not: "array" } }),
    ) as unknown as typeof fetch;
    await expect(fetchRobotStatus(ARGS)).rejects.toThrow("response data is not an array");
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("status_code 200 且 data 为 null 时按成功空数据处理(决策 #22)", async () => {
    // 线上无告警时的真实响应;用 JSON.parse 复现 JSON null(仓库 lint 禁 null 字面量)
    const body = JSON.parse('{"status_code":200,"message":"成功","data":null}') as unknown;
    global.fetch = jest.fn(async () => jsonResponse(body)) as unknown as typeof fetch;
    await expect(fetchRobotStatus(ARGS)).resolves.toEqual([]);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("data 为空数组是成功(无数据)", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ status_code: 200, data: [] }),
    ) as unknown as typeof fetch;
    await expect(fetchRobotStatus(ARGS)).resolves.toEqual([]);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("网络错误原样透传", async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(fetchRobotStatus(ARGS)).rejects.toThrow("Failed to fetch");
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("外部 abort 透传 AbortError,不会被误报为超时", async () => {
    global.fetch = neverResolvingFetch();
    const controller = new AbortController();
    const promise = fetchRobotStatus({ ...ARGS, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow("The user aborted a request.");
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("10 分钟无响应抛出 timeout 错误", async () => {
    jest.useFakeTimers();
    try {
      global.fetch = neverResolvingFetch();
      const promise = fetchRobotStatus(ARGS);
      jest.advanceTimersByTime(10 * 60 * 1000);
      await expect(promise).rejects.toThrow("timeout");
      // 超时定时器已在 finally 中清理,无残留定时器
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
