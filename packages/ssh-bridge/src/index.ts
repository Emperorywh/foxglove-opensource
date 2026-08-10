// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { DEFAULT_PORT, startBridgeServer } from "./server";

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

function main(): void {
  const port = parsePort(process.argv.slice(2));
  const wss = startBridgeServer(port);

  process.on("SIGINT", () => {
    wss.close();
    process.exit(0);
  });
}

main();
