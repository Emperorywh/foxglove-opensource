// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import {
  Alert,
  Button,
  Checkbox,
  Chip,
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
import {
  ServerExportZipWriter,
  ZipSizeLimitExceededError,
  createZipWriter,
  resolveZipNameConflict,
  zipFileName,
  zipSelectionTooLarge,
} from "./serverExportZip";

const LOCAL_STORAGE_PREFIX = "foxglove.serverExport.";

/** Sliding window used to estimate the current download speed. */
const SPEED_WINDOW_MS = 5000;

type Step = "connect" | "browse" | "exporting" | "summary";

type ExportItemStatus = "pending" | "active" | "success" | "failed" | "skipped" | "notStarted";

/** Failure reasons shown in the summary: bridge codes plus client-local zip semantics. */
type ExportItemReasonCode = ServerExportErrorCode | "CANCELED" | "ZIP_ABORTED" | "ZIP_TOO_LARGE";

type ExportItem = {
  name: string;
  /** Best-known size: from list, corrected to the actual byte count as the transfer reports it. */
  size: number;
  /** From the directory listing; used as the zip entry's mtime (clamped by the writer). */
  mtimeMs: number;
  status: ExportItemStatus;
  bytesWritten: number;
  reasonCode?: ExportItemReasonCode;
  reasonDetail?: string;
};

type ConflictChoice = "overwrite" | "skip" | "cancel";

type ExportSession = {
  cancelRequested: boolean;
  stopQueue: boolean;
  consecutiveLocalFailures: number;
};

/** Single file = bare export (original flow); ≥2 files = one streamed zip (SPEC §5). */
type ExportMode = "single" | "zip";

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
  nameCell: {
    minWidth: 0,
    overflow: "hidden",
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

function errorText(t: TFunction<"openDialog">, code: ExportItemReasonCode): string {
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
    case "ZIP_TOO_LARGE":
      return t("serverExportErrorZipTooLarge");
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
  const [filter, setFilter] = useState("");
  const [dirName, setDirName] = useState<string>();
  const [connectionLost, setConnectionLost] = useState<string>();

  // ----- Export state -----
  const [items, setItemsState] = useState<ExportItem[]>([]);
  const [canceling, setCanceling] = useState(false);
  const [conflictCount, setConflictCount] = useState<number>();
  /** Zip file being written / produced by the current export session (zip mode only). */
  const [activeZipName, setActiveZipName] = useState<string>();
  /** Partial zip that could not be deleted after a voided export (SPEC §8.6). */
  const [leftoverZip, setLeftoverZip] = useState<string>();
  // Re-render on a slow tick while exporting so the speed/ETA display stays fresh.
  const [, setStatsTick] = useState(0);

  const itemsRef = useRef<ExportItem[]>([]);
  const clientRef = useRef<ServerExportBridgeClient>();
  const dirHandleRef = useRef<FileSystemDirectoryHandle>();
  const exportSessionRef = useRef<ExportSession>();
  const openAfterExportRef = useRef(false);
  const conflictResolveRef = useRef<(choice: ConflictChoice) => void>();
  const speedSamplesRef = useRef<{ time: number; bytes: number }[]>([]);
  const exportModeRef = useRef<ExportMode>("single");
  /** Base zip name of the current export session; retries reuse it (SPEC §5.4). */
  const zipNameRef = useRef<string>();
  const zipWriterRef = useRef<ServerExportZipWriter>();
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
      const zipWriter = zipWriterRef.current;
      if (zipWriter != undefined) {
        zipWriterRef.current = undefined;
        // Deletes the partial zip via the writer's onAbort cleanup (SPEC §7).
        void zipWriter.abort().catch(() => undefined);
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

  /**
   * Zip mode (SPEC §5/§7): ≥2 selected files are streamed into a single zip container.
   * Any failure or cancellation voids the whole package — the partial zip is deleted,
   * previously completed items join the failed group, and retry re-runs everything.
   */
  const runZipExport = useCallback(
    async (files: ExportItem[], opts: { openAfter: boolean }) => {
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

      // The zip name is generated once per export session and reused across retries
      // (SPEC §5.4); a leftover partial zip gets an automatic " (n)" suffix instead.
      zipNameRef.current ??= zipFileName(new Date());
      const zipName = await resolveZipNameConflict(zipNameRef.current, async (name) => {
        try {
          await dirHandle.getFileHandle(name);
          return true;
        } catch {
          return false; // NotFoundError: no conflict
        }
      });

      let writable: FileSystemWritableFileStream;
      try {
        const fileHandle = await dirHandle.getFileHandle(zipName, { create: true });
        writable = await fileHandle.createWritable();
      } catch (err) {
        // The single local product cannot be created — nothing has started (SPEC §7).
        setAlertText(errorText(tRef.current, "LOCAL_WRITE_ERROR"));
        for (const file of files) {
          updateItem(file.name, {
            status: "notStarted",
            bytesWritten: 0,
            reasonDetail: err instanceof Error ? err.message : String(err),
          });
        }
        exportSessionRef.current = undefined;
        setStep("summary");
        return;
      }

      setActiveZipName(zipName);
      const writer = createZipWriter(writable, {
        onAbort: async () => {
          try {
            await dirHandle.removeEntry(zipName);
          } catch (err) {
            // A leftover partial zip is reported in the summary for manual cleanup
            // (SPEC §8.6); NotFoundError just means it was never flushed to disk.
            if (!(err instanceof DOMException && err.name === "NotFoundError")) {
              setLeftoverZip(zipName);
            }
          }
        },
      });
      zipWriterRef.current = writer;

      /**
       * Whole-package void (SPEC §7.3): abort the writer (deleting the partial zip),
       * then regroup — items before `currentIndex` were completed but lose their
       * product; the trigger item keeps its own error; later items never started.
       */
      const voidZip = async (
        currentIndex: number,
        trigger: { code: ExportItemReasonCode; detail?: string } | undefined,
        completedCode: ExportItemReasonCode,
        currentWritten: number,
      ): Promise<void> => {
        zipWriterRef.current = undefined;
        await writer.abort();
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          if (file == undefined) {
            continue;
          }
          if (index < currentIndex) {
            updateItem(file.name, { status: "failed", reasonCode: completedCode, bytesWritten: 0 });
          } else if (index === currentIndex && trigger != undefined) {
            updateItem(file.name, {
              status: "failed",
              reasonCode: trigger.code,
              reasonDetail: trigger.detail,
              bytesWritten: currentWritten,
            });
          } else {
            updateItem(file.name, { status: "notStarted", bytesWritten: 0 });
          }
        }
      };

      // Stable flag object: set from inside the download handlers (closures in the loop
      // below) when the zip writer's size guard trips.
      const zipGuard = { exceeded: false };
      let voided = false;
      // The cancel flag is flipped by onCancelExport — read it through the ref so TS
      // doesn't narrow it to its initial value.
      const isCancelRequested = () => exportSessionRef.current?.cancelRequested === true;
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (file == undefined) {
          continue;
        }
        if (isCancelRequested()) {
          await voidZip(index, undefined, "CANCELED", 0);
          voided = true;
          break;
        }
        updateItem(file.name, { status: "active", bytesWritten: 0 });
        let written = 0;
        try {
          const outcome = await client.download(`${normalizedBagPath}/${file.name}`, {
            onStart: (_name, size) => {
              // Correct this file's share of the progress denominator as soon as the
              // real size is known — symlink list sizes can be wildly off (SPEC §5.3).
              updateItem(file.name, { size });
              writer.beginEntry(file.name, file.mtimeMs);
            },
            onData: async (chunk) => {
              try {
                await writer.pushEntryChunk(chunk);
              } catch (err) {
                // The client wraps local onData failures as LOCAL_WRITE_ERROR; remember
                // the size guard so the catch below can classify it correctly.
                zipGuard.exceeded = zipGuard.exceeded || err instanceof ZipSizeLimitExceededError;
                throw err;
              }
              written += chunk.byteLength;
              updateItem(file.name, { bytesWritten: written });
            },
          });
          if (isCancelRequested() || outcome.status === "canceled") {
            // SPEC §8.7: the zip is voided no matter whether fileEnd or canceled won
            // the race; the "keep the completed file" rule is single-file mode only.
            await voidZip(index, { code: "CANCELED" }, "CANCELED", written);
            voided = true;
            break;
          }
          await writer.endEntry();
          updateItem(file.name, {
            status: "success",
            bytesWritten: outcome.bytes,
            size: outcome.bytes,
          });
        } catch (err) {
          zipGuard.exceeded = zipGuard.exceeded || err instanceof ZipSizeLimitExceededError;
          const code: ExportItemReasonCode = zipGuard.exceeded
            ? "ZIP_TOO_LARGE"
            : err instanceof ServerExportError
              ? err.code
              : "LOCAL_WRITE_ERROR";
          await voidZip(
            index,
            { code, detail: err instanceof Error ? err.message : String(err) },
            "ZIP_ABORTED",
            written,
          );
          voided = true;
          break;
        }
      }

      if (!voided) {
        try {
          await writer.finalize();
        } catch (err) {
          // The size guard tripped on the central directory, or the final close hit a
          // local write failure: the completed package is voided as well (SPEC §5.6/§7).
          const code: ExportItemReasonCode =
            err instanceof ZipSizeLimitExceededError ? "ZIP_TOO_LARGE" : "LOCAL_WRITE_ERROR";
          await voidZip(files.length, undefined, code, 0);
        }
      }

      zipWriterRef.current = undefined;
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
        .filter((entry) => entry.kind !== "active" && selected.has(entry.name))
        .map((entry) => ({
          name: entry.name,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          status: "pending",
          bytesWritten: 0,
        }));
      setItems(() => chosen);
      setAlertText(undefined);
      setLeftoverZip(undefined);
      if (chosen.length >= 2) {
        // SPEC §5.5: zip mode skips the per-file conflict prompt entirely — only the
        // zip name is probed. A fresh export session gets a fresh zip name.
        exportModeRef.current = "zip";
        zipNameRef.current = undefined;
        await runZipExport(chosen, { openAfter });
      } else {
        exportModeRef.current = "single";
        setActiveZipName(undefined);
        await checkConflictsAndExport(chosen, { openAfter });
      }
    },
    [entries, selected, setItems, checkConflictsAndExport, runZipExport],
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
    if (exportModeRef.current === "zip") {
      // SPEC §7: a zip-mode retry re-runs the whole package; the failed + not-started
      // groups are the entire selection, and the session's zip name is reused.
      const files = retryFiles.map((item) => ({
        ...item,
        status: "pending" as const,
        bytesWritten: 0,
        reasonCode: undefined,
        reasonDetail: undefined,
      }));
      setItems((prev) => prev.map((item) => files.find((f) => f.name === item.name) ?? item));
      setLeftoverZip(undefined);
      await runZipExport(files, { openAfter: openAfterExportRef.current });
      return;
    }
    await checkConflictsAndExport(retryFiles, { openAfter: openAfterExportRef.current });
  }, [checkConflictsAndExport, connectAndList, connectionLost, replaceClient, runZipExport, setItems, t]);

  const onDone = useCallback(() => {
    replaceClient(undefined);
    dialogActions.dataSource.close();
  }, [dialogActions, replaceClient]);

  // ----- Derived rendering state -----

  // File-name substring filter (SPEC §6.1): case-insensitive, applied live. Selections
  // are recorded by name and survive filter changes.
  const normalizedFilter = filter.toLowerCase();
  const visibleEntries = useMemo(
    () =>
      normalizedFilter === ""
        ? entries
        : entries.filter((entry) => entry.name.toLowerCase().includes(normalizedFilter)),
    [entries, normalizedFilter],
  );
  const visibleSelectable = useMemo(
    () => visibleEntries.filter((entry) => entry.kind !== "active"),
    [visibleEntries],
  );
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selected.has(entry.name)),
    [entries, selected],
  );
  // Selection counts/sizes always cover every checked item, including ones currently
  // hidden by the filter (SPEC §6.1).
  const selectedCount = selectedEntries.length;
  const selectedTotalSize = selectedEntries.reduce((acc, entry) => acc + entry.size, 0);
  const outsideFilterCount =
    normalizedFilter === ""
      ? 0
      : selectedEntries.filter((entry) => !entry.name.toLowerCase().includes(normalizedFilter))
          .length;
  // The header checkbox acts on the *filtered* selectable rows only.
  const allSelected =
    visibleSelectable.length > 0 &&
    visibleSelectable.every((entry) => selected.has(entry.name));
  const someSelected =
    !allSelected && visibleSelectable.some((entry) => selected.has(entry.name));

  const singleSelectedEntry = selectedCount === 1 ? selectedEntries[0] : undefined;
  // SPEC §5.6: selections at or over the container limit are rejected up front —
  // the write-time guard in the zip writer stays the correctness backstop.
  const overZipLimit = selectedCount >= 2 && zipSelectionTooLarge(selectedTotalSize);

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
    selectedCount === 0 || dirName == undefined || connectionLost != undefined || overZipLimit;
  const exportAndOpenDisabled =
    singleSelectedEntry?.kind !== "bag" || dirName == undefined || connectionLost != undefined;

  // Explain why the export buttons are disabled (disabled buttons need a wrapper span for
  // the tooltip to receive mouse events).
  let exportTooltip = "";
  if (dirName == undefined) {
    exportTooltip = t("serverExportSelectDirectoryFirst");
  } else if (overZipLimit) {
    exportTooltip = t("serverExportErrorZipTooLarge");
  }
  let exportAndOpenTooltip = dirName == undefined ? t("serverExportSelectDirectoryFirst") : "";
  if (exportAndOpenTooltip === "") {
    if (selectedCount > 1) {
      exportAndOpenTooltip = t("serverExportMultiFileOpenDisabled");
    } else if (selectedCount === 1 && singleSelectedEntry?.kind !== "bag") {
      exportAndOpenTooltip = t("serverExportNonBagOpenDisabled");
    }
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
        <Stack direction="row" alignItems="center" gap={1} className={classes.nameCell}>
          <Typography
            variant="body2"
            className={`${classes.monoName} ${isActive ? classes.disabledFileName : ""}`}
            title={entry.name}
          >
            {entry.name}
          </Typography>
          {entry.kind === "bag" && <Chip label="BAG" size="small" color="primary" variant="outlined" />}
        </Stack>
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
        <TextField
          size="small"
          placeholder={t("serverExportFilterPlaceholder")}
          value={filter}
          disabled={connectionLost != undefined}
          onChange={(event) => {
            setFilter(event.target.value);
          }}
          fullWidth
          variant="outlined"
        />
        <div className={classes.fileList}>
          <div className={`${classes.fileRow} ${classes.headerRow}`}>
            <Checkbox
              size="small"
              disabled={visibleSelectable.length === 0 || connectionLost != undefined}
              checked={allSelected}
              indeterminate={someSelected}
              onChange={(_event, isChecked) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  for (const entry of visibleSelectable) {
                    if (isChecked) {
                      next.add(entry.name);
                    } else {
                      next.delete(entry.name);
                    }
                  }
                  return next;
                });
              }}
            />
            <Typography variant="subtitle2">{t("serverExportColumnName")}</Typography>
            <Typography variant="subtitle2">{t("serverExportColumnSize")}</Typography>
            <Typography variant="subtitle2">{t("serverExportColumnModified")}</Typography>
            <span />
          </div>
          {visibleEntries.map(renderFileRow)}
          {entries.length === 0 && (
            <Stack padding={4} alignItems="center">
              <Typography variant="body2" color="text.secondary">
                {t("serverExportEmptyDirectory")}
              </Typography>
            </Stack>
          )}
          {entries.length > 0 && visibleEntries.length === 0 && (
            <Stack padding={4} alignItems="center">
              <Typography variant="body2" color="text.secondary">
                {t("serverExportNoMatchingFiles")}
              </Typography>
            </Stack>
          )}
        </div>
        <Typography variant="body2" color="text.secondary">
          {t("serverExportSelectionSummary", {
            count: selectedCount,
            size: formatBytes(selectedTotalSize),
          })}
          {outsideFilterCount > 0
            ? ` ${t("serverExportSelectionOutsideFilter", { count: outsideFilterCount })}`
            : ""}
        </Typography>
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
                {selectedCount >= 2
                  ? t("serverExportExportZip", { count: selectedCount })
                  : selectedCount === 1
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
          {activeZipName != undefined && (
            <Typography variant="body2" color="text.secondary" className={classes.monoName}>
              {t("serverExportZipTarget", { name: activeZipName })}
            </Typography>
          )}
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
    const successTitle =
      exportModeRef.current === "zip" && activeZipName != undefined
        ? t("serverExportSucceededZipped", { name: activeZipName })
        : t("serverExportSucceeded");
    return (
      <>
        <div className={classes.content}>
          {alertText != undefined && <Alert severity="error">{alertText}</Alert>}
          {leftoverZip != undefined && (
            <Alert severity="warning">{t("serverExportLeftoverZip", { name: leftoverZip })}</Alert>
          )}
          {renderSummaryGroup(successTitle, succeeded, { showReason: false })}
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
