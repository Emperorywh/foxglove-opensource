// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Link,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { TFunction } from "i18next";
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles } from "tss-react/mui";

import Stack from "@foxglove/studio-base/components/Stack";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { useWorkspaceActions } from "@foxglove/studio-base/context/Workspace/useWorkspaceActions";

import {
  ServerExportBridgeClient,
  ServerExportError,
  ServerExportErrorCode,
  ServerExportListEntry,
} from "./ServerExportBridgeClient";

const LOCAL_STORAGE_PREFIX = "foxglove.serverExport.";

/** Sliding window used to estimate the current download speed. */
const SPEED_WINDOW_MS = 5000;

type Step = "connect" | "browse" | "exporting" | "summary";

type ExportItemStatus = "pending" | "active" | "success" | "failed" | "skipped" | "notStarted";

type ExportItem = {
  name: string;
  /** Best-known size: from list, corrected to the actual byte count as the transfer reports it. */
  size: number;
  status: ExportItemStatus;
  bytesWritten: number;
  reasonCode?: ServerExportErrorCode | "CANCELED";
  reasonDetail?: string;
};

type ConflictChoice = "overwrite" | "skip" | "cancel";

type ExportSession = {
  cancelRequested: boolean;
  stopQueue: boolean;
  consecutiveLocalFailures: number;
};

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
  fileList: {
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: theme.shape.borderRadius,
    overflowY: "auto",
    maxHeight: 320,
  },
  browseHeader: {
    // Keep clear of the dialog's absolutely positioned close button in the top-right corner.
    paddingRight: theme.spacing(6),
  },
  warningText: {
    color: theme.palette.warning.main,
  },
  fileRow: {
    display: "grid",
    gridTemplateColumns: "auto 1fr auto auto auto",
    alignItems: "center",
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 2),
    borderBottom: `1px solid ${theme.palette.divider}`,
    "&:last-child": {
      borderBottom: "none",
    },
  },
  headerRow: {
    position: "sticky",
    top: 0,
    backgroundColor: theme.palette.background.paper,
    zIndex: 1,
  },
  disabledFileName: {
    color: theme.palette.text.disabled,
  },
  monoName: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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

/** Format seconds as m:ss (or h:mm:ss) for the ETA display. */
function formatDuration(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

function errorText(
  t: TFunction<"openDialog">,
  code: ServerExportErrorCode | "CANCELED",
): string {
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
    case "IO_ERROR":
    case "BAD_REQUEST":
    default:
      return code === "IO_ERROR" ? t("serverExportErrorIo") : t("serverExportErrorUnknown");
  }
}

function readStoredField(key: string): string | undefined {
  try {
    return localStorage.getItem(`${LOCAL_STORAGE_PREFIX}${key}`) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeField(key: string, value: string): void {
  try {
    localStorage.setItem(`${LOCAL_STORAGE_PREFIX}${key}`, value);
  } catch {
    // storage full / blocked — prefill is a convenience, ignore
  }
}

export default function ServerExport(): JSX.Element {
  const { classes } = useStyles();
  const { t } = useTranslation("openDialog");
  const { dialogActions } = useWorkspaceActions();
  const { selectSource } = usePlayerSelection();

  const supportsFileSystemAccess = "showDirectoryPicker" in window;

  // ----- Step & connection form state -----
  const [step, setStep] = useState<Step>("connect");
  const [host, setHost] = useState(() => readStoredField("host") ?? "");
  const [port, setPort] = useState(() => readStoredField("port") ?? "22");
  const [username, setUsername] = useState(() => readStoredField("username") ?? "");
  // The password is intentionally memory-only (SPEC §11) and never persisted.
  const [password, setPassword] = useState("");
  const [bagPath, setBagPath] = useState(() => readStoredField("bagPath") ?? "");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [alertText, setAlertText] = useState<string>();
  const [busy, setBusy] = useState(false);

  // ----- Browse state -----
  const [entries, setEntries] = useState<ServerExportListEntry[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [dirName, setDirName] = useState<string>();
  const [connectionLost, setConnectionLost] = useState<string>();

  // ----- Export state -----
  const [items, setItemsState] = useState<ExportItem[]>([]);
  const [canceling, setCanceling] = useState(false);
  const [conflictCount, setConflictCount] = useState<number>();
  // Re-render on a slow tick while exporting so the speed/ETA display stays fresh.
  const [, setStatsTick] = useState(0);

  const itemsRef = useRef<ExportItem[]>([]);
  const clientRef = useRef<ServerExportBridgeClient>();
  const dirHandleRef = useRef<FileSystemDirectoryHandle>();
  const exportSessionRef = useRef<ExportSession>();
  const openAfterExportRef = useRef(false);
  const conflictResolveRef = useRef<(choice: ConflictChoice) => void>();
  const speedSamplesRef = useRef<{ time: number; bytes: number }[]>([]);
  const currentWritableRef = useRef<{
    writable: FileSystemWritableFileStream;
    name: string;
  }>();

  const tRef = useRef(t);
  tRef.current = t;

  const setItems = useCallback((updater: (prev: ExportItem[]) => ExportItem[]) => {
    itemsRef.current = updater(itemsRef.current);
    setItemsState(itemsRef.current);
  }, []);

  const updateItem = useCallback(
    (name: string, patch: Partial<ExportItem>) => {
      setItems((prev) => prev.map((it) => (it.name === name ? { ...it, ...patch } : it)));
    },
    [setItems],
  );

  const makeClient = useCallback(() => {
    const client = new ServerExportBridgeClient();
    client.onSshClosed = (_reason, message) => {
      setConnectionLost(message || tRef.current("serverExportConnectionLost"));
    };
    client.onBridgeDisconnected = () => {
      setConnectionLost(tRef.current("serverExportConnectionLost"));
    };
    return client;
  }, []);

  const replaceClient = useCallback(
    (client: ServerExportBridgeClient | undefined) => {
      clientRef.current?.disconnect();
      clientRef.current = client;
    },
    [],
  );

  // ----- Teardown on unmount / dialog close (SPEC §13.18: closing mid-export cancels) -----
  useEffect(() => {
    return () => {
      const session = exportSessionRef.current;
      if (session != undefined) {
        session.cancelRequested = true;
        session.stopQueue = true;
      }
      const client = clientRef.current;
      if (client != undefined) {
        client.cancelDownload();
        client.disconnect();
      }
      const current = currentWritableRef.current;
      if (current != undefined) {
        const dirHandle = dirHandleRef.current;
        void current.writable.abort().catch(() => undefined);
        void dirHandle?.removeEntry(current.name).catch(() => undefined);
      }
    };
  }, []);

  const validateForm = useCallback((): boolean => {
    const errors: Record<string, string> = {};
    if (host.trim() === "") {
      errors.host = t("serverExportValidationRequired");
    }
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      errors.port = t("serverExportValidationPort");
    }
    if (username.trim() === "") {
      errors.username = t("serverExportValidationRequired");
    }
    if (password === "") {
      errors.password = t("serverExportValidationRequired");
    }
    if (!bagPath.trim().startsWith("/")) {
      errors.bagPath = t("serverExportValidationPath");
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [host, port, username, password, bagPath, t]);

  const normalizedBagPath = useMemo(() => {
    const trimmed = bagPath.trim();
    return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
  }, [bagPath]);

  /** Open bridge + SSH + list. Throws ServerExportError. Returns entries sorted newest first. */
  const connectAndList = useCallback(async (): Promise<{
    client: ServerExportBridgeClient;
    entries: ServerExportListEntry[];
  }> => {
    const client = makeClient();
    await client.open();
    try {
      await client.connectSsh({
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        password,
      });
      const list = await client.list(normalizedBagPath);
      list.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return { client, entries: list };
    } catch (err) {
      client.disconnect();
      throw err;
    }
  }, [makeClient, host, port, username, password, normalizedBagPath]);

  const onConnect = useCallback(async () => {
    if (!validateForm()) {
      return;
    }
    setBusy(true);
    setAlertText(undefined);
    try {
      const { client, entries: list } = await connectAndList();
      storeField("host", host.trim());
      storeField("port", port);
      storeField("username", username.trim());
      storeField("bagPath", normalizedBagPath);
      replaceClient(client);
      setEntries(list);
      setSelected(new Set());
      setConnectionLost(undefined);
      setStep("browse");
    } catch (err) {
      const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
      setAlertText(
        `${errorText(t, code)}${err instanceof Error && err.message !== "" ? ` — ${err.message}` : ""}`,
      );
    } finally {
      setBusy(false);
    }
  }, [validateForm, connectAndList, host, port, username, normalizedBagPath, replaceClient, t]);

  const onDisconnectAndBack = useCallback(() => {
    replaceClient(undefined);
    setEntries([]);
    setSelected(new Set());
    setConnectionLost(undefined);
    setAlertText(undefined);
    setStep("connect");
  }, [replaceClient]);

  const onReconnect = useCallback(async () => {
    setBusy(true);
    setAlertText(undefined);
    try {
      const { client, entries: list } = await connectAndList();
      replaceClient(client);
      setEntries(list);
      setSelected(new Set());
      setConnectionLost(undefined);
    } catch (err) {
      // Reconnect failed: fall back to the form step and show the error there (SPEC §5 Step B).
      replaceClient(undefined);
      const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
      setAlertText(errorText(t, code));
      setStep("connect");
    } finally {
      setBusy(false);
    }
  }, [connectAndList, replaceClient, t]);

  const onRefresh = useCallback(async () => {
    const client = clientRef.current;
    if (client == undefined) {
      return;
    }
    setBusy(true);
    try {
      const list = await client.list(normalizedBagPath);
      list.sort((a, b) => b.mtimeMs - a.mtimeMs);
      setEntries(list);
      setSelected((prev) => {
        const names = new Set(list.map((entry) => entry.name));
        return new Set([...prev].filter((name) => names.has(name)));
      });
    } catch (err) {
      const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
      setAlertText(errorText(t, code));
    } finally {
      setBusy(false);
    }
  }, [normalizedBagPath, t]);

  const onPickDirectory = useCallback(async () => {
    try {
      const handle = await showDirectoryPicker({ mode: "readwrite" });
      dirHandleRef.current = handle;
      setDirName(handle.name);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return; // user dismissed the picker
      }
      setAlertText(errorText(t, "LOCAL_WRITE_ERROR"));
    }
  }, [t]);

  // ----- Conflict prompt -----
  const promptConflict = useCallback(async (count: number): Promise<ConflictChoice> => {
    return await new Promise<ConflictChoice>((resolve) => {
      conflictResolveRef.current = resolve;
      setConflictCount(count);
    });
  }, []);

  const resolveConflict = useCallback((choice: ConflictChoice) => {
    conflictResolveRef.current?.(choice);
    conflictResolveRef.current = undefined;
    setConflictCount(undefined);
  }, []);

  // ----- Export loop -----

  const finishIfAllSucceeded = useCallback(
    async ({ openAfter }: { openAfter: boolean }) => {
      if (!openAfter) {
        return;
      }
      const allSucceeded =
        itemsRef.current.length > 0 &&
        itemsRef.current.every((item) => item.status === "success");
      if (!allSucceeded) {
        return;
      }
      const first = itemsRef.current[0];
      const dirHandle = dirHandleRef.current;
      if (first == undefined || dirHandle == undefined) {
        return;
      }
      try {
        const fileHandle = await dirHandle.getFileHandle(first.name);
        const file = await fileHandle.getFile();
        selectSource("ros1-local-bagfile", { type: "file", files: [file] });
        replaceClient(undefined);
        dialogActions.dataSource.close();
      } catch (err) {
        console.error("failed to open exported bag", err);
      }
    },
    [dialogActions, replaceClient, selectSource],
  );

  const runExport = useCallback(
    async (files: ExportItem[], skip: ReadonlySet<string>, opts: { openAfter: boolean }) => {
      const client = clientRef.current;
      const dirHandle = dirHandleRef.current;
      if (client == undefined || dirHandle == undefined) {
        return;
      }
      const session: ExportSession = {
        cancelRequested: false,
        stopQueue: false,
        consecutiveLocalFailures: 0,
      };
      exportSessionRef.current = session;
      setCanceling(false);
      setStep("exporting");

      for (const file of files) {
        if (skip.has(file.name)) {
          updateItem(file.name, { status: "skipped", bytesWritten: 0 });
        }
      }

      for (const file of files) {
        if (skip.has(file.name)) {
          continue;
        }
        if (session.cancelRequested || session.stopQueue) {
          updateItem(file.name, { status: "notStarted", bytesWritten: 0 });
          continue;
        }
        updateItem(file.name, { status: "active", bytesWritten: 0 });

        let writable: FileSystemWritableFileStream;
        try {
          const fileHandle = await dirHandle.getFileHandle(file.name, { create: true });
          writable = await fileHandle.createWritable();
        } catch (err) {
          session.consecutiveLocalFailures += 1;
          if (session.consecutiveLocalFailures >= 2) {
            session.stopQueue = true;
          }
          updateItem(file.name, {
            status: "failed",
            reasonCode: "LOCAL_WRITE_ERROR",
            reasonDetail: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        currentWritableRef.current = { writable, name: file.name };
        let written = 0;
        try {
          const outcome = await client.download(`${normalizedBagPath}/${file.name}`, {
            onStart: (_name, size) => {
              updateItem(file.name, { size });
            },
            onData: async (chunk) => {
              await writable.write(chunk);
              written += chunk.byteLength;
              updateItem(file.name, { bytesWritten: written });
            },
          });
          currentWritableRef.current = undefined;
          if (outcome.status === "completed") {
            try {
              await writable.close();
            } catch (closeErr) {
              // Flushing on close can still hit local write failures (disk full, …).
              session.consecutiveLocalFailures += 1;
              if (session.consecutiveLocalFailures >= 2) {
                session.stopQueue = true;
              }
              await dirHandle.removeEntry(file.name).catch(() => undefined);
              updateItem(file.name, {
                status: "failed",
                reasonCode: "LOCAL_WRITE_ERROR",
                reasonDetail: closeErr instanceof Error ? closeErr.message : String(closeErr),
                bytesWritten: written,
              });
              continue;
            }
            session.consecutiveLocalFailures = 0;
            updateItem(file.name, {
              status: "success",
              bytesWritten: outcome.bytes,
              size: outcome.bytes,
            });
          } else {
            // Canceled: delete the partially written file (SPEC §4.3).
            await writable.abort().catch(() => undefined);
            await dirHandle.removeEntry(file.name).catch(() => undefined);
            updateItem(file.name, {
              status: "failed",
              reasonCode: "CANCELED",
              bytesWritten: written,
            });
          }
        } catch (err) {
          currentWritableRef.current = undefined;
          await writable.abort().catch(() => undefined);
          await dirHandle.removeEntry(file.name).catch(() => undefined);
          const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
          if (code === "LOCAL_WRITE_ERROR") {
            session.consecutiveLocalFailures += 1;
            if (session.consecutiveLocalFailures >= 2) {
              session.stopQueue = true;
            }
          }
          if (code === "DISCONNECTED") {
            // The queue cannot make progress without a connection (SPEC §5 Step C).
            session.stopQueue = true;
          }
          updateItem(file.name, {
            status: "failed",
            reasonCode: code,
            reasonDetail: err instanceof Error ? err.message : String(err),
            bytesWritten: written,
          });
        }
      }

      exportSessionRef.current = undefined;
      setStep("summary");
      await finishIfAllSucceeded(opts);
    },
    [finishIfAllSucceeded, normalizedBagPath, updateItem],
  );

  const checkConflictsAndExport = useCallback(
    async (files: ExportItem[], opts: { openAfter: boolean }) => {
      const dirHandle = dirHandleRef.current;
      if (dirHandle == undefined || files.length === 0) {
        return;
      }
      // Conflict precheck before any transfer starts (SPEC §10).
      const conflicts: string[] = [];
      await Promise.all(
        files.map(async (file) => {
          try {
            await dirHandle.getFileHandle(file.name);
            conflicts.push(file.name);
          } catch {
            // NotFoundError: no conflict
          }
        }),
      );
      let skip = new Set<string>();
      if (conflicts.length > 0) {
        const choice = await promptConflict(conflicts.length);
        if (choice === "cancel") {
          return;
        }
        if (choice === "skip") {
          skip = new Set(conflicts);
        }
      }
      await runExport(files, skip, opts);
    },
    [promptConflict, runExport],
  );

  const onStartExport = useCallback(
    async ({ openAfter }: { openAfter: boolean }) => {
      openAfterExportRef.current = openAfter;
      const chosen: ExportItem[] = entries
        .filter((entry) => entry.kind === "bag" && selected.has(entry.name))
        .map((entry) => ({
          name: entry.name,
          size: entry.size,
          status: "pending",
          bytesWritten: 0,
        }));
      setItems(() => chosen);
      setAlertText(undefined);
      await checkConflictsAndExport(chosen, { openAfter });
    },
    [entries, selected, setItems, checkConflictsAndExport],
  );

  const onCancelExport = useCallback(() => {
    const session = exportSessionRef.current;
    if (session == undefined) {
      return;
    }
    session.cancelRequested = true;
    setCanceling(true);
    clientRef.current?.cancelDownload();
  }, []);

  const onRetry = useCallback(async () => {
    setAlertText(undefined);
    // If the failure was caused by a dropped connection, silently reconnect first
    // (the password is still in memory, SPEC §5 Step D).
    if (connectionLost != undefined || clientRef.current == undefined) {
      setBusy(true);
      try {
        const { client } = await connectAndList();
        replaceClient(client);
        setConnectionLost(undefined);
      } catch (err) {
        replaceClient(undefined);
        const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
        setAlertText(errorText(t, code));
        setStep("connect");
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    const retryFiles = itemsRef.current.filter(
      (item) => item.status === "failed" || item.status === "notStarted",
    );
    await checkConflictsAndExport(retryFiles, { openAfter: openAfterExportRef.current });
  }, [checkConflictsAndExport, connectAndList, connectionLost, replaceClient, t]);

  const onDone = useCallback(() => {
    replaceClient(undefined);
    dialogActions.dataSource.close();
  }, [dialogActions, replaceClient]);

  // ----- Derived rendering state -----

  const selectable = useMemo(() => entries.filter((entry) => entry.kind === "bag"), [entries]);
  const selectedCount = selected.size;
  const allSelected = selectable.length > 0 && selectedCount === selectable.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const progress = useMemo(() => {
    let total = 0;
    let completed = 0;
    for (const item of items) {
      switch (item.status) {
        case "pending":
          total += item.size;
          break;
        case "active":
          total += item.size;
          completed += item.bytesWritten;
          break;
        case "success":
        case "failed":
          // Failed/canceled files keep only their downloaded bytes in the denominator so
          // the bar can still reach 100% (SPEC §5 Step C).
          total += item.bytesWritten;
          completed += item.bytesWritten;
          break;
        case "skipped":
        case "notStarted":
          break;
      }
    }
    return { total, completed };
  }, [items]);

  // Periodic re-render while exporting so speed/ETA update even between chunk callbacks.
  useEffect(() => {
    if (step !== "exporting") {
      return;
    }
    const timer = setInterval(() => {
      setStatsTick((n) => n + 1);
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [step]);

  // Maintain a sliding window of (time, downloaded bytes) samples for the speed estimate.
  useEffect(() => {
    if (step !== "exporting") {
      speedSamplesRef.current = [];
      return;
    }
    const now = performance.now();
    const samples = speedSamplesRef.current;
    samples.push({ time: now, bytes: progress.completed });
    const cutoff = now - SPEED_WINDOW_MS;
    let head = samples[0];
    while (head != undefined && head.time < cutoff) {
      samples.shift();
      head = samples[0];
    }
  }, [step, progress.completed]);

  // Speed from the sliding sample window; cheap enough to recompute on every render so the
  // periodic tick refreshes the ETA even when no new chunk has arrived.
  const exportStats = (() => {
    const samples = speedSamplesRef.current;
    const first = samples[0];
    const last = samples[samples.length - 1];
    let speedBytesPerSec: number | undefined;
    if (first != undefined && last != undefined && last.time - first.time >= 500) {
      speedBytesPerSec = Math.max(
        0,
        ((last.bytes - first.bytes) / (last.time - first.time)) * 1000,
      );
    }
    const remainingBytes = Math.max(0, progress.total - progress.completed);
    const etaSeconds =
      speedBytesPerSec != undefined && speedBytesPerSec > 0 && remainingBytes > 0
        ? remainingBytes / speedBytesPerSec
        : undefined;
    return { speedBytesPerSec, etaSeconds };
  })();

  const activeItem = items.find((item) => item.status === "active");
  const retryableCount = items.filter(
    (item) => item.status === "failed" || item.status === "notStarted",
  ).length;

  const exportDisabled =
    selectedCount === 0 || dirName == undefined || connectionLost != undefined;
  const exportAndOpenDisabled = selectedCount !== 1 || dirName == undefined || connectionLost != undefined;

  // Explain why the export buttons are disabled (disabled buttons need a wrapper span for
  // the tooltip to receive mouse events).
  let exportTooltip = "";
  if (dirName == undefined) {
    exportTooltip = t("serverExportSelectDirectoryFirst");
  }
  let exportAndOpenTooltip = exportTooltip;
  if (exportAndOpenTooltip === "" && selectedCount > 1) {
    exportAndOpenTooltip = t("serverExportMultiFileOpenDisabled");
  }

  // ----- Render helpers -----

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

  const renderConnectStep = () => (
    <>
      <div className={classes.content}>
        {!supportsFileSystemAccess && (
          <Alert severity="warning">{t("serverExportBrowserUnsupported")}</Alert>
        )}
        {alertText != undefined && <Alert severity="error">{alertText}</Alert>}
        <TextField
          label={t("serverExportHost")}
          value={host}
          error={fieldErrors.host != undefined}
          helperText={fieldErrors.host}
          disabled={!supportsFileSystemAccess || busy}
          onChange={(event) => {
            setHost(event.target.value);
          }}
          fullWidth
          variant="outlined"
        />
        <TextField
          label={t("serverExportPort")}
          value={port}
          error={fieldErrors.port != undefined}
          helperText={fieldErrors.port}
          disabled={!supportsFileSystemAccess || busy}
          onChange={(event) => {
            setPort(event.target.value);
          }}
          fullWidth
          variant="outlined"
        />
        <TextField
          label={t("serverExportUsername")}
          value={username}
          error={fieldErrors.username != undefined}
          helperText={fieldErrors.username}
          disabled={!supportsFileSystemAccess || busy}
          onChange={(event) => {
            setUsername(event.target.value);
          }}
          fullWidth
          variant="outlined"
          autoComplete="username"
        />
        <TextField
          label={t("serverExportPassword")}
          type="password"
          value={password}
          error={fieldErrors.password != undefined}
          helperText={fieldErrors.password}
          disabled={!supportsFileSystemAccess || busy}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          fullWidth
          variant="outlined"
          autoComplete="new-password"
        />
        <TextField
          label={t("serverExportBagPath")}
          placeholder="/data/bags"
          value={bagPath}
          error={fieldErrors.bagPath != undefined}
          helperText={fieldErrors.bagPath}
          disabled={!supportsFileSystemAccess || busy}
          onChange={(event) => {
            setBagPath(event.target.value);
          }}
          fullWidth
          variant="outlined"
        />
      </div>
      {renderFooter(
        <Button
          startIcon={<ChevronLeftIcon fontSize="large" />}
          onClick={() => {
            dialogActions.dataSource.open("start");
          }}
        >
          {t("serverExportBack")}
        </Button>,
        <Button
          variant="contained"
          disabled={!supportsFileSystemAccess || busy}
          onClick={() => {
            void onConnect();
          }}
          startIcon={busy ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          {t("serverExportConnectAndBrowse")}
        </Button>,
      )}
    </>
  );

  const renderFileRow = (entry: ServerExportListEntry) => {
    const isActive = entry.kind === "active";
    const checked = selected.has(entry.name);
    return (
      <div key={entry.name} className={classes.fileRow}>
        <Checkbox
          size="small"
          disabled={isActive || connectionLost != undefined}
          checked={checked}
          onChange={(_event, isChecked) => {
            setSelected((prev) => {
              const next = new Set(prev);
              if (isChecked) {
                next.add(entry.name);
              } else {
                next.delete(entry.name);
              }
              return next;
            });
          }}
        />
        <Typography
          variant="body2"
          className={`${classes.monoName} ${isActive ? classes.disabledFileName : ""}`}
          title={entry.name}
        >
          {entry.name}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {formatBytes(entry.size)}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {new Date(entry.mtimeMs).toLocaleString()}
        </Typography>
        {isActive ? (
          <Tooltip title={t("serverExportRecordingInProgress")}>
            <IconButton size="small" disabled>
              <CircularProgress size={14} variant="indeterminate" />
            </IconButton>
          </Tooltip>
        ) : (
          <span />
        )}
      </div>
    );
  };

  const renderBrowseStep = () => (
    <>
      <div className={classes.content}>
        {connectionLost != undefined && (
          <Alert
            severity="error"
            action={
              <Button
                color="inherit"
                size="small"
                disabled={busy}
                onClick={() => {
                  void onReconnect();
                }}
              >
                {t("serverExportReconnect")}
              </Button>
            }
          >
            {t("serverExportConnectionLost")}
          </Alert>
        )}
        {alertText != undefined && <Alert severity="error">{alertText}</Alert>}
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          gap={2}
          className={classes.browseHeader}
        >
          <Typography variant="body2" color="text.secondary" className={classes.monoName}>
            {t("serverExportConnectedTo", {
              username,
              host,
              path: normalizedBagPath,
            })}
          </Typography>
          <Stack direction="row" gap={1} alignItems="center">
            <Button
              size="small"
              disabled={busy || connectionLost != undefined}
              onClick={() => {
                void onRefresh();
              }}
            >
              {t("serverExportRefresh")}
            </Button>
            <Link
              component="button"
              variant="body2"
              onClick={onDisconnectAndBack}
            >
              {t("serverExportDisconnectAndBack")}
            </Link>
          </Stack>
        </Stack>
        <div className={classes.fileList}>
          <div className={`${classes.fileRow} ${classes.headerRow}`}>
            <Checkbox
              size="small"
              disabled={selectable.length === 0 || connectionLost != undefined}
              checked={allSelected}
              indeterminate={someSelected}
              onChange={(_event, isChecked) => {
                setSelected(isChecked ? new Set(selectable.map((entry) => entry.name)) : new Set());
              }}
            />
            <Typography variant="subtitle2">{t("serverExportColumnName")}</Typography>
            <Typography variant="subtitle2">{t("serverExportColumnSize")}</Typography>
            <Typography variant="subtitle2">{t("serverExportColumnModified")}</Typography>
            <span />
          </div>
          {entries.map(renderFileRow)}
          {entries.length === 0 && (
            <Stack padding={4} alignItems="center">
              <Typography variant="body2" color="text.secondary">
                {t("serverExportEmptyDirectory")}
              </Typography>
            </Stack>
          )}
        </div>
        <Stack direction="row" alignItems="center" gap={2}>
          <Button
            variant="outlined"
            startIcon={<FolderOpenIcon />}
            disabled={connectionLost != undefined}
            onClick={() => {
              void onPickDirectory();
            }}
          >
            {t("serverExportChooseDirectory")}
          </Button>
          {dirName != undefined ? (
            // The File System Access API only exposes the directory name, not its full path.
            <Typography variant="body2" className={classes.monoName} title={dirName}>
              {dirName}
            </Typography>
          ) : (
            <Typography variant="body2" className={classes.warningText}>
              {t("serverExportNoDirectorySelected")}
            </Typography>
          )}
        </Stack>
      </div>
      {renderFooter(
        <span />,
        <>
          <Tooltip title={exportAndOpenTooltip}>
            <span>
              <Button
                variant="outlined"
                disabled={exportAndOpenDisabled}
                onClick={() => {
                  void onStartExport({ openAfter: true });
                }}
              >
                {t("serverExportAndOpen")}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={exportTooltip}>
            <span>
              <Button
                variant="contained"
                disabled={exportDisabled}
                onClick={() => {
                  void onStartExport({ openAfter: false });
                }}
              >
                {selectedCount === 1
                  ? t("serverExportExportFile")
                  : t("serverExportExportFiles", { count: selectedCount })}
              </Button>
            </span>
          </Tooltip>
        </>,
      )}
    </>
  );

  const renderExportingStep = () => (
    <>
      <div className={classes.content}>
        <Typography variant="h6">{t("serverExportExporting")}</Typography>
        <Stack gap={1}>
          <LinearProgress
            variant="determinate"
            value={progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}
          />
          <Typography variant="body2" color="text.secondary">
            {t("serverExportExportStats", {
              completed: formatBytes(progress.completed),
              total: formatBytes(progress.total),
              speed:
                exportStats.speedBytesPerSec != undefined
                  ? `${formatBytes(exportStats.speedBytesPerSec)}/s`
                  : "—",
              eta:
                exportStats.etaSeconds != undefined
                  ? formatDuration(exportStats.etaSeconds)
                  : "—",
            })}
          </Typography>
          {activeItem != undefined && (
            <Typography variant="body2" color="text.secondary" className={classes.monoName}>
              {t("serverExportCurrentFile", { name: activeItem.name })}
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

  const renderSummaryGroup = (title: string, groupItems: ExportItem[], opts: { showReason: boolean }) => {
    if (groupItems.length === 0) {
      return undefined;
    }
    const totalBytes = groupItems.reduce((acc, item) => acc + item.bytesWritten, 0);
    return (
      <Stack gap={0.5}>
        <Typography variant="subtitle2">
          {`${title} (${groupItems.length}${groupItems.every((i) => i.status === "success") ? ` · ${formatBytes(totalBytes)}` : ""})`}
        </Typography>
        {opts.showReason &&
          groupItems.map((item) => (
            <Typography key={item.name} variant="body2" color="text.secondary">
              {`${item.name} — ${
                item.reasonCode != undefined ? errorText(t, item.reasonCode) : ""
              }${item.reasonDetail != undefined && item.reasonDetail !== "" ? ` (${item.reasonDetail})` : ""}`}
            </Typography>
          ))}
        {!opts.showReason && (
          <Typography variant="body2" color="text.secondary" className={classes.monoName}>
            {groupItems.map((item) => item.name).join(", ")}
          </Typography>
        )}
      </Stack>
    );
  };

  const renderSummaryStep = () => {
    const succeeded = items.filter((item) => item.status === "success");
    const skipped = items.filter((item) => item.status === "skipped");
    const failed = items.filter((item) => item.status === "failed");
    const notStarted = items.filter((item) => item.status === "notStarted");
    return (
      <>
        <div className={classes.content}>
          {alertText != undefined && <Alert severity="error">{alertText}</Alert>}
          {renderSummaryGroup(t("serverExportSucceeded"), succeeded, { showReason: false })}
          {renderSummaryGroup(t("serverExportSkipped"), skipped, { showReason: false })}
          {renderSummaryGroup(t("serverExportFailed"), failed, { showReason: true })}
          {renderSummaryGroup(t("serverExportNotStarted"), notStarted, { showReason: false })}
        </div>
        {renderFooter(
          <span />,
          <>
            {retryableCount > 0 && (
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
      {step === "connect" && renderConnectStep()}
      {step === "browse" && renderBrowseStep()}
      {step === "exporting" && renderExportingStep()}
      {step === "summary" && renderSummaryStep()}
      <Dialog open={conflictCount != undefined} onClose={() => { resolveConflict("cancel"); }}>
        <DialogTitle>{t("serverExportConflictTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {t("serverExportConflictMessage", { count: conflictCount ?? 0 })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { resolveConflict("cancel"); }}>{t("serverExportCancel")}</Button>
          <Button onClick={() => { resolveConflict("skip"); }}>{t("serverExportSkipExisting")}</Button>
          <Button variant="contained" onClick={() => { resolveConflict("overwrite"); }}>
            {t("serverExportOverwriteAll")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
