import { stat } from "node:fs/promises";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { basename, sep } from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import { logger } from "../logfile/index.js";
import {
  ERR_BINARY_FILE,
  ERR_FILE_NOT_FOUND,
  EVENT_FILE_CHANGED,
  EVENT_UPDATE,
  type FileEntry,
  type FileRef,
  type GlobPattern,
  type Group,
  type RestoreData,
  type SseEvent,
  type UploadedFileData,
} from "./types.js";
import { fileID, uploadedFileID } from "./file-id.js";
import {
  extractTitle,
  extractTitleFromFile,
  HEAD_FILE_SIZE_LIMIT,
} from "./title.js";
import {
  isRecursivePattern,
  pathSegments,
  splitPattern,
  sortPathsNatural,
  toSlash,
  walkSymlinkTree,
} from "../common/glob.js";
import {
  expandGlob,
  expandRecursiveGlob,
  matchPattern,
} from "../common/glob-match.js";
import { isBinaryBuffer, isBinaryText } from "../common/binary.js";

const DEFAULT_DEBOUNCE_MS = 200;
const BACKUP_DEBOUNCE_MS = 1000;
// Editors that save atomically (write a temp file, then rename it over the
// original) surface as unlink+add; wait this long before trusting an unlink.
const UNLINK_CONFIRM_MS = 100;

type Subscriber = (e: SseEvent) => void;
type BackupSaveFn = (data: RestoreData) => void | Promise<void>;

interface StateOptions {
  fileChangeDebounceMs?: number;
  disableWatcher?: boolean;
}

function readFileHead(path: string): Buffer | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(HEAD_FILE_SIZE_LIMIT);
    const n = readSync(fd, buf, 0, HEAD_FILE_SIZE_LIMIT, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function cloneEntry(f: FileEntry): FileEntry {
  const c = { ...f };
  if (f.segments) c.segments = [...f.segments];
  return c;
}

export class State {
  private groups = new Map<string, Group>();
  private subscribers = new Set<Subscriber>();
  private watcher: FSWatcher | null = null;
  private patterns: GlobPattern[] = [];
  private watchedDirs = new Map<string, number>();

  private fileChangeDebounceMs: number;
  private fileChangeTimers = new Map<string, NodeJS.Timeout>();
  private unlinkTimers = new Set<NodeJS.Timeout>();

  private backupSaveFn: BackupSaveFn | null = null;
  private backupDirty = false;
  private backupTimer: NodeJS.Timeout | null = null;
  private backupClosed = false;
  private backupInFlight: Promise<void> = Promise.resolve();

  private restartListeners = new Set<(file: string) => void>();
  private shutdownListeners = new Set<() => void>();

  constructor(opts: StateOptions = {}) {
    this.fileChangeDebounceMs =
      opts.fileChangeDebounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (opts.disableWatcher) return;
    try {
      this.watcher = chokidarWatch([], {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: true,
        awaitWriteFinish: false,
        usePolling: false,
        atomic: true,
      });
      this.attachWatcher();
    } catch (err) {
      logger.warn("failed to create file watcher", { error: String(err) });
      this.watcher = null;
    }
  }

  private attachWatcher(): void {
    if (!this.watcher) return;
    // "all" delivers every event kind (including raw/ready, which are
    // ignored) with the kind as first argument, in one registration.
    this.watcher.on("all", (kind, p) => this.handleWatcherEvent(kind, p));
    this.watcher.on("error", (err: unknown) => {
      logger.warn("file watcher error", { error: String(err) });
    });
  }

  // Unlike upstream's watcher, chokidar reports every event under the path it
  // was asked to watch, never a symlink-resolved form: with followSymlinks it
  // watches each alias of a linked directory itself (one event per alias), so
  // events need no translation back to the stored path.
  private handleWatcherEvent(kind: string, eventPath: string): void {
    const refs = this.findRefsByPath(eventPath);
    if (refs.length > 0) {
      if (kind === "change" || kind === "add") {
        logger.info("file changed", { path: eventPath });
        this.scheduleFileChanged(eventPath);
      }
      if (kind === "unlink") {
        this.confirmUnlink(eventPath, refs);
      }
    }

    if (kind === "unlinkDir" && this.isWatchedDir(eventPath)) {
      this.handleDirMove(eventPath);
    }
    if (kind === "add" || kind === "addDir") {
      void this.handleCreateForGlobs(eventPath);
    }
  }

  // confirmUnlink re-checks the path after a short delay: an atomic save
  // briefly removes the original inode, so a still-present file is a change,
  // not a deletion. The watch is re-armed in that case because some backends
  // drop it together with the old inode.
  private confirmUnlink(eventPath: string, refs: FileRef[]): void {
    const timer = setTimeout(() => {
      this.unlinkTimers.delete(timer);
      let stillExists = false;
      try {
        statSync(eventPath);
        stillExists = true;
      } catch {
        // gone for real
      }
      if (!stillExists) {
        logger.info("file deleted, removing from list", { path: eventPath });
        for (const ref of refs) this.removeFile(ref.id, ref.group);
        return;
      }
      if (this.watcher) {
        try {
          this.watcher.add(eventPath);
        } catch (err) {
          logger.warn("failed to re-watch file", {
            path: eventPath,
            error: String(err),
          });
        }
      }
      this.scheduleFileChanged(eventPath);
    }, UNLINK_CONFIRM_MS);
    this.unlinkTimers.add(timer);
  }

  // --- helpers ---

  private findRefsByPath(absPath: string): FileRef[] {
    const refs: FileRef[] = [];
    for (const g of this.groups.values()) {
      for (const f of g.files) {
        if (f.path === absPath) refs.push({ id: f.id, group: g.name });
      }
    }
    return refs;
  }

  private findRefsByPathPrefix(dirPath: string): FileRef[] {
    const prefix = dirPath + sep;
    const refs: FileRef[] = [];
    for (const g of this.groups.values()) {
      for (const f of g.files) {
        if (f.path.startsWith(prefix)) refs.push({ id: f.id, group: g.name });
      }
    }
    return refs;
  }

  private isPathReferenced(absPath: string): boolean {
    for (const g of this.groups.values()) {
      if (g.files.some((f) => f.path === absPath)) return true;
    }
    return false;
  }

  private isWatchedDir(path: string): boolean {
    return this.watchedDirs.has(path);
  }

  private handleDirMove(dirPath: string): void {
    for (const ref of this.findRefsByPathPrefix(dirPath)) {
      logger.info("removing stale file after directory move", {
        dir: dirPath,
        id: ref.id,
      });
      this.removeFile(ref.id, ref.group);
    }
  }

  private groupHasPatterns(groupName: string): boolean {
    return this.patterns.some((p) => p.group === groupName);
  }

  private getOrCreateGroup(groupName: string): Group {
    let g = this.groups.get(groupName);
    if (!g) {
      g = { name: groupName, files: [] };
      this.groups.set(groupName, g);
    }
    return g;
  }

  // A group lives as long as it has files or watch patterns.
  private pruneGroupIfEmpty(groupName: string): void {
    const g = this.groups.get(groupName);
    if (g && g.files.length === 0 && !this.groupHasPatterns(groupName)) {
      this.groups.delete(groupName);
    }
  }

  // Drops the watch for a path that no entry references anymore.
  private unwatchPathIfUnreferenced(absPath: string): void {
    if (!this.watcher || absPath === "" || this.isPathReferenced(absPath)) {
      return;
    }
    try {
      this.watcher.unwatch(absPath);
    } catch (err) {
      logger.warn("failed to unwatch file", {
        path: absPath,
        error: String(err),
      });
    }
  }

  private sendEvent(e: SseEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(e);
      } catch (err) {
        logger.warn("SSE subscriber error", { error: String(err) });
      }
    }
    if (e.name === EVENT_UPDATE) this.markDirty();
  }

  private sendUpdate(): void {
    this.sendEvent({ name: EVENT_UPDATE, data: "{}" });
  }

  private scheduleFileChanged(absPath: string): void {
    if (this.fileChangeDebounceMs <= 0) {
      this.notifyFileChangedByPath(absPath);
      return;
    }
    const existing = this.fileChangeTimers.get(absPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      if (this.fileChangeTimers.get(absPath) === timer) {
        this.fileChangeTimers.delete(absPath);
        this.notifyFileChangedByPath(absPath);
      }
    }, this.fileChangeDebounceMs);
    this.fileChangeTimers.set(absPath, timer);
  }

  private notifyFileChangedByPath(absPath: string): void {
    const { title: newTitle, ok: titleOK } = extractTitleFromFile(absPath);

    const ids: string[] = [];
    let titleChanged = false;
    for (const g of this.groups.values()) {
      for (const f of g.files) {
        if (f.path !== absPath) continue;
        ids.push(f.id);
        if (titleOK && (f.title ?? "") !== newTitle) {
          if (newTitle) f.title = newTitle;
          else delete f.title;
          titleChanged = true;
        }
      }
    }
    if (ids.length === 0) return;
    if (titleChanged) this.sendUpdate();
    for (const id of ids) {
      this.sendEvent({
        name: EVENT_FILE_CHANGED,
        data: JSON.stringify({ id }),
      });
    }
  }

  // --- public API ---

  addFile(absPath: string, groupName: string): FileEntry {
    const existing = this.groups
      .get(groupName)
      ?.files.find((x) => x.path === absPath);
    if (existing) return existing;

    const head = readFileHead(absPath);
    if (head && head.length > 0 && isBinaryBuffer(head)) {
      throw new Error(`${absPath}: ${ERR_BINARY_FILE}`);
    }

    const title = head ? extractTitle(head.toString("utf8")) : "";

    const entry: FileEntry = {
      name: basename(absPath),
      id: fileID(absPath),
      path: absPath,
      segments: pathSegments(absPath),
    };
    if (title) entry.title = title;
    this.getOrCreateGroup(groupName).files.push(entry);

    if (this.watcher) {
      try {
        this.watcher.add(absPath);
      } catch (err) {
        logger.warn("failed to watch file", {
          path: absPath,
          error: String(err),
        });
      }
    }
    logger.info("file added", {
      path: absPath,
      group: groupName,
      id: entry.id,
    });
    this.sendUpdate();
    return entry;
  }

  addUploadedFile(name: string, content: string, groupName: string): FileEntry {
    if (isBinaryText(content)) {
      throw new Error(`${name}: ${ERR_BINARY_FILE}`);
    }
    const id = uploadedFileID(content);

    const g = this.getOrCreateGroup(groupName);
    const dup = g.files.find((x) => x.id === id);
    if (dup) return dup;

    const head =
      content.length > HEAD_FILE_SIZE_LIMIT
        ? content.substring(0, HEAD_FILE_SIZE_LIMIT)
        : content;
    const title = extractTitle(head);

    const entry: FileEntry = {
      name,
      id,
      path: "",
      uploaded: true,
      content,
    };
    if (title) entry.title = title;
    g.files.push(entry);

    logger.info("uploaded file added", { name, group: groupName, id });
    this.sendUpdate();
    return entry;
  }

  // listGroups returns a deep copy: callers (JSON encoding, search batches
  // that await between files) must never observe in-place mutations such as
  // title updates from notifyFileChangedByPath.
  listGroups(): Group[] {
    return [...this.groups.values()].map((g) => ({
      name: g.name,
      files: g.files.map(cloneEntry),
    }));
  }

  // snapshotGroup returns a copy of a single group without materializing
  // every other group the way listGroups() does (search hits this per
  // keystroke).
  snapshotGroup(groupName: string): Group | null {
    const g = this.groups.get(groupName);
    if (!g) return null;
    return { name: g.name, files: g.files.map(cloneEntry) };
  }

  findFile(id: string, groupName: string): FileEntry | null {
    return this.groups.get(groupName)?.files.find((x) => x.id === id) ?? null;
  }

  reorderFiles(groupName: string, fileIDs: string[]): boolean {
    const g = this.groups.get(groupName);
    if (!g) return false;
    if (fileIDs.length !== g.files.length) return false;
    const idToFile = new Map(g.files.map((f) => [f.id, f]));
    const reordered: FileEntry[] = [];
    for (const id of fileIDs) {
      const f = idToFile.get(id);
      if (!f) return false;
      reordered.push(f);
    }
    g.files = reordered;
    this.sendUpdate();
    return true;
  }

  moveFile(
    id: string,
    sourceGroupName: string,
    targetGroup: string,
  ): { ok: true } | { error: string; status: number } {
    const sourceGroup = this.groups.get(sourceGroupName);
    const file = sourceGroup?.files.find((x) => x.id === id);
    if (!sourceGroup || !file) {
      return { error: ERR_FILE_NOT_FOUND, status: 404 };
    }
    if (sourceGroupName === targetGroup) {
      return {
        error: `file is already in group "${targetGroup}"`,
        status: 409,
      };
    }
    // Duplicates are detected by path for filesystem files and by ID for
    // uploaded ones (whose ID is derived from the content).
    const conflict = this.groups
      .get(targetGroup)
      ?.files.some((f) =>
        file.uploaded ? f.id === file.id : f.path === file.path,
      );
    if (conflict) {
      return {
        error: `file "${file.name}" already exists in group "${targetGroup}"`,
        status: 409,
      };
    }
    sourceGroup.files = sourceGroup.files.filter((x) => x.id !== id);
    this.pruneGroupIfEmpty(sourceGroupName);
    this.getOrCreateGroup(targetGroup).files.push(file);
    this.sendUpdate();
    return { ok: true };
  }

  removeFilesByPath(absPath: string): boolean {
    if (absPath === "") return false;
    let removed = false;
    for (const [name, g] of [...this.groups]) {
      const before = g.files.length;
      g.files = g.files.filter((f) => {
        if (f.path !== absPath) return true;
        logger.info("file removed", { path: f.path, id: f.id, group: name });
        return false;
      });
      if (before !== g.files.length) removed = true;
      this.pruneGroupIfEmpty(name);
    }
    if (!removed) return false;
    this.unwatchPathIfUnreferenced(absPath);
    this.sendUpdate();
    return true;
  }

  removeFile(id: string, groupName: string): boolean {
    const g = this.groups.get(groupName);
    if (!g) return false;
    const idx = g.files.findIndex((x) => x.id === id);
    if (idx === -1) return false;
    const removedPath = g.files[idx]?.path ?? "";
    g.files.splice(idx, 1);
    this.pruneGroupIfEmpty(groupName);
    logger.info("file removed", { path: removedPath, id });
    this.unwatchPathIfUnreferenced(removedPath);
    this.sendUpdate();
    return true;
  }

  // --- subscribers ---

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  // closeAllSubscribers ends every SSE stream and stops the file watcher and
  // all pending watcher timers, so nothing keeps the event loop alive.
  closeAllSubscribers(): void {
    for (const fn of this.subscribers) {
      try {
        fn({ name: "__close__", data: "" });
      } catch {
        // ignore
      }
    }
    this.subscribers.clear();
    if (this.watcher) {
      try {
        void this.watcher.close();
      } catch {
        // ignore
      }
      this.watcher = null;
    }
    for (const t of this.fileChangeTimers.values()) clearTimeout(t);
    this.fileChangeTimers.clear();
    for (const t of this.unlinkTimers) clearTimeout(t);
    this.unlinkTimers.clear();
  }

  // --- restart / shutdown channels ---

  onRestart(fn: (restoreFile: string) => void): () => void {
    this.restartListeners.add(fn);
    return () => this.restartListeners.delete(fn);
  }

  onShutdown(fn: () => void): () => void {
    this.shutdownListeners.add(fn);
    return () => this.shutdownListeners.delete(fn);
  }

  signalRestart(restoreFile: string): void {
    for (const fn of this.restartListeners) fn(restoreFile);
  }

  signalShutdown(): void {
    for (const fn of this.shutdownListeners) fn();
  }

  // --- patterns ---

  async addPattern(
    absPattern: string,
    groupName: string,
  ): Promise<FileEntry[]> {
    const slash = toSlash(absPattern);
    const { base, rel } = splitPattern(slash);

    let info;
    try {
      info = await stat(base);
    } catch (err) {
      throw new Error(
        `base directory "${base}" does not exist: ${String(err)}`,
        { cause: err },
      );
    }
    if (!info.isDirectory()) {
      throw new Error(`base path "${base}" is not a directory`);
    }

    // Re-registering an existing pattern is idempotent: skip the watcher
    // bookkeeping (dir watches are ref-counted) but still expand the glob so
    // the caller gets the current matches instead of a misleading empty list.
    const existing = this.patterns.find(
      (p) => p.pattern === absPattern && p.group === groupName,
    );
    const gp: GlobPattern = existing ?? {
      pattern: absPattern,
      patternSlash: slash,
      baseDir: base,
      group: groupName,
      recursive: isRecursivePattern(absPattern),
    };
    let createdGroup = false;
    if (!existing) {
      this.patterns.push(gp);
      // Ensure the group exists even if no files match yet.
      createdGroup = !this.groups.has(groupName);
      this.getOrCreateGroup(groupName);
      await this.walkDirsForPattern(gp, (d) => this.addDirWatch(d));
    }

    let matches;
    try {
      matches = gp.recursive
        ? await expandRecursiveGlob(base, rel)
        : await expandGlob(base, rel, { filesOnly: true });
    } catch (err) {
      if (!existing) await this.rollbackPattern(gp, createdGroup);
      throw new Error(`glob expansion failed: ${String(err)}`, { cause: err });
    }
    sortPathsNatural(matches);

    const entries: FileEntry[] = [];
    for (const m of matches) {
      try {
        entries.push(this.addFile(m, groupName));
      } catch (err) {
        logger.warn("skipping file", { path: m, error: String(err) });
      }
    }
    return entries;
  }

  patternsForGroup(groupName: string): string[] {
    return this.patterns
      .filter((p) => p.group === groupName)
      .map((p) => p.pattern);
  }

  removePattern(absPattern: string, groupName: string): boolean {
    const idx = this.patterns.findIndex(
      (p) => p.pattern === absPattern && p.group === groupName,
    );
    const removed = this.patterns[idx];
    if (idx === -1 || !removed) return false;
    this.patterns.splice(idx, 1);
    void this.walkDirsForPattern(removed, (d) => this.removeDirWatch(d));
    logger.info("pattern removed", { pattern: absPattern, group: groupName });
    this.pruneGroupIfEmpty(groupName);
    this.sendUpdate();
    return true;
  }

  // rollbackPattern undoes what addPattern registered before an initial
  // expansion that failed. Left in place, the pattern would be reported by
  // --status and persisted to the backup although the caller was told it
  // could not be added.
  private async rollbackPattern(
    gp: GlobPattern,
    createdGroup: boolean,
  ): Promise<void> {
    const idx = this.patterns.indexOf(gp);
    // A removePattern that ran meanwhile has already released its watches.
    if (idx === -1) return;
    this.patterns.splice(idx, 1);
    await this.walkDirsForPattern(gp, (d) => this.removeDirWatch(d));
    if (createdGroup) this.pruneGroupIfEmpty(gp.group);
  }

  private async walkDirsForPattern(
    gp: GlobPattern,
    fn: (path: string) => void,
  ): Promise<void> {
    if (!this.watcher) return;
    if (!gp.recursive) {
      fn(gp.baseDir);
      return;
    }
    const { unresolved, error } = await walkSymlinkTree(gp.baseDir, fn, null);
    // Entries that could not be classified never reached fn. Hand over the
    // ones tracked as watched directories, so an unwatch still releases a
    // directory that stopped resolving after its watch was set up (a
    // deleted base, or a symlinked directory whose target is gone). Anything
    // else, such as a dangling file symlink, has no watch to release.
    for (const p of unresolved) {
      if (this.isWatchedDir(p)) fn(p);
    }
    if (error) {
      logger.warn("failed to walk directories for pattern", {
        pattern: gp.pattern,
        base: gp.baseDir,
        error: String(error),
      });
    }
  }

  private addDirWatch(dir: string): void {
    const cur = this.watchedDirs.get(dir) ?? 0;
    this.watchedDirs.set(dir, cur + 1);
    if (cur > 0 || !this.watcher) return;
    try {
      this.watcher.add(dir);
    } catch (err) {
      this.watchedDirs.delete(dir);
      logger.warn("failed to watch directory", {
        path: dir,
        error: String(err),
      });
    }
  }

  private removeDirWatch(dir: string): void {
    const count = this.watchedDirs.get(dir);
    if (count === undefined) return;
    if (count > 1) {
      this.watchedDirs.set(dir, count - 1);
      return;
    }
    this.watchedDirs.delete(dir);
    if (this.watcher) {
      try {
        this.watcher.unwatch(dir);
      } catch (err) {
        logger.warn("failed to remove directory watch", {
          dir,
          error: String(err),
        });
      }
    }
  }

  // coversDir reports whether a recursive pattern's base contains dir
  // (path-aware: "/docs2" is not under "/docs").
  private static coversDir(gp: GlobPattern, dir: string): boolean {
    return (
      gp.recursive && (dir === gp.baseDir || dir.startsWith(gp.baseDir + sep))
    );
  }

  private async handleCreateForGlobs(path: string): Promise<void> {
    if (this.patterns.length === 0) return;
    const patterns = [...this.patterns];
    let info;
    try {
      info = statSync(path);
    } catch {
      return;
    }
    if (!info.isDirectory()) {
      this.matchAndAddFile(path, patterns);
      return;
    }
    // A new directory gets one refcount per recursive pattern covering it,
    // mirroring walkDirsForPattern at registration time, so removing any one
    // of those patterns later leaves the watch intact for the others. Only
    // the directory itself is counted: chokidar reports an addDir for every
    // directory below it (through symlinks too) as it reads the new tree.
    const covering = patterns.filter((gp) => State.coversDir(gp, path));
    if (covering.length === 0) return;
    for (let i = 0; i < covering.length; i++) this.addDirWatch(path);
    // The files are matched here as well rather than left to chokidar's add
    // events alone, the way registration-time expansion found them —
    // including those inside directories linked into the new tree.
    const { error } = await walkSymlinkTree(path, null, (p) =>
      this.matchAndAddFile(p, patterns),
    );
    if (error) {
      logger.warn("failed to scan created directory", {
        path,
        error: String(error),
      });
    }
  }

  // matchAndAddFile adds a newly created file to every group with a
  // matching pattern, the same way registration-time expansion did for
  // files that already existed (addFile is idempotent per group).
  private matchAndAddFile(path: string, patterns: GlobPattern[]): void {
    for (const gp of patterns) {
      if (!matchPattern(gp.pattern, path)) continue;
      try {
        this.addFile(path, gp.group);
      } catch (err) {
        // Rejected for what it is (e.g. binary); no other pattern can
        // change that.
        logger.warn("skipping file", { path, error: String(err) });
        return;
      }
      logger.info("auto-added file via glob", {
        path,
        pattern: gp.pattern,
        group: gp.group,
      });
    }
  }

  // --- restore data / backup ---

  snapshotRestoreData(): RestoreData {
    const data: RestoreData = { groups: {} };
    const uploadedFiles: UploadedFileData[] = [];
    for (const [name, g] of this.groups) {
      const paths: string[] = [];
      for (const f of g.files) {
        if (f.uploaded) {
          uploadedFiles.push({
            name: f.name,
            content: f.content ?? "",
            group: name,
          });
          continue;
        }
        paths.push(f.path);
      }
      data.groups[name] = paths;
    }
    if (this.patterns.length > 0) {
      const patternsByGroup: Record<string, string[]> = {};
      for (const p of this.patterns) {
        (patternsByGroup[p.group] ??= []).push(p.pattern);
      }
      data.patterns = patternsByGroup;
    }
    if (uploadedFiles.length > 0) data.uploadedFiles = uploadedFiles;
    return data;
  }

  // enableBackup installs the save callback; nothing is written until the
  // next state change or an explicit scheduleBackup(). Servers enable it
  // only once they own their port, so a start that loses the port can never
  // overwrite the backup of the instance that actually serves it.
  enableBackup(saveFn: BackupSaveFn): void {
    this.backupSaveFn = saveFn;
  }

  // scheduleBackup queues a (debounced) save of the current state, e.g. the
  // session seeded before the backup was enabled.
  scheduleBackup(): void {
    this.markDirty();
  }

  // closeBackup flushes the final save and resolves once every pending
  // write (including one started by the debounce timer just before close)
  // has completed. Shutdown must await this: the process exits right after
  // the HTTP server closes, and an unfinished write could be lost — or land
  // *after* a `--clear` client already deleted the backup file, resurrecting
  // the session it just cleared.
  async closeBackup(): Promise<void> {
    if (this.backupClosed) {
      await this.backupInFlight;
      return;
    }
    this.stopBackup();
    await this.saveBackupNow();
  }

  // discardBackup cancels any pending save without flushing. A server that
  // never got to listen (port in use) must not overwrite the backup that
  // belongs to the instance actually serving the port.
  async discardBackup(): Promise<void> {
    this.stopBackup();
    this.backupDirty = false;
    await this.backupInFlight;
  }

  private stopBackup(): void {
    this.backupClosed = true;
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
      this.backupTimer = null;
    }
  }

  private markDirty(): void {
    if (!this.backupSaveFn || this.backupClosed) return;
    this.backupDirty = true;
    if (this.backupTimer) clearTimeout(this.backupTimer);
    this.backupTimer = setTimeout(() => {
      this.backupTimer = null;
      void this.saveBackupNow();
    }, BACKUP_DEBOUNCE_MS);
  }

  // Serializes saves: each write chains onto the previous one, and the
  // returned promise settles only when all writes so far have finished.
  private saveBackupNow(): Promise<void> {
    if (this.backupSaveFn && this.backupDirty) {
      this.backupDirty = false;
      const data = this.snapshotRestoreData();
      const fn = this.backupSaveFn;
      const write = async (): Promise<void> => {
        try {
          await fn(data);
        } catch (err) {
          logger.warn("backup save failed", { error: String(err) });
        }
      };
      this.backupInFlight = this.backupInFlight.then(write);
    }
    return this.backupInFlight;
  }
}
