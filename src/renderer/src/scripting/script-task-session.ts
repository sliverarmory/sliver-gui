import { parseScriptSource } from "../../../shared/script-contracts";
import type { ScriptConsoleRecord, ScriptRunState } from "../../../shared/script-runtime-protocol";
import { SCRIPT_TASK_LIMITS } from "../../../shared/script-task-manager-contracts";
import { ScriptRunner } from "./script-runner";

export interface ScriptRunSnapshot {
  readonly scriptId: string;
  readonly name: string;
  readonly source: string;
  readonly unsaved: boolean;
}
export interface ScriptTaskOutput {
  readonly records: readonly ScriptConsoleRecord[];
  readonly outputReset: number;
  readonly state: ScriptRunState;
  readonly snapshot: ScriptRunSnapshot;
}
interface TaskEntry {
  output: ScriptTaskOutput;
  runner: ScriptRunner | undefined;
}

/** One workspace owns the workers; other windows only receive console snapshots. */
export class ScriptTaskSession {
  private readonly tasks = new Map<string, TaskEntry>();
  private disposed = false;
  private reset = 0;

  constructor(
    private readonly loadRuntime: () => Promise<Uint8Array>,
    private readonly changed: () => void,
    private readonly createRunner: (callbacks: ConstructorParameters<typeof ScriptRunner>[0]) => ScriptRunner = (callbacks) => new ScriptRunner(callbacks),
  ) {}

  get(id: string | undefined): ScriptTaskOutput | undefined { return id ? this.tasks.get(id)?.output : undefined; }
  isRunning(id: string): boolean { return isRunning(this.get(id)?.state); }
  runningCount(): number { return [...this.tasks.values()].filter((entry) => isRunning(entry.output.state)).length; }

  async run(snapshot: ScriptRunSnapshot): Promise<void> {
    if (this.disposed || this.isRunning(snapshot.scriptId)) return;
    if (this.runningCount() >= SCRIPT_TASK_LIMITS.maxConcurrentRuns) {
      throw new Error(`Up to ${SCRIPT_TASK_LIMITS.maxConcurrentRuns} scripts can run at once. Stop a running script before starting another.`);
    }
    parseScriptSource(snapshot.source);
    this.remove(snapshot.scriptId, false);
    // Insertion order is the order of the last runs. Running tasks are never evicted.
    if (this.tasks.size >= SCRIPT_TASK_LIMITS.retainedOutputs) {
      const oldest = [...this.tasks].find(([, entry]) => !isRunning(entry.output.state));
      if (oldest) this.remove(oldest[0], false);
    }
    const entry: TaskEntry = {
      output: { snapshot, state: { status: "starting", elapsedMs: 0 }, records: [], outputReset: ++this.reset },
      runner: undefined,
    };
    this.tasks.set(snapshot.scriptId, entry);
    this.changed();
    try {
      const wasmBytes = await this.loadRuntime();
      if (!this.current(snapshot.scriptId, entry) || !isRunning(entry.output.state)) return;
      entry.runner = this.createRunner({
        onOutput: (records) => {
          if (!this.current(snapshot.scriptId, entry)) return;
          entry.output = { ...entry.output, records: [...entry.output.records, ...records] };
          this.changed();
        },
        onState: (state) => {
          if (!this.current(snapshot.scriptId, entry)) return;
          entry.output = { ...entry.output, state };
          this.changed();
        },
      });
      entry.runner.run({ source: snapshot.source, scriptId: snapshot.scriptId, wasmBytes });
    } catch (cause) {
      if (!this.current(snapshot.scriptId, entry) || !isRunning(entry.output.state)) return;
      entry.output = { ...entry.output, state: { status: "failed", elapsedMs: 0, message: cause instanceof Error ? cause.message : "Could not start the script runtime." } };
      this.changed();
    }
  }

  stop(id: string): void {
    const entry = this.tasks.get(id);
    if (!entry || !isRunning(entry.output.state)) return;
    entry.runner?.stop();
    // Also cancel runtime loading, before a worker exists.
    if (isRunning(entry.output.state)) {
      entry.output = { ...entry.output, state: { status: "stopped", elapsedMs: 0, message: "Execution stopped." } };
      this.changed();
    }
  }

  clear(id: string): void {
    const entry = this.tasks.get(id);
    if (!entry) return;
    entry.output = { ...entry.output, records: [], outputReset: ++this.reset };
    this.changed();
  }

  remove(id: string, notify = true): void {
    const entry = this.tasks.get(id);
    if (!entry) return;
    this.tasks.delete(id);
    entry.runner?.dispose();
    if (notify) this.changed();
  }

  retainScripts(ids: ReadonlySet<string>): void {
    for (const id of this.tasks.keys()) if (!ids.has(id)) this.remove(id);
  }

  stopAll(): void { for (const id of this.tasks.keys()) this.stop(id); }
  dispose(): void {
    this.disposed = true;
    for (const id of this.tasks.keys()) this.remove(id, false);
  }
  private current(id: string, entry: TaskEntry): boolean { return !this.disposed && this.tasks.get(id) === entry; }
}

function isRunning(state: ScriptRunState | undefined): boolean { return state?.status === "starting" || state?.status === "running"; }
