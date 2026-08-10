// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { AddressInfo } from "net";

import { WebSocketServer, WebSocket } from "ws";

import { BridgeLogger, BridgeTransport, SshBridge } from "./SshBridge";
import { ServerMessage } from "./protocol";
import { ssh2Connector } from "./ssh2Connector";

export const DEFAULT_PORT = 8765;
export const BIND_HOST = "127.0.0.1";

/** BridgeTransport on top of a ws WebSocket. */
class WsTransport implements BridgeTransport {
  #ws: WebSocket;

  public constructor(ws: WebSocket) {
    this.#ws = ws;
  }

  public sendText(message: ServerMessage): void {
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(message));
    }
  }

  public sendBinary(data: Buffer): void {
    if (this.#ws.readyState === WebSocket.OPEN) {
      this.#ws.send(data);
    }
  }

  public close(): void {
    this.#ws.close();
  }
}

const defaultLogger: BridgeLogger = {
  info: (message) => {
    console.debug(`[ssh-bridge] ${message}`);
  },
  error: (message) => {
    console.error(`[ssh-bridge] ${message}`);
  },
};

/**
 * Start the WebSocket-to-SSH/SFTP bridge. Shared by the standalone CLI entry
 * (index.ts) and the Electron desktop shell, which embeds the bridge in its
 * main process so users don't have to run it separately.
 */
export function startBridgeServer(port: number, logger: BridgeLogger = defaultLogger): WebSocketServer {
  const bridge = new SshBridge({ connect: ssh2Connector, logger });

  const wss = new WebSocketServer({ host: BIND_HOST, port });
  wss.on("listening", () => {
    // `port` may be 0 (ephemeral), so report the actually bound port.
    const boundPort = (wss.address() as AddressInfo).port;
    logger.info(`listening on ws://${BIND_HOST}:${boundPort}`);
  });
  wss.on("connection", (ws) => {
    const transport = new WsTransport(ws);
    const session = bridge.handleConnection(transport);
    // The isBinary flag is part of the ws library's message event signature.
    // eslint-disable-next-line @foxglove/no-boolean-parameters
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        session.handleBinary(data);
      } else {
        session.handleText(data.toString("utf-8"));
      }
    });
    ws.on("close", () => {
      bridge.detach(session);
      session.destroy();
    });
    ws.on("error", () => {
      bridge.detach(session);
      session.destroy();
    });
  });

  return wss;
}
