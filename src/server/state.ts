import { stat } from "node:fs/promises";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { basename, dirname, join, sep, relative } from "node:path";
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
  resolvePathAlias,
  splitPattern,
  sortPathsNatural,
  toSlash,
  walkDirs,
  walkFiles,
} from "../common/glob.js";
import { expandGlob, matchPattern } from "../common/glob-match.js";

const DEFAULT_DEBOUNCE_MS = 200;
const BACKUP_DEBOUNCE_MS = 1000;

type Subscriber = (e: SseEvent) => void;

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

function isBinaryBuffer(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export class State {
  private groups = new Map<string, Group>();
  private subscribers = new Set<Subscriber>();
  private watcher: FSWatcher | null = null;
  private patterns: GlobPattern[] = [];
  private watchedDirs = new Map<string, number>();
  private pathAliases = new Map<string, string>();
  private aliasReverse = new Map<string, string>();

  private fileChangeDebounceMs: number;
  private fileChangeTimers = new Map<string, NodeJS.Timeout>();

  private backupSaveFn: ((data: RestoreData) => void | Promise<void>) | null =
    null;
  private backupDirty = false;
  private backupTimer: NodeJS.Timeout | null = null;
  private backupClosed = false;
  private backupInFlight: Promise<void> = Promise.resolve();

  private restartListeners = new Set<(file: string) => void>();
  private shutdownListeners = new Set<() => void>();

  constructor(opts: StateOptions = {}) {
    this.fileChangeDebounceMs =
      opts.fileChangeDebounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (opts.disableWatcher) {
      this.watcher = null;
      return;
    }
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
    this.watcher.on("change", (p: string) =>
      this.handleWatcherEvent("change", p),
    );
    this.watcher.on("add", (p: string) => this.handleWatcherEvent("add", p));
    this.watcher.on("unlink", (p: string) =>
      this.handleWatcherEvent("unlink", p),
    );
    this.watcher.on("addDir", (p: string) =>
      this.handleWatcherEvent("addDir", p),
    );
    this.watcher.on("unlinkDir", (p: string) =>
      this.handleWatcherEvent("unlinkDir", p),
    );
    this.watcher.on("error", (err: unknown) => {
      logger.warn("file watcher error", { error: String(err) });
    });
  }

  private handleWatcherEvent(kind: string, p: string): void {
    const eventPath = this.translateEventPath(p);
    const refsTranslated = this.findRefsByPath(eventPath);
    const refsRaw = eventPath !== p ? this.findRefsByPath(p) : [];

    if (refsTranslated.length + refsRaw.length > 0) {
      if (kind === "change" || kind === "add") {
        logger.info("file changed", { path: eventPath });
        if (refsTranslated.length > 0) this.scheduleFileChanged(eventPath);
        if (refsRaw.length > 0) this.scheduleFileChanged(p);
      }
      if (kind === "unlink") {
        // Confirm after a small delay (editors do atomic-replace)
        setTimeout(() => {
          try {
            statSync(eventPath);
            // file still exists, treat as change
            if (refsTranslated.length > 0) this.scheduleFileChanged(eventPath);
            if (refsRaw.length > 0) this.scheduleFileChanged(p);
          } catch {
            logger.info("file deleted, removing from list", {
              path: eventPath,
            });
            for (const ref of refsTranslated)
              this.removeFile(ref.id, ref.group);
            for (const ref of refsRaw) this.removeFile(ref.id, ref.group);
          }
        }, 100);
      }
    }

    if (kind === "unlinkDir") {
      if (this.isWatchedDir(eventPath)) {
        this.handleDirMove(eventPath);
      } else if (eventPath !== p && this.isWatchedDir(p)) {
        this.handleDirMove(p);
      }
    }
    if (kind === "add" || kind === "addDir") {
      this.handleCreateForGlobs(eventPath);
    }
  }

  // --- helpers ---

  private translateEventPath(p: string): string {
    const orig = this.pathAliases.get(p);
    if (orig !== undefined) return orig;
    let dir = p;
    while (true) {
      const parent = dirname(dir);
      if (parent === dir) return p;
      dir = parent;
      const o = this.pathAliases.get(dir);
      if (o !== undefined) {
        const rel = relative(dir, p);
        return join(o, rel);
      }
    }
  }

  private registerPathAlias(orig: string, canonical: string): void {
    if (canonical === "") return;
    this.pathAliases.set(canonical, orig);
    this.aliasReverse.set(orig, canonical);
  }

  private unregisterPathAlias(orig: string): void {
    const canonical = this.aliasReverse.get(orig);
    if (canonical === undefined) return;
    this.pathAliases.delete(canonical);
    this.aliasReverse.delete(orig);
  }

  private findRefsByPath(absPath: string): FileRef[] {
    const refs: FileRef[] = [];
    for (const g of this.groups.values()) {
      for (const f of g.files) {
        if (f.path === absPath) {
          refs.push({ id: f.id, group: g.name });
        }
      }
    }
    return refs;
  }

  private findRefsByPathPrefix(dirPath: string): FileRef[] {
    const prefix = dirPath + sep;
    const refs: FileRef[] = [];
    for (const g of this.groups.values()) {
      for (const f of g.files) {
        if (f.path.startsWith(prefix)) {
          refs.push({ id: f.id, group: g.name });
        }
      }
    }
    return refs;
  }

  private isWatchedDir(path: string): boolean {
    return this.watchedDirs.has(path);
  }

  private handleDirMove(dirPath: string): void {
    const refs = this.findRefsByPathPrefix(dirPath);
    for (const ref of refs) {
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

  private scheduleFileChanged(absPath: string): void {
    if (this.fileChangeDebounceMs <= 0) {
      this.notifyFileChangedByPath(absPath);
      return;
    }
    const existing = this.fileChangeTimers.get(absPath);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      const current = this.fileChangeTimers.get(absPath);
      if (current === timer) {
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
        if (f.path === absPath) {
          ids.push(f.id);
          if (titleOK && f.title !== newTitle) {
            f.title = newTitle;
            titleChanged = true;
          }
        }
      }
    }
    if (ids.length === 0) return;
    if (titleChanged) this.sendEvent({ name: EVENT_UPDATE, data: "{}" });
    for (const id of ids) {
      this.sendEvent({
        name: EVENT_FILE_CHANGED,
        data: JSON.stringify({ id }),
      });
    }
  }

  // --- public API ---

  addFile(absPath: string, groupName: string): FileEntry {
    const existingGroup = this.groups.get(groupName);
    if (existingGroup) {
      const f = existingGroup.files.find((x) => x.path === absPath);
      if (f) return f;
    }

    const head = readFileHead(absPath);
    if (head && head.length > 0 && isBinaryBuffer(head)) {
      throw new Error(`${absPath}: ${ERR_BINARY_FILE}`);
    }

    const title = head ? extractTitle(head.toString("utf8")) : "";
    const canonical = this.watcher ? resolvePathAlias(absPath) : "";

    let g = this.groups.get(groupName);
    if (!g) {
      g = { name: groupName, files: [] };
      this.groups.set(groupName, g);
    }
    const dup = g.files.find((x) => x.path === absPath);
    if (dup) return dup;

    const entry: FileEntry = {
      name: basename(absPath),
      id: fileID(absPath),
      path: absPath,
    };
    if (title) entry.title = title;
    g.files.push(entry);

    if (this.watcher) {
      try {
        this.watcher.add(absPath);
        this.registerPathAlias(absPath, canonical);
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
    this.sendEvent({ name: EVENT_UPDATE, data: "{}" });
    return entry;
  }

  addUploadedFile(name: string, content: string, groupName: string): FileEntry {
    const id = uploadedFileID(content);

    let g = this.groups.get(groupName);
    if (!g) {
      g = { name: groupName, files: [] };
      this.groups.set(groupName, g);
    }
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
    this.sendEvent({ name: EVENT_UPDATE, data: "{}" });
    return entry;
  }

  listGroups(): Group[] {
    return [...this.groups.values()].map((g) => ({
      name: g.name,
      files: [...g.files],
    }));
  }

  // snapshotGroup returns a copy of a single group without materializing
  // every other group the way listGroups() does (search hits this per
  // keystroke).
  snapshotGroup(groupName: string): Group | null {
    const g = this.groups.get(groupName);
    if (!g) return null;
    return { name: g.name, files: [...g.files] };
  }

  findFile(id: string, groupName: string): FileEntry | null {
    const g = this.groups.get(groupName);
    if (!g) return null;
    return g.files.find((x) => x.id === id) ?? null;
  }

  reorderFiles(groupName: string, fileIDs: string[]): boolean {
    const g = this.groups.get(groupName);
    if (!g) return false;
    if (fileIDs.length !== g.files.length) return false;
    const idToFile = new Map<string, FileEntry>();
    for (const f of g.files) idToFile.set(f.id, f);
    const reordered: FileEntry[] = [];
    for (const id of fileIDs) {
      const f = idToFile.get(id);
      if (!f) return false;
      reordered.push(f);
    }
    g.files = reordered;
    this.sendEvent({ name: EVENT_UPDATE, data: "{}" });
    return true;
  }

  moveFile(
    id: string,
    sourceGroupName: string,
    targetGroup: string,
  ): { ok: true } | { error: string; status: number } {
    let file: FileEntry | null = null;
    let sourceGroup: Group | null = null;
    const sg = this.groups.get(sourceGroupName);
    if (sg) {
      const f = sg.files.find((x) => x.id === id);
      if (f) {
        file = f;
        sourceGroup = sg;
      }
    }
    if (!file || !sourceGroup) {
      return { error: ERR_FILE_NOT_FOUND, status: 404 };
    }
    if (sourceGroupName === targetGroup) {
      return {
        error: `file is already in group "${targetGroup}"`,
        status: 409,
      };
    }
    const tg = this.groups.get(targetGroup);
    if (tg) {
      for (const f of tg.files) {
        if (file.uploaded) {
          if (f.id === file.id) {
            return {
              error: `file "${file.name}" already exists in group "${targetGroup}"`,
              status: 409,
            };
          }
        } else if (f.path === file.path) {
          return {
            error: `file "${file.name}" already exists in group "${targetGroup}"`,
            status: 409,
          };
        }
      }
    }
    sourceGroup.files = sourceGroup.files.filter((x) => x.id !== id);
    if (
      sourceGroup.files.length === 0 &&
      !this.groupHasPatterns(sourceGroupName)
    ) {
      this.groups.delete(sourceGroupName);
    }
    let target = this.groups.get(targetGroup);
    if (!target) {
      target = { name: targetGroup, files: [] };
      this.groups.set(targetGroup, target);
    }
    target.files.push(file);
    this.sendEvent({ name: EVENT_UPDATE, data: "{}" });
    return { ok: true };
  }

  removeFilesByPath(absPath: string): boolean {
    if (absPath === "") return false;
    let removed = false;
    for (const [name, g] of [...this.groups]) {
      const before = g.files.length;
      g.files = g.files.filter((f) => {
        if (f.path === absPath) {
          logger.info("file removed", { path: f.path, id: f.id, group: name });
          return false;
        }
        return true;
      });
      if (before !== g.files.length) removed = true;
      if (g.files.length === 0 && !this.groupHasPatterns(name)) {
        this.groups.delete(name);
      }
    }
    if (removed && this.watcher) {
      try {
        this.watcher.unwatch(absPath);
      } catch (err) {
        logger.warn("failed to unwatch file", {
          path: absPath,
          error: String(err),
        });
      }
      this.unregisterPathAlias(absPath);
    }
    if (removed) this.sendEvent({ name: EVENT_UPDATE, data: "{}" });
    return removed;
  }

  removeFile(id: string, groupName: string): boolean {
    const g = this.groups.get(groupName);
    if (!g) return false;
    const idx = g.files.findIndex((x) => x.id === id);
    if (idx === -1) return false;
    const removedPath = g.files[idx]?.path ?? "";
    g.files.splice(idx, 1);
    if (g.files.length === 0 && !this.groupHasPatterns(groupName)) {
      this.groups.delete(groupName);
    }
    logger.info("file removed", { path: removedPath, id });

    if (this.watcher && removedPath) {
      let stillReferenced = false;
      for (const og of this.groups.values()) {
        if (og.files.some((f) => f.path === removedPath)) {
          stillReferenced = true;
          break;
        }
      }
      if (!stillReferenced) {
        try {
          this.watcher.unwatch(removedPath);
        } catch (err) {
          logger.warn("failed to unwatch file", {
            path: removedPath,
            error: String(err),
          });
        }
        this.unregisterPathAlias(removedPath);
      }
    }
    this.sendEvent({ name: EVENT_UPDATE, data: "{}" });
    return true;
  }

  // --- subscribers ---

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

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
        {
          cause: err,
        },
      );
    }
    if (!info.isDirectory()) {
      throw new Error(`base path "${base}" is not a directory`);
    }

    // Re-registering an existing pattern is idempotent: skip the watcher
    // bookkeeping (dir watches are ref-counted) but still expand the glob so
    // the caller gets the current matches instead of a misleading empty list.
    const isNew = !this.patterns.some(
      (p) => p.pattern === absPattern && p.group === groupName,
    );
    if (isNew) {
      const gp: GlobPattern = {
        pattern: absPattern,
        patternSlash: slash,
        baseDir: base,
        group: groupName,
        recursive: isRecursivePattern(absPattern),
      };
      this.patterns.push(gp);
      if (!this.groups.has(groupName)) {
        this.groups.set(groupName, { name: groupName, files: [] });
      }
      await this.watchDirsForPattern(gp);
    }

    const matches = await expandGlob(base, rel, { filesOnly: true });
    sortPathsNatural(matches);

    const entries: FileEntry[] = [];
    for (const m of matches) {
      try {
        const entry = this.addFile(m, groupName);
        entries.push(entry);
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
    if (idx === -1) return false;
    const removed = this.patterns[idx];
    if (!removed) return false;
    this.patterns.splice(idx, 1);
    void this.walkDirsForPattern(removed, (d) => this.removeDirWatch(d));
    logger.info("pattern removed", { pattern: absPattern, group: groupName });
    const g = this.groups.get(groupName);
    if (g && g.files.length === 0 && !this.groupHasPatterns(groupName)) {
      this.groups.delete(groupName);
    }
    this.sendEvent({ name: EVENT_UPDATE, data: "{}" });
    return true;
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
    try {
      await walkDirs(gp.baseDir, fn);
    } catch (err) {
      fn(gp.baseDir);
      logger.warn("failed to walk directories for pattern", {
        pattern: gp.pattern,
        base: gp.baseDir,
        error: String(err),
      });
    }
  }

  private async watchDirsForPattern(gp: GlobPattern): Promise<void> {
    await this.walkDirsForPattern(gp, (d) => this.addDirWatch(d));
  }

  private addDirWatch(dir: string): void {
    const cur = this.watchedDirs.get(dir) ?? 0;
    this.watchedDirs.set(dir, cur + 1);
    if (cur === 0 && this.watcher) {
      try {
        this.watcher.add(dir);
      } catch (err) {
        this.watchedDirs.delete(dir);
        logger.warn("failed to watch directory", {
          path: dir,
          error: String(err),
        });
        return;
      }
    } else {
      return;
    }
    const canonical = resolvePathAlias(dir);
    if (this.watchedDirs.has(dir)) this.registerPathAlias(dir, canonical);
  }

  private removeDirWatch(dir: string): void {
    const count = this.watchedDirs.get(dir);
    if (count === undefined) return;
    if (count <= 1) {
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
      this.unregisterPathAlias(dir);
    } else {
      this.watchedDirs.set(dir, count - 1);
    }
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
    if (info.isDirectory()) {
      for (const gp of patterns) {
        if (!gp.recursive) continue;
        // Path-aware boundary: "/docs2" must not match baseDir "/docs".
        if (path !== gp.baseDir && !path.startsWith(gp.baseDir + sep)) {
          continue;
        }
        this.addDirWatch(path);
        await walkFiles(path, (p) => this.matchAndAddFile(p, patterns));
        break;
      }
      return;
    }
    this.matchAndAddFile(path, patterns);
  }

  private matchAndAddFile(path: string, patterns: GlobPattern[]): void {
    for (const gp of patterns) {
      if (matchPattern(gp.pattern, path)) {
        try {
          this.addFile(path, gp.group);
        } catch (err) {
          logger.warn("skipping file", { path, error: String(err) });
          return;
        }
        logger.info("auto-added file via glob", {
          path,
          pattern: gp.pattern,
          group: gp.group,
        });
        return;
      }
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
        const list = patternsByGroup[p.group] ?? [];
        list.push(p.pattern);
        patternsByGroup[p.group] = list;
      }
      data.patterns = patternsByGroup;
    }
    if (uploadedFiles.length > 0) data.uploadedFiles = uploadedFiles;
    return data;
  }

  enableBackup(saveFn: (data: RestoreData) => void | Promise<void>): void {
    this.backupSaveFn = saveFn;
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
    this.backupClosed = true;
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
      this.backupTimer = null;
    }
    await this.saveBackupNow();
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
