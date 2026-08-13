// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { action } from "@storybook/addon-actions";
import { StoryObj, StoryFn } from "@storybook/react";
import { PropsWithChildren, useEffect, useLayoutEffect, useMemo } from "react";

import MockMessagePipelineProvider from "@foxglove/studio-base/components/MessagePipeline/MockMessagePipelineProvider";
import AppConfigurationContext, {
  IAppConfiguration,
} from "@foxglove/studio-base/context/AppConfigurationContext";
import { useEvents } from "@foxglove/studio-base/context/EventsContext";
import PlayerSelectionContext, {
  IDataSourceFactory,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import { useSetHoverValue } from "@foxglove/studio-base/context/TimelineInteractionStateContext";
import {
  PlayerCapabilities,
  PlayerPresence,
  PlayerState,
  PlayerStateActiveData,
} from "@foxglove/studio-base/players/types";
import MockCurrentLayoutProvider from "@foxglove/studio-base/providers/CurrentLayoutProvider/MockCurrentLayoutProvider";
import EventsProvider from "@foxglove/studio-base/providers/EventsProvider";
import WorkspaceContextProvider from "@foxglove/studio-base/providers/WorkspaceContextProvider";
import { makeMockEvents } from "@foxglove/studio-base/test/mocks/makeMockEvents";

import PlaybackControls from "./index";

const START_TIME = 1531761690;

// 告警泳道(§7):合格的 ROS1 本地 bag 数据源 mock
const ROS1_BAG_SOURCE: IDataSourceFactory = {
  id: "ros1-local-bagfile",
  type: "file",
  displayName: "ROS 1 Bag",
  initialize: () => undefined,
};

const BAG_START_MS = START_TIME * 1000;

/** 构造一条 1Hz 状态采样记录(字段对齐接口示例) */
function makeStatusSample(id: number, offsetMs: number, alarmMessage: string) {
  return {
    id,
    time: BAG_START_MS + offsetMs,
    alarm_message: alarmMessage,
    action_info: "退出暂停状态",
    task_id: "-",
    power: 100,
    linear_speed: 0,
    angle_speed: 0,
    steer: 0,
    work_model: 1,
    agv_model: 0,
    charge_model: 0,
    fork_model: 0,
    load_model: 0,
    release_model: false,
    reset_button: 0,
  };
}

// 两段告警:5s–7s(261;262 → 261)与 12s(265)
const ALARM_SAMPLES = [
  makeStatusSample(1331713, 5000, "261;262;"),
  makeStatusSample(1331714, 6000, "261;"),
  makeStatusSample(1331715, 7000, ""),
  makeStatusSample(1331716, 12000, "265;"),
  makeStatusSample(1331717, 13000, ""),
];

const NO_ALARM_SAMPLES = [
  makeStatusSample(1331713, 5000, ""),
  makeStatusSample(1331714, 6000, ""),
  makeStatusSample(1331715, 7000, ""),
];

/**
 * render 阶段同步安装 fetch mock,保证 AlarmLane 的查询 effect 发起请求时已生效;
 * 卸载时恢复为不可用实现,避免泄漏到其他 story。
 */
function AlarmFetchMock({ data, children }: PropsWithChildren<{ data: unknown[] }>): JSX.Element {
  useMemo(() => {
    global.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status_code: 200, message: "成功", data }),
      } as Response;
    }) as typeof fetch;
  }, [data]);
  useEffect(() => {
    return () => {
      global.fetch = async () => {
        throw new Error("not available");
      };
    };
  }, []);
  return <>{children}</>;
}

/** 提供 PlayerSelection mock:默认无数据源(不合格,不查询);告警 story 传入 ROS1 bag 源 */
function makePlayerSelection(source?: IDataSourceFactory) {
  return {
    selectSource: () => {},
    selectRecent: () => {},
    availableSources: [],
    recentSources: [],
    selectedSource: source,
  };
}

function getPlayerState(): PlayerState {
  const player: PlayerState = {
    presence: PlayerPresence.PRESENT,
    progress: {},
    capabilities: [PlayerCapabilities.setSpeed, PlayerCapabilities.playbackControl],
    profile: undefined,
    playerId: "1",
    activeData: {
      messages: [],
      startTime: { sec: START_TIME, nsec: 331 },
      endTime: { sec: START_TIME + 20, nsec: 331 },
      currentTime: { sec: START_TIME + 5, nsec: 331 },
      isPlaying: true,
      speed: 0.2,
      lastSeekTime: 0,
      topics: [{ name: "/empty_topic", schemaName: "VoidType" }],
      topicStats: new Map(),
      datatypes: new Map(Object.entries({ VoidType: { definitions: [] } })),
      totalBytesReceived: 1234,
    },
  };
  return player;
}

const mockAppConfiguration: IAppConfiguration = {
  get: (key: string) => {
    if (key === "timezone") {
      return "America/Los_Angeles";
    } else {
      return undefined;
    }
  },
  set: async () => {},
  addChangeListener: () => {},
  removeChangeListener: () => {},
};

function Wrapper({
  isPlaying = false,
  activeData,
  children,
  progress,
  presence,
  noActiveData,
}: {
  isPlaying?: boolean;
  activeData?: PlayerStateActiveData;
  children: React.ReactNode;
  progress?: PlayerState["progress"];
  presence?: PlayerState["presence"];
  noActiveData?: boolean;
}) {
  return (
    <MockMessagePipelineProvider
      isPlaying={isPlaying}
      capabilities={["setSpeed", "playbackControl"]}
      presence={presence}
      activeData={activeData}
      pausePlayback={action("pause")}
      seekPlayback={action("seek")}
      startPlayback={action("play")}
      progress={progress}
      noActiveData={noActiveData}
    >
      <div style={{ padding: 20, margin: 20 }}>{children}</div>
    </MockMessagePipelineProvider>
  );
}

export default {
  title: "components/PlaybackControls",
  decorators: [
    (Wrapped: StoryFn): JSX.Element => (
      <AppConfigurationContext.Provider value={mockAppConfiguration}>
        {/* 默认无选中数据源:告警泳道不查询、不渲染,既有 story 行为不变 */}
        <PlayerSelectionContext.Provider value={makePlayerSelection()}>
          <WorkspaceContextProvider>
            <MockCurrentLayoutProvider>
              <EventsProvider>
                <Wrapped />
              </EventsProvider>
            </MockCurrentLayoutProvider>
          </WorkspaceContextProvider>
        </PlayerSelectionContext.Provider>
      </AppConfigurationContext.Provider>
    ),
  ],
};

export const Playing: StoryObj = {
  render: () => {
    return (
      <Wrapper isPlaying>
        <PlaybackControls
          isPlaying={true}
          getTimeInfo={() => ({})}
          play={action("play")}
          pause={action("pause")}
          seek={action("seek")}
        />
      </Wrapper>
    );
  },

  parameters: { colorScheme: "both-column" },
};

export const Paused: StoryObj = {
  render: () => {
    return (
      <Wrapper>
        <PlaybackControls
          isPlaying={false}
          getTimeInfo={() => ({})}
          play={action("play")}
          pause={action("pause")}
          seek={action("seek")}
        />
      </Wrapper>
    );
  },

  parameters: { colorScheme: "both-column" },
};

export const Disabled: StoryObj = {
  render: () => {
    return (
      <Wrapper presence={PlayerPresence.ERROR} noActiveData>
        <PlaybackControls
          isPlaying={false}
          getTimeInfo={() => ({})}
          play={action("play")}
          pause={action("pause")}
          seek={action("seek")}
        />
      </Wrapper>
    );
  },

  parameters: { colorScheme: "both-column" },
};

export const DownloadProgressByRanges: StoryObj = {
  render: () => {
    const player = getPlayerState();
    player.progress = {
      ...player.progress,
      fullyLoadedFractionRanges: [
        { start: -2, end: 0.1 },
        { start: 0.23, end: 0.6 },
        { start: 0.7, end: 1 },
      ],
    };
    return (
      <Wrapper progress={player.progress}>
        <PlaybackControls
          isPlaying
          getTimeInfo={() => ({})}
          play={action("play")}
          pause={action("pause")}
          seek={action("seek")}
        />
      </Wrapper>
    );
  },

  parameters: { colorScheme: "both-column" },
};

export const HoverTicks: StoryObj = {
  render: function Story() {
    const player = getPlayerState();
    const setHoverValue = useSetHoverValue();

    useLayoutEffect(() => {
      setHoverValue({
        type: "PLAYBACK_SECONDS",
        value: 0.5,
        componentId: "story",
      });
    }, [setHoverValue]);

    return (
      <Wrapper activeData={player.activeData}>
        <PlaybackControls
          isPlaying
          getTimeInfo={() => ({})}
          play={action("play")}
          pause={action("pause")}
          seek={action("seek")}
        />
      </Wrapper>
    );
  },

  parameters: { colorScheme: "both-column" },
};

export const WithEvents: StoryObj = {
  render: function Story() {
    const player = getPlayerState();
    const setEvents = useEvents((store) => store.setEvents);

    useEffect(() => {
      setEvents({ loading: false, value: makeMockEvents(4, START_TIME + 1, 4) });
    });

    return (
      <Wrapper activeData={player.activeData}>
        <PlaybackControls
          isPlaying
          getTimeInfo={() => ({})}
          play={action("play")}
          pause={action("pause")}
          seek={action("seek")}
        />
      </Wrapper>
    );
  },

  parameters: { colorScheme: "both-column" },
};

// 决策 #13:查询成功但无告警时泳道完全隐藏,不占位
export const AlarmLaneNoAlarms: StoryObj = {
  render: () => {
    const player = getPlayerState();
    return (
      <PlayerSelectionContext.Provider value={makePlayerSelection(ROS1_BAG_SOURCE)}>
        <AlarmFetchMock data={NO_ALARM_SAMPLES}>
          <Wrapper activeData={player.activeData}>
            <PlaybackControls
              isPlaying
              getTimeInfo={() => ({})}
              play={action("play")}
              pause={action("pause")}
              seek={action("seek")}
            />
          </Wrapper>
        </AlarmFetchMock>
      </PlayerSelectionContext.Provider>
    );
  },

  parameters: { colorScheme: "both-column" },
};

// 有告警:进度条下方出现与时间轴对齐的红色告警区间,hover 查看采样详情,点击 seek
export const AlarmLaneWithAlarms: StoryObj = {
  render: () => {
    const player = getPlayerState();
    return (
      <PlayerSelectionContext.Provider value={makePlayerSelection(ROS1_BAG_SOURCE)}>
        <AlarmFetchMock data={ALARM_SAMPLES}>
          <Wrapper activeData={player.activeData}>
            <PlaybackControls
              isPlaying
              getTimeInfo={() => ({})}
              play={action("play")}
              pause={action("pause")}
              seek={action("seek")}
            />
          </Wrapper>
        </AlarmFetchMock>
      </PlayerSelectionContext.Provider>
    );
  },

  parameters: { colorScheme: "both-column" },
};
