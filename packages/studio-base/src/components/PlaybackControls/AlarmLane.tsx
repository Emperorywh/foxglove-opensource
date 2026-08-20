// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Tooltip } from "@mui/material";
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { makeStyles } from "tss-react/mui";

import { Time, fromMillis, toMillis } from "@foxglove/rostime";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import { useAppTimeFormat } from "@foxglove/studio-base/hooks";

import { AlarmInterval, AlarmSample } from "./alarms/robotAlarmTypes";
import { useRobotAlarms } from "./alarms/useRobotAlarms";

// tooltip 字段顺序固定为接口示例顺序(SPEC §6.3);记录中多出的未知字段追加在末尾。
// localTime / alarm_text / alarm_hint 是本地派生字段(不在接口示例中),
// 分别手动排在 time / alarm_message 之后
const FIELD_ORDER = [
  "id",
  "time",
  "localTime",
  "alarm_message",
  "alarm_text",
  "alarm_hint",
  "action_info",
  "task_id",
  "power",
  "linear_speed",
  "angle_speed",
  "steer",
  "work_model",
  "agv_model",
  "charge_model",
  "fork_model",
  "load_model",
  "release_model",
  "reset_button",
];

const useStyles = makeStyles()((theme) => ({
  // 泳道轨道:高 8px、全宽、背景透明,上下各留 2px 间距;短区间由 overflow 裁剪(§6.1)
  track: {
    position: "relative",
    overflow: "hidden",
    height: 8,
    margin: theme.spacing(0.25, 0),
  },
  // 红色告警区间:hover 时透明度升至 1 并加 1px 边框(与 EventsOverlay 的 hover 语言一致)
  interval: {
    position: "absolute",
    top: 0,
    bottom: 0,
    boxSizing: "border-box",
    backgroundColor: theme.palette.error.main,
    opacity: 0.8,
    cursor: "pointer",
    "&:hover": {
      opacity: 1,
      border: `1px solid ${theme.palette.error.main}`,
    },
  },
  // tooltip 两列字段表:左列英文原字段名,右列值
  detailsGrid: {
    display: "grid",
    gridTemplateColumns: "auto auto",
    columnGap: theme.spacing(1),
    alignItems: "center",
    whiteSpace: "nowrap",
    fontFamily: theme.typography.body1.fontFamily,
  },
  itemKey: {
    fontSize: "0.7rem",
    opacity: 0.7,
    textAlign: "end",
  },
  itemValue: {
    fontSize: "0.75rem",
  },
}));

const selectStartTime = (ctx: MessagePipelineContext) => ctx.playerState.activeData?.startTime;
const selectEndTime = (ctx: MessagePipelineContext) => ctx.playerState.activeData?.endTime;

/**
 * 在已按 time 升序排列的采样中二分查找距 timeMs 最近的一条(§6.3)
 */
function findNearestSample(samples: AlarmSample[], timeMs: number): AlarmSample | undefined {
  // 二分查找第一个 time >= timeMs 的位置
  let lo = 0;
  let hi = samples.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.time < timeMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const after = samples[lo];
  const before = samples[lo - 1];
  if (before == undefined) {
    return after;
  }
  if (after == undefined) {
    return before;
  }
  return timeMs - before.time <= after.time - timeMs ? before : after;
}

/**
 * 单个红色告警区间:hover 展示最近采样详情 tooltip,点击 seek 到区间起始时刻
 */
function AlarmIntervalBlock(props: {
  interval: AlarmInterval;
  laneRef: React.RefObject<HTMLDivElement>;
  bagStartMs: number;
  bagStopMs: number;
  onSeek: (seekTo: Time) => void;
}): JSX.Element {
  const { interval, laneRef, bagStartMs, bagStopMs, onSeek } = props;
  const { classes } = useStyles();
  const { formatTime } = useAppTimeFormat();

  // 鼠标所指时刻最近的一条采样;tooltip 内容随鼠标移动实时刷新(决策 #5)
  const [hoverSample, setHoverSample] = useState<AlarmSample | undefined>();

  const spanMs = bagStopMs - bagStartMs;
  const leftFraction = (interval.startMs - bagStartMs) / spanMs;
  const widthFraction = (interval.endMs - interval.startMs) / spanMs;

  const onMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const lane = laneRef.current;
      if (!lane) {
        return;
      }
      // 用整条泳道的 bounding rect 反推 bag 时刻(不能用区间元素的 offsetX,
      // 否则 2px 最小宽度、边框和嵌套节点会使时间映射失真),并裁剪到当前区间范围
      const rect = lane.getBoundingClientRect();
      if (rect.width <= 0) {
        return;
      }
      const fraction = (event.clientX - rect.left) / rect.width;
      const timeMs = Math.min(
        Math.max(bagStartMs + fraction * spanMs, interval.startMs),
        interval.endMs,
      );
      setHoverSample(findNearestSample(interval.samples, timeMs));
    },
    [laneRef, bagStartMs, spanMs, interval],
  );

  const onMouseLeave = useCallback(() => {
    setHoverSample(undefined);
  }, []);

  const onClick = useCallback(() => {
    // 决策 #10:点击红色区间 seek 到该区间起始时刻
    onSeek(fromMillis(interval.startMs));
  }, [onSeek, interval.startMs]);

  // tooltip 字段表:固定顺序在前,未知字段追加末尾;alarmCodes 是内部解析产物,不展示
  const detailsRows = useMemo(() => {
    if (!hoverSample) {
      return undefined;
    }
    const keys = Object.keys(hoverSample).filter((key) => key !== "alarmCodes");
    const orderedKeys = [
      ...FIELD_ORDER.filter((key) => keys.includes(key)),
      ...keys.filter((key) => !FIELD_ORDER.includes(key)),
    ];
    return orderedKeys.map((key) => {
      const value = hoverSample[key];
      let display: string;
      if (key === "time" && typeof value === "number" && Number.isFinite(value)) {
        // time 行按 App 时区/时间格式设置格式化
        display = formatTime(fromMillis(value));
      } else if (key === "alarm_message") {
        // 展示解析后的告警码,逗号连接(决策 #3:直接显示原始码)
        display = hoverSample.alarmCodes.join(", ");
      } else if (typeof value === "object" && value != undefined) {
        // 数组/对象用 JSON.stringify,避免显示为 [object Object];序列化失败回退 String
        try {
          display = JSON.stringify(value) ?? String(value);
        } catch {
          display = String(value);
        }
      } else {
        display = String(value);
      }
      return { key, display };
    });
  }, [hoverSample, formatTime]);

  return (
    <Tooltip
      title={
        detailsRows ? (
          <div className={classes.detailsGrid}>
            {detailsRows.map((row) => (
              <Fragment key={row.key}>
                <div className={classes.itemKey}>{row.key}</div>
                <div className={classes.itemValue}>{row.display}</div>
              </Fragment>
            ))}
          </div>
        ) : (
          ""
        )
      }
      placement="top"
      followCursor
      disableInteractive
    >
      <div
        className={classes.interval}
        // 最小显示宽度 2px(§6.1);靠近右边界的短区间由轨道 overflow 裁剪
        style={{ left: `${leftFraction * 100}%`, width: `max(2px, ${widthFraction * 100}%)` }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
      />
    </Tooltip>
  );
}

const MemoAlarmIntervalBlock = React.memo(AlarmIntervalBlock);

/**
 * 播放进度条告警泳道(SPEC §6):与时间轴对齐的 8px 细轨道,告警时段渲染红色区间。
 * 决策 #13:仅查询成功且存在告警区间时渲染;加载中、无告警、失败、无数据源一律不占位。
 */
export default function AlarmLane(props: {
  onSeek: (seekTo: Time) => void;
}): ReactNull | JSX.Element {
  const { onSeek } = props;
  const { classes } = useStyles();
  const { status, intervals } = useRobotAlarms();
  const startTime = useMessagePipeline(selectStartTime);
  const endTime = useMessagePipeline(selectEndTime);
  const laneRef = useRef<HTMLDivElement>(ReactNull);

  if (status !== "success" || intervals.length === 0 || !startTime || !endTime) {
    return ReactNull;
  }
  const bagStartMs = toMillis(startTime, false);
  const bagStopMs = toMillis(endTime, true);
  if (bagStopMs <= bagStartMs) {
    return ReactNull;
  }

  return (
    <div className={classes.track} ref={laneRef}>
      {intervals.map((interval, index) => (
        <MemoAlarmIntervalBlock
          key={index}
          interval={interval}
          laneRef={laneRef}
          bagStartMs={bagStartMs}
          bagStopMs={bagStopMs}
          onSeek={onSeek}
        />
      ))}
    </div>
  );
}
