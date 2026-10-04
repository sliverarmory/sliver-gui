import { readBoundedRegularFile, writePrivateFileAtomic } from "./secure-file.js";
import {
  SOFTWARE_DEPLOYMENT_STATE_VERSION,
  parseLocalRedirectorRecord,
  parseSoftwareDeploymentState,
  type LocalRedirectorRecord,
  type SoftwareDeploymentState,
} from "../shared/software-deployment-contracts.js";
import { join } from "node:path";

const FILE_NAME = "software.json";
const MAX_BYTES = 512 * 1024;

export class SoftwareDeploymentStore {
  readonly filePath: string;
  #state: SoftwareDeploymentState;
  #mutationChain: Promise<void> = Promise.resolve();

  private constructor(filePath: string, state: SoftwareDeploymentState) {
    this.filePath = filePath;
    this.#state = state;
  }

  static async load(rootDirectory: string): Promise<SoftwareDeploymentStore> {
    const filePath = join(rootDirectory, FILE_NAME);
    let state = parseSoftwareDeploymentState({ v: SOFTWARE_DEPLOYMENT_STATE_VERSION, revision: 0, records: [] });
    try {
      const loaded = await readBoundedRegularFile(filePath, {
        label: "Managed software state",
        maxBytes: MAX_BYTES,
        requirePrivateMode: true,
      });
      try {
        state = parseSoftwareDeploymentState(JSON.parse(loaded.data.toString("utf8")) as unknown);
      } finally {
        loaded.data.fill(0);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
    return new SoftwareDeploymentStore(filePath, state);
  }

  getState(): SoftwareDeploymentState {
    return this.#state;
  }

  /** Preserve interrupted remote operations for explicit, reviewable cleanup. */
  recoverInterruptedTransitions(now: () => number = Date.now): Promise<SoftwareDeploymentState> {
    return this.#serialize(async () => {
      if (!this.#state.records.some(({ status }) => status === "installing" || status === "removing")) {
        return this.#state;
      }
      const updatedAt = new Date(now()).toISOString();
      const records = this.#state.records.map((record) => {
        if (record.status !== "installing" && record.status !== "removing") return record;
        const action = record.status === "installing" ? "installation" : "removal";
        return {
          ...record,
          status: "outcome-unknown" as const,
          updatedAt,
          lastCheckedAt: null,
          lastError: `The app closed before redirector ${action} completed. Inspect the managed server before retrying removal.`,
        };
      });
      return this.#commit(records);
    });
  }

  put(record: LocalRedirectorRecord, expectedRevision?: number): Promise<SoftwareDeploymentState> {
    return this.#serialize(async () => {
      if (expectedRevision !== undefined && expectedRevision !== this.#state.revision) throw new Error("Managed software state changed. Refresh and try again.");
      const validated = parseLocalRedirectorRecord(record);
      const records = this.#state.records.filter(({ id }) => id !== validated.id);
      records.push(validated);
      return this.#commit(records);
    });
  }

  remove(id: string, expectedRevision?: number): Promise<SoftwareDeploymentState> {
    return this.#serialize(async () => {
      if (expectedRevision !== undefined && expectedRevision !== this.#state.revision) throw new Error("Managed software state changed. Refresh and try again.");
      return this.#commit(this.#state.records.filter((record) => record.id !== id));
    });
  }

  async #commit(records: readonly LocalRedirectorRecord[]): Promise<SoftwareDeploymentState> {
    const state = parseSoftwareDeploymentState({
      v: SOFTWARE_DEPLOYMENT_STATE_VERSION,
      revision: this.#state.revision + 1,
      records,
    });
    const data = Buffer.from(JSON.stringify(state), "utf8");
    try {
      if (data.byteLength > MAX_BYTES) throw new Error("Managed software state is full");
      await writePrivateFileAtomic(this.filePath, data);
      this.#state = state;
      return state;
    } finally {
      data.fill(0);
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationChain.then(operation);
    this.#mutationChain = result.then(() => undefined, () => undefined);
    return result;
  }
}
