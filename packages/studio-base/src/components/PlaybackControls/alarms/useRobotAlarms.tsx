// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Button } from "@mui/material";
import { useSnackbar } from "notistack";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { toMillis } from "@foxglove/rostime";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import {
  isValidRobotAlarmPort,
  useRobotAlarmConfiguration,
} from "@foxglove/studio-base/hooks/useRobotAlarmConfiguration";
import { PlayerPresence } from "@foxglove/studio-base/players/types";

import { fetchRobotStatus } from "./fetchRobotStatus";
import { mergeAlarmIntervals } from "./mergeAlarmIntervals";
import { AlarmInterval } from "./robotAlarmTypes";

const selectPresence = (ctx: MessagePipelineContext) => ctx.playerState.presence;
const selectPlayerId = (ctx: MessagePipelineContext) => ctx.playerState.playerId;
const selectStartTime = (ctx: MessagePipelineContext) => ctx.playerState.activeData?.startTime;
const selectEndTime = (ctx: MessagePipelineContext) => ctx.playerState.activeData?.endTime;

export type RobotAlarmStatus = "idle" | "loading" | "success" | "error";

/** 一次告警查询的完整参数;key 为规范化后的查询键字符串(决策 #19 去重也用它) */
type AlarmQuery = {
  key: string;
  host: string;
  port: string;
  startMs: number;
  stopMs: number;
};

type QueryResult = {
  key: string;
  status: "loading" | "success" | "error";
  intervals: AlarmInterval[];
};

type InFlight = {
  key: string;
  controller: AbortController;
};

const NO_INTERVALS: AlarmInterval[] = [];

/**
 * 告警泳道数据 hook(SPEC §8 状态机):
 *
 * - 仅 ROS1 本地 bag 数据源有资格(决策 #7);
 * - host/port 任一为空或 port 非法即禁用,不查询、不渲染、不 toast(决策 #17);
 * - 每个查询键(playerId + 数据源 + 起止时间 + 配置)只在首次 ready 时查询一次;
 *   同 key 短暂 BUFFERING 不 abort、不重查;
 * - queryKey 变化 / 禁用 / NOT_PRESENT / ERROR / 卸载 → abort 在途请求并隐藏泳道;
 * - 查询失败全局 toast 一次(决策 #11/#19),toast 附"重试"按钮,点击后按同一
 *   查询键重新查询一次(决策 #21),同 key 不重复打扰。
 * - 查询成功但无任何告警时弹绿色成功 toast"没有告警"(决策 #22),泳道仍隐藏(决策 #13)。
 */
export function useRobotAlarms(): { status: RobotAlarmStatus; intervals: AlarmInterval[] } {
  const { t } = useTranslation("robotAlarms");
  const { enqueueSnackbar } = useSnackbar();

  const presence = useMessagePipeline(selectPresence);
  const playerId = useMessagePipeline(selectPlayerId);
  const startTime = useMessagePipeline(selectStartTime);
  const endTime = useMessagePipeline(selectEndTime);
  const { selectedSource } = usePlayerSelection();
  const { host, port } = useRobotAlarmConfiguration();

  // 决策 #7:eligible 是硬门槛,不能仅凭 startTime/endTime 推断数据源类型
  const eligible = selectedSource?.type === "file" && selectedSource.id === "ros1-local-bagfile";

  const normalizedHost = host.trim();
  const enabled = normalizedHost !== "" && isValidRobotAlarmPort(port);

  // 决策 #12:ROS1 bag 内消息时间为 Unix 墙钟,与接口 ms 时间戳同源,直接换算;
  // startMs 向下取整、stopMs 向上取整,形成覆盖完整 bag 边界的毫秒闭区间
  const startMs = startTime ? toMillis(startTime, false) : undefined;
  const stopMs = endTime ? toMillis(endTime, true) : undefined;
  const timesValid =
    startMs != undefined &&
    stopMs != undefined &&
    Number.isFinite(startMs) &&
    Number.isFinite(stopMs) &&
    stopMs > startMs;

  // 查询键:playerId 是播放器实例的稳定标识;配置是键的一部分,修改地址立即重查(§6.5)。
  // 不对 endTime 做量化——边界真正改变就必须形成新 key 并重新查询。
  const query = useMemo<AlarmQuery | undefined>(() => {
    if (!eligible || !timesValid) {
      return undefined;
    }
    return {
      // 输入必为对象字面量,stringify 不会返回 undefined;?? "" 仅满足仓库扩展的类型定义
      key:
        JSON.stringify({
          playerId,
          // eligible 为真时 selectedSource 必然存在(TS 别名条件窄化)
          sourceType: selectedSource.type,
          sourceId: selectedSource.id,
          startMs,
          stopMs,
          host: normalizedHost,
          port,
        }) ?? "",
      host: normalizedHost,
      port,
      startMs,
      stopMs,
    };
  }, [
    eligible,
    timesValid,
    playerId,
    selectedSource?.type,
    selectedSource?.id,
    startMs,
    stopMs,
    normalizedHost,
    port,
  ]);

  const [result, setResult] = useState<QueryResult | undefined>(undefined);
  // 手动重试令牌(决策 #21):点击失败 toast 的"重试"按钮时 bump,
  // 使下方 effect 按当前查询键重新执行一遍
  const [retryToken, setRetryToken] = useState(0);
  // 本挂载周期内已发起过查询的 key:请求一经发起即登记;presence 波动或错误状态重置不移除
  const attemptedKeysRef = useRef<Set<string>>(new Set<string>());
  // toast 去重记录(决策 #19);正常播放器 BUFFERING 不使其失效
  const toastedKeysRef = useRef<Set<string>>(new Set<string>());
  // 在途请求(同时最多一个;发起新请求前旧请求必然已 abort)
  const inFlightRef = useRef<InFlight | undefined>(undefined);

  useEffect(() => {
    const terminal = presence === PlayerPresence.NOT_PRESENT || presence === PlayerPresence.ERROR;

    // abort 在途请求:queryKey 变化/消失、功能禁用、进入 NOT_PRESENT/ERROR(§8.2)。
    // 同 key 短暂 BUFFERING 不属于清理条件。
    const inFlight = inFlightRef.current;
    if (inFlight && (query == undefined || inFlight.key !== query.key || !enabled || terminal)) {
      inFlight.controller.abort();
      inFlightRef.current = undefined;
    }

    if (
      query == undefined ||
      !enabled ||
      presence !== PlayerPresence.PRESENT ||
      attemptedKeysRef.current.has(query.key)
    ) {
      return;
    }
    // 请求一经发起即登记,保证同一 key 不会被 effect 再次触发
    attemptedKeysRef.current.add(query.key);

    const currentQuery = query;
    const controller = new AbortController();
    inFlightRef.current = { key: currentQuery.key, controller };
    setResult({ key: currentQuery.key, status: "loading", intervals: NO_INTERVALS });

    fetchRobotStatus({
      host: currentQuery.host,
      port: currentQuery.port,
      startMs: currentQuery.startMs,
      stopMs: currentQuery.stopMs,
      signal: controller.signal,
    })
      .then((records) => {
        // 竞态防护:本轮请求已不是在途请求时(key 变化/禁用/卸载引发的 abort),
        // 迟到响应不得 setState(§8.2)
        if (inFlightRef.current?.controller !== controller) {
          return;
        }
        inFlightRef.current = undefined;
        const intervals = mergeAlarmIntervals(records, currentQuery.startMs, currentQuery.stopMs);
        setResult({ key: currentQuery.key, status: "success", intervals });
        // 决策 #22:查询成功但无告警(data 为 null、空数组或全部无告警采样)时弹绿色
        // 成功 toast"没有告警",泳道仍隐藏。每个查询键只查询一次,toast 天然
        // 每 key 至多一次,无需像错误 toast 那样单独去重
        if (intervals.length === 0) {
          enqueueSnackbar(t("noAlarms"), { variant: "success" });
        }
      })
      .catch((error: unknown) => {
        // 主动 abort 的 AbortError 也走到这里:用户切换/禁用/卸载导致的 abort 静默
        if (inFlightRef.current?.controller !== controller) {
          return;
        }
        inFlightRef.current = undefined;
        setResult({ key: currentQuery.key, status: "error", intervals: NO_INTERVALS });
        // toast 去重:同一查询键只报错一次,切到新 key 可再次报告
        if (!toastedKeysRef.current.has(currentQuery.key)) {
          toastedKeysRef.current.add(currentQuery.key);
          const reason = error instanceof Error ? error.message : String(error);
          enqueueSnackbar(t("alarmQueryFailed", { reason }), {
            variant: "error",
            // 决策 #21:失败 toast 附"重试"按钮。点击后从已登记/已报错记录中移除
            // 当前 key 并 bump retryToken,effect 随即按同一查询键重新查询一遍;
            // 若点击时已切到其他查询键,删除的只是旧 key,对当前查询无影响
            action: (
              <Button
                color="inherit"
                size="small"
                onClick={() => {
                  // 重试请求在途期间忽略重复点击,避免并发发出两个相同请求
                  if (inFlightRef.current) {
                    return;
                  }
                  attemptedKeysRef.current.delete(currentQuery.key);
                  toastedKeysRef.current.delete(currentQuery.key);
                  setResult((prev) => (prev?.key === currentQuery.key ? undefined : prev));
                  setRetryToken((token) => token + 1);
                }}
              >
                {t("retry")}
              </Button>
            ),
          });
        }
      });
  }, [query, enabled, presence, retryToken, enqueueSnackbar, t]);

  // 组件卸载时 abort 在途请求
  useEffect(() => {
    return () => {
      inFlightRef.current?.controller.abort();
      inFlightRef.current = undefined;
    };
  }, []);

  // 显隐派生:结果必须属于当前查询键、功能启用且非终态 presence 才对外可见;
  // 同 key 短暂 BUFFERING 时结果保持可见(泳道不清空)
  const terminal = presence === PlayerPresence.NOT_PRESENT || presence === PlayerPresence.ERROR;
  if (
    !enabled ||
    terminal ||
    result == undefined ||
    query == undefined ||
    result.key !== query.key
  ) {
    return { status: "idle", intervals: NO_INTERVALS };
  }
  return { status: result.status, intervals: result.intervals };
}
