// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ServerExportListEntry } from "./ServerExportBridgeClient";
import {
  SelectedFile,
  breadcrumbSegments,
  browserEmptyState,
  compareEntries,
  createHistory,
  historyBack,
  historyCanGoBack,
  historyCanGoForward,
  historyCurrent,
  historyForward,
  historyNavigate,
  isNameVisible,
  joinPath,
  setManySelected,
  summarizeSelection,
  toggleSelected,
  visibleSortedEntries,
} from "./serverExportBrowser";

function entry(
  name: string,
  kind: ServerExportListEntry["kind"] = "file",
  mtimeMs = 0,
): ServerExportListEntry {
  return { name, size: 0, mtimeMs, kind };
}

function file(path: string): SelectedFile {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { path, name, size: 1, mtimeMs: 0, kind: "file" };
}

describe("joinPath", () => {
  it("joins a canonical directory and an entry name", () => {
    expect(joinPath("/data/bags", "sub")).toBe("/data/bags/sub");
    expect(joinPath("/", "sub")).toBe("/sub");
  });
});

describe("breadcrumbSegments", () => {
  it("starts at the root with one segment per path component", () => {
    expect(breadcrumbSegments("/")).toEqual([{ label: "/", path: "/" }]);
    expect(breadcrumbSegments("/home/user/data")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "user", path: "/home/user" },
      { label: "data", path: "/home/user/data" },
    ]);
  });
});

describe("navigation history", () => {
  it("pushes new directories and truncates the forward branch", () => {
    let history = createHistory("/home");
    history = historyNavigate(history, "/home/a");
    history = historyNavigate(history, "/home/a/b");
    expect(history).toEqual({ entries: ["/home", "/home/a", "/home/a/b"], index: 2 });

    history = historyBack(history);
    expect(historyCurrent(history)).toBe("/home/a");
    expect(historyCanGoBack(history)).toBe(true);
    expect(historyCanGoForward(history)).toBe(true);

    // A new navigation discards the forward branch.
    history = historyNavigate(history, "/home/c");
    expect(history).toEqual({ entries: ["/home", "/home/a", "/home/c"], index: 2 });
    expect(historyCanGoForward(history)).toBe(false);
  });

  it("does not push the current directory again", () => {
    const history = historyNavigate(createHistory("/home"), "/home");
    expect(history.entries).toEqual(["/home"]);
    expect(history.index).toBe(0);
  });

  it("clamps back/forward at the ends", () => {
    const history = createHistory("/home");
    expect(historyCanGoBack(history)).toBe(false);
    expect(historyBack(history)).toBe(history);
    expect(historyCanGoForward(history)).toBe(false);
    expect(historyForward(history)).toBe(history);
  });

  it("moves the pointer with back/forward", () => {
    let history = createHistory("/home");
    history = historyNavigate(history, "/a");
    history = historyNavigate(history, "/b");
    history = historyBack(history);
    expect(historyCurrent(history)).toBe("/a");
    history = historyForward(history);
    expect(historyCurrent(history)).toBe("/b");
  });
});

describe("isNameVisible", () => {
  const HIDE = { normalizedFilter: "", showHidden: false };
  const SHOW = { normalizedFilter: "", showHidden: true };
  const filtering = (normalizedFilter: string) => ({ normalizedFilter, showHidden: false });

  it("hides dotfiles unless the switch is on", () => {
    expect(isNameVisible(".env", HIDE)).toBe(false);
    expect(isNameVisible(".env", SHOW)).toBe(true);
    expect(isNameVisible("a.bag", HIDE)).toBe(true);
  });

  it("applies the (lowercased) substring filter case-insensitively", () => {
    expect(isNameVisible("Run-01.BAG", filtering("run"))).toBe(true);
    expect(isNameVisible("Run-01.BAG", filtering("bag"))).toBe(true);
    expect(isNameVisible("Run-01.BAG", filtering("log"))).toBe(false);
  });
});

describe("compareEntries / visibleSortedEntries", () => {
  const HIDE = { normalizedFilter: "", showHidden: false };

  it("orders directories by name first, files by mtime descending after", () => {
    const sorted = visibleSortedEntries(
      [
        entry("old.bag", "bag", 100),
        entry("zeta", "dir", 50),
        entry("new.bag", "bag", 300),
        entry("Alpha", "dir", 10),
        entry("mid.bag", "bag", 200),
      ],
      HIDE,
    );
    expect(sorted.map((e) => e.name)).toEqual(["Alpha", "zeta", "new.bag", "mid.bag", "old.bag"]);
  });

  it("breaks ties by name (case-insensitive, then case-sensitive) for stable ordering", () => {
    expect(compareEntries(entry("a.bag", "bag", 100), entry("B.bag", "bag", 100))).toBeLessThan(0);
    expect(compareEntries(entry("Readme", "dir"), entry("readme", "dir"))).toBeLessThan(0);
    expect(compareEntries(entry("x", "dir"), entry("x", "dir"))).toBe(0);
  });

  it("applies visibility before ordering", () => {
    const sorted = visibleSortedEntries(
      [entry(".hidden", "dir", 1), entry("shown", "dir", 2), entry(".secret.bag", "bag", 3)],
      HIDE,
    );
    expect(sorted.map((e) => e.name)).toEqual(["shown"]);
  });
});

describe("browserEmptyState", () => {
  const HIDE = { normalizedFilter: "", showHidden: false };
  const SHOW = { normalizedFilter: "", showHidden: true };
  const filtering = (normalizedFilter: string) => ({ normalizedFilter, showHidden: false });

  it("classifies the tiers in order", () => {
    // ① no entries at all
    expect(browserEmptyState([], HIDE)).toBe("empty");
    // visible entries → no empty state
    expect(browserEmptyState([entry("a.bag", "bag")], HIDE)).toBe("notEmpty");
    // ② all entries hidden by the switch alone
    expect(browserEmptyState([entry(".a"), entry(".b", "dir")], HIDE)).toBe("allHidden");
    expect(browserEmptyState([entry(".a"), entry(".b")], filtering("."))).toBe("allHidden");
    // ③ filter + hidden combined is a filter miss, not "all hidden"
    expect(browserEmptyState([entry(".a"), entry(".b")], filtering("zzz"))).toBe("noMatch");
    expect(browserEmptyState([entry("a.bag", "bag")], filtering("zzz"))).toBe("noMatch");
    // switch on → the dotfiles are visible
    expect(browserEmptyState([entry(".a")], SHOW)).toBe("notEmpty");
  });
});

describe("selection operations", () => {
  it("toggles by full path and survives entries from other directories", () => {
    let selection = new Map<string, SelectedFile>();
    selection = toggleSelected(selection, file("/a/x.bag"));
    selection = toggleSelected(selection, file("/b/x.bag")); // same name, other dir
    expect(selection.size).toBe(2);
    selection = toggleSelected(selection, file("/a/x.bag"));
    expect([...selection.keys()]).toEqual(["/b/x.bag"]);
  });

  it("setManySelected only touches the given files", () => {
    let selection = new Map<string, SelectedFile>();
    selection = toggleSelected(selection, file("/elsewhere/keep.bag"));
    selection = setManySelected(selection, [file("/here/a.bag"), file("/here/b.bag")], {
      selected: true,
    });
    expect(selection.size).toBe(3);
    selection = setManySelected(selection, [file("/here/a.bag"), file("/here/b.bag")], {
      selected: false,
    });
    expect([...selection.keys()]).toEqual(["/elsewhere/keep.bag"]);
  });
});

describe("summarizeSelection", () => {
  const HIDE = { normalizedFilter: "", showHidden: false };

  it("counts distinct parent directories and current-dir invisibility separately", () => {
    const selection = new Map<string, SelectedFile>([
      ["/data/a.bag", file("/data/a.bag")],
      ["/data/.hidden.bag", file("/data/.hidden.bag")],
      ["/other/b.bag", file("/other/b.bag")],
    ]);
    const summary = summarizeSelection(selection, "/data", HIDE);
    expect(summary.count).toBe(3);
    expect(summary.totalBytes).toBe(3);
    expect(summary.dirCount).toBe(2);
    // Only the dotfile in the current directory counts — the other-directory item is
    // disclosed by the cross-directory suffix instead.
    expect(summary.notVisibleInCurrentDir).toBe(1);
  });

  it("counts filter-hidden selections in the current directory", () => {
    const selection = new Map<string, SelectedFile>([["/data/run.bag", file("/data/run.bag")]]);
    const filtering = (normalizedFilter: string) => ({ normalizedFilter, showHidden: false });
    expect(summarizeSelection(selection, "/data", filtering("zzz")).notVisibleInCurrentDir).toBe(1);
    expect(summarizeSelection(selection, "/data", filtering("run")).notVisibleInCurrentDir).toBe(0);
    expect(summarizeSelection(selection, "/other", filtering("zzz")).notVisibleInCurrentDir).toBe(
      0,
    );
  });
});
