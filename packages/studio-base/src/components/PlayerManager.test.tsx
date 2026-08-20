/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { act, render } from "@testing-library/react";

import PlayerManager from "@foxglove/studio-base/components/PlayerManager";
import AppConfigurationContext, {
  AppConfigurationValue,
  ChangeHandler,
  IAppConfiguration,
} from "@foxglove/studio-base/context/AppConfigurationContext";
import { AppContext } from "@foxglove/studio-base/context/AppContext";
import {
  IDataSourceFactory,
  PlayerSelection,
  usePlayerSelection,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import { Player } from "@foxglove/studio-base/players/types";

/** 空实现的假配置(MessagePipeline 子树里的 useAppConfiguration 需要 Provider)。 */
class FakeAppConfiguration implements IAppConfiguration {
  public get(_key: string): AppConfigurationValue {
    return undefined;
  }
  public async set(_key: string, _value: AppConfigurationValue): Promise<void> {}
  public addChangeListener(_key: string, _cb: ChangeHandler): void {}
  public removeChangeListener(_key: string, _cb: ChangeHandler): void {}
}

// useIndexedDbRecents 走 IndexedDB,jsdom 没有——mock 掉并捕获 addRecent
jest.mock("@foxglove/studio-base/hooks/useIndexedDbRecents", () => ({
  __esModule: true,
  default: () => ({ recents: [], addRecent: mockAddRecent }),
}));
const mockAddRecent = jest.fn();

// notistack 的 useSnackbar:捕获 toast 调用
jest.mock("notistack", () => {
  const actual = jest.requireActual("notistack");
  return {
    ...actual,
    useSnackbar: () => ({ enqueueSnackbar: mockEnqueueSnackbar }),
  };
});
const mockEnqueueSnackbar = jest.fn();

function makeSource(id: string, type: IDataSourceFactory["type"]): IDataSourceFactory {
  return {
    id,
    type,
    displayName: id,
    initialize: () => undefined,
  };
}

const FILE_SOURCE = makeSource("ros1-local-bagfile", "file");
const EXPORT_PACKAGE_SOURCE = makeSource("robot-export-package", "file");
const CONNECTION_SOURCE = makeSource("foxglove-websocket", "connection");

/** 探针:捕获 PlayerSelection context 值(§11.5 通道断言)。 */
let selection: PlayerSelection | undefined;
function SelectionProbe(): JSX.Element {
  selection = usePlayerSelection();
  return <div />;
}

/**
 * 在 act 里执行一次选择:file/connection 分支的选择逻辑在调用内同步完成
 * (接口把 selectSource 类型声明为 void,故作为语句调用、微任务冲刷后断言)。
 */
async function selectInAct(
  sourceId: string,
  args?: Parameters<PlayerSelection["selectSource"]>[1],
): Promise<void> {
  selection!.selectSource(sourceId, args);
  await Promise.resolve();
}

function renderManager(sources: IDataSourceFactory[]) {
  // ExtensionCatalogContext 自带默认 store,AnalyticsContext 默认 NullAnalytics。
  const view = render(
    <AppConfigurationContext.Provider value={new FakeAppConfiguration()}>
      <AppContext.Provider value={{ wrapPlayer: (player: Player) => player }}>
        <PlayerManager playerSources={sources}>
          <SelectionProbe />
        </PlayerManager>
      </AppContext.Provider>
    </AppConfigurationContext.Provider>,
  );
  return view;
}

describe("PlayerManager — selectedFiles / selectedParams 通道(SPEC_robot_export_package.md §11.5)", () => {
  beforeEach(() => {
    mockAddRecent.mockClear();
    mockEnqueueSnackbar.mockClear();
    selection = undefined;
  });

  it("writes selectedFiles on a successful file selection and clears on switch", async () => {
    renderManager([FILE_SOURCE, CONNECTION_SOURCE]);
    const file = new File([new Uint8Array(4)], "a.bag");
    await act(async () => {
      await selectInAct("ros1-local-bagfile", { type: "file", files: [file] });
    });
    expect(selection!.selectedFiles).toEqual([file]);
    expect(selection!.selectedParams).toBeUndefined();

    // 切换到连接型数据源:files 清空,params 写入
    await act(async () => {
      await selectInAct("foxglove-websocket", { type: "connection", params: { url: "ws://x" } });
    });
    expect(selection!.selectedFiles).toBeUndefined();
    expect(selection!.selectedParams).toEqual({ url: "ws://x" });
  });

  it("clears selectedParams when switching to a file source", async () => {
    renderManager([FILE_SOURCE, CONNECTION_SOURCE]);
    await act(async () => {
      await selectInAct("foxglove-websocket", { type: "connection", params: { url: "ws://x" } });
    });
    expect(selection!.selectedParams).toEqual({ url: "ws://x" });

    const file = new File([new Uint8Array(4)], "a.bag");
    await act(async () => {
      await selectInAct("ros1-local-bagfile", { type: "file", files: [file] });
    });
    expect(selection!.selectedFiles).toEqual([file]);
    expect(selection!.selectedParams).toBeUndefined();
  });

  it("does not write a recent for robot-export-package connection selections", async () => {
    renderManager([EXPORT_PACKAGE_SOURCE, CONNECTION_SOURCE]);
    await act(async () => {
      await selectInAct("robot-export-package", {
        type: "connection",
        params: { url: "http://127.0.0.1:1/exported-file/token/x.zip" },
      });
    });
    expect(mockAddRecent).not.toHaveBeenCalled();
    expect(selection!.selectedParams).toEqual({
      url: "http://127.0.0.1:1/exported-file/token/x.zip",
    });

    // 对照:普通连接型数据源仍写 recent
    await act(async () => {
      await selectInAct("foxglove-websocket", { type: "connection", params: { url: "ws://x" } });
    });
    expect(mockAddRecent).toHaveBeenCalledTimes(1);
  });
});
