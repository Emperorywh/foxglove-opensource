// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { readFileSync } from "fs";
import path from "path";

import { Time } from "@foxglove/rostime";
import { MessageEvent } from "@foxglove/studio";
import { buildExportManifest, serializeExportManifest } from "@foxglove/studio-base/components/DataSourceDialog/exportManifest";
import { ServerExportWritable } from "@foxglove/studio-base/components/DataSourceDialog/serverExportTarget";
import { createZipWriter } from "@foxglove/studio-base/components/DataSourceDialog/serverExportZip";
import { TopicSelection } from "@foxglove/studio-base/players/types";

import { GetBackfillMessagesArgs, IIterableSource, Initalization, IteratorResult, MessageIteratorArgs } from "./IIterableSource";
import { MergedBagIterableSource } from "./MergedBagIterableSource";

/** 内存 writable 夹具:把 writer 产物拼成单个 Uint8Array。 */
class MemoryWritable implements ServerExportWritable {
  public chunks: Uint8Array[] = [];
  public async write(chunk: Uint8Array): Promise<void> {
    this.chunks.push(chunk);
  }
  public async close(): Promise<void> {}
  public async abort(): Promise<void> {}
  public bytes(): Uint8Array {
    const total = this.chunks.reduce((acc, chunk) => acc + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, cursor);
      cursor += chunk.byteLength;
    }
    return out;
  }
}

async function buildZip(entries: { name: string; data: Uint8Array }[]): Promise<File> {
  const writable = new MemoryWritable();
  const writer = createZipWriter(writable);
  for (const entry of entries) {
    writer.beginEntry(entry.name, Date.UTC(2026, 7, 20, 9, 0, 0), entry.data.byteLength);
    await writer.pushEntryChunk(entry.data);
    await writer.endEntry(entry.data.byteLength);
  }
  await writer.finalize();
  return new File([writable.bytes() as BlobPart], "robot-export-20260820-090000-20260820-100000.zip");
}

function manifestText(bagNames: string[]): string {
  return serializeExportManifest(
    buildExportManifest({
      generatorVersion: "test",
      source: { host: "10.0.0.1", bagPath: "/bags", logPath: "/var/log/robot" },
      range: {
        startLocal: "2026-08-20 09:00:00",
        endLocal: "2026-08-20 10:00:00",
        tzOffsetMinutes: 480,
        tzSource: "server",
        startUnixMs: 0,
        endUnixMs: 0,
      },
      bags: bagNames.map((name, index) => ({
        name,
        size: 1,
        timeLocal: "2026-08-20 09:00:00",
        seq: index,
        role: "in-range" as const,
      })),
      logs: { included: false, count: 0, bytes: 0 },
      alarms: { status: "ok", query: { startUnixMs: 0, stopUnixMs: 0 } },
      nowMs: 0,
    }),
  );
}

function time(sec: number, nsec = 0): Time {
  return { sec, nsec };
}

function messageEvent(topic: string, receiveTime: Time, payload: number): MessageEvent {
  return { topic, receiveTime, message: { value: payload }, sizeInBytes: 4, schemaName: "T" };
}

/** 内存 stub 分片(§16:注入式工厂以内存 stub 构造)。 */
class StubShardSource implements IIterableSource {
  public constructor(
    public readonly init: Partial<Initalization>,
    public readonly results: IteratorResult[],
    public readonly backfill: MessageEvent[] = [],
  ) {}

  public async initialize(): Promise<Initalization> {
    return {
      start: this.init.start ?? time(0),
      end: this.init.end ?? time(1),
      topics: this.init.topics ?? [],
      topicStats: this.init.topicStats ?? new Map(),
      datatypes: this.init.datatypes ?? new Map(),
      profile: "ros1",
      publishersByTopic: this.init.publishersByTopic ?? new Map(),
      problems: this.init.problems ?? [],
      ...this.init,
    };
  }

  public async *messageIterator(
    _opt: MessageIteratorArgs,
  ): AsyncIterableIterator<Readonly<IteratorResult>> {
    for (const result of this.results) {
      yield result;
    }
  }

  public async getBackfillMessages(_args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    return this.backfill;
  }
}

const bagEntry = (name: string): { name: string; data: Uint8Array } => ({
  name: `bags/${name}`,
  data: new Uint8Array(16).fill(1),
});

async function makeZipWithShards(
  bagNames: string[],
  shardsByIndex: (index: number) => StubShardSource,
): Promise<{ file: File; shards: StubShardSource[] }> {
  const shards = bagNames.map((_name, index) => shardsByIndex(index));
  const file = await buildZip([
    ...bagNames.map((name) => bagEntry(name)),
    { name: "manifest.json", data: new TextEncoder().encode(manifestText(bagNames)) },
  ]);
  return { file, shards };
}

function mergedWithStubs(
  file: File,
  shards: StubShardSource[],
): MergedBagIterableSource {
  return new MergedBagIterableSource({ type: "file", file }, (entry) => {
    const match = /_(\d+)\.bag$/.exec(entry.name);
    const index = match == undefined ? 0 : Number(match[1]);
    return shards[index] ?? shards[0]!;
  });
}

async function collectMessages(
  source: MergedBagIterableSource,
  topicSelection: TopicSelection = new Map(),
): Promise<{
  results: IteratorResult[];
  problems: Extract<IteratorResult, { type: "problem" }>[];
}> {
  const results: IteratorResult[] = [];
  const problems: Extract<IteratorResult, { type: "problem" }>[] = [];
  for await (const result of source.messageIterator({ topics: topicSelection })) {
    if (result.type === "problem") {
      problems.push(result);
    } else {
      results.push(result);
    }
  }
  return { results, problems };
}

describe("MergedBagIterableSource — initialize (spec §11.3)", () => {
  it("merges start/end extremes, topics, datatypes and problems across shards", async () => {
    const { file, shards } = await makeZipWithShards(
      ["2026-08-20-09-00-00_0.bag", "2026-08-20-09-30-00_1.bag"],
      (index) =>
        new StubShardSource(
          {
            start: time(index === 0 ? 100 : 50),
            end: time(index === 0 ? 200 : 300),
            topics: [{ name: index === 0 ? "/a" : "/b", schemaName: "T" }],
            datatypes: new Map(
              index === 0 ? [["T", { name: "T", definitions: [] }]] : [["U", { name: "U", definitions: [] }]],
            ),
            problems: [{ severity: "warn", message: `shard${index}` }],
          },
          [],
        ),
    );
    const source = mergedWithStubs(file, shards);
    const init = await source.initialize();
    expect(init.start).toEqual(time(50)); // min
    expect(init.end).toEqual(time(300)); // max
    expect(init.topics.map((topic) => topic.name).sort()).toEqual(["/a", "/b"]);
    expect([...init.datatypes.keys()].sort()).toEqual(["T", "U"]);
    expect(init.problems.map((problem) => problem.message)).toEqual(["shard0", "shard1"]);
    expect(init.name).toBe("robot-export-20260820-090000-20260820-100000.zip");
    expect(init.profile).toBe("ros1");
  });

  it("keeps the first datatype on same-topic conflicts and discloses a problem", async () => {
    const { file, shards } = await makeZipWithShards(
      ["2026-08-20-09-00-00_0.bag", "2026-08-20-09-30-00_1.bag"],
      (index) =>
        new StubShardSource(
          {
            topics: [{ name: "/a", schemaName: index === 0 ? "First" : "Second" }],
          },
          [],
        ),
    );
    const init = await mergedWithStubs(file, shards).initialize();
    expect(init.topics).toEqual([{ name: "/a", schemaName: "First" }]);
    expect(init.problems).toEqual([
      expect.objectContaining({ severity: "warn", message: expect.stringContaining("/a") }),
    ]);
  });

  it("merges topicStats by summing counts", async () => {
    const { file, shards } = await makeZipWithShards(
      ["2026-08-20-09-00-00_0.bag", "2026-08-20-09-30-00_1.bag"],
      (index) =>
        new StubShardSource(
          {
            topicStats: new Map([["/a", { numMessages: index === 0 ? 3 : 4 }]]),
          },
          [],
        ),
    );
    const init = await mergedWithStubs(file, shards).initialize();
    expect(init.topicStats.get("/a")).toEqual({ numMessages: 7 });
  });

  it("rejects a foreign zip without manifest.json (edge #17)", async () => {
    const file = await buildZip([bagEntry("2026-08-20-09-00-00_0.bag")]);
    await expect(mergedWithStubs(file, []).initialize()).rejects.toThrow(
      /not a robot export package/,
    );
  });

  it("rejects an unsupported manifest format version (edge #18)", async () => {
    const file = await buildZip([
      bagEntry("2026-08-20-09-00-00_0.bag"),
      {
        name: "manifest.json",
        data: new TextEncoder().encode(
          JSON.stringify({ format: "robot-export-package", formatVersion: 2 }),
        ),
      },
    ]);
    await expect(mergedWithStubs(file, []).initialize()).rejects.toThrow(/upgrade the app/);
  });

  it("rejects a package whose bags/ contains no parseable entries (edge #19/#33)", async () => {
    const file = await buildZip([
      { name: "bags/renamed.bag", data: new Uint8Array(4) },
      { name: "manifest.json", data: new TextEncoder().encode(manifestText([])) },
    ]);
    await expect(mergedWithStubs(file, []).initialize()).rejects.toThrow(/导出包不含 bag/);
  });

  it("skips unreadable shards with a problem and throws when all fail (edge #20)", async () => {
    const failing = {
      initialize: async () => await Promise.reject(new Error("corrupt chunk")),
      messageIterator: () => {
        throw new Error("unused");
      },
      getBackfillMessages: () => {
        throw new Error("unused");
      },
    };
    const file = await buildZip([
      bagEntry("2026-08-20-09-00-00_0.bag"),
      bagEntry("2026-08-20-09-30-00_1.bag"),
      { name: "manifest.json", data: new TextEncoder().encode(manifestText(["a", "b"])) },
    ]);
    const mixed = new MergedBagIterableSource({ type: "file", file }, (entry) =>
      entry.name.endsWith("_0.bag")
        ? new StubShardSource({}, [mkEventResult("/a", time(1), 0)])
        : (failing as unknown as IIterableSource),
    );
    const init = await mixed.initialize();
    expect(init.problems).toEqual([
      expect.objectContaining({ severity: "error", message: expect.stringContaining("已跳过") }),
    ]);

    const allFailing = new MergedBagIterableSource({ type: "file", file }, () => failing as unknown as IIterableSource);
    await expect(allFailing.initialize()).rejects.toThrow(/所有 bag 分片均无法打开/);
  });

  it("discloses unrecognized bag entry names as a problem (edge #33)", async () => {
    const file = await buildZip([
      bagEntry("2026-08-20-09-00-00_0.bag"),
      { name: "bags/stray-name.bag", data: new Uint8Array(4) },
      { name: "manifest.json", data: new TextEncoder().encode(manifestText(["a"])) },
    ]);
    const source = new MergedBagIterableSource(
      { type: "file", file },
      () => new StubShardSource({}, []),
    );
    const init = await source.initialize();
    expect(init.problems).toEqual([
      expect.objectContaining({ message: expect.stringContaining("1 个 bag 条目名未识别") }),
    ]);
  });
});

function mkEventResult(topic: string, receiveTime: Time, payload: number): IteratorResult {
  return { type: "message-event", msgEvent: messageEvent(topic, receiveTime, payload) };
}

describe("MergedBagIterableSource — k-way merge (spec §11.3)", () => {
  it("emits messages from all shards interleaved by receiveTime, duplicates kept", async () => {
    const { file, shards } = await makeZipWithShards(
      ["2026-08-20-09-00-00_0.bag", "2026-08-20-09-30-00_1.bag"],
      (index) =>
        new StubShardSource(
          {},
          index === 0
            ? [mkEventResult("/a", time(1), 10), mkEventResult("/a", time(3), 30)]
            : [mkEventResult("/b", time(2), 20), mkEventResult("/b", time(3), 31), mkEventResult("/b", time(5), 50)],
        ),
    );
    const source = mergedWithStubs(file, shards);
    await source.initialize();
    const { results } = await collectMessages(source);
    // t=3 两分片各有一条(重叠),按分片顺序交错且不去重(决策 #8)。
    expect(results.map((result) => (result as { msgEvent: MessageEvent }).msgEvent.message)).toEqual([
      { value: 10 },
      { value: 20 },
      { value: 30 },
      { value: 31 },
      { value: 50 },
    ]);
  });

  it("forwards stamps from shards as the minimum stamp", async () => {
    const { file, shards } = await makeZipWithShards(
      ["2026-08-20-09-00-00_0.bag", "2026-08-20-09-30-00_1.bag"],
      (index) =>
        new StubShardSource(
          {},
          index === 0
            ? [{ type: "stamp", stamp: time(2) } as IteratorResult, mkEventResult("/a", time(4), 1)]
            : [{ type: "stamp", stamp: time(1) } as IteratorResult, mkEventResult("/b", time(3), 2)],
        ),
    );
    const source = mergedWithStubs(file, shards);
    await source.initialize();
    const { results } = await collectMessages(source);
    expect(results.map((result) => result.type)).toEqual(["stamp", "stamp", "message-event", "message-event"]);
    expect((results[0] as { stamp: Time }).stamp).toEqual(time(1));
    expect((results[1] as { stamp: Time }).stamp).toEqual(time(2));
  });

  it("remaps problem connectionIds to globally unique ids (decision #32)", async () => {
    const { file, shards } = await makeZipWithShards(
      ["2026-08-20-09-00-00_0.bag", "2026-08-20-09-30-00_1.bag"],
      (index) =>
        new StubShardSource(
          {},
          index === 0
            ? [
                {
                  type: "problem",
                  connectionId: 7,
                  problem: { severity: "error", message: "shard0 problem" },
                } as IteratorResult,
              ]
            : [
                {
                  type: "problem",
                  connectionId: 7,
                  problem: { severity: "error", message: "shard1 problem" },
                } as IteratorResult,
              ],
        ),
    );
    const source = mergedWithStubs(file, shards);
    await source.initialize();
    const { problems } = await collectMessages(source);
    // 两分片各自 connectionId=7,映射后全局唯一不串号。
    const ids = problems.map((problem) => problem.connectionId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(new Set(ids).size).toBe(2);
    expect(problems.map((problem) => problem.problem.message)).toEqual([
      "shard0 problem",
      "shard1 problem",
    ]);
  });
});

describe("MergedBagIterableSource — backfill (spec §11.3)", () => {
  it("keeps the latest message per topic across shards", async () => {
    const { file, shards } = await makeZipWithShards(
      ["2026-08-20-09-00-00_0.bag", "2026-08-20-09-30-00_1.bag"],
      (index) =>
        new StubShardSource(
          {},
          [],
          index === 0
            ? [messageEvent("/a", time(10), 1), messageEvent("/b", time(11), 2)]
            : [messageEvent("/a", time(20), 3)],
        ),
    );
    const source = mergedWithStubs(file, shards);
    await source.initialize();
    const messages = await source.getBackfillMessages({ topics: new Map(), time: time(30) });
    expect(messages.map((message) => message.message)).toEqual([{ value: 2 }, { value: 3 }]);
  });
});

describe("MergedBagIterableSource — real-bag smoke (spec §16)", () => {
  it("opens a real bag stored inside a package via the default shard factory", async () => {
    const bagBytes = readFileSync(
      path.join(__dirname, "../../test/fixtures/example.bag"),
    );
    const file = await buildZip([
      { name: "bags/2026-08-20-09-00-00_0.bag", data: new Uint8Array(bagBytes) },
      {
        name: "manifest.json",
        data: new TextEncoder().encode(manifestText(["2026-08-20-09-00-00_0.bag"])),
      },
    ]);
    const source = new MergedBagIterableSource({ type: "file", file });
    const init = await source.initialize();
    expect(init.topics.length).toBeGreaterThan(0);
    expect(init.topicStats.size).toBeGreaterThan(0);
    // 订阅全部话题后应能迭代出真实消息(空订阅在 bag 侧天然无输出)。
    const allTopics = new Map(
      init.topics.map((topic) => [topic.name, { topic: topic.name } as const]),
    );
    let count = 0;
    const iterator = source.messageIterator({ topics: allTopics });
    while (count < 5) {
      const next = await iterator.next();
      if (next.done === true) {
        break;
      }
      count += 1;
    }
    expect(count).toBeGreaterThanOrEqual(5);
  });
});
