// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { RobotStatusRecord, RobotStatusResponse } from "./robotAlarmTypes";

/** 告警服务固定路径(决策 #14,不开放配置) */
const ROBOT_STATUS_PATH = "/rbrainrobot/data/get_robot_status_list";

/** 请求超时:10 分钟(决策 #18——服务端大数据量查询可能很慢,放宽等待) */
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 校验告警接口响应体(SPEC_playback_alarm_lane §4.3 的公共入口):status_code 200、
 * data 为数组;data 为 null/缺失按空数组成功(决策 #22)。在线 fetch 与导出包
 * alarms.json 读取(SPEC_robot_export_package.md §12.1)共用同一份校验。
 */
export function parseRobotStatusBody(rawText: string): RobotStatusRecord[] {
  let body: RobotStatusResponse;
  try {
    body = JSON.parse(rawText) as RobotStatusResponse;
  } catch {
    throw new Error("response is not valid JSON");
  }
  if (body.status_code !== 200) {
    throw new Error(`status_code ${body.status_code}`);
  }
  if (body.data == undefined) {
    return [];
  }
  if (!Array.isArray(body.data)) {
    throw new Error("response data is not an array");
  }
  return body.data as RobotStatusRecord[];
}

/**
 * 构造请求 URL(SPEC §12 风险 #1 的客户端规避——服务端不支持 CORS 且不可修改):
 * - development 构建(yarn web:serve):浏览器直连跨域 JSON POST 会被 OPTIONS 预检
 *   拦截,改走 dev server 的同源代理 `/robot-alarm-proxy/{host}/{port}/...`
 *   (代理实现见 packages/studio-web/src/webpackConfigs.ts);
 * - production 构建:直连。桌面端 Electron 已关闭 webSecurity(desktop/src/main.ts),
 *   不受同源策略约束;浏览器生产部署仍需服务端 CORS 或反向代理(§12 记录在案)。
 */
function robotStatusUrl(host: string, port: string): string {
  if (process.env.NODE_ENV === "development") {
    return `/robot-alarm-proxy/${host}/${port}${ROBOT_STATUS_PATH}`;
  }
  return `http://${host}:${port}${ROBOT_STATUS_PATH}`;
}

/**
 * 查询机器人告警状态采样(SPEC §4;SPEC_robot_export_package.md §10 双输出)。
 *
 * - POST + JSON body,无鉴权;
 * - 10 分钟超时,超时抛出 message 为 "timeout" 的 Error(按查询失败处理);
 * - 响应校验(§4.3):HTTP ok、status_code === 200、data 为数组,任一不满足抛错;
 *   HTTP 非 2xx 时错误信息附带截断后的响应体(dev 代理会把"目标不可达"等原因写进 body);
 *   例外(决策 #22):status_code 200 但 data 为 null/缺失表示服务端无告警数据,按空数组成功返回;
 * - 双输出签名 `{ rawText, records }`(决策 #28/§10):`rawText` 是响应**原始 body
 *   文本**(导出包的 alarms.json 条目原样落盘),`records` 是解析校验后的记录数组
 *   (泳道在线路径改取 `.records`,行为零变化)——先 `res.text()` 再内部 `JSON.parse`;
 * - 外部 signal(切换数据源/禁用/卸载)触发的中止原样透传 AbortError,由调用方静默处理;
 * - 无论成功、失败还是中止,finally 中都会清理超时定时器。
 */
export async function fetchRobotStatus(args: {
  host: string;
  port: string;
  startMs: number;
  stopMs: number;
  signal?: AbortSignal;
}): Promise<{ rawText: string; records: RobotStatusRecord[] }> {
  const { host, port, startMs, stopMs, signal } = args;

  // 内部 controller 同时承载超时中止与外部中止两个来源;
  // 用显式 timedOut 标记区分超时与主动中止(§8.2)。用对象属性存储是因为
  // TS 控制流分析不追踪闭包内对局部变量的赋值,会把布尔字面量窄化为 false
  const controller = new AbortController();
  const state = { timedOut: false };

  const onExternalAbort = (): void => {
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onExternalAbort);
    }
  }

  const timeout = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const res = await fetch(robotStatusUrl(host, port), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { start_time: startMs, stop_time: stopMs } }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // HTTP 错误尽量带上响应体(截断 200 字符)作为失败原因:dev 代理目标不可达时
      // onError 会把 "cannot reach http://... (ECONNREFUSED)" 写进 body(见
      // packages/studio-web/src/webpackConfigs.ts),真实服务 4xx/5xx 的 body 也常含
      // 具体原因;body 读取失败时退化为仅状态码
      let detail = "";
      try {
        const text = (await res.text()).trim();
        if (text !== "") {
          detail = `: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
        }
      } catch {
        // 忽略 body 读取失败,保留仅状态码的错误信息
      }
      throw new Error(`HTTP ${res.status}${detail}`);
    }
    // 双输出:原始 body 文本先落手(rawText),解析校验共用 parseRobotStatusBody。
    const rawText = await res.text();
    return { rawText, records: parseRobotStatusBody(rawText) };
  } catch (err) {
    if (state.timedOut) {
      throw new Error("timeout");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener("abort", onExternalAbort);
    }
  }
}
