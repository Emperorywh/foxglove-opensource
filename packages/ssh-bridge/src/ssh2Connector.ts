// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Client, SFTPWrapper, Stats } from "ssh2";
import { PassThrough, Readable } from "stream";

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
    const raw = this.#sftp.createReadStream(path, {
      highWaterMark: MAX_BINARY_FRAME_BYTES,
    });
    // Proxy through a PassThrough so ssh2 errors can be remapped to SshErrors exactly
    // once, and so that destroying the returned stream also stops the SFTP read.
    const proxy = new PassThrough({ highWaterMark: MAX_BINARY_FRAME_BYTES });
    raw.on("error", (err: unknown) => {
      proxy.destroy(mapSftpError(err));
    });
    proxy.on("close", () => {
      raw.destroy();
    });
    raw.pipe(proxy);
    return proxy;
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
