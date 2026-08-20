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
    // 双输出签名先读 text() 再内部 JSON.parse(§10):mock 提供 text() 即可
    text: async () => JSON.stringify(body),
  } as Response;
}

/** 构造带 text() 的 HTTP 错误响应(用于错误响应体透传测试) */
function errorTextResponse(text: string, status: number): Response {
  return {
    ok: false,
    status,
    text: async () => text,
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
    // 双输出:records 为解析结果,rawText 为响应原始 body 文本(§10)
    expect(result.records).toEqual(records);
    expect(result.rawText).toBe(JSON.stringify({ status_code: 200, data: records }));
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
    // 该 mock 不提供 text(),同时覆盖 body 读取失败退化为仅状态码的路径
    global.fetch = jest.fn(async () =>
      jsonResponse({}, { ok: false, status: 500 }),
    ) as unknown as typeof fetch;
    await expect(fetchRobotStatus(ARGS)).rejects.toThrow("HTTP 500");
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("HTTP 错误附带响应体内容(dev 代理目标不可达的原因透传)", async () => {
    global.fetch = jest.fn(async () =>
      errorTextResponse(
        "robot-alarm-proxy: cannot reach http://10.11.2.208:50004 (ECONNREFUSED)",
        502,
      ),
    ) as unknown as typeof fetch;
    await expect(fetchRobotStatus(ARGS)).rejects.toThrow(
      "HTTP 502: robot-alarm-proxy: cannot reach http://10.11.2.208:50004 (ECONNREFUSED)",
    );
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("HTTP 错误响应体超长时截断到 200 字符", async () => {
    global.fetch = jest.fn(async () =>
      errorTextResponse("x".repeat(500), 500),
    ) as unknown as typeof fetch;
    const error: unknown = await fetchRobotStatus(ARGS).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`HTTP 500: ${"x".repeat(200)}…`);
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("HTTP 错误响应体为空白时仅报状态码", async () => {
    global.fetch = jest.fn(async () => errorTextResponse("  \n  ", 404)) as unknown as typeof fetch;
    await expect(fetchRobotStatus(ARGS)).rejects.toThrow("HTTP 404");
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
    await expect(fetchRobotStatus(ARGS)).resolves.toEqual({
      rawText: JSON.stringify(body),
      records: [],
    });
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("data 为空数组是成功(无数据)", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse({ status_code: 200, data: [] }),
    ) as unknown as typeof fetch;
    await expect(fetchRobotStatus(ARGS)).resolves.toEqual({
      rawText: JSON.stringify({ status_code: 200, data: [] }),
      records: [],
    });
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it("响应体非 JSON 时抛错(双输出路径先读文本再解析,§10)", async () => {
    global.fetch = jest.fn(async () =>
      ({ ok: true, status: 200, text: async () => "<html>gateway error</html>" }) as Response,
    ) as unknown as typeof fetch;
    await expect(fetchRobotStatus(ARGS)).rejects.toThrow("not valid JSON");
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
