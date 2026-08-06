// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { WebSocketServer, WebSocket } from "ws";

import { BridgeTransport, SshBridge } from "./SshBridge";
import { ServerMessage } from "./protocol";
import { ssh2Connector } from "./ssh2Connector";

const DEFAULT_PORT = 8765;
const BIND_HOST = "127.0.0.1";

function parsePort(argv: string[]): number {
  const flagIndex = argv.indexOf("--port");
  const raw = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  if (raw == undefined) {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`invalid --port value: ${raw}`);
    process.exit(1);
  }
  return port;
}

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

function main(): void {
  const port = parsePort(process.argv.slice(2));
  const bridge = new SshBridge({
    connect: ssh2Connector,
    logger: {
      info: (message) => {
        console.debug(`[ssh-bridge] ${message}`);
      },
      error: (message) => {
        console.error(`[ssh-bridge] ${message}`);
      },
    },
  });

  const wss = new WebSocketServer({ host: BIND_HOST, port });
  wss.on("listening", () => {
    console.debug(`[ssh-bridge] listening on ws://${BIND_HOST}:${port}`);
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

  process.on("SIGINT", () => {
    wss.close();
    process.exit(0);
  });
}

main();
