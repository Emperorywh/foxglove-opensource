// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import FolderIcon from "@mui/icons-material/Folder";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import RefreshIcon from "@mui/icons-material/Refresh";
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
  FormControlLabel,
  IconButton,
  LinearProgress,
  Link,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { TFunction } from "i18next";
import { Fragment, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  NavigationHistory,
  SelectedFile,
  breadcrumbSegments,
  browserEmptyState,
  createHistory,
  historyBack,
  historyCanGoBack,
  historyCanGoForward,
  historyCurrent,
  historyForward,
  historyNavigate,
  historyWithCurrent,
  joinPath,
  setManySelected,
  summarizeSelection,
  toggleSelected,
  visibleSortedEntries,
} from "./serverExportBrowser";
import {
  ServerExportZipWriter,
  ZipSizeLimitExceededError,
  commonAncestorDir,
  createZipWriter,
  parentDir,
  resolveZipNameConflict,
  zipEntryName,
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
  /** Full canonical path — the item's identity and download target (SPEC §6.5). */
  path: string;
  /** Bare file name — the local file name in single-file mode. */
  name: string;
  /**
   * Zip entry name / display label (SPEC §5.1), computed once from the full selection
   * when the export starts and frozen — retries (including a §7.2 reduced set) never
   * recompute it.
   */
  entryName: string;
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

/**
 * How a successful list response updates the navigation history (SPEC §6.2/§8.2):
 * "push" enters a directory (breadcrumb jumps included), "back"/"forward" move the
 * history pointer, "replace" resets to a fresh [dir] (initial load, reconnect),
 * "refresh" keeps the history. Only successful navigations apply — a failed list leaves
 * the history untouched.
 */
type ListNavigation = "push" | "back" | "forward" | "replace" | "refresh";

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
  breadcrumbs: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(0.5),
    flexGrow: 1,
    minWidth: 0,
    overflowX: "auto",
    whiteSpace: "nowrap",
  },
  breadcrumbSeparator: {
    color: theme.palette.text.disabled,
    flexShrink: 0,
  },
  warningText: {
    color: theme.palette.warning.main,
  },
  fileRow: {
    display: "grid",
    gridTemplateColumns: "38px minmax(0, 1fr) auto auto auto",
    alignItems: "center",
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 2),
    borderBottom: `1px solid ${theme.palette.divider}`,
    "&:last-child": {
      borderBottom: "none",
    },
  },
  clickableRow: {
    cursor: "pointer",
    "&:hover": {
      backgroundColor: theme.palette.action.hover,
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [alertText, setAlertText] = useState<string>();
  const [busy, setBusy] = useState(false);

  // ----- Browse state -----
  const [history, setHistory] = useState<NavigationHistory>(() => createHistory("/"));
  const [entries, setEntries] = useState<ServerExportListEntry[]>([]);
  // Checked files live in a path-keyed map so they survive navigation, filtering and
  // the hidden-files switch (B1).
  const [selected, setSelected] = useState<ReadonlyMap<string, SelectedFile>>(() => new Map());
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(() => readStoredField("showHidden") === "1");
  const [navigating, setNavigating] = useState(false);
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
  /**
   * Sole arbiter of navigation races (SPEC §6.2): every list request captures the
   * current value; a response whose value no longer matches is discarded. Covers
   * double-clicks, refresh-overlapping navigation and late responses after leaving
   * Step B.
   */
  const navigationSeqRef = useRef(0);

  const tRef = useRef(t);
  tRef.current = t;

  const setItems = useCallback((updater: (prev: ExportItem[]) => ExportItem[]) => {
    itemsRef.current = updater(itemsRef.current);
    setItemsState(itemsRef.current);
  }, []);

  const updateItem = useCallback(
    (path: string, patch: Partial<ExportItem>) => {
      setItems((prev) => prev.map((it) => (it.path === path ? { ...it, ...patch } : it)));
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

  const replaceClient = useCallback((client: ServerExportBridgeClient | undefined) => {
    clientRef.current?.disconnect();
    clientRef.current = client;
  }, []);

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
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }, [host, port, username, password, t]);

  /** Open the bridge WebSocket and connect SSH. Throws ServerExportError. */
  const connectBridge = useCallback(async (): Promise<{
    client: ServerExportBridgeClient;
    home: string;
  }> => {
    const client = makeClient();
    await client.open();
    try {
      const { home } = await client.connectSsh({
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        password,
      });
      return { client, home };
    } catch (err) {
      client.disconnect();
      throw err;
    }
  }, [makeClient, host, port, username, password]);

  /**
   * Request a directory listing and apply it on success. Stale responses are discarded
   * via navigationSeq; a failed navigation leaves the history and the current listing
   * untouched (SPEC §8.2), while a failed refresh/replace clears the listing (the
   * displayed directory itself is broken — SPEC §8.5/§8.21).
   */
  const requestList = useCallback(async (target: string, nav: ListNavigation): Promise<void> => {
    const client = clientRef.current;
    if (client == undefined) {
      return;
    }
    const seq = ++navigationSeqRef.current;
    setNavigating(true);
    try {
      const result = await client.list(target);
      if (seq !== navigationSeqRef.current) {
        return;
      }
      setHistory((prev) => {
        switch (nav) {
          case "push":
            return historyNavigate(prev, result.path);
          case "back":
            return historyWithCurrent(historyBack(prev), result.path);
          case "forward":
            return historyWithCurrent(historyForward(prev), result.path);
          case "replace":
            return createHistory(result.path);
          case "refresh":
            return historyWithCurrent(prev, result.path);
        }
      });
      setEntries(result.entries);
      // Switching directories clears the filter (B12); a refresh keeps it.
      if (nav !== "refresh") {
        setFilter("");
      }
      setAlertText(undefined);
    } catch (err) {
      if (seq !== navigationSeqRef.current) {
        return;
      }
      if (nav === "refresh" || nav === "replace") {
        setEntries([]);
      }
      const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
      setAlertText(
        `${errorText(tRef.current, code)}${
          err instanceof Error && err.message !== "" ? ` — ${err.message}` : ""
        }`,
      );
    } finally {
      if (seq === navigationSeqRef.current) {
        setNavigating(false);
      }
    }
  }, []);

  const onConnect = useCallback(async () => {
    if (!validateForm()) {
      return;
    }
    setBusy(true);
    setAlertText(undefined);
    try {
      const { client, home } = await connectBridge();
      storeField("host", host.trim());
      storeField("port", port);
      storeField("username", username.trim());
      replaceClient(client);
      // B3/B8: browsing starts at the login user's home (canonical from the bridge).
      setHistory(createHistory(home));
      setEntries([]);
      setSelected(new Map());
      setFilter("");
      setConnectionLost(undefined);
      setStep("browse");
      // SPEC §8.21: if this first listing fails we still stay in Step B — breadcrumb
      // at home, empty list, error alert; refresh / disconnect remain available.
      await requestList(home, "replace");
    } catch (err) {
      const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
      setAlertText(
        `${errorText(t, code)}${
          err instanceof Error && err.message !== "" ? ` — ${err.message}` : ""
        }`,
      );
    } finally {
      setBusy(false);
    }
  }, [validateForm, connectBridge, host, port, username, replaceClient, requestList, t]);

  const onDisconnectAndBack = useCallback(() => {
    // Invalidate any in-flight list response before tearing the client down.
    navigationSeqRef.current += 1;
    setNavigating(false);
    replaceClient(undefined);
    setEntries([]);
    setSelected(new Map());
    setFilter("");
    setConnectionLost(undefined);
    setAlertText(undefined);
    setStep("connect");
  }, [replaceClient]);

  const onReconnect = useCallback(async () => {
    setBusy(true);
    setAlertText(undefined);
    try {
      const { client, home } = await connectBridge();
      replaceClient(client);
      // B13/§7.1: after a reconnect the browser returns to home with the selection,
      // filter and navigation history all cleared. The bridge-side visited-dirs set
      // died with the old SSH session, so the two ends stay consistent.
      setHistory(createHistory(home));
      setEntries([]);
      setSelected(new Map());
      setFilter("");
      setConnectionLost(undefined);
      await requestList(home, "replace");
    } catch (err) {
      // Reconnect failed: fall back to the form step and show the error there (SPEC §5 Step B).
      replaceClient(undefined);
      const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
      setAlertText(errorText(t, code));
      setStep("connect");
    } finally {
      setBusy(false);
    }
  }, [connectBridge, replaceClient, requestList, t]);

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
        itemsRef.current.length > 0 && itemsRef.current.every((item) => item.status === "success");
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
        if (skip.has(file.path)) {
          updateItem(file.path, { status: "skipped", bytesWritten: 0 });
        }
      }

      for (const file of files) {
        if (skip.has(file.path)) {
          continue;
        }
        if (session.cancelRequested || session.stopQueue) {
          updateItem(file.path, { status: "notStarted", bytesWritten: 0 });
          continue;
        }
        updateItem(file.path, { status: "active", bytesWritten: 0 });

        let writable: FileSystemWritableFileStream;
        try {
          // Single-file mode: the local file name is the bare name (SPEC §6.5).
          const fileHandle = await dirHandle.getFileHandle(file.name, { create: true });
          writable = await fileHandle.createWritable();
        } catch (err) {
          session.consecutiveLocalFailures += 1;
          if (session.consecutiveLocalFailures >= 2) {
            session.stopQueue = true;
          }
          updateItem(file.path, {
            status: "failed",
            reasonCode: "LOCAL_WRITE_ERROR",
            reasonDetail: err instanceof Error ? err.message : String(err),
          });
          continue;
        }

        currentWritableRef.current = { writable, name: file.name };
        let written = 0;
        try {
          const outcome = await client.download(file.path, {
            onStart: (_name, size) => {
              updateItem(file.path, { size });
            },
            onData: async (chunk) => {
              await writable.write(chunk);
              written += chunk.byteLength;
              updateItem(file.path, { bytesWritten: written });
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
              updateItem(file.path, {
                status: "failed",
                reasonCode: "LOCAL_WRITE_ERROR",
                reasonDetail: closeErr instanceof Error ? closeErr.message : String(closeErr),
                bytesWritten: written,
              });
              continue;
            }
            session.consecutiveLocalFailures = 0;
            updateItem(file.path, {
              status: "success",
              bytesWritten: outcome.bytes,
              size: outcome.bytes,
            });
          } else {
            // Canceled: delete the partially written file (SPEC §4.3).
            await writable.abort().catch(() => undefined);
            await dirHandle.removeEntry(file.name).catch(() => undefined);
            updateItem(file.path, {
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
          updateItem(file.path, {
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
    [finishIfAllSucceeded, updateItem],
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
          updateItem(file.path, {
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
            updateItem(file.path, { status: "failed", reasonCode: completedCode, bytesWritten: 0 });
          } else if (index === currentIndex && trigger != undefined) {
            updateItem(file.path, {
              status: "failed",
              reasonCode: trigger.code,
              reasonDetail: trigger.detail,
              bytesWritten: currentWritten,
            });
          } else {
            updateItem(file.path, { status: "notStarted", bytesWritten: 0 });
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
        updateItem(file.path, { status: "active", bytesWritten: 0 });
        let written = 0;
        try {
          const outcome = await client.download(file.path, {
            onStart: (_name, size) => {
              // Correct this file's share of the progress denominator as soon as the
              // real size is known — symlink list sizes can be wildly off (SPEC §5.3).
              updateItem(file.path, { size });
              writer.beginEntry(file.entryName, file.mtimeMs);
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
              updateItem(file.path, { bytesWritten: written });
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
          updateItem(file.path, {
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
    [finishIfAllSucceeded, updateItem],
  );

  const checkConflictsAndExport = useCallback(
    async (files: ExportItem[], opts: { openAfter: boolean }) => {
      const dirHandle = dirHandleRef.current;
      if (dirHandle == undefined || files.length === 0) {
        return;
      }
      // Conflict precheck before any transfer starts (SPEC §10): single-file mode only,
      // keyed by the local (bare) file name.
      const conflicts: string[] = [];
      await Promise.all(
        files.map(async (file) => {
          try {
            await dirHandle.getFileHandle(file.name);
            conflicts.push(file.path);
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
      // The zip entry names are computed once from the whole selection (common ancestor
      // of the parent directories, SPEC §5.1/§6.5) and frozen for the export session.
      const paths = [...selected.keys()].sort();
      const ancestor = commonAncestorDir(paths.map(parentDir));
      const chosen: ExportItem[] = [];
      for (const path of paths) {
        const file = selected.get(path);
        if (file == undefined) {
          continue;
        }
        chosen.push({
          path: file.path,
          name: file.name,
          entryName: zipEntryName(file.path, ancestor),
          size: file.size,
          mtimeMs: file.mtimeMs,
          status: "pending",
          bytesWritten: 0,
        });
      }
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
    [selected, setItems, checkConflictsAndExport, runZipExport],
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
    let client = clientRef.current;
    // If the failure was caused by a dropped connection, silently reconnect first
    // (the password is still in memory, SPEC §5 Step D).
    const reconnectNeeded = connectionLost != undefined || client == undefined;
    if (reconnectNeeded) {
      setBusy(true);
      try {
        const connected = await connectBridge();
        replaceClient(connected.client);
        client = connected.client;
        setConnectionLost(undefined);
      } catch (err) {
        // The silent reconnect itself failed — no retry can proceed at all (§7.2).
        replaceClient(undefined);
        const code = err instanceof ServerExportError ? err.code : "IO_ERROR";
        setAlertText(errorText(t, code));
        setStep("connect");
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    const retryItems = itemsRef.current.filter(
      (item) => item.status === "failed" || item.status === "notStarted",
    );
    let runnable = retryItems;
    if (reconnectNeeded && client != undefined && retryItems.length > 0) {
      // The new SSH session dropped the bridge's visited-dirs set — re-list every retry
      // item's parent directory (deduped) before downloading (§7.2). Per-directory
      // degradation: items under a directory that fails to re-list join the failed
      // group directly (with the re-list error) and sit this export out.
      const parentDirs = [...new Set(retryItems.map((item) => parentDir(item.path)))];
      const relistFailures = new Map<string, ServerExportError>();
      setBusy(true);
      for (const dir of parentDirs) {
        try {
          await client.list(dir);
        } catch (err) {
          relistFailures.set(
            dir,
            err instanceof ServerExportError
              ? err
              : new ServerExportError("IO_ERROR", err instanceof Error ? err.message : String(err)),
          );
        }
      }
      setBusy(false);
      if (relistFailures.size > 0) {
        runnable = [];
        for (const item of retryItems) {
          const failure = relistFailures.get(parentDir(item.path));
          if (failure == undefined) {
            runnable.push(item);
          } else {
            updateItem(item.path, {
              status: "failed",
              reasonCode: failure.code,
              reasonDetail: failure.message,
              bytesWritten: 0,
            });
          }
        }
      }
    }
    if (runnable.length === 0) {
      // Every retry item degraded — the summary already shows the re-list failures.
      return;
    }
    if (exportModeRef.current === "zip") {
      // SPEC §7: a zip-mode retry re-runs the package (reduced to the successfully
      // re-listed directories under §7.2); entryName stays frozen and the session's
      // zip name is reused.
      const files = runnable.map((item) => ({
        ...item,
        status: "pending" as const,
        bytesWritten: 0,
        reasonCode: undefined,
        reasonDetail: undefined,
      }));
      setItems((prev) => prev.map((item) => files.find((f) => f.path === item.path) ?? item));
      setLeftoverZip(undefined);
      await runZipExport(files, { openAfter: openAfterExportRef.current });
      return;
    }
    await checkConflictsAndExport(runnable, { openAfter: openAfterExportRef.current });
  }, [
    checkConflictsAndExport,
    connectBridge,
    connectionLost,
    replaceClient,
    runZipExport,
    setItems,
    t,
    updateItem,
  ]);

  const onDone = useCallback(() => {
    replaceClient(undefined);
    dialogActions.dataSource.close();
  }, [dialogActions, replaceClient]);

  // ----- Derived rendering state -----

  const currentDir = historyCurrent(history);
  // File-name substring filter (B12): case-insensitive, applied live, current
  // directory only; cleared on every directory switch.
  const normalizedFilter = filter.toLowerCase();
  const visibility = useMemo(
    () => ({ normalizedFilter, showHidden }),
    [normalizedFilter, showHidden],
  );
  const visibleEntries = useMemo(
    () => visibleSortedEntries(entries, visibility),
    [entries, visibility],
  );
  /** Visible files that can be checked (no directories, no .bag.active) — the header
   *  checkbox acts on exactly this set (SPEC §6.2). */
  const selectableFiles = useMemo(
    () =>
      visibleEntries
        .filter((entry) => entry.kind === "bag" || entry.kind === "file")
        .map((entry) => ({
          path: joinPath(currentDir, entry.name),
          name: entry.name,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          kind: entry.kind === "bag" ? ("bag" as const) : ("file" as const),
        })),
    [visibleEntries, currentDir],
  );
  const selectionSummary = useMemo(
    () => summarizeSelection(selected, currentDir, visibility),
    [selected, currentDir, visibility],
  );
  // Selection counts/sizes always cover every checked item, across directories and
  // visibility states (B1, SPEC §6.2).
  const selectedCount = selectionSummary.count;
  const allSelected =
    selectableFiles.length > 0 && selectableFiles.every((file) => selected.has(file.path));
  const someSelected = !allSelected && selectableFiles.some((file) => selected.has(file.path));

  const selectedFiles = useMemo(() => [...selected.values()], [selected]);
  const singleSelectedFile = selectedCount === 1 ? selectedFiles[0] : undefined;
  // SPEC §5.6: selections at or over the container limit are rejected up front —
  // the write-time guard in the zip writer stays the correctness backstop.
  const overZipLimit = selectedCount >= 2 && zipSelectionTooLarge(selectionSummary.totalBytes);

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
    singleSelectedFile?.kind !== "bag" || dirName == undefined || connectionLost != undefined;

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
    } else if (selectedCount === 1 && singleSelectedFile?.kind !== "bag") {
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

  const renderDirRow = (entry: ServerExportListEntry) => (
    <div
      key={entry.name}
      className={`${classes.fileRow} ${classes.clickableRow}`}
      onClick={() => {
        // Single click enters a directory (B4); no checkbox on directory rows (B2).
        if (connectionLost != undefined) {
          return;
        }
        void requestList(joinPath(currentDir, entry.name), "push");
      }}
    >
      <span />
      <Stack direction="row" alignItems="center" gap={1} className={classes.nameCell}>
        <FolderIcon fontSize="small" color="action" />
        <Typography variant="body2" className={classes.monoName} title={entry.name}>
          {entry.name}
        </Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" noWrap>
        —
      </Typography>
      <Typography variant="body2" color="text.secondary" noWrap>
        {new Date(entry.mtimeMs).toLocaleString()}
      </Typography>
      <span />
    </div>
  );

  const renderFileRow = (entry: ServerExportListEntry) => {
    const isActive = entry.kind === "active";
    const path = joinPath(currentDir, entry.name);
    const checked = selected.has(path);
    const toggle = () => {
      if (isActive || connectionLost != undefined) {
        return;
      }
      // Single click on a file row toggles its checkbox (B4 — symmetric gestures).
      setSelected((prev) =>
        toggleSelected(prev, {
          path,
          name: entry.name,
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          kind: entry.kind === "bag" ? "bag" : "file",
        }),
      );
    };
    return (
      <div
        key={entry.name}
        className={`${classes.fileRow} ${isActive ? "" : classes.clickableRow}`}
        onClick={toggle}
      >
        <Checkbox
          size="small"
          disabled={isActive || connectionLost != undefined}
          checked={checked}
          onClick={(event) => {
            // The row's own onClick would double-toggle.
            event.stopPropagation();
          }}
          onChange={toggle}
        />
        <Stack direction="row" alignItems="center" gap={1} className={classes.nameCell}>
          <Typography
            variant="body2"
            className={`${classes.monoName} ${isActive ? classes.disabledFileName : ""}`}
            title={entry.name}
          >
            {entry.name}
          </Typography>
          {entry.kind === "bag" && (
            <Chip label="BAG" size="small" color="primary" variant="outlined" />
          )}
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

  const renderBrowseStep = () => {
    const segments = breadcrumbSegments(currentDir);
    const emptyState = browserEmptyState(entries, visibility);
    // Summary suffixes, in a fixed order and combinable (SPEC §6.2):
    // "(across D directories)" when the selection spans directories, and
    // "(incl. F hidden by filter/visibility)" for checked items of the CURRENT
    // directory hidden by the filter or the hidden-files switch.
    const summaryExtras = [
      selectionSummary.dirCount >= 2
        ? t("serverExportSelectionCrossDirs", { count: selectionSummary.dirCount })
        : undefined,
      selectionSummary.notVisibleInCurrentDir >= 1
        ? t("serverExportSelectionNotVisible", { count: selectionSummary.notVisibleInCurrentDir })
        : undefined,
    ].filter((part) => part != undefined);
    const summarySuffix = summaryExtras.length > 0 ? `(${summaryExtras.join("; ")})` : "";
    return (
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
          <Stack direction="row" alignItems="center" gap={1} className={classes.browseHeader}>
            <Tooltip title={t("serverExportNavigateBack")}>
              <span>
                <IconButton
                  size="small"
                  disabled={!historyCanGoBack(history) || connectionLost != undefined}
                  onClick={() => {
                    const target = history.entries[history.index - 1];
                    if (target != undefined) {
                      void requestList(target, "back");
                    }
                  }}
                >
                  <ArrowBackIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={t("serverExportNavigateForward")}>
              <span>
                <IconButton
                  size="small"
                  disabled={!historyCanGoForward(history) || connectionLost != undefined}
                  onClick={() => {
                    const target = history.entries[history.index + 1];
                    if (target != undefined) {
                      void requestList(target, "forward");
                    }
                  }}
                >
                  <ArrowForwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <div className={classes.breadcrumbs}>
              {segments.map((segment, index) => {
                const isCurrent = index === segments.length - 1;
                return (
                  <Fragment key={segment.path}>
                    {index > 0 && (
                      <ChevronRightIcon fontSize="small" className={classes.breadcrumbSeparator} />
                    )}
                    {isCurrent || connectionLost != undefined ? (
                      <Typography variant="body2" noWrap>
                        {segment.label}
                      </Typography>
                    ) : (
                      <Link
                        component="button"
                        variant="body2"
                        noWrap
                        onClick={() => {
                          void requestList(segment.path, "push");
                        }}
                      >
                        {segment.label}
                      </Link>
                    )}
                  </Fragment>
                );
              })}
            </div>
            <Tooltip title={t("serverExportRefresh")}>
              <span>
                <IconButton
                  size="small"
                  disabled={connectionLost != undefined}
                  onClick={() => {
                    void requestList(currentDir, "refresh");
                  }}
                >
                  <RefreshIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={showHidden}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setShowHidden(next);
                    storeField("showHidden", next ? "1" : "0");
                  }}
                />
              }
              label={<Typography variant="body2">{t("serverExportShowHidden")}</Typography>}
            />
            <Link component="button" variant="body2" noWrap onClick={onDisconnectAndBack}>
              {t("serverExportDisconnectAndBack")}
            </Link>
          </Stack>
          <Typography variant="body2" color="text.secondary" className={classes.monoName}>
            {t("serverExportConnectedTo", { username, host })}
          </Typography>
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
            {navigating ? (
              // While navigating the list shows a loading placeholder instead of rows,
              // so nothing stale can be clicked (SPEC §6.2). The navigation controls
              // and [断开并返回] above stay usable — a hung list must not trap the user.
              <Stack padding={4} alignItems="center">
                <CircularProgress size={24} />
              </Stack>
            ) : (
              <>
                <div className={`${classes.fileRow} ${classes.headerRow}`}>
                  <Checkbox
                    size="small"
                    disabled={selectableFiles.length === 0 || connectionLost != undefined}
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={(_event, isChecked) => {
                      setSelected((prev) =>
                        setManySelected(prev, selectableFiles, { selected: isChecked }),
                      );
                    }}
                  />
                  <Typography variant="subtitle2">{t("serverExportColumnName")}</Typography>
                  <Typography variant="subtitle2">{t("serverExportColumnSize")}</Typography>
                  <Typography variant="subtitle2">{t("serverExportColumnModified")}</Typography>
                  <span />
                </div>
                {visibleEntries.map((entry) =>
                  entry.kind === "dir" ? renderDirRow(entry) : renderFileRow(entry),
                )}
                {visibleEntries.length === 0 && (
                  <Stack padding={4} alignItems="center">
                    <Typography variant="body2" color="text.secondary">
                      {emptyState === "empty"
                        ? t("serverExportEmptyDirectory")
                        : emptyState === "allHidden"
                        ? t("serverExportAllHidden")
                        : t("serverExportNoMatchingFiles")}
                    </Typography>
                  </Stack>
                )}
              </>
            )}
          </div>
          <Typography variant="body2" color="text.secondary">
            {t("serverExportSelectionSummary", {
              count: selectedCount,
              suffix: summarySuffix,
              size: formatBytes(selectionSummary.totalBytes),
            })}
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
  };

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
                exportStats.etaSeconds != undefined ? formatDuration(exportStats.etaSeconds) : "—",
            })}
          </Typography>
          {activeItem != undefined && (
            <Typography variant="body2" color="text.secondary" className={classes.monoName}>
              {t("serverExportCurrentFile", { name: activeItem.entryName })}
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

  const renderSummaryGroup = (
    title: string,
    groupItems: ExportItem[],
    opts: { showReason: boolean },
  ) => {
    if (groupItems.length === 0) {
      return undefined;
    }
    const totalBytes = groupItems.reduce((acc, item) => acc + item.bytesWritten, 0);
    return (
      <Stack gap={0.5}>
        <Typography variant="subtitle2">
          {`${title} (${groupItems.length}${
            groupItems.every((i) => i.status === "success") ? ` · ${formatBytes(totalBytes)}` : ""
          })`}
        </Typography>
        {opts.showReason &&
          groupItems.map((item) => (
            <Typography key={item.path} variant="body2" color="text.secondary">
              {`${item.entryName} — ${
                item.reasonCode != undefined ? errorText(t, item.reasonCode) : ""
              }${
                item.reasonDetail != undefined && item.reasonDetail !== ""
                  ? ` (${item.reasonDetail})`
                  : ""
              }`}
            </Typography>
          ))}
        {!opts.showReason && (
          <Typography variant="body2" color="text.secondary" className={classes.monoName}>
            {groupItems.map((item) => item.entryName).join(", ")}
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
      <Dialog
        open={conflictCount != undefined}
        onClose={() => {
          resolveConflict("cancel");
        }}
      >
        <DialogTitle>{t("serverExportConflictTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {t("serverExportConflictMessage", { count: conflictCount ?? 0 })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              resolveConflict("cancel");
            }}
          >
            {t("serverExportCancel")}
          </Button>
          <Button
            onClick={() => {
              resolveConflict("skip");
            }}
          >
            {t("serverExportSkipExisting")}
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              resolveConflict("overwrite");
            }}
          >
            {t("serverExportOverwriteAll")}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
