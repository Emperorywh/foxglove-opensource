// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { contextBridge } from "electron";

// The main process passes the resolved bridge URL via additionalArguments
// (--ssh-bridge-url=ws://...). The renderer reads it in defaultBridgeUrl()
// (ServerExportBridgeClient.ts). Deliberately NOT named "desktopBridge" — that
// global gates closed-source desktop features in isDesktopApp().
const PREFIX = "--ssh-bridge-url=";
const arg = process.argv.find((entry) => entry.startsWith(PREFIX));
const url = arg?.slice(PREFIX.length);
if (url != undefined) {
  contextBridge.exposeInMainWorld("sshBridgeUrl", url);
}
