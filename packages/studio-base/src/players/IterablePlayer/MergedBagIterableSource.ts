// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * 多 bag 归并数据源(docs/SPEC_robot_export_package.md §11.3,决策 #5)。
 *
 * 机器人导出包 zip 里的多个 bag 分片在**播放层**被当作一个连续 IIterableSource:
 * 原始分片字节原样保留(零格式风险),消息按 receiveTime k 路归并发出。归并源
 * 就是一个普通 IIterableSource——IterablePlayer/MessagePipeline 零改动。
 *
 * 分片的打开与迭代走注入式工厂(默认实现按 §11.2 打开 `Bag`),单测可用内存
 * stub 替代(§16)。worker 侧入口见 MergedBagIterableSourceWorker.worker.ts。
 */

import { compare, isGreaterThan, isLessThan, Time } from "@foxglove/rostime";
import { MessageEvent } from "@foxglove/studio";
import { parseExportManifest } from "@foxglove/studio-base/components/DataSourceDialog/exportManifest";
import {
  BagDirEntry,
  selectBagsForExport,
} from "@foxglove/studio-base/components/DataSourceDialog/selectBagsForExport";
import { PlayerProblem, Topic, TopicStats } from "@foxglove/studio-base/players/types";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";

import { BagIterableSource } from "./BagIterableSource";
import {
  GetBackfillMessagesArgs,
  IIterableSource,
  Initalization,
  IteratorResult,
  MessageIteratorArgs,
} from "./IIterableSource";
import {
  BlobRandomAccessReader,
  RandomAccessReader,
  RangedFilelike,
  ZipEntry,
  openUrlReader,
  openZipArchive,
} from "./zipArchiveReader";

export type MergedBagSource = { type: "file"; file: File } | { type: "remote"; url: string };

/**
 * 分片工厂:为每个 bag 条目构造一个 IIterableSource。默认实现按 §11.2 以
 * RangedFilelike 打开 `Bag`(运行形态与 BagIterableSource 完全一致,decompress
 * 配置复用);测试注入内存 stub。
 */
export type BagShardFactory = (
  entry: ZipEntry,
  reader: RandomAccessReader,
) => IIterableSource;

export function defaultBagShardFactory(
  entry: ZipEntry,
  reader: RandomAccessReader,
): IIterableSource {
  return new BagIterableSource({ type: "filelike", filelike: new RangedFilelike(reader, entry) });
}

/** problem 型结果的 connectionId 全局映射基数(决策 #32:分片内按 bag 实际 id)。 */
const CONNECTION_ID_STRIDE = 2 ** 20;

type Shard = {
  name: string;
  bagIndex: number;
  source: IIterableSource;
};

export class MergedBagIterableSource implements IIterableSource {
  readonly #source: MergedBagSource;
  readonly #shardFactory: BagShardFactory;
  #shards: Shard[] = [];
  #name: string | undefined;

  public constructor(source: MergedBagSource, shardFactory: BagShardFactory = defaultBagShardFactory) {
    this.#source = source;
    this.#shardFactory = shardFactory;
  }

  public async initialize(): Promise<Initalization> {
    const reader: RandomAccessReader =
      this.#source.type === "remote"
        ? await openUrlReader(this.#source.url)
        : new BlobRandomAccessReader(this.#source.file);
    this.#name =
      this.#source.type === "remote"
        ? this.#source.url.split("/").pop() ?? this.#source.url
        : this.#source.file.name;

    const archive = await openZipArchive(reader);
    const manifestEntry = archive.entries.find((entry) => entry.name === "manifest.json");
    if (manifestEntry == undefined) {
      // 决策 #22:manifest 必须存在且受支持,否则拒绝导入(边界 #17)。
      throw new Error("not a robot export package (missing manifest.json)");
    }
    // 严格校验:format/formatVersion 不受支持 → 抛带用户可读文案的 Error。
    parseExportManifest(await archive.readEntryText(manifestEntry));

    // bags/ 条目按 §6 排序规则排序;不可解析条目名跳过并记 problem(边界 #33)。
    const bagEntries = archive.entries.filter((entry) => entry.name.startsWith("bags/"));
    const dirEntries: BagDirEntry[] = bagEntries.map((entry) => ({
      // selectBagsForExport 需要 list 条目形态;kind 由文件名分类(不以 .bag.active
      // 结尾的 .bag 即常规分片——导出侧不会写入 active 分片)。
      name: entry.name.slice("bags/".length),
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      kind: entry.name.toLowerCase().endsWith(".bag.active")
        ? ("active" as const)
        : entry.name.toLowerCase().endsWith(".bag")
          ? ("bag" as const)
          : ("file" as const),
    }));
    // 全区间筛选:分片排序用(predecessor 排最前),区间本身不影响导入。
    const selected = selectBagsForExport({
      entries: dirEntries,
      startNaive: "0000-01-01T00:00:00",
      endNaive: "9999-12-31T23:59:59",
    });
    const problems: PlayerProblem[] = [];
    if (selected.skippedUnrecognized > 0) {
      problems.push({
        severity: "warn",
        message: `${String(selected.skippedUnrecognized)} 个 bag 条目名未识别,已跳过`,
      });
    }
    if (selected.selected.length === 0) {
      // 可解析条目为 0 → 拒绝(决策 #22/边界 #19)。
      throw new Error("导出包不含 bag");
    }

    // 逐条打开分片:失败分片记 problem 并跳过,全失败 → 抛错(边界 #20)。
    const shards: Shard[] = [];
    const inits: Initalization[] = [];
    for (const candidate of selected.selected) {
      const entry = bagEntries.find((bag) => bag.name === `bags/${candidate.name}`);
      if (entry == undefined) {
        continue;
      }
      const shardSource = this.#shardFactory(entry, reader);
      try {
        inits.push(await shardSource.initialize());
      } catch (err) {
        problems.push({
          severity: "error",
          message: `bag 分片 ${candidate.name} 无法打开,已跳过`,
          tip: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      shards.push({ name: candidate.name, bagIndex: shards.length, source: shardSource });
    }
    if (shards.length === 0) {
      throw new Error("导出包内所有 bag 分片均无法打开");
    }
    this.#shards = shards;

    // 合并 Initalization(§11.3):
    // - start/end 取各分片极值(决策 #8:播放完整分片内容);
    // - topics/publishersByTopic/datatypes 并集,同名 topic datatype 冲突先到先得
    //   + problem 披露;
    // - topicStats 按 topic 合并(numMessages 求和,首末时间取极值);
    // - problems 串接;name 取 zip 文件名。
    let start = inits[0]!.start;
    let end = inits[0]!.end;
    for (const init of inits.slice(1)) {
      if (isLessThan(init.start, start)) {
        start = init.start;
      }
      if (isGreaterThan(init.end, end)) {
        end = init.end;
      }
    }

    const topics = new Map<string, Topic>();
    const topicStats = new Map<string, TopicStats>();
    const datatypes: RosDatatypes = new Map();
    const publishersByTopic = new Map<string, Set<string>>();
    for (const init of inits) {
      // problems 串接(§11.3):分片自身的 problems 一并披露。
      problems.push(...init.problems);
      for (const topic of init.topics) {
        const existing = topics.get(topic.name);
        if (existing == undefined) {
          topics.set(topic.name, topic);
        } else if (existing.schemaName !== topic.schemaName) {
          problems.push({
            severity: "warn",
            message: `话题 ${topic.name} 在分片间 datatype 冲突(${String(existing.schemaName)} / ${String(topic.schemaName)}),以首个为准`,
          });
        }
      }
      for (const [topicName, publishers] of init.publishersByTopic) {
        const merged = publishersByTopic.get(topicName) ?? new Set<string>();
        for (const publisher of publishers) {
          merged.add(publisher);
        }
        publishersByTopic.set(topicName, merged);
      }
      for (const [datatypeName, definition] of init.datatypes) {
        if (!datatypes.has(datatypeName)) {
          datatypes.set(datatypeName, definition);
        }
      }
      for (const [topicName, stats] of init.topicStats) {
        const existing = topicStats.get(topicName);
        if (existing == undefined) {
          topicStats.set(topicName, { ...stats });
        } else {
          topicStats.set(topicName, mergeTopicStats(existing, stats));
        }
      }
    }

    return {
      topics: Array.from(topics.values()),
      topicStats,
      start,
      end,
      problems,
      profile: "ros1",
      datatypes,
      publishersByTopic,
      name: this.#name,
    };
  }

  public async *messageIterator(
    opt: MessageIteratorArgs,
  ): AsyncIterableIterator<Readonly<IteratorResult>> {
    if (this.#shards.length === 0) {
      throw new Error("Invariant: uninitialized");
    }

    // 每分片以相同 args 建迭代器,缓冲 1 条,取最小 receiveTime 者发出;k 路按
    // receiveTime 归并(§11.3)。重复消息不去重(决策 #8);分片耗尽即出堆。
    // cursor 结构自包含(shard + iterator + current 同体),移除分片不打乱配对。
    type Cursor = {
      shard: Shard;
      iterator: AsyncIterableIterator<Readonly<IteratorResult>>;
      current: IteratorResult | undefined;
      done: boolean;
    };
    const cursors: Cursor[] = this.#shards.map((shard) => ({
      shard,
      iterator: shard.source.messageIterator(opt),
      current: undefined,
      done: false,
    }));
    const pull = async (cursor: Cursor): Promise<void> => {
      const next = await cursor.iterator.next();
      if (next.done === true) {
        cursor.done = true;
        cursor.current = undefined;
        return;
      }
      cursor.current = next.value;
    };
    for (const cursor of cursors) {
      await pull(cursor);
    }

    for (;;) {
      const live = cursors.filter((cursor) => !cursor.done);
      if (live.length === 0) {
        break;
      }
      // problem 型结果无时间,透传优先(决策 #32:connectionId 映射为全局唯一)。
      const problemCursor = live.find((cursor) => cursor.current?.type === "problem");
      if (problemCursor?.current?.type === "problem") {
        yield {
          type: "problem",
          connectionId: this.#globalConnectionId(
            problemCursor.shard.bagIndex,
            problemCursor.current.connectionId,
          ),
          problem: problemCursor.current.problem,
        };
        await pull(problemCursor);
        continue;
      }

      // 选 receiveTime/stamp 最小的分片发出;stamp 取各分片最小 stamp。
      let chosen: Cursor | undefined;
      let chosenTime: Time | undefined;
      for (const cursor of live) {
        const result = cursor.current;
        if (result == undefined) {
          continue;
        }
        const time =
          result.type === "message-event"
            ? result.msgEvent.receiveTime
            : result.type === "stamp"
              ? result.stamp
              : undefined;
        if (time == undefined) {
          continue;
        }
        if (chosenTime == undefined || compare(time, chosenTime) < 0) {
          chosenTime = time;
          chosen = cursor;
        }
      }
      if (chosen?.current == undefined) {
        break;
      }
      const result = chosen.current;
      chosen.current = undefined;
      yield result;
      await pull(chosen);
    }
  }

  /** 按 topic 取各分片 backfill 中 receiveTime 最大者合并(§11.3)。 */
  public async getBackfillMessages({
    topics,
    time,
  }: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    if (this.#shards.length === 0) {
      throw new Error("Invariant: uninitialized");
    }
    const merged = new Map<string, MessageEvent>();
    for (const shard of this.#shards) {
      const messages = await shard.source.getBackfillMessages({ topics, time });
      for (const message of messages) {
        const existing = merged.get(message.topic);
        if (existing == undefined || compare(message.receiveTime, existing.receiveTime) > 0) {
          merged.set(message.topic, message);
        }
      }
    }
    const messages = [...merged.values()];
    messages.sort((a, b) => compare(a.receiveTime, b.receiveTime));
    return messages;
  }

  /** 分片 i 的 connectionId 映射为全局 id(i * 2^20 + connId),避免跨分片归因串号。 */
  #globalConnectionId(bagIndex: number, connectionId: number): number {
    return bagIndex * CONNECTION_ID_STRIDE + connectionId;
  }
}

function mergeTopicStats(a: TopicStats, b: TopicStats): TopicStats {
  const merged: TopicStats = {
    numMessages: a.numMessages + b.numMessages,
  };
  for (const [key, pick] of [
    ["firstMessageTime", (x: Time, y: Time) => (compare(x, y) <= 0 ? x : y)] as const,
    ["lastMessageTime", (x: Time, y: Time) => (compare(x, y) >= 0 ? x : y)] as const,
  ] as const) {
    const aTime = a[key];
    const bTime = b[key];
    if (aTime != undefined && bTime != undefined) {
      merged[key] = pick(aTime, bTime);
    } else {
      merged[key] = aTime ?? bTime;
    }
  }
  return merged;
}
