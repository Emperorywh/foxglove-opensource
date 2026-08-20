// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * 机器人导出包(多 bag 归并)的 worker 入口(docs/SPEC_robot_export_package.md
 * §11.4):自带 initialize() 按 file/url 分发 + Comlink.expose,镜像
 * BagIterableSourceWorker.worker.ts 的形态。通用包装 WorkerIterableSourceWorker.ts
 * 零改动——仓库无集中式 switch 分发,每个数据源一个 worker 入口。
 */

import * as Comlink from "comlink";

import { IterableSourceInitializeArgs } from "@foxglove/studio-base/players/IterablePlayer/IIterableSource";
import { WorkerIterableSourceWorker } from "@foxglove/studio-base/players/IterablePlayer/WorkerIterableSourceWorker";

import { MergedBagIterableSource } from "./MergedBagIterableSource";

export function initialize(args: IterableSourceInitializeArgs): WorkerIterableSourceWorker {
  if (args.file) {
    const source = new MergedBagIterableSource({ type: "file", file: args.file });
    const wrapped = new WorkerIterableSourceWorker(source);
    return Comlink.proxy(wrapped);
  } else if (args.url) {
    const source = new MergedBagIterableSource({ type: "remote", url: args.url });
    const wrapped = new WorkerIterableSourceWorker(source);
    return Comlink.proxy(wrapped);
  }

  throw new Error("file or url required");
}

Comlink.expose(initialize);
