// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Client, SFTPWrapper, Stats } from "ssh2";
import { PassThrough, Readable } from "stream";

import { ConnectOptions, Connector, SshError, SshFileInfo, SshSession } from "./SshSession";
import { MAX_BINARY_FRAME_BYTES } from "./protocol";

// OpenSSH SFTP status codes relevant to us.
const SSH_FX_NO_SUCH_FILE = 2;
const SSH_FX_PERMISSION_DENIED = 3;

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

class Ssh2Session implements SshSession {
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
            isDirectory: item.attrs.isDirectory(),
          })),
        );
      });
    });
  }

  public async fileSize(path: string): Promise<number> {
    const stats = await this.#stat(path);
    return stats.size;
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
