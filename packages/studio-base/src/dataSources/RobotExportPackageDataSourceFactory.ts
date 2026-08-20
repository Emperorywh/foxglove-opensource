// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * 机器人导出包数据源(docs/SPEC_robot_export_package.md §11.4,决策 #6/#24)。
 *
 * 导入 zip 直接播放:多 bag 分片经 MergedBagIterableSource 在播放层按时间归并为
 * 一个连续数据源,告警泳道改读包内 alarms.json(离线可用,决策 #7)。
 *
 * - `args.file` → `{type:"file", file}`(Web 闭环/文件选择/拖拽,File 经
 *   Comlink 结构化克隆进 worker,懒加载不占内存);
 * - `args.params.url` → `{type:"remote", url}`(桌面闭环,§13 的 Range 路由)。
 *
 * worker 为独立入口 MergedBagIterableSourceWorker.worker.ts(自带 initialize()
 * 分发 + Comlink.expose);通用包装 WorkerIterableSourceWorker.ts 零改动。
 */

import {
  IDataSourceFactory,
  DataSourceFactoryInitializeArgs,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import { IterablePlayer, WorkerIterableSource } from "@foxglove/studio-base/players/IterablePlayer";
import { Player } from "@foxglove/studio-base/players/types";

class RobotExportPackageDataSourceFactory implements IDataSourceFactory {
  public id = "robot-export-package";
  public type: IDataSourceFactory["type"] = "file";
  public displayName = "Robot Export Package";
  public iconName: IDataSourceFactory["iconName"] = "OpenFile";
  public supportedFileTypes = [".zip"];

  public initialize(args: DataSourceFactoryInitializeArgs): Player | undefined {
    const file = args.file;
    const url = args.params?.url;
    if (!file && !url) {
      throw new Error("Missing file or url argument");
    }

    const source = new WorkerIterableSource({
      initWorker: () => {
        return new Worker(
          // foxglove-depcheck-used: babel-plugin-transform-import-meta
          new URL(
            "@foxglove/studio-base/players/IterablePlayer/MergedBagIterableSourceWorker.worker",
            import.meta.url,
          ),
        );
      },
      initArgs: file ? { file } : { url: url! },
    });

    return new IterablePlayer({
      metricsCollector: args.metricsCollector,
      source,
      name: file ? file.name : url!,
      sourceId: this.id,
    });
  }
}

export default RobotExportPackageDataSourceFactory;
