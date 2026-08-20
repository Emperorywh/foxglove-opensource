// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { TypeOptions } from "i18next";

export const robotAlarms: Partial<TypeOptions["resources"]["robotAlarms"]> = {
  alarmQueryFailed: "告警查询失败:{{reason}}",
  noAlarms: "没有告警",
  packageNoAlarms: "导出包不含告警数据",
  packageReadFailed: "读取导出包告警数据失败:{{reason}}",
  retry: "重试",
};
