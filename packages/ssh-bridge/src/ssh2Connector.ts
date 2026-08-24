// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Client, SFTPWrapper, Stats } from "ssh2";
import { Readable } from "stream";

import {
  ConnectOptions,
  Connector,
  SshEntryType,
  SshError,
  SshFileInfo,
  SshSession,
} from "./SshSession";
import { MAX_BINARY_FRAME_BYTES } from "./protocol";

/**
 * Map SFTP attrs to a directory entry type (SPEC_server_file_export_zip.md §4.2).
 * Servers that omit the permission/type bits report `mode` as undefined; those entries
 * are treated as regular files (download-stage errors cover unreadable ones).
 */
export function entryTypeFromAttrs(attrs: Stats): SshEntryType {
  // The @types/ssh2 declarations mark mode as always present, but servers may omit the
  // permission/type bits, in which case ssh2 leaves it undefined.
  const mode = attrs.mode as number | undefined;
  if (mode == undefined) {
    return "file";
  }
  if (attrs.isDirectory()) {
    return "directory";
  }
  if (attrs.isSymbolicLink()) {
    return "symlink";
  }
  if (attrs.isSocket() || attrs.isFIFO() || attrs.isBlockDevice() || attrs.isCharacterDevice()) {
    return "other";
  }
  return "file";
}

// OpenSSH SFTP status codes relevant to us.
const SSH_FX_NO_SUCH_FILE = 2;
const SSH_FX_PERMISSION_DENIED = 3;

/**
 * 读取机器人时钟与时区用的固定命令(SPEC_robot_export_package.md §4.2):输出形如
 * `1787191264 +0800`。命令串是常量——协议不暴露任何参数化的任意命令执行面。
 * 导出仅供测试断言其恒为该字面量(不得出现参数化命令)。
 */
export const SERVER_TIME_COMMAND = "date '+%s %z'";
/** serverTime 命令的超时(exec 被拒/受限 shell 时及时失败,客户端回退浏览器时区)。 */
const SERVER_TIME_TIMEOUT_MS = 5_000;
/** unixMs 合理性下界:2001-09-09(32 位秒计数溢出日之后即视为现代机器人)。 */
const MIN_REASONABLE_UNIX_MS = 1000000000000;
/** `date` 输出解析:`%s` 秒 + `%z` 偏移([+-]HHMM)。 */
const SERVER_TIME_OUTPUT_RE = /^(\d+)\s+([+-])(\d{2})(\d{2})/;

/**
 * 解析 `date '+%s %z'` 输出(SPEC_robot_export_package.md §4.2)。纯函数,单测覆盖
 * 正/负偏移与各种畸形输出。偏移折算为分钟:本地时间超前 UTC 的分钟数
 * (`+0800` → +480,`-0500` → −300)。
 */
export function parseServerTimeOutput(output: string): {
  unixMs: number;
  tzOffsetMinutes: number;
} {
  const match = SERVER_TIME_OUTPUT_RE.exec(output.trim());
  if (match == undefined) {
    throw new SshError("IO_ERROR", `unparseable date output: ${output.trim().slice(0, 60)}`);
  }
  const seconds = Number(match[1]);
  const sign = match[2] === "-" ? -1 : 1;
  const hours = Number(match[3]);
  const minutes = Number(match[4]);
  const tzOffsetMinutes = sign * (hours * 60 + minutes);
  const unixMs = seconds * 1000;
  // 有限数且晚于 2001-01-01;不合理即失败(客户端按决策 #27 回退浏览器时区)。
  if (!Number.isFinite(unixMs) || unixMs < MIN_REASONABLE_UNIX_MS) {
    throw new SshError("IO_ERROR", `unreasonable server time: ${String(unixMs)}`);
  }
  return { unixMs, tzOffsetMinutes };
}

function mapSftpError(err: unknown): SshError {
  if (err != undefined && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    const message = err instanceof Error ? err.message : String(err);
    if (code === SSH_FX_NO_SUCH_FILE) {
      return new SshError("NO_SUCH_PATH", message);
    }
    if (code === SSH_FX_PERMISSION_DENIED) {
      return new SshError("PERMISSION_DENIED", message);
    }
  }
  return new SshError("IO_ERROR", err instanceof Error ? err.message : String(err));
}

function mapConnectError(err: unknown): SshError {
  const message = err instanceof Error ? err.message : String(err);
  if (err != undefined && typeof err === "object") {
    const record = err as { level?: unknown; code?: unknown };
    if (record.level === "client-authentication") {
      return new SshError("AUTH_FAILED", message);
    }
    if (record.level === "client-timeout" || record.code === "ETIMEDOUT") {
      return new SshError("TIMEOUT", message);
    }
    if (
      record.code === "ENOTFOUND" ||
      record.code === "EAI_AGAIN" ||
      record.code === "EHOSTUNREACH" ||
      record.code === "ENETUNREACH" ||
      record.code === "ECONNREFUSED"
    ) {
      return new SshError("HOST_UNREACHABLE", message);
    }
  }
  return new SshError("IO_ERROR", message);
}

/** 导出仅供测试注入伪造 Client(getServerTime 的 exec 路径单测)。 */
export class Ssh2Session implements SshSession {
  #client: Client;
  #sftp: SFTPWrapper;

  public constructor(client: Client, sftp: SFTPWrapper) {
    this.#client = client;
    this.#sftp = sftp;
  }

  public async list(dir: string): Promise<SshFileInfo[]> {
    const stats = await this.#stat(dir);
    if (!stats.isDirectory()) {
      throw new SshError("NOT_A_DIRECTORY", `${dir} is not a directory`);
    }
    return await new Promise<SshFileInfo[]>((resolve, reject) => {
      this.#sftp.readdir(dir, (err, items) => {
        if (err != undefined) {
          reject(mapSftpError(err));
          return;
        }
        resolve(
          items.map((item) => ({
            name: item.filename,
            size: item.attrs.size,
            mtimeMs: item.attrs.mtime * 1000,
            entryType: entryTypeFromAttrs(item.attrs),
          })),
        );
      });
    });
  }

  public async fileSize(path: string): Promise<number> {
    const stats = await this.#stat(path);
    return stats.size;
  }

  public async realpath(path: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      this.#sftp.realpath(path, (err, absPath) => {
        if (err != undefined) {
          reject(mapSftpError(err));
          return;
        }
        resolve(absPath);
      });
    });
  }

  public async statFollow(
    path: string,
  ): Promise<{ size: number; mtimeMs: number; entryType: SshEntryType }> {
    // sftp.stat follows symlinks (unlike lstat), so the entry type describes the target.
    const stats = await this.#stat(path);
    return {
      size: stats.size,
      mtimeMs: stats.mtime * 1000,
      entryType: entryTypeFromAttrs(stats),
    };
  }

  public async getServerTime(): Promise<{ unixMs: number; tzOffsetMinutes: number }> {
    return await new Promise<{ unixMs: number; tzOffsetMinutes: number }>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn();
        }
      };
      const timer = setTimeout(() => {
        finish(() => {
          reject(new SshError("TIMEOUT", "serverTime command timed out"));
        });
      }, SERVER_TIME_TIMEOUT_MS);
      this.#client.exec(SERVER_TIME_COMMAND, (err, stream) => {
        if (err != undefined) {
          finish(() => {
            reject(new SshError("IO_ERROR", err instanceof Error ? err.message : String(err)));
          });
          return;
        }
        let stdout = "";
        stream.on("data", (chunk: Buffer | string) => {
          stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        stream.on("error", (streamErr: unknown) => {
          finish(() => {
            reject(new SshError("IO_ERROR", streamErr instanceof Error ? streamErr.message : String(streamErr)));
          });
        });
        stream.on("close", () => {
          finish(() => {
            // parseServerTimeOutput 只抛 SshError,原样透传(错误码映射在桥接层)。
            try {
              resolve(parseServerTimeOutput(stdout));
            } catch (parseErr) {
              reject(parseErr as SshError);
            }
          });
        });
      });
    });
  }

  public openReadStream(path: string): Readable {
    // 并行预读流取代 ssh2 的串行 ReadStream(串行把吞吐钉在「单请求字节 ÷ RTT」,
    // 实测 0.85 MB/s;见 ParallelPrefetchReadStream 头注释)。错误经 mapSftpError
    // 映射后恰好一次地从流上抛出,destroy 即停读并关句柄——沿用本方法的既有契约。
    return new ParallelPrefetchReadStream(this.#sftp, path);
  }

  public close(): void {
    this.#client.end();
  }

  public onClose(callback: () => void): void {
    this.#client.on("close", callback);
  }

  async #stat(path: string): Promise<Stats> {
    return await new Promise<Stats>((resolve, reject) => {
      this.#sftp.stat(path, (err, stats) => {
        if (err != undefined) {
          reject(mapSftpError(err));
          return;
        }
        resolve(stats);
      });
    });
  }
}

/**
 * 并行预读参数(2026-08-24 基准,机器人 10.11.2.208 / Wi-Fi):服务端单次 READ
 * 实际返回上限 64KB(请求更大也只回 64KB),16 路并发即可把单条 SSH 通道打到链路
 * 上限——串行 0.85 MB/s,16×64KB ≈ 7.2 MB/s(再往上 32×32KB 仅 +0.1,链路饱和)。
 */
const PREFETCH_CHUNK_BYTES = 64 * 1024;
const PREFETCH_CONCURRENCY = 16;

export type PrefetchOptions = {
  /** 单次 SFTP READ 请求的字节数(生产 64KB;测试注入小值驱动边界)。 */
  chunkBytes?: number;
  /** 未完成 READ 请求的并发上限(生产 16)。 */
  concurrency?: number;
};

/**
 * 并行按序 SFTP 预读流(取代 ssh2 的串行 `createReadStream`)。
 *
 * ssh2 的 ReadStream 同一时刻只保持一个未完成的 SFTP READ(其 `_read` 在回调
 * `push()` 之后才会被 Node 再次调用),吞吐被钉在「单请求字节 ÷ RTT」,与链路
 * 带宽无关。本流改为:并发发出多条按 offset 递增的 READ,完成结果乱序进入
 * pending 表,**只把连续前缀按序交付**——对外仍是一条保序流,桥接的
 * pause/resume、ack 窗口与取消语义零改动。
 *
 * - EOF:open 后先 `fstat` 取文件大小作为精确终点(不发投机读);短读/零读作为
 *   文件收缩时的兜底边界,乱序完成下取各次完成的最小值;
 * - 内存上限 = 在飞 + 待交付 ≤ 并发 × 块大小(1MB),加上流自身高水位 1MB;
 *   交付停滞(push 返回 false)后读前门槛停止发新请求,不会无界堆积;
 * - 错误:任一 READ 失败即 `destroy(mapSftpError(err))` 恰好一次;destroy 后
 *   迟到的完成回调全部忽略,句柄尽力关闭。
 */
export class ParallelPrefetchReadStream extends Readable {
  #sftp: SFTPWrapper;
  #path: string;
  #chunkBytes: number;
  #concurrency: number;
  #readaheadBytes: number;
  #opening = false;
  #handle: Buffer | undefined;
  /** destroy 已发生:迟到的 open/fstat/read 回调据此忽略。 */
  #stopped = false;
  #nextIssueOffset = 0;
  #nextDeliverOffset = 0;
  /** 终点 offset:fstat 大小,或文件收缩时短读/零读给出的更小边界。 */
  #endOffset: number | undefined;
  #outstanding = 0;
  #pending = new Map<number, Buffer>();
  #pushedEnd = false;

  public constructor(sftp: SFTPWrapper, path: string, opts?: PrefetchOptions) {
    super({ highWaterMark: MAX_BINARY_FRAME_BYTES });
    this.#sftp = sftp;
    this.#path = path;
    this.#chunkBytes = opts?.chunkBytes ?? PREFETCH_CHUNK_BYTES;
    this.#concurrency = opts?.concurrency ?? PREFETCH_CONCURRENCY;
    this.#readaheadBytes = this.#chunkBytes * this.#concurrency;
  }

  public override _read(): void {
    if (this.#handle == undefined) {
      this.#openHandle();
      return;
    }
    this.#deliverPending();
    this.#pump();
  }

  #openHandle(): void {
    if (this.#opening) {
      return;
    }
    this.#opening = true;
    this.#sftp.open(this.#path, "r", (err, handle) => {
      this.#opening = false;
      if (this.#stopped) {
        if (err == undefined) {
          this.#closeHandle(handle);
        }
        return;
      }
      if (err != undefined) {
        this.destroy(mapSftpError(err));
        return;
      }
      // 句柄先登记:fstat 期间发生 destroy 时 _destroy 能顺手关掉它。
      this.#handle = handle;
      this.#sftp.fstat(handle, (statErr, stats) => {
        if (this.#stopped) {
          return;
        }
        if (statErr != undefined) {
          this.destroy(mapSftpError(statErr));
          return;
        }
        this.#endOffset = Math.min(this.#endOffset ?? Number.MAX_SAFE_INTEGER, stats.size);
        this.#deliverPending();
        this.#pump();
      });
    });
  }

  #pump(): void {
    const handle = this.#handle;
    if (this.#stopped || handle == undefined) {
      return;
    }
    while (
      this.#outstanding < this.#concurrency &&
      (this.#endOffset == undefined || this.#nextIssueOffset < this.#endOffset) &&
      this.#nextIssueOffset - this.#nextDeliverOffset < this.#readaheadBytes
    ) {
      const offset = this.#nextIssueOffset;
      this.#nextIssueOffset += this.#chunkBytes;
      this.#outstanding += 1;
      const buffer = Buffer.allocUnsafe(this.#chunkBytes);
      this.#sftp.read(handle, buffer, 0, buffer.length, offset, (err, got) => {
        this.#onReadComplete(offset, buffer, err, got);
      });
    }
  }

  #onReadComplete(offset: number, buffer: Buffer, err: Error | undefined, got: number): void {
    this.#outstanding -= 1;
    if (this.#stopped) {
      return;
    }
    if (err != undefined) {
      this.destroy(mapSftpError(err));
      return;
    }
    if (got < buffer.length) {
      // 短读/零读:文件比 fstat 报告的小(收缩)。取最小值,交付到该边界即止。
      const boundary = offset + got;
      this.#endOffset = Math.min(this.#endOffset ?? Number.MAX_SAFE_INTEGER, boundary);
    }
    if (got > 0) {
      this.#pending.set(offset, buffer.subarray(0, got));
    }
    this.#deliverPending();
    this.#pump();
  }

  #deliverPending(): void {
    if (this.#stopped || this.#pushedEnd) {
      return;
    }
    for (;;) {
      const chunk = this.#pending.get(this.#nextDeliverOffset);
      if (chunk == undefined) {
        break;
      }
      this.#pending.delete(this.#nextDeliverOffset);
      this.#nextDeliverOffset += chunk.length;
      if (!this.push(chunk)) {
        // 流缓冲到高水位:剩余留在 pending,等消费端排空后再次 _read 时交付。
        break;
      }
    }
    if (this.#endOffset != undefined && this.#nextDeliverOffset >= this.#endOffset) {
      this.#pushedEnd = true;
      this.push(null); // eslint-disable-line no-restricted-syntax -- Node 流协议:push(null) 即 EOF
    }
  }

  // Node 基类签名以 null 表示"无错误的 destroy";保持一致以可赋值(仓库禁 null 的
  // 例外处理见 webpack.ts 的 ReactNull 同款 disable)。
  public override _destroy(
    err: Error | null, // eslint-disable-line no-restricted-syntax -- Node 基类签名
    callback: (error?: Error | null) => void, // eslint-disable-line no-restricted-syntax -- Node 基类签名
  ): void {
    this.#stopped = true;
    this.#pending.clear();
    const handle = this.#handle;
    this.#handle = undefined;
    if (handle != undefined) {
      this.#closeHandle(handle);
    }
    callback(err);
  }

  #closeHandle(handle: Buffer): void {
    // 尽力而为:会话已断时回调可能永不到来,不做任何记账。
    this.#sftp.close(handle, () => {});
  }
}

export const ssh2Connector: Connector = async (opts: ConnectOptions) => {
  return await new Promise<SshSession>((resolve, reject) => {
    const client = new Client();
    let settled = false;
    client.on("ready", () => {
      client.sftp((err, sftp) => {
        settled = true;
        if (err != undefined) {
          client.end();
          reject(mapSftpError(err));
          return;
        }
        resolve(new Ssh2Session(client, sftp));
      });
    });
    client.on("error", (err: unknown) => {
      if (!settled) {
        settled = true;
        reject(mapConnectError(err));
      }
    });
    client.connect({
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password,
      readyTimeout: opts.timeoutMs,
    });
  });
};
