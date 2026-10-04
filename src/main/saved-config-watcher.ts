import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

const SCAN_DEBOUNCE_MS = 100;
const WATCH_RETRY_MS = 1_000;
const WATCH_VERIFY_MS = 500;
const SCAN_FALLBACK_MS = 2_000;

interface WatchedDirectory {
  readonly watcher: FSWatcher;
  readonly identity: string;
}

interface DirectoryIdentity {
  readonly path: string;
  readonly identity: string;
}

/** Watches a config directory and its parent so creation and atomic replacement are noticed. */
export class SavedConfigDirectoryWatcher {
  private readonly directory: string;
  private readonly watches = new Map<string, WatchedDirectory>();
  private active = false;
  private generation = 0;
  private signature: string | undefined;
  private scanTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private verifyTimer: NodeJS.Timeout | undefined;
  private fallbackTimer: NodeJS.Timeout | undefined;
  private reconcilePending = false;
  private reconciling = false;
  private scanPending = false;
  private scanning = false;

  constructor(
    directory: string,
    private readonly readSignature: () => Promise<string>,
    private readonly onChanged: () => void,
  ) {
    this.directory = resolve(directory);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.signature = undefined;
    this.generation += 1;
    this.requestReconcile();
    this.verifyTimer = setInterval(() => this.requestReconcile(), WATCH_VERIFY_MS);
    this.verifyTimer.unref();
    this.fallbackTimer = setInterval(() => this.requestScan(), SCAN_FALLBACK_MS);
    this.fallbackTimer.unref();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.verifyTimer) clearInterval(this.verifyTimer);
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.scanTimer = undefined;
    this.retryTimer = undefined;
    this.verifyTimer = undefined;
    this.fallbackTimer = undefined;
    this.scanPending = false;
    this.reconcilePending = false;
    for (const { watcher } of this.watches.values()) watcher.close();
    this.watches.clear();
  }

  private requestReconcile(): void {
    if (!this.active) return;
    this.reconcilePending = true;
    if (this.reconciling) return;
    void this.reconcile();
  }

  private async reconcile(): Promise<void> {
    this.reconciling = true;
    try {
      while (this.active && this.reconcilePending) {
        this.reconcilePending = false;
        const generation = this.generation;
        try {
          const parent = await nearestExistingDirectory(dirname(this.directory));
          const directory = await directoryIdentity(this.directory);
          if (!this.active || generation !== this.generation) return;

          const desired = new Map<string, { child: string | null; identity: string }>();
          if (parent) {
            const child = relative(parent.path, this.directory).split(sep)[0] ?? basename(this.directory);
            desired.set(parent.path, { child, identity: parent.identity });
          }
          if (directory) desired.set(this.directory, { child: null, identity: directory.identity });

          let changed = false;
          for (const [path, { watcher, identity }] of this.watches) {
            if (desired.get(path)?.identity === identity) continue;
            watcher.close();
            this.watches.delete(path);
            changed = true;
          }
          for (const [path, { child, identity }] of desired) {
            if (this.watches.has(path)) continue;
            const watcher = watch(path, (event, fileName) => {
              if (!this.active || generation !== this.generation) return;
              const relevant = child === null || fileName === null || fileName.toString() === child;
              // macOS can report only the destination name when a watched
              // child is renamed. Recheck the inode on all parent renames.
              if (!relevant && event !== "rename") return;
              if (child !== null && relevant) {
                // A renamed directory keeps its old inode watcher alive. Reopen
                // the path so subsequent writes in the replacement are seen.
                const directoryWatcher = this.watches.get(this.directory);
                directoryWatcher?.watcher.close();
                this.watches.delete(this.directory);
              }
              this.requestReconcile();
              if (relevant) this.scheduleScan();
            });
            watcher.on("error", () => {
              if (this.watches.get(path)?.watcher !== watcher) return;
              watcher.close();
              this.watches.delete(path);
              this.scheduleRetry();
            });
            watcher.unref();
            this.watches.set(path, { watcher, identity });
            changed = true;
          }
          if (changed) this.scheduleScan();
          if (desired.size === 0) this.scheduleRetry();
        } catch {
          // Missing or temporarily inaccessible paths can recover on a later event or retry.
          this.scheduleRetry();
        }
      }
    } finally {
      this.reconciling = false;
      if (this.active && this.reconcilePending) this.requestReconcile();
    }
  }

  private scheduleScan(): void {
    if (!this.active) return;
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      this.requestScan();
    }, SCAN_DEBOUNCE_MS);
    this.scanTimer.unref();
  }

  private requestScan(): void {
    if (!this.active) return;
    this.scanPending = true;
    if (this.scanning) return;
    void this.scan();
  }

  private async scan(): Promise<void> {
    this.scanning = true;
    try {
      while (this.active && this.scanPending) {
        this.scanPending = false;
        const generation = this.generation;
        try {
          const next = await this.readSignature();
          if (!this.active || generation !== this.generation) return;
          if (this.signature !== undefined && this.signature !== next) {
            this.signature = next;
            this.onChanged();
          } else if (this.signature === undefined && next !== "[]") {
            // A config may arrive during startup before the first scan completes.
            // The initial refresh closes that gap with the renderer's first list.
            this.signature = next;
            this.onChanged();
          } else {
            this.signature = next;
          }
        } catch {
          // Keep the last valid catalog. A later filesystem event or retry rechecks it.
          this.scheduleRetry();
        }
      }
    } finally {
      this.scanning = false;
      if (this.active && this.scanPending) this.requestScan();
    }
  }

  private scheduleRetry(): void {
    if (!this.active || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.requestReconcile();
      this.requestScan();
    }, WATCH_RETRY_MS);
    this.retryTimer.unref();
  }
}

async function nearestExistingDirectory(path: string): Promise<DirectoryIdentity | undefined> {
  let candidate = path;
  while (true) {
    const directory = await directoryIdentity(candidate);
    if (directory) return directory;
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

async function directoryIdentity(path: string): Promise<DirectoryIdentity | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) return undefined;
    return { path, identity: `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}` };
  } catch {
    return undefined;
  }
}
