// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  IconButton,
  InputAdornment,
  LinearProgress,
  TextField,
  Typography,
} from "@mui/material";
import { TFunction } from "i18next";
import { useSnackbar } from "notistack";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles } from "tss-react/mui";

import { AppSetting } from "@foxglove/studio-base/AppSetting";
import { fetchRobotStatus } from "@foxglove/studio-base/components/PlaybackControls/alarms/fetchRobotStatus";
import Stack from "@foxglove/studio-base/components/Stack";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { useWorkspaceActions } from "@foxglove/studio-base/context/Workspace/useWorkspaceActions";
import { useAppConfigurationValue } from "@foxglove/studio-base/hooks/useAppConfigurationValue";
import { useRobotAlarmConfiguration } from "@foxglove/studio-base/hooks/useRobotAlarmConfiguration";

import { ServerExportBridgeClient, ServerExportError, ServerExportErrorCode } from "./ServerExportBridgeClient";
import {
  buildExportManifest,
  ExportManifestAlarms,
  ExportManifestBag,
  serializeExportManifest,
} from "./exportManifest";
import {
  BagCandidate,
  browserTzOffsetMinutes,
  formatNaiveDisplay,
  naiveToUnixMs,
  normalizeNaiveTime,
  selectBagsForExport,
  unixMsToNaiveKey,
} from "./selectBagsForExport";
import {
  ServerExportTarget,
  ServerExportWritable,
  desktopExportFs,
  pickExportTarget,
} from "./serverExportTarget";
import {
  ServerExportZipWriter,
  createZipWriter,
  resolveZipNameConflict,
  robotExportZipFileName,
} from "./serverExportZip";

/**
 * 机器人数据导出包 UI(docs/SPEC_robot_export_package.md §9):任务式表单 →
 * 预览 → 导出 → 汇总 的单一路径(决策 #9,取代旧浏览式导出)。
 *
 * - Step A 任务表单:IP/SSH 端口/告警端口/用户名/密码(记住+明文/密文切换)/bag
 *   路径/日志路径/起止时间(机器人时区)/本地导出目录/包含日志(默认勾选);除
 *   时间/目录/包含日志外全部持久化(决策 #10,含密码——应用户要求);
 * - Step B 预览(决策 #11):连接 → serverTime(失败按决策 #27 回退)→ list bag
 *   目录 → §6 筛选 → 日志递归(§4.3)→ 告警试连(非致命);
 * - Step C 导出(决策 #28):立即并发发起正式告警查询,与 SFTP 下载并行;logs
 *   写完后主动断开桥接(§9.3);随后写 alarms.json 与 manifest;
 * - Step D 汇总:警告组 + [重试失败项](整包重跑,决策 #20)+ [立即导入播放]
 *   (决策 #24;0-bag 包不出且明示仅归档)。
 */

const DEFAULT_SSH_PORT = "22";
const DEFAULT_BAG_PATH = "/home/rxx/bkbagfiles";
const DEFAULT_LOG_PATH = "/var/log/robot";

/** 日志递归深度上限(§4.3):触及上限的子树跳过并计数,不静默截断。 */
const LOG_RECURSION_DEPTH_LIMIT = 16;
/** 预览告警试连的小窗口(§9.2):[end−60s, end],结果丢弃、非致命。 */
const ALARM_PROBE_WINDOW_MS = 60_000;
/** 机器人时钟与本地偏差告警阈值(决策 #30)。 */
const CLOCK_SKEW_WARN_MS = 5 * 60_000;
/** 传输速率统计(仅展示,§9.3):滑动窗口内按累计字节差估算,采样节流、每秒结算。 */
const SPEED_WINDOW_MS = 10_000;
const SPEED_SAMPLE_MIN_INTERVAL_MS = 250;
const SPEED_TICK_MS = 1000;

type Step = "form" | "preview" | "exporting" | "summary";

/** 失败原因码:桥接错误码 + 本地语义。 */
type FailureCode = ServerExportErrorCode | "CANCELED" | "ZIP_ABORTED";

type LogFile = {
  /** 下载目标(canonical 绝对路径)。 */
  path: string;
  /** zip 条目名:logs/ + 相对路径。 */
  entryName: string;
  displayName: string;
  size: number;
  mtimeMs: number;
};

type ServerTimeInfo = {
  tzOffsetMinutes: number;
  tzSource: "server" | "browser-assumed";
  /** 机器人当前 Unix ms;回退模式下为浏览器本地假定(§5)。 */
  robotUnixMs: number;
};

type PreviewData = {
  serverTime: ServerTimeInfo;
  /** |robotUnixMs − Date.now()|;回退模式下 undefined(偏差检查跳过)。 */
  clockSkewMs: number | undefined;
  /** 已按 §5 钳制的 naive 起止比较键。 */
  startKey: string;
  endKey: string;
  clampedEnd: boolean;
  startUnixMs: number;
  endUnixMs: number;
  bagCandidates: BagCandidate[];
  predecessorCount: number;
  skippedActive: number;
  skippedUnrecognized: number;
  /** logPath 列举失败(勾选日志时为预览错误;取消勾选后可继续,§9.2)。 */
  logError: string | undefined;
  logFiles: LogFile[];
  deepSkippedDirs: number;
  activeSkippedInLogs: number;
  alarmReachable: boolean;
  alarmProbeError: string | undefined;
};

type ExportPhase =
  | { kind: "bags"; index: number; total: number }
  | { kind: "logs"; index: number; total: number }
  | { kind: "alarms" }
  | { kind: "manifest" };

type ExportItem = {
  entryName: string;
  displayName: string;
  size: number;
  status: "pending" | "active" | "success" | "failed" | "notStarted";
  reasonCode?: FailureCode;
  reasonDetail?: string;
};

type SummaryState = {
  zipName: string;
  succeeded: boolean;
  /** 成功组的警告(§9.4:告警失败原因、active 跳过数、未识别名、browser-assumed)。 */
  warnings: string[];
  failure?: { code: FailureCode; detail: string };
  leftoverZip?: string;
  /** 导出包是否含 bag(0-bag「仍导出」的包不可播放,§9.4)。 */
  hasBags: boolean;
};

type ExportSession = {
  cancelRequested: boolean;
};

/** 速率滑动窗口样本:某时刻的累计已传输字节。 */
type SpeedSample = { timeMs: number; totalBytes: number };

/** 定时结算出的传输速率与预计剩余时间(展示用;字节累计走 ref)。 */
type TransferRate = { bytesPerSecond: number; etaSeconds: number | undefined };

const useStyles = makeStyles()((theme) => ({
  content: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    height: "100%",
    gap: theme.spacing(2),
    overflowY: "auto",
    padding: theme.spacing(3, 4, 0),
  },
  monoName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  warningText: {
    color: theme.palette.warning.main,
  },
  errorText: {
    color: theme.palette.error.main,
    fontWeight: 600,
  },
}));

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value >= 100 ? 0 : 1);
  return `${rounded} ${units[unit] ?? ""}`;
}

/** ETA 时长文案:最多取两级单位(1 小时 23 分 / 4 分 05 秒 / 45 秒)。 */
function formatEtaDuration(seconds: number, t: TFunction<"openDialog">): string {
  const total = Math.max(1, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${t("serverExportEtaHour", { value: hours })} ${t("serverExportEtaMinute", { value: minutes })}`;
  }
  if (minutes > 0) {
    return `${t("serverExportEtaMinute", { value: minutes })} ${t("serverExportEtaSecond", { value: secs })}`;
  }
  return t("serverExportEtaSecond", { value: secs });
}

function errorText(t: TFunction<"openDialog">, code: FailureCode): string {
  switch (code) {
    case "AUTH_FAILED":
      return t("serverExportErrorAuthFailed");
    case "HOST_UNREACHABLE":
      return t("serverExportErrorHostUnreachable");
    case "TIMEOUT":
      return t("serverExportErrorTimeout");
    case "NO_SUCH_PATH":
      return t("serverExportErrorNoSuchPath");
    case "NOT_A_DIRECTORY":
      return t("serverExportErrorNotADirectory");
    case "PERMISSION_DENIED":
      return t("serverExportErrorPermissionDenied");
    case "DISCONNECTED":
      return t("serverExportErrorDisconnected");
    case "BRIDGE_UNREACHABLE":
      return t("serverExportErrorBridgeUnreachable");
    case "BRIDGE_INVALID_HELLO":
      return t("serverExportErrorBridgeInvalidHello");
    case "BRIDGE_VERSION_MISMATCH":
      return t("serverExportErrorBridgeVersionMismatch");
    case "LOCAL_WRITE_ERROR":
      return t("serverExportErrorLocalWrite");
    case "CANCELED":
      return t("serverExportErrorCanceled");
    case "ZIP_ABORTED":
      return t("serverExportErrorZipAborted");
    case "IO_ERROR":
      return t("serverExportErrorIo");
    case "BAD_REQUEST":
    default:
      return t("serverExportErrorUnknown");
  }
}

function joinRemotePath(dir: string, name: string): string {
  return `${dir === "/" ? "" : dir}/${name}`;
}

/** naive 比较键 → datetime-local 输入值(快捷范围回填用)。 */
function keyToDatetimeLocal(key: string): string {
  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${key.slice(8, 10)}:${key.slice(10, 12)}:${key.slice(12, 14)}`;
}

/** 浏览器当前时刻(本地时区)→ datetime-local 输入值(决策 #30:连接前可用)。 */
function datetimeLocalNow(offsetMs = 0): string {
  const date = new Date(Date.now() + offsetMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

type CollectedLogs = {
  files: LogFile[];
  deepSkippedDirs: number;
  activeSkipped: number;
};

/**
 * 日志目录递归全量列举(§4.3,决策 #3:mtime 不过滤)。客户端从 logPath 起深度
 * 优先遍历;以 list 响应的 canonical path 建 visited 集合去环;深度上限 16 防御,
 * 触及上限的子树跳过并计数(预览/汇总披露,不静默截断)。任一层 list 失败抛出
 * (调用方按 §14 处理为预览错误)。
 */
async function collectLogFiles(
  client: ServerExportBridgeClient,
  rootPath: string,
): Promise<CollectedLogs> {
  const files: LogFile[] = [];
  const visited = new Set<string>();
  let deepSkippedDirs = 0;
  let activeSkipped = 0;
  const stack: { path: string; rel: string; depth: number }[] = [
    { path: rootPath, rel: "", depth: 0 },
  ];
  while (stack.length > 0) {
    const { path, rel, depth } = stack.pop()!;
    const result = await client.list(path);
    const canonical = result.path;
    if (visited.has(canonical)) {
      continue;
    }
    visited.add(canonical);
    // 子目录先压栈(后访问),保持目录内文件先于子目录落盘——展示顺序无所谓,
    // 但 zip 内条目顺序稳定(遍历顺序,§7.2)。
    const subdirs: { path: string; rel: string }[] = [];
    for (const entry of result.entries) {
      if (entry.kind === "dir") {
        if (depth + 1 > LOG_RECURSION_DEPTH_LIMIT) {
          deepSkippedDirs += 1;
          continue;
        }
        subdirs.push({ path: joinRemotePath(canonical, entry.name), rel: `${rel}${entry.name}/` });
      } else if (entry.kind === "active") {
        // 日志目录里理论上不该有 .bag.active——跳过并计数(§4.3)。
        activeSkipped += 1;
      } else {
        files.push({
          path: joinRemotePath(canonical, entry.name),
          entryName: `logs/${rel}${entry.name}`,
          displayName: `${rel}${entry.name}`,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
        });
      }
    }
    for (const subdir of subdirs.reverse()) {
      stack.push({ ...subdir, depth: depth + 1 });
    }
  }
  return { files, deepSkippedDirs, activeSkipped };
}

export default function ServerExport(): JSX.Element {
  const { classes } = useStyles();
  const { t } = useTranslation("openDialog");
  const { enqueueSnackbar } = useSnackbar();
  const { dialogActions } = useWorkspaceActions();
  const { selectSource } = usePlayerSelection();

  // 浏览器经 File System Access API 写盘;桌面走 Electron 注入的 IPC fs 桥。
  const supportsLocalExport = desktopExportFs() != undefined || "showDirectoryPicker" in window;

  // ----- Step A 表单状态 -----
  // IP 与告警服务 host 双向联动(沿用);告警端口与 robotAlarm.port 双向联动(§3)。
  const { host: configuredHost, setHost: saveConfiguredHost, port: configuredAlarmPort, setPort: saveConfiguredAlarmPort } =
    useRobotAlarmConfiguration();
  const [step, setStep] = useState<Step>("form");
  // 持久化字段的初始值:AppConfiguration 同步读取(useAppConfigurationValue 首渲染
  // 即返回存储值),useState 惰性初始化仅取首渲染快照——与"下次预填"语义一致。
  const [storedSshPort, persistSshPort] = useAppConfigurationValue<string>(
    AppSetting.ROBOT_EXPORT_SSH_PORT,
  );
  const [storedUsername, persistUsername] = useAppConfigurationValue<string>(
    AppSetting.ROBOT_EXPORT_USERNAME,
  );
  const [storedBagPath, persistBagPath] = useAppConfigurationValue<string>(
    AppSetting.ROBOT_EXPORT_BAG_PATH,
  );
  const [storedLogPath, persistLogPath] = useAppConfigurationValue<string>(
    AppSetting.ROBOT_EXPORT_LOG_PATH,
  );
  const [storedPassword, persistPassword] = useAppConfigurationValue<string>(
    AppSetting.ROBOT_EXPORT_PASSWORD,
  );
  const [host, setHost] = useState(configuredHost);
  const [sshPort, setSshPort] = useState(storedSshPort ?? DEFAULT_SSH_PORT);
  const [alarmPort, setAlarmPort] = useState(configuredAlarmPort);
  const [username, setUsername] = useState(storedUsername ?? "");
  // 密码一并记住(决策 #10 修订:应用户要求),输入框支持明文/密文切换。
  const [password, setPassword] = useState(storedPassword ?? "");
  const [showPassword, setShowPassword] = useState(false);
  const [bagPath, setBagPath] = useState(storedBagPath ?? DEFAULT_BAG_PATH);
  const [logPath, setLogPath] = useState(storedLogPath ?? DEFAULT_LOG_PATH);
  const [startLocal, setStartLocal] = useState(() => datetimeLocalNow(-60 * 60 * 1000));
  const [endLocal, setEndLocal] = useState(() => datetimeLocalNow());
  // 包含日志不持久化,每次打开默认勾选(决策 #17)。
  const [includeLogs, setIncludeLogs] = useState(true);
  const [dirName, setDirName] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [alertText, setAlertText] = useState<string>();
  const [busy, setBusy] = useState(false);

  // ----- 预览/导出/汇总状态 -----
  const [preview, setPreview] = useState<PreviewData>();
  const [items, setItems] = useState<ExportItem[]>([]);
  const [progress, setProgress] = useState<{ total: number; completed: number }>({
    total: 0,
    completed: 0,
  });
  const [currentEntry, setCurrentEntry] = useState<string>();
  // 速率/ETA:逐 chunk 只累计到 ref,由下方定时器按滑动窗口每秒结算一次。
  const [transferRate, setTransferRate] = useState<TransferRate>({
    bytesPerSecond: 0,
    etaSeconds: undefined,
  });
  const [phase, setPhase] = useState<ExportPhase>({ kind: "bags", index: 0, total: 0 });
  const [canceling, setCanceling] = useState(false);
  const [summary, setSummary] = useState<SummaryState>();
  const [connectionLost, setConnectionLost] = useState(false);

  const clientRef = useRef<ServerExportBridgeClient>();
  const targetRef = useRef<ServerExportTarget>();
  const sessionRef = useRef<ExportSession>();
  /** 速率统计的 ref 侧镜像(progress state 的字节累计,免逐 chunk 读 state)。 */
  const completedBytesRef = useRef(0);
  const totalBytesRef = useRef(0);
  const speedSamplesRef = useRef<SpeedSample[]>([]);
  /** 本次会话的 zip 名(重试沿用,§7.1)。 */
  const zipNameRef = useRef<string>();
  const writerRef = useRef<ServerExportZipWriter>();
  const currentWritableRef = useRef<{ writable: ServerExportWritable; name: string }>();
  const alarmAbortRef = useRef<AbortController>();
  /** logs 写完后已主动断开桥接——此后的 WS 断开/sshClosed 不触发作废(§9.3/§14)。 */
  const bridgeTeardownRef = useRef(false);
  const tRef = useRef(t);
  tRef.current = t;

  // 持久化(§9.1):除时间/目录/包含日志外全部 AppConfiguration(键值声明见上方
  // useAppConfigurationValue 调用,setter 在连接成功时统一写回;密码一并写回)。

  // ----- 拆卸(关闭对话框/卸载:进行中的导出按取消处理) -----
  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (session != undefined) {
        session.cancelRequested = true;
      }
      alarmAbortRef.current?.abort();
      const client = clientRef.current;
      if (client != undefined) {
        client.cancelDownload();
        client.disconnect();
      }
      const writer = writerRef.current;
      if (writer != undefined) {
        writerRef.current = undefined;
        void writer.abort().catch(() => undefined);
      }
      const current = currentWritableRef.current;
      if (current != undefined) {
        void current.writable.abort().catch(() => undefined);
        void targetRef.current?.removeEntry(current.name).catch(() => undefined);
      }
    };
  }, []);

  const replaceClient = useCallback((client: ServerExportBridgeClient | undefined) => {
    clientRef.current?.disconnect();
    clientRef.current = client;
  }, []);

  // 导出中每秒结算一次速率/ETA:窗口内(累计字节差 ÷ 墙钟差,含停顿时长,
  // 停顿时速率自然衰减);无样本差或已停传 → 速率 0、ETA 不展示。
  useEffect(() => {
    if (step !== "exporting") {
      return;
    }
    const id = setInterval(() => {
      const samples = speedSamplesRef.current;
      const now = Date.now();
      while (samples.length > 1 && now - samples[0]!.timeMs > SPEED_WINDOW_MS) {
        samples.shift();
      }
      const oldest = samples[0];
      const newest = samples[samples.length - 1];
      let bytesPerSecond = 0;
      if (oldest != undefined && newest != undefined) {
        const elapsedSec = (now - oldest.timeMs) / 1000;
        if (elapsedSec > 0) {
          bytesPerSecond = Math.max(0, (newest.totalBytes - oldest.totalBytes) / elapsedSec);
        }
      }
      const remainingBytes = Math.max(0, totalBytesRef.current - completedBytesRef.current);
      setTransferRate({
        bytesPerSecond,
        etaSeconds: bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : undefined,
      });
    }, SPEED_TICK_MS);
    return () => {
      clearInterval(id);
    };
  }, [step]);

  const makeClient = useCallback(() => {
    const client = new ServerExportBridgeClient();
    client.onSshClosed = (_reason, message) => {
      // 主动断开之后的 sshClosed 不再视为失败(§9.3/边界 #31)。
      if (bridgeTeardownRef.current) {
        return;
      }
      setConnectionLost(true);
      setAlertText(message || tRef.current("serverExportConnectionLost"));
    };
    client.onBridgeDisconnected = () => {
      if (bridgeTeardownRef.current) {
        return;
      }
      setConnectionLost(true);
      setAlertText(tRef.current("serverExportConnectionLost"));
    };
    return client;
  }, []);

  /** 打开桥接并连接 SSH(抛 ServerExportError)。 */
  const connectBridge = useCallback(async (): Promise<ServerExportBridgeClient> => {
    const client = makeClient();
    await client.open();
    try {
      await client.connectSsh({
        host: host.trim(),
        port: Number(sshPort),
        username: username.trim(),
        password,
      });
    } catch (err) {
      client.disconnect();
      throw err;
    }
    return client;
  }, [makeClient, host, sshPort, username, password]);

  const validateForm = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    if (host.trim() === "") {
      errors.host = t("serverExportValidationRequired");
    }
    for (const [key, value] of [
      ["sshPort", sshPort],
      ["alarmPort", alarmPort],
    ] as const) {
      const portNum = Number(value);
      if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
        errors[key] = t("serverExportValidationPort");
      }
    }
    if (username.trim() === "") {
      errors.username = t("serverExportValidationRequired");
    }
    if (password === "") {
      errors.password = t("serverExportValidationRequired");
    }
    for (const [key, value] of [
      ["bagPath", bagPath],
      ["logPath", logPath],
    ] as const) {
      if (!value.trim().startsWith("/")) {
        errors[key] = t("serverExportValidationAbsolutePath");
      }
    }
    const startKey = normalizeNaiveTime(startLocal);
    const endKey = normalizeNaiveTime(endLocal);
    if (startKey == undefined || endKey == undefined || startKey >= endKey) {
      errors.timeRange = t("serverExportValidationTimeRange");
    }
    if (targetRef.current == undefined) {
      errors.directory = t("serverExportNoDirectorySelected");
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [host, sshPort, alarmPort, username, password, bagPath, logPath, startLocal, endLocal, t]);

  /**
   * 预览数据采集(§9.2):serverTime(失败按决策 #27 回退)→ list bag 目录 →
   * §6 筛选 →(勾选日志时)日志递归 → 告警试连(小窗口,非致命)。列出的目录
   * 会被桥接记入 visited-dirs,供后续 download 校验。
   */
  const collectPreview = useCallback(
    async (
      client: ServerExportBridgeClient,
      opts: { includeLogs: boolean },
    ): Promise<PreviewData> => {
      // serverTime:失败(exec 被拒/受限 shell/超时/解析失败)回退浏览器时区——
      // 符号必须取负(getTimezoneOffset 符号相反,决策 #27);回退模式下
      // robotNowNaive 以浏览器本地时刻假定(§5)。
      let serverTime: ServerTimeInfo;
      try {
        const result = await client.requestServerTime();
        serverTime = {
          tzOffsetMinutes: result.tzOffsetMinutes,
          tzSource: "server",
          robotUnixMs: result.unixMs,
        };
      } catch {
        serverTime = {
          tzOffsetMinutes: browserTzOffsetMinutes(),
          tzSource: "browser-assumed",
          robotUnixMs: Date.now(),
        };
      }
      const clockSkewMs =
        serverTime.tzSource === "server"
          ? Math.abs(serverTime.robotUnixMs - Date.now())
          : undefined;

      const startKey = normalizeNaiveTime(startLocal)!;
      // end 钳制(决策 #23):endNaive > robotNowNaive 时按机器人当前时间钳制。
      const robotNowNaive = unixMsToNaiveKey(serverTime.robotUnixMs, serverTime.tzOffsetMinutes);
      const requestedEndKey = normalizeNaiveTime(endLocal)!;
      const clampedEnd = requestedEndKey > robotNowNaive;
      const endKey = clampedEnd ? robotNowNaive : requestedEndKey;

      const bagListing = await client.list(bagPath.trim());
      const selection = selectBagsForExport({
        entries: bagListing.entries,
        startNaive: startLocal,
        endNaive: keyToDatetimeLocal(endKey),
      });

      let logFiles: LogFile[] = [];
      let deepSkippedDirs = 0;
      let activeSkipped = 0;
      let logError: string | undefined;
      if (opts.includeLogs) {
        try {
          const collected = await collectLogFiles(client, logPath.trim());
          logFiles = collected.files;
          deepSkippedDirs = collected.deepSkippedDirs;
          activeSkipped = collected.activeSkipped;
        } catch (err) {
          const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
          logError = `${errorText(tRef.current, code)}${
            err instanceof Error && err.message !== "" ? ` — ${err.message}` : ""
          }`;
        }
      }

      // 告警试连(§9.2):小窗口查询,结果丢弃,非致命(决策 #12)。
      const startUnixMs = naiveToUnixMs(startKey, serverTime.tzOffsetMinutes);
      const endUnixMs = naiveToUnixMs(endKey, serverTime.tzOffsetMinutes);
      let alarmReachable = true;
      let alarmProbeError: string | undefined;
      try {
        await fetchRobotStatus({
          host: host.trim(),
          port: alarmPort,
          startMs: endUnixMs - ALARM_PROBE_WINDOW_MS,
          stopMs: endUnixMs,
        });
      } catch (err) {
        alarmReachable = false;
        alarmProbeError = err instanceof Error ? err.message : String(err);
      }

      return {
        serverTime,
        clockSkewMs,
        startKey,
        endKey,
        clampedEnd,
        startUnixMs,
        endUnixMs,
        bagCandidates: selection.selected,
        predecessorCount: selection.selected.filter((bag) => bag.role === "predecessor").length,
        skippedActive: selection.skippedActive,
        skippedUnrecognized: selection.skippedUnrecognized,
        logError,
        logFiles,
        deepSkippedDirs,
        activeSkippedInLogs: activeSkipped,
        alarmReachable,
        alarmProbeError,
      };
    },
    [startLocal, endLocal, bagPath, logPath, host, alarmPort],
  );

  /** 连接成功时写回持久化(决策 #10,含密码)+ host/告警端口联动(§3)。 */
  const persistSettings = useCallback(async () => {
    void saveConfiguredHost(host.trim());
    void saveConfiguredAlarmPort(alarmPort);
    void persistSshPort(sshPort);
    void persistUsername(username.trim());
    void persistBagPath(bagPath.trim());
    void persistLogPath(logPath.trim());
    void persistPassword(password);
  }, [
    host,
    alarmPort,
    sshPort,
    username,
    bagPath,
    logPath,
    password,
    saveConfiguredHost,
    saveConfiguredAlarmPort,
    persistSshPort,
    persistUsername,
    persistBagPath,
    persistLogPath,
    persistPassword,
  ]);

  const onConnectAndPreview = useCallback(async () => {
    if (!validateForm()) {
      // 未选目录是表单里唯一没有输入框落点的校验错误:除了提示文字标红,
      // 再弹一次 toast,确保用户点「连接并预览」后有明确反馈。
      if (targetRef.current == undefined) {
        enqueueSnackbar(t("serverExportNoDirectorySelected"), { variant: "warning" });
      }
      return;
    }
    setBusy(true);
    setAlertText(undefined);
    setConnectionLost(false);
    bridgeTeardownRef.current = false;
    try {
      const client = await connectBridge();
      replaceClient(client);
      // 决策 #10:连接成功即写回持久化(含 host/告警端口联动)。
      await persistSettings();
      const data = await collectPreview(client, { includeLogs });
      setPreview(data);
      // bagPath 列举失败会直接抛到 catch(预览错误,必须返回修改,§14);
      // 仅日志失败保留在 preview.logError(取消勾选后可继续)。
      setStep("preview");
    } catch (err) {
      replaceClient(undefined);
      const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
      setAlertText(
        `${errorText(t, code)}${err instanceof Error && err.message !== "" ? ` — ${err.message}` : ""}`,
      );
    } finally {
      setBusy(false);
    }
  }, [
    validateForm,
    connectBridge,
    replaceClient,
    persistSettings,
    collectPreview,
    includeLogs,
    t,
    enqueueSnackbar,
  ]);

  const onPickDirectory = useCallback(async () => {
    try {
      const target = await pickExportTarget();
      if (target == undefined) {
        return; // 用户取消选择
      }
      targetRef.current = target;
      setDirName(target.displayName);
    } catch {
      setAlertText(errorText(t, "LOCAL_WRITE_ERROR"));
    }
  }, [t]);

  // ----- Step C:导出 -----

  /**
   * 下载一个条目并写入 zip;取消时返回 canceled。onStart 时以 fileStart 的真实
   * size 修正份额并开条目(expectedSize 使本地头可直接以 zip64 形态写出,§8.1)。
   */
  const downloadIntoZip = useCallback(
    async (opts: {
      client: ServerExportBridgeClient;
      writer: ServerExportZipWriter;
      item: ExportItem;
      path: string;
      mtimeMs: number;
      onBytes: (chunkBytes: number) => void;
      /** fileStart 真实 size 与已知 size 的偏差 → 修正总进度份额(§8.1)。 */
      onSizeCorrection: (deltaBytes: number) => void;
    }): Promise<{ canceled: boolean; bytes?: number }> => {
      const { client, writer, item, path, mtimeMs, onBytes, onSizeCorrection } = opts;
      const knownSize = item.size;
      const outcome = await client.download(path, {
        onStart: (_name, size) => {
          if (size !== knownSize) {
            onSizeCorrection(size - knownSize);
          }
          setItems((prev) =>
            prev.map((entry) => (entry.entryName === item.entryName ? { ...entry, size } : entry)),
          );
          writer.beginEntry(item.entryName, mtimeMs, size);
        },
        onData: async (chunk) => {
          await writer.pushEntryChunk(chunk);
          onBytes(chunk.byteLength);
        },
      });
      if (outcome.status !== "completed") {
        return { canceled: true };
      }
      await writer.endEntry(outcome.bytes);
      return { canceled: false, bytes: outcome.bytes };
    },
    [],
  );

  /** 把告警原始响应/manifest 之类的小文本写成一个条目。 */
  const writeTextEntry = useCallback(
    async (writer: ServerExportZipWriter, name: string, text: string): Promise<void> => {
      const bytes = new TextEncoder().encode(text);
      writer.beginEntry(name, Date.now(), bytes.byteLength);
      await writer.pushEntryChunk(bytes);
      await writer.endEntry(bytes.byteLength);
    },
    [],
  );

  /**
   * 导出主流程(§9.3)。`opts.retry` 时沿用同一 zip 名(决策 #20);重试前由调用
   * 方保证桥接可用(WS 断开先静默重连+SSH,密码在内存)与目录已重新 list。
   */
  const runExport = useCallback(
    async (data: PreviewData, opts: { retry: boolean }) => {
      const client = clientRef.current;
      const target = targetRef.current;
      if (client == undefined || target == undefined) {
        return;
      }
      const session: ExportSession = { cancelRequested: false };
      sessionRef.current = session;
      setCanceling(false);
      bridgeTeardownRef.current = false;
      setConnectionLost(false);
      setAlertText(undefined);
      setStep("exporting");
      if (!opts.retry) {
        zipNameRef.current = undefined; // 新导出会话换新名(§7.1)
      }
      zipNameRef.current ??= await resolveZipNameConflict(
        robotExportZipFileName(data.startKey, data.endKey),
        async (name) => await target.exists(name),
      );
      const zipName = zipNameRef.current;

      const bagItems: ExportItem[] = data.bagCandidates.map((bag) => ({
        entryName: `bags/${bag.name}`,
        displayName: bag.name,
        size: bag.size,
        status: "pending",
      }));
      const logItems: ExportItem[] = data.logFiles.map((file) => ({
        entryName: file.entryName,
        displayName: file.displayName,
        size: file.size,
        status: "pending",
      }));
      const allItems = [...bagItems, ...logItems];
      setItems(allItems);
      const totalBytes = allItems.reduce((acc, item) => acc + item.size, 0);
      setProgress({ total: totalBytes, completed: 0 });
      // 速率/ETA 统计基线:ref 镜像 + 窗口样本(种子样本保证首秒即有速率)。
      totalBytesRef.current = totalBytes;
      completedBytesRef.current = 0;
      speedSamplesRef.current = [{ timeMs: Date.now(), totalBytes: 0 }];
      setTransferRate({ bytesPerSecond: 0, etaSeconds: undefined });

      let writable: ServerExportWritable;
      try {
        writable = await target.createWritable(zipName);
      } catch (err) {
        // 本地产物都建不出来——什么都没开始(§14)。
        const detail = err instanceof Error ? err.message : String(err);
        setItems((prev) => prev.map((item) => ({ ...item, status: "notStarted" })));
        setSummary({
          zipName,
          succeeded: false,
          warnings: [],
          failure: { code: "LOCAL_WRITE_ERROR", detail },
          hasBags: data.bagCandidates.length > 0,
        });
        setStep("summary");
        return;
      }
      currentWritableRef.current = { writable, name: zipName };
      let leftoverZip: string | undefined;
      const writer = createZipWriter(writable, {
        onAbort: async () => {
          try {
            await target.removeEntry(zipName);
          } catch (err) {
            if (!(err instanceof DOMException && err.name === "NotFoundError")) {
              leftoverZip = zipName;
            }
          }
        },
      });
      writerRef.current = writer;

      const markItem = (entryName: string, patch: Partial<ExportItem>): void => {
        setItems((prev) =>
          prev.map((item) => (item.entryName === entryName ? { ...item, ...patch } : item)),
        );
      };

      /**
       * 整包作废(§14/决策 #20):abort zip(删除部分包),条目归组——触发项记
       * 失败原因,之前完成的计失败组,其余未开始;汇总页给出 [重试失败项]。
       */
      const voidPackage = async (
        triggerIndex: number,
        code: FailureCode,
        detail: string,
      ): Promise<void> => {
        writerRef.current = undefined;
        await writer.abort();
        currentWritableRef.current = undefined;
        setItems((prev) =>
          prev.map((item, index) => {
            if (index < triggerIndex) {
              return { ...item, status: "failed", reasonCode: code };
            }
            if (index === triggerIndex) {
              return { ...item, status: "failed", reasonCode: code, reasonDetail: detail };
            }
            return { ...item, status: "notStarted" };
          }),
        );
        setSummary({
          zipName,
          succeeded: false,
          warnings: [],
          failure: { code, detail },
          leftoverZip,
          hasBags: data.bagCandidates.length > 0,
        });
        setStep("summary");
      };

      try {
        // 决策 #28:开始即并发发起正式告警查询(窗口=§5 换算的区间),与 SFTP
        // 下载并行;失败仅入警告组(决策 #12),不触发作废。
        const alarmController = new AbortController();
        alarmAbortRef.current = alarmController;
        const alarmPromise: Promise<
          { status: "ok"; rawText: string; records: number } | { status: "failed"; error: string }
        > = fetchRobotStatus({
          host: host.trim(),
          port: alarmPort,
          startMs: data.startUnixMs,
          stopMs: data.endUnixMs,
          signal: alarmController.signal,
        }).then(
          (result) => ({ status: "ok" as const, rawText: result.rawText, records: result.records.length }),
          (err: unknown) => ({
            status: "failed" as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        );

        // 顺序下载 bags → logs,逐条目写入 zip(§8);每条 fileStart 修正份额。
        const plans: { item: ExportItem; path: string; mtimeMs: number }[] = [
          ...data.bagCandidates.map((bag, index) => ({
            item: bagItems[index]!,
            path: joinRemotePath(bagPath.trim(), bag.name),
            mtimeMs: bag.mtimeMs,
          })),
          ...data.logFiles.map((file, index) => ({
            item: logItems[index]!,
            path: file.path,
            mtimeMs: file.mtimeMs,
          })),
        ];
        for (let index = 0; index < plans.length; index++) {
          const plan = plans[index]!;
          if (session.cancelRequested) {
            await voidPackage(index, "CANCELED", tRef.current("serverExportErrorCanceled"));
            return;
          }
          const isBag = index < bagItems.length;
          setPhase(
            isBag
              ? { kind: "bags", index: index + 1, total: bagItems.length }
              : { kind: "logs", index: index - bagItems.length + 1, total: logItems.length },
          );
          markItem(plan.item.entryName, { status: "active" });
          setCurrentEntry(plan.item.displayName);
          try {
            const result = await downloadIntoZip({
              client,
              writer,
              item: plan.item,
              path: plan.path,
              mtimeMs: plan.mtimeMs,
              onBytes: (chunkBytes) => {
                completedBytesRef.current += chunkBytes;
                setProgress((prev) => ({ ...prev, completed: prev.completed + chunkBytes }));
                // 节流采样:窗口内按时间差估速率,无需逐 chunk 记录。
                const samples = speedSamplesRef.current;
                const last = samples[samples.length - 1];
                if (last == undefined || Date.now() - last.timeMs >= SPEED_SAMPLE_MIN_INTERVAL_MS) {
                  samples.push({ timeMs: Date.now(), totalBytes: completedBytesRef.current });
                }
              },
              onSizeCorrection: (deltaBytes) => {
                totalBytesRef.current = Math.max(0, totalBytesRef.current + deltaBytes);
                setProgress((prev) => ({ ...prev, total: Math.max(0, prev.total + deltaBytes) }));
              },
            });
            if (result.canceled) {
              // SPEC §8.7 口径:取消竞态里 fileEnd/canceled 无论谁赢都整包作废。
              await voidPackage(index, "CANCELED", tRef.current("serverExportErrorCanceled"));
              return;
            }
            markItem(plan.item.entryName, {
              status: "success",
              size: result.bytes!,
            });
          } catch (err) {
            const code: FailureCode = err instanceof ServerExportError ? err.code : "LOCAL_WRITE_ERROR";
            const detail = err instanceof Error ? err.message : String(err);
            await voidPackage(index, code, detail);
            return;
          }
        }

        // 下载全部结束:不再有"正在下载"的文件;告警/清单阶段不展示速率/ETA。
        setCurrentEntry(undefined);
        // logs 写完后主动断开桥接(§9.3):余下阶段仅需本地写盘,且规避
        // IDLE_TIMEOUT_MS(10min)在"等待告警查询"阶段误杀已完成下载。
        bridgeTeardownRef.current = true;
        client.disconnect();

        setPhase({ kind: "alarms" });
        const alarm = await alarmPromise;
        let alarmsField: ExportManifestAlarms;
        const warnings: string[] = [];
        if (alarm.status === "ok") {
          // 成功:响应原始 body 写入 alarms.json;data 为空也写(status:"empty",§10)。
          await writeTextEntry(writer, "alarms.json", alarm.rawText);
          alarmsField = {
            status: alarm.records === 0 ? "empty" : "ok",
            query: { startUnixMs: data.startUnixMs, stopUnixMs: data.endUnixMs },
          };
        } else {
          alarmsField = {
            status: "failed",
            query: { startUnixMs: data.startUnixMs, stopUnixMs: data.endUnixMs },
            error: alarm.error,
          };
          warnings.push(tRef.current("serverExportWarningAlarmFailed", { reason: alarm.error }));
        }
        if (data.skippedActive > 0) {
          warnings.push(
            tRef.current("serverExportWarningActiveSkipped", { count: data.skippedActive }),
          );
        }
        if (data.skippedUnrecognized > 0) {
          warnings.push(
            tRef.current("serverExportWarningUnrecognized", {
              count: data.skippedUnrecognized,
            }),
          );
        }
        if (data.serverTime.tzSource === "browser-assumed") {
          warnings.push(tRef.current("serverExportWarningBrowserTz"));
        }
        if (data.deepSkippedDirs > 0) {
          warnings.push(
            tRef.current("serverExportWarningDeepDirs", { count: data.deepSkippedDirs }),
          );
        }

        // manifest 最后写入(决策 #29):记录告警终态与最终清单。
        setPhase({ kind: "manifest" });
        const manifestBags: ExportManifestBag[] = data.bagCandidates.map((bag) => ({
          name: bag.name,
          size: bag.size,
          timeLocal: formatNaiveDisplay(bag.naiveKey),
          seq: bag.seq,
          role: bag.role,
        }));
        const logBytes = data.logFiles.reduce((acc, file) => acc + file.size, 0);
        const manifest = buildExportManifest({
          generatorVersion: process.env.NODE_ENV ?? "unknown",
          source: {
            host: host.trim(),
            bagPath: bagPath.trim(),
            logPath: logPath.trim(),
          },
          range: {
            startLocal: formatNaiveDisplay(data.startKey),
            endLocal: formatNaiveDisplay(data.endKey),
            tzOffsetMinutes: data.serverTime.tzOffsetMinutes,
            tzSource: data.serverTime.tzSource,
            startUnixMs: data.startUnixMs,
            endUnixMs: data.endUnixMs,
          },
          bags: manifestBags,
          logs: {
            included: data.logFiles.length > 0,
            count: data.logFiles.length,
            bytes: logBytes,
          },
          alarms: alarmsField,
        });
        await writeTextEntry(writer, "manifest.json", serializeExportManifest(manifest));

        await writer.finalize();
        writerRef.current = undefined;
        currentWritableRef.current = undefined;
        setSummary({
          zipName,
          succeeded: true,
          warnings,
          hasBags: data.bagCandidates.length > 0,
        });
        setStep("summary");
      } catch (err) {
        // alarms/manifest 写入或 finalize 的本地失败同样整包作废(§14)。
        const code: FailureCode = err instanceof ServerExportError ? err.code : "LOCAL_WRITE_ERROR";
        const detail = err instanceof Error ? err.message : String(err);
        await voidPackage(allItems.length, code, detail);
      }
    },
    [
      host,
      alarmPort,
      bagPath,
      logPath,
      downloadIntoZip,
      writeTextEntry,
    ],
  );

  const onStartExport = useCallback(async () => {
    if (preview == undefined) {
      return;
    }
    await runExport(preview, { retry: false });
  }, [preview, runExport]);

  /**
   * [重试失败项] = 整包重跑(决策 #20,沿用同一 zip 名)。WS 断开导致的失败:
   * 先静默重连桥接+SSH(密码在内存,§9.4);重连后重新 list(visited-dirs 随
   * 旧 SSH 会话失效)。
   */
  const onRetry = useCallback(async () => {
    if (preview == undefined) {
      return;
    }
    setBusy(true);
    setAlertText(undefined);
    try {
      let client = clientRef.current;
      const reconnectNeeded =
        connectionLost || client == undefined || bridgeTeardownRef.current;
      if (reconnectNeeded) {
        client = await connectBridge();
        replaceClient(client);
        setConnectionLost(false);
      }
      if (client == undefined) {
        return;
      }
      bridgeTeardownRef.current = false;
      // 重新采集(重新 list;serverTime 顺带刷新——钳制口径可能改变)。
      const data = await collectPreview(client, { includeLogs });
      setPreview(data);
      if (data.logError != undefined && includeLogs) {
        // 日志目录又失败了:回到预览页披露(取消勾选后可继续,§14)。
        setStep("preview");
        return;
      }
      await runExport(data, { retry: true });
    } catch (err) {
      const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
      setAlertText(
        `${errorText(t, code)}${err instanceof Error && err.message !== "" ? ` — ${err.message}` : ""}`,
      );
      setStep("form");
    } finally {
      setBusy(false);
    }
  }, [preview, connectionLost, connectBridge, replaceClient, collectPreview, includeLogs, runExport, t]);

  const onCancelExport = useCallback(() => {
    const session = sessionRef.current;
    if (session == undefined) {
      return;
    }
    session.cancelRequested = true;
    setCanceling(true);
    // 并发中的告警 fetch 一并 abort(边界 #14)。
    alarmAbortRef.current?.abort();
    clientRef.current?.cancelDownload();
  }, []);

  /** [立即导入播放](决策 #24):Web → readFile 懒加载 File;桌面 → readFileUrl。 */
  const onPlayNow = useCallback(async () => {
    const target = targetRef.current;
    const zipName = summary?.zipName;
    if (target == undefined || zipName == undefined) {
      return;
    }
    try {
      if (target.readFileUrl != undefined) {
        const url = await target.readFileUrl(zipName);
        selectSource("robot-export-package", { type: "connection", params: { url } });
      } else {
        const file = await target.readFile(zipName);
        selectSource("robot-export-package", { type: "file", files: [file] });
      }
      replaceClient(undefined);
      dialogActions.dataSource.close();
    } catch (err) {
      console.error("failed to open the export package", err);
      setAlertText(errorText(t, "IO_ERROR"));
    }
  }, [summary, selectSource, replaceClient, dialogActions, t]);

  const onBackToForm = useCallback(() => {
    navigationReset();
    replaceClient(undefined);
    setPreview(undefined);
    setAlertText(undefined);
    setConnectionLost(false);
    bridgeTeardownRef.current = false;
    setStep("form");
  }, [replaceClient]);

  /** 重置进行中标志(离开导出/预览时)。 */
  function navigationReset(): void {
    setCanceling(false);
  }

  const onDone = useCallback(() => {
    replaceClient(undefined);
    dialogActions.dataSource.close();
  }, [dialogActions, replaceClient]);

  // ----- 派生渲染状态 -----

  const bagCount = preview?.bagCandidates.length ?? 0;
  const totalPreviewBytes = useMemo(() => {
    if (preview == undefined) {
      return 0;
    }
    return (
      preview.bagCandidates.reduce((acc, bag) => acc + bag.size, 0) +
      preview.logFiles.reduce((acc, file) => acc + file.size, 0)
    );
  }, [preview]);
  const logListingBlocked = preview?.logError != undefined && includeLogs;
  const zeroBags = preview != undefined && preview.bagCandidates.length === 0;
  const robotNowDisplay =
    preview != undefined
      ? formatNaiveDisplay(
          unixMsToNaiveKey(preview.serverTime.robotUnixMs, preview.serverTime.tzOffsetMinutes),
        )
      : undefined;
  const clockSkewWarn =
    preview?.clockSkewMs != undefined && preview.clockSkewMs > CLOCK_SKEW_WARN_MS;

  const phaseLabel = (value: ExportPhase): string => {
    switch (value.kind) {
      case "bags":
        return t("serverExportPhaseBags", { index: value.index, total: value.total });
      case "logs":
        return t("serverExportPhaseLogs", { index: value.index, total: value.total });
      case "alarms":
        return t("serverExportPhaseAlarms");
      case "manifest":
        return t("serverExportPhaseManifest");
    }
  };

  // ----- 渲染 -----

  const renderFooter = (left: ReactNode, right: ReactNode) => (
    <Stack
      direction="row"
      justifyContent="space-between"
      alignItems="center"
      paddingX={4}
      paddingBottom={4}
      paddingTop={2}
    >
      {left}
      <Stack direction="row" gap={2}>
        {right}
      </Stack>
    </Stack>
  );

  const renderFormStep = () => (
    <>
      <div className={classes.content}>
        {!supportsLocalExport && (
          <Alert severity="warning">{t("serverExportBrowserUnsupported")}</Alert>
        )}
        {alertText != undefined && <Alert severity="error">{alertText}</Alert>}
        <Stack direction="row" gap={2}>
          <TextField
            label={t("serverExportHost")}
            value={host}
            error={fieldErrors.host != undefined}
            helperText={fieldErrors.host ?? t("serverExportHostSharedHint")}
            disabled={!supportsLocalExport || busy}
            onChange={(event) => {
              setHost(event.target.value);
            }}
            fullWidth
            variant="outlined"
          />
          <TextField
            label={t("serverExportSshPort")}
            value={sshPort}
            error={fieldErrors.sshPort != undefined}
            helperText={fieldErrors.sshPort}
            disabled={!supportsLocalExport || busy}
            onChange={(event) => {
              setSshPort(event.target.value);
            }}
            fullWidth
            variant="outlined"
          />
          <TextField
            label={t("serverExportAlarmPort")}
            value={alarmPort}
            error={fieldErrors.alarmPort != undefined}
            helperText={fieldErrors.alarmPort ?? t("serverExportAlarmPortSharedHint")}
            disabled={!supportsLocalExport || busy}
            onChange={(event) => {
              setAlarmPort(event.target.value);
            }}
            fullWidth
            variant="outlined"
          />
        </Stack>
        <Stack direction="row" gap={2}>
          <TextField
            label={t("serverExportUsername")}
            value={username}
            error={fieldErrors.username != undefined}
            helperText={fieldErrors.username}
            disabled={!supportsLocalExport || busy}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
            fullWidth
            variant="outlined"
            autoComplete="username"
          />
          <TextField
            label={t("serverExportPassword")}
            type={showPassword ? "text" : "password"}
            value={password}
            error={fieldErrors.password != undefined}
            helperText={fieldErrors.password}
            disabled={!supportsLocalExport || busy}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            fullWidth
            variant="outlined"
            autoComplete="new-password"
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    edge="end"
                    aria-label={t("serverExportTogglePassword")}
                    onClick={() => {
                      setShowPassword(!showPassword);
                    }}
                  >
                    {showPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />
        </Stack>
        <TextField
          label={t("serverExportBagPath")}
          value={bagPath}
          error={fieldErrors.bagPath != undefined}
          helperText={fieldErrors.bagPath}
          disabled={!supportsLocalExport || busy}
          onChange={(event) => {
            setBagPath(event.target.value);
          }}
          fullWidth
          variant="outlined"
        />
        <TextField
          label={t("serverExportLogPath")}
          value={logPath}
          error={fieldErrors.logPath != undefined}
          helperText={fieldErrors.logPath}
          disabled={!supportsLocalExport || busy}
          onChange={(event) => {
            setLogPath(event.target.value);
          }}
          fullWidth
          variant="outlined"
        />
        {/* 时间范围:机器人时区 naive(决策 #4/#19);快捷按钮按浏览器时钟填充(决策 #30)。
            两字段结构对称(helperText 仅在报错时出现)保证水平对齐;秒可省略
            (normalizeNaiveTime 按分钟精度 :00 解析,Chromium 下拉面板值)。 */}
        <Stack direction="row" gap={2}>
          <TextField
            label={t("serverExportStartTime")}
            type="datetime-local"
            value={startLocal}
            error={fieldErrors.timeRange != undefined}
            helperText={fieldErrors.timeRange}
            disabled={!supportsLocalExport || busy}
            onChange={(event) => {
              setStartLocal(event.target.value);
            }}
            fullWidth
            variant="outlined"
            inputProps={{ step: 1 }}
          />
          <TextField
            label={t("serverExportEndTime")}
            type="datetime-local"
            value={endLocal}
            error={fieldErrors.timeRange != undefined}
            helperText={fieldErrors.timeRange}
            disabled={!supportsLocalExport || busy}
            onChange={(event) => {
              setEndLocal(event.target.value);
            }}
            fullWidth
            variant="outlined"
            inputProps={{ step: 1 }}
          />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {t("serverExportRobotTimezoneHint")}
        </Typography>
        <Stack direction="row" gap={1}>
          <Button
            size="small"
            disabled={!supportsLocalExport || busy}
            onClick={() => {
              setStartLocal(datetimeLocalNow(-60 * 60 * 1000));
              setEndLocal(datetimeLocalNow());
            }}
          >
            {t("serverExportQuickLastHour")}
          </Button>
          <Button
            size="small"
            disabled={!supportsLocalExport || busy}
            onClick={() => {
              setStartLocal(datetimeLocalNow(-24 * 60 * 60 * 1000));
              setEndLocal(datetimeLocalNow());
            }}
          >
            {t("serverExportQuickLast24Hours")}
          </Button>
          <Button
            size="small"
            disabled={!supportsLocalExport || busy}
            onClick={() => {
              const now = new Date();
              const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
              const pad = (value: number) => String(value).padStart(2, "0");
              const dayStartValue = `${dayStart.getFullYear()}-${pad(dayStart.getMonth() + 1)}-${pad(dayStart.getDate())}T00:00:00`;
              setStartLocal(dayStartValue);
              setEndLocal(datetimeLocalNow());
            }}
          >
            {t("serverExportQuickToday")}
          </Button>
        </Stack>
        <Stack direction="row" alignItems="center" gap={2}>
          <Button
            variant="outlined"
            startIcon={<FolderOpenIcon />}
            disabled={!supportsLocalExport || busy}
            onClick={() => {
              void onPickDirectory();
            }}
          >
            {t("serverExportChooseDirectory")}
          </Button>
          {dirName != undefined ? (
            <Typography variant="body2" className={classes.monoName} title={dirName}>
              {dirName}
            </Typography>
          ) : (
            // validateForm 的 directory 错误唯一落点:未选目录时点击「连接并预览」
            // 仅置 fieldErrors.directory,这里必须变红,否则点击看起来毫无反应。
            <Typography
              variant="body2"
              className={
                fieldErrors.directory != undefined ? classes.errorText : classes.warningText
              }
            >
              {t("serverExportNoDirectorySelected")}
            </Typography>
          )}
        </Stack>
        <FormControlLabel
          control={
            <Checkbox
              checked={includeLogs}
              disabled={!supportsLocalExport || busy}
              onChange={(event) => {
                setIncludeLogs(event.target.checked);
              }}
            />
          }
          label={<Typography variant="body2">{t("serverExportIncludeLogs")}</Typography>}
        />
      </div>
      {renderFooter(
        <Button
          onClick={() => {
            dialogActions.dataSource.open("start");
          }}
        >
          {t("serverExportBack")}
        </Button>,
        <Button
          variant="contained"
          disabled={!supportsLocalExport || busy}
          onClick={() => {
            void onConnectAndPreview();
          }}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {t("serverExportConnectAndPreview")}
        </Button>,
      )}
    </>
  );

  const renderPreviewStep = () => {
    if (preview == undefined) {
      return undefined;
    }
    return (
      <>
        <div className={classes.content}>
          {connectionLost && (
            <Alert severity="error">{t("serverExportConnectionLost")}</Alert>
          )}
          {alertText != undefined && <Alert severity="error">{alertText}</Alert>}
          {preview.logError != undefined && includeLogs && (
            <Alert severity="error">
              {t("serverExportLogListFailed", { reason: preview.logError })}
            </Alert>
          )}
          {preview.clampedEnd && (
            <Alert severity="info">
              {t("serverExportEndClamped", {
                time: formatNaiveDisplay(preview.endKey),
              })}
            </Alert>
          )}
          {clockSkewWarn && (
            <Alert severity="warning">
              {t("serverExportClockSkew", {
                minutes: Math.round((preview.clockSkewMs ?? 0) / 60000),
              })}
            </Alert>
          )}
          {preview.serverTime.tzSource === "browser-assumed" && (
            <Alert severity="warning">{t("serverExportBrowserTzFallback")}</Alert>
          )}
          {!preview.alarmReachable && (
            <Alert severity="warning">
              {t("serverExportAlarmUnreachable", { reason: preview.alarmProbeError ?? "" })}
            </Alert>
          )}
          <Typography variant="h6">
            {t("serverExportPreviewTitle", {
              bags: bagCount,
              logs: includeLogs ? preview.logFiles.length : 0,
              size: formatBytes(totalPreviewBytes),
            })}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("serverExportPreviewRobotNow", {
              time: robotNowDisplay ?? "",
              tz: preview.serverTime.tzSource === "server" ? "" : t("serverExportRobotTimeAssumed"),
            })}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("serverExportPreviewRange", {
              start: formatNaiveDisplay(preview.startKey),
              end: formatNaiveDisplay(preview.endKey),
            })}
          </Typography>
          {zeroBags ? (
            <Alert severity="warning">{t("serverExportZeroBags")}</Alert>
          ) : (
            <Stack gap={0.5}>
              <Typography variant="body2" color="text.secondary">
                {t("serverExportPreviewBags", {
                  count: bagCount,
                  predecessor: preview.predecessorCount,
                })}
              </Typography>
              {preview.skippedActive > 0 && (
                <Typography variant="body2" color="text.secondary">
                  {t("serverExportPreviewActiveSkipped", { count: preview.skippedActive })}
                </Typography>
              )}
              {preview.skippedUnrecognized > 0 && (
                <Typography variant="body2" color="text.secondary">
                  {t("serverExportPreviewUnrecognized", { count: preview.skippedUnrecognized })}
                </Typography>
              )}
              {includeLogs && (
                <Typography variant="body2" color="text.secondary">
                  {t("serverExportPreviewLogs", {
                    count: preview.logFiles.length,
                    size: formatBytes(
                      preview.logFiles.reduce((acc, file) => acc + file.size, 0),
                    ),
                  })}
                </Typography>
              )}
              {preview.deepSkippedDirs > 0 && (
                <Typography variant="body2" color="text.secondary">
                  {t("serverExportPreviewDeepDirs", { count: preview.deepSkippedDirs })}
                </Typography>
              )}
            </Stack>
          )}
          <FormControlLabel
            control={
              <Checkbox
                checked={includeLogs}
                onChange={(event) => {
                  setIncludeLogs(event.target.checked);
                }}
              />
            }
            label={<Typography variant="body2">{t("serverExportIncludeLogs")}</Typography>}
          />
          <Typography variant="body2" color="text.secondary" className={classes.monoName}>
            {t("serverExportConnectedTo", { username, host })}
          </Typography>
        </div>
        {renderFooter(
          <Button onClick={onBackToForm}>{t("serverExportBackToForm")}</Button>,
          zeroBags ? (
            <>
              <Button variant="outlined" disabled={logListingBlocked} onClick={onStartExport}>
                {t("serverExportProceedWithoutBags")}
              </Button>
            </>
          ) : (
            <Button
              variant="contained"
              disabled={logListingBlocked || connectionLost}
              onClick={() => {
                void onStartExport();
              }}
            >
              {t("serverExportStart")}
            </Button>
          ),
        )}
      </>
    );
  };

  const renderExportingStep = () => {
    // 仅下载阶段展示速率/ETA(§9.3):告警查询/写清单阶段无传输。
    const downloading = phase.kind === "bags" || phase.kind === "logs";
    const statsParts = [
      t("serverExportExportStats", {
        completed: formatBytes(progress.completed),
        total: formatBytes(progress.total),
      }),
    ];
    if (downloading && transferRate.bytesPerSecond > 0) {
      statsParts.push(t("serverExportSpeed", { value: formatBytes(transferRate.bytesPerSecond) }));
      if (transferRate.etaSeconds != undefined) {
        statsParts.push(
          t("serverExportEtaRemaining", {
            duration: formatEtaDuration(transferRate.etaSeconds, t),
          }),
        );
      }
    }
    return (
      <>
        <div className={classes.content}>
          <Typography variant="h6">{t("serverExportExporting")}</Typography>
          <Stack gap={1}>
            {summary == undefined && zipNameRef.current != undefined && (
              <Typography variant="body2" color="text.secondary" className={classes.monoName}>
                {t("serverExportZipTarget", { name: zipNameRef.current })}
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              {phaseLabel(phase)}
            </Typography>
            {/* 单条总进度条:条目内进度并入总量,不再单独展示(§9.3)。 */}
            <LinearProgress
              variant="determinate"
              value={progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}
            />
            <Typography variant="body2" color="text.secondary">
              {statsParts.join(" · ")}
            </Typography>
            {currentEntry != undefined && (
              <Typography
                variant="body2"
                color="text.secondary"
                className={classes.monoName}
                title={currentEntry}
              >
                {t("serverExportCurrentFile", { name: currentEntry })}
              </Typography>
            )}
          </Stack>
        </div>
        {renderFooter(
          <span />,
          <Button color="inherit" variant="outlined" disabled={canceling} onClick={onCancelExport}>
            {t("serverExportCancel")}
          </Button>,
        )}
      </>
    );
  };

  const renderSummaryStep = () => {
    if (summary == undefined) {
      return undefined;
    }
    const failed = items.filter((item) => item.status === "failed");
    const notStarted = items.filter((item) => item.status === "notStarted");
    return (
      <>
        <div className={classes.content}>
          {alertText != undefined && <Alert severity="error">{alertText}</Alert>}
          {summary.leftoverZip != undefined && (
            <Alert severity="warning">
              {t("serverExportLeftoverZip", { name: summary.leftoverZip })}
            </Alert>
          )}
          {summary.succeeded ? (
            <>
              <Typography variant="h6">
                {t("serverExportSucceededZipped", { name: summary.zipName })}
              </Typography>
              {summary.warnings.map((warning) => (
                <Alert key={warning} severity="warning">
                  {warning}
                </Alert>
              ))}
              {!summary.hasBags && (
                <Alert severity="info">{t("serverExportArchiveOnly")}</Alert>
              )}
            </>
          ) : (
            <>
              <Typography variant="h6">{t("serverExportFailed")}</Typography>
              <Alert severity="error">
                {`${errorText(t, summary.failure?.code ?? "IO_ERROR")}${
                  summary.failure?.detail != undefined && summary.failure.detail !== ""
                    ? ` (${summary.failure.detail})`
                    : ""
                }`}
              </Alert>
            </>
          )}
          {failed.length > 0 && (
            <Stack gap={0.5}>
              <Typography variant="subtitle2">
                {t("serverExportFailedGroup", { count: failed.length })}
              </Typography>
              {failed.slice(0, 20).map((item) => (
                <Typography
                  key={item.entryName}
                  variant="body2"
                  color="text.secondary"
                  className={classes.monoName}
                >
                  {item.displayName}
                </Typography>
              ))}
            </Stack>
          )}
          {notStarted.length > 0 && (
            <Stack gap={0.5}>
              <Typography variant="subtitle2">
                {t("serverExportNotStartedGroup", { count: notStarted.length })}
              </Typography>
            </Stack>
          )}
        </div>
        {renderFooter(
          <span />,
          <>
            {!summary.succeeded && (
              <Button
                variant="outlined"
                disabled={busy}
                onClick={() => {
                  void onRetry();
                }}
              >
                {t("serverExportRetryFailed")}
              </Button>
            )}
            {summary.succeeded && summary.hasBags && (
              <Button variant="outlined" onClick={() => void onPlayNow()}>
                {t("serverExportPlayNow")}
              </Button>
            )}
            <Button variant="contained" onClick={onDone}>
              {t("serverExportDone")}
            </Button>
          </>,
        )}
      </>
    );
  };

  return (
    <>
      {step === "form" && renderFormStep()}
      {step === "preview" && renderPreviewStep()}
      {step === "exporting" && renderExportingStep()}
      {step === "summary" && renderSummaryStep()}
    </>
  );
}
