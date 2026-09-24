import { dirname } from "node:path";

import { readBoundedRegularFile, writePrivateFileAtomic } from "./secure-file.js";

const WORKSPACE_ZOOM_VERSION = 1;
const WORKSPACE_ZOOM_MAX_BYTES = 1024;
const DEFAULT_ZOOM_FACTOR = 1;
const MIN_ZOOM_FACTOR = 0.25;
const MAX_ZOOM_FACTOR = 5;

interface PersistedWorkspaceZoom {
  v: typeof WORKSPACE_ZOOM_VERSION;
  zoomFactor: number;
}

/** Main-owned, best-effort persistence for the workspace's native page zoom. */
export class WorkspaceZoomSettings {
  readonly filePath: string;
  #factor: number;
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, factor: number) {
    this.filePath = filePath;
    this.#factor = factor;
  }

  static async load(filePath: string): Promise<WorkspaceZoomSettings> {
    if (typeof filePath !== "string" || filePath.trim() === "" || dirname(filePath) === filePath) {
      throw new TypeError("A workspace zoom settings file path is required");
    }
    let factor = DEFAULT_ZOOM_FACTOR;
    try {
      const loaded = await readBoundedRegularFile(filePath, {
        label: "Workspace zoom settings",
        maxBytes: WORKSPACE_ZOOM_MAX_BYTES,
        requirePrivateMode: true,
      });
      try {
        factor = parsePersistedZoom(JSON.parse(loaded.data.toString("utf8")) as unknown);
      } finally {
        loaded.data.fill(0);
      }
    } catch {
      // An absent, corrupt, or unsupported preference must not block startup.
      factor = DEFAULT_ZOOM_FACTOR;
    }
    return new WorkspaceZoomSettings(filePath, factor);
  }

  getFactor(): number {
    return this.#factor;
  }

  /** Updates the running app immediately; writes are ordered and failure-tolerant. */
  setFactor(factor: number): void {
    if (!isValidZoomFactor(factor) || factor === this.#factor) return;
    this.#factor = factor;
    const data = Buffer.from(JSON.stringify({ v: WORKSPACE_ZOOM_VERSION, zoomFactor: factor } satisfies PersistedWorkspaceZoom));
    this.#writeChain = this.#writeChain.then(async () => {
      try {
        await writePrivateFileAtomic(this.filePath, data);
      } catch {
        // Zoom is a convenience preference; retain the current session value.
      } finally {
        data.fill(0);
      }
    });
  }

  flush(): Promise<void> {
    return this.#writeChain;
  }
}

function parsePersistedZoom(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid workspace zoom settings");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record["v"] !== WORKSPACE_ZOOM_VERSION ||
      !isValidZoomFactor(record["zoomFactor"])) {
    throw new TypeError("Invalid workspace zoom settings");
  }
  return record["zoomFactor"];
}

function isValidZoomFactor(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= MIN_ZOOM_FACTOR && value <= MAX_ZOOM_FACTOR;
}
