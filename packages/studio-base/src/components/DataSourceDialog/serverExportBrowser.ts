// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Pure Step-B (directory browser) logic for the server-export view
 * (docs/SPEC_server_file_browser.md §6.2): navigation history, entry visibility and
 * ordering, empty-state classification, and the selection summary. No React — the
 * component is a thin shell over these functions, and they are unit-tested in
 * serverExportBrowser.test.ts.
 */

import { ServerExportListEntry } from "./ServerExportBridgeClient";
import { parentDir } from "./serverExportZip";

/**
 * Join a canonical directory and an entry name into a navigation target
 * (SPEC §4.2: navigation targets are always "current canonical path + entry name"; the
 * client never resolves `.`/`..` or redundant slashes locally).
 */
export function joinPath(dir: string, name: string): string {
  return `${dir === "/" ? "" : dir}/${name}`;
}

/** Breadcrumb segments for a canonical path: the root `/` first (SPEC §6.2). */
export function breadcrumbSegments(dir: string): { label: string; path: string }[] {
  const segments = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of dir.split("/")) {
    if (part === "") {
      continue;
    }
    current += `/${part}`;
    segments.push({ label: part, path: current });
  }
  return segments;
}

/**
 * In-session navigation history (B9): canonical directories plus a pointer. Only
 * successful navigations mutate it (SPEC §8.2); a reconnect resets it to [home] (B13).
 */
export type NavigationHistory = {
  entries: string[];
  index: number;
};

export function createHistory(home: string): NavigationHistory {
  return { entries: [home], index: 0 };
}

export function historyCurrent(history: NavigationHistory): string {
  return history.entries[history.index] ?? "/";
}

export function historyCanGoBack(history: NavigationHistory): boolean {
  return history.index > 0;
}

export function historyCanGoForward(history: NavigationHistory): boolean {
  return history.index < history.entries.length - 1;
}

/** Push a new directory, truncating any forward branch. Breadcrumb jumps are pushes too. */
export function historyNavigate(history: NavigationHistory, path: string): NavigationHistory {
  if (path === historyCurrent(history)) {
    return history;
  }
  return {
    entries: [...history.entries.slice(0, history.index + 1), path],
    index: history.index + 1,
  };
}

export function historyBack(history: NavigationHistory): NavigationHistory {
  if (!historyCanGoBack(history)) {
    return history;
  }
  return { entries: history.entries, index: history.index - 1 };
}

export function historyForward(history: NavigationHistory): NavigationHistory {
  if (!historyCanGoForward(history)) {
    return history;
  }
  return { entries: history.entries, index: history.index + 1 };
}

/**
 * Update the current history entry to the canonical path the bridge just returned
 * (B8). A re-list of an already-canonical path normally returns it unchanged; if a
 * symlink in the chain was retargeted since, the displayed location follows reality.
 */
export function historyWithCurrent(history: NavigationHistory, path: string): NavigationHistory {
  if (historyCurrent(history) === path) {
    return history;
  }
  const entries = [...history.entries];
  entries[history.index] = path;
  return { ...history, entries };
}

export function isDotfileName(name: string): boolean {
  return name.startsWith(".");
}

/**
 * The two inputs of the visibility rule (SPEC §6.2): the already-lowercased filter
 * substring and the show-hidden switch.
 */
export type Visibility = {
  normalizedFilter: string;
  showHidden: boolean;
};

/**
 * Unified visibility rule (SPEC §6.2): an entry is visible iff it matches the
 * (already lowercased) filter substring AND (it is not a dotfile OR the show-hidden
 * switch is on).
 */
export function isNameVisible(name: string, visibility: Visibility): boolean {
  if (!visibility.showHidden && isDotfileName(name)) {
    return false;
  }
  return (
    visibility.normalizedFilter === "" || name.toLowerCase().includes(visibility.normalizedFilter)
  );
}

/** Name ordering: case-insensitive first, case-sensitive as the tie-breaker (B11). */
function compareNames(a: string, b: string): number {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA !== lowerB) {
    return lowerA < lowerB ? -1 : 1;
  }
  if (a !== b) {
    return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * Display order (B11): directories by name first, files by mtime descending after;
 * name breaks ties at both levels so the order is stable across refreshes.
 */
export function compareEntries(a: ServerExportListEntry, b: ServerExportListEntry): number {
  const aDir = a.kind === "dir";
  const bDir = b.kind === "dir";
  if (aDir !== bDir) {
    return aDir ? -1 : 1;
  }
  if (aDir) {
    return compareNames(a.name, b.name);
  }
  if (a.mtimeMs !== b.mtimeMs) {
    return b.mtimeMs - a.mtimeMs;
  }
  return compareNames(a.name, b.name);
}

/** The visible entries of the current directory, in display order (SPEC §6.2). */
export function visibleSortedEntries(
  entries: readonly ServerExportListEntry[],
  visibility: Visibility,
): ServerExportListEntry[] {
  return entries.filter((entry) => isNameVisible(entry.name, visibility)).sort(compareEntries);
}

export type BrowserEmptyState = "notEmpty" | "empty" | "allHidden" | "noMatch";

/**
 * Empty-state tiers, first match wins (SPEC §6.2): ① the directory has no entries at
 * all; ② entries exist but are all invisible because of the hidden-files switch alone;
 * ③ any other empty visible set (no filter match, including filter + hidden combined).
 */
export function browserEmptyState(
  entries: readonly ServerExportListEntry[],
  visibility: Visibility,
): BrowserEmptyState {
  if (entries.some((entry) => isNameVisible(entry.name, visibility))) {
    return "notEmpty";
  }
  if (entries.length === 0) {
    return "empty";
  }
  if (
    !visibility.showHidden &&
    entries.every(
      (entry) =>
        isDotfileName(entry.name) &&
        (visibility.normalizedFilter === "" ||
          entry.name.toLowerCase().includes(visibility.normalizedFilter)),
    )
  ) {
    return "allHidden";
  }
  return "noMatch";
}

/** A checked file, remembered by full canonical path so it survives navigation (B1). */
export type SelectedFile = {
  /** Full canonical path — the selection identity. */
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  kind: "bag" | "file";
};

/** Toggle one file; returns a new map. */
export function toggleSelected(
  selection: ReadonlyMap<string, SelectedFile>,
  file: SelectedFile,
): Map<string, SelectedFile> {
  const next = new Map(selection);
  if (next.has(file.path)) {
    next.delete(file.path);
  } else {
    next.set(file.path, file);
  }
  return next;
}

/**
 * Add or remove the given (visible, selectable) files — the header checkbox
 * (SPEC §6.2). Selections outside the visible set are untouched.
 */
export function setManySelected(
  selection: ReadonlyMap<string, SelectedFile>,
  files: readonly SelectedFile[],
  { selected }: { selected: boolean },
): Map<string, SelectedFile> {
  const next = new Map(selection);
  for (const file of files) {
    if (selected) {
      next.set(file.path, file);
    } else {
      next.delete(file.path);
    }
  }
  return next;
}

export type SelectionSummary = {
  /** Total checked items (N), across all directories and visibility states. */
  count: number;
  /** Σ list sizes of all checked items. */
  totalBytes: number;
  /** Distinct canonical parent directories of the checked items (D). */
  dirCount: number;
  /**
   * Checked items in the CURRENT directory hidden by the filter or the hidden-files
   * switch (F). Checked items in other directories are disclosed by dirCount instead
   * and are never counted here (SPEC §6.2).
   */
  notVisibleInCurrentDir: number;
};

export function summarizeSelection(
  selection: ReadonlyMap<string, SelectedFile>,
  currentDir: string,
  visibility: Visibility,
): SelectionSummary {
  const parentDirs = new Set<string>();
  let totalBytes = 0;
  let notVisible = 0;
  for (const file of selection.values()) {
    totalBytes += file.size;
    const parent = parentDir(file.path);
    parentDirs.add(parent);
    if (parent === currentDir && !isNameVisible(file.name, visibility)) {
      notVisible += 1;
    }
  }
  return {
    count: selection.size,
    totalBytes,
    dirCount: parentDirs.size,
    notVisibleInCurrentDir: notVisible,
  };
}
