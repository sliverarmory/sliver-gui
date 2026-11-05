import { posix, win32 } from "node:path";

import { redactDiagnosticText } from "./diagnostic-redaction.js";

const APPLICATION_PROCESS_GRACEFUL_EXIT_TIMEOUT_MS = 5_000;
const APPLICATION_PROCESS_FORCE_EXIT_TIMEOUT_MS = 15_000;

export const BROAD_APPLICATION_PROCESS_INVENTORY = {
  includeDescendants: true,
  includeHelpers: true,
} as const;

export interface ProcessRecord {
  readonly pid: number;
  readonly parentPid?: number;
  readonly executablePath?: string;
  readonly commandLine: string;
}

export interface ApplicationProcessInventoryOptions {
  readonly includeDescendants?: boolean;
  readonly includeHelpers?: boolean;
}

interface ApplicationProcessCandidate extends ProcessRecord {
  readonly directlyOwned: boolean;
  readonly helper: boolean;
  readonly parentPid: number;
}

interface ProcessDependencies {
  readonly platform: NodeJS.Platform;
  readonly harnessPid: number;
  runCommand(command: string, args: readonly string[], options?: { readonly timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
  readFile(path: string): Promise<Buffer>;
  readProcessEntries(): Promise<readonly { readonly name: string; isDirectory(): boolean }[]>;
  kill(pid: number, signal: NodeJS.Signals): void;
  pollUntil<T>(operation: () => Promise<T | undefined | false>, timeoutMs: number, label: string): Promise<T>;
}

/** All operating-system interactions are injected so ownership and teardown can be exercised safely. */
export function createPackagedUpdateProcessController(dependencies: ProcessDependencies) {
  const { platform, harnessPid, runCommand, readFile, readProcessEntries, kill, pollUntil } = dependencies;
  const { isAbsolute, relative, sep } = platform === "win32" ? win32 : posix;

  async function waitForForcedRelaunch({
    executablePath,
    installRoot,
    excludedPids,
    timeoutMs,
  }: {
    executablePath: string;
    installRoot: string;
    excludedPids: ReadonlySet<number>;
    timeoutMs: number;
  }): Promise<ProcessRecord> {
    return pollUntil(async () => {
      const processes = await applicationProcesses(executablePath, installRoot);
      return processes.find(({ pid }) => !excludedPids.has(pid));
    }, timeoutMs, "the updater-forced N relaunch");
  }

  async function applicationProcesses(
    executablePath: string | undefined,
    installRoot: string,
    options: ApplicationProcessInventoryOptions = {},
  ): Promise<ProcessRecord[]> {
    if (platform === "win32") {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$items = @(Get-CimInstance Win32_Process -ErrorAction Stop | " +
          "Where-Object {-not [string]::IsNullOrWhiteSpace($_.ExecutablePath)} | " +
          "Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine)",
        "ConvertTo-Json -Compress -InputObject $items -ErrorAction Stop",
      ].join("; ");
      const result = await runCommand("pwsh.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ], { timeoutMs: 30_000 });
      if (result.stderr) {
        throw new Error(`Windows process inventory wrote stderr: ${redactDiagnosticText(result.stderr, [], 4_096)}`);
      }
      const parsed = parseWindowsProcessInventory(result.stdout);
      const candidates = parsed.flatMap((item): ApplicationProcessCandidate[] => {
        const commandLine = item.CommandLine ?? item.ExecutablePath;
        const directlyOwned = isPathInside(item.ExecutablePath, installRoot) &&
          (!executablePath || samePath(item.ExecutablePath, executablePath));
        return [{
          pid: item.ProcessId,
          parentPid: item.ParentProcessId,
          executablePath: item.ExecutablePath,
          commandLine,
          directlyOwned,
          helper: isApplicationHelperCommand(commandLine),
        }];
      });
      return selectOwnedApplicationProcesses(candidates, options);
    }

    if (platform === "linux") {
      return linuxAppImageProcesses(executablePath, installRoot, options);
    }

    return macApplicationProcesses(executablePath, installRoot, options);
  }

  interface WindowsProcessInventoryRecord {
    readonly CommandLine: string | null;
    readonly ExecutablePath: string;
    readonly ParentProcessId: number;
    readonly ProcessId: number;
  }

  function parseWindowsProcessInventory(content: string): WindowsProcessInventoryRecord[] {
    const value = JSON.parse(content) as unknown;
    if (!Array.isArray(value)) throw new Error("Windows process inventory must return a JSON array");
    return value.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Windows process inventory item ${index} must be an object`);
      }
      const record = item as Record<string, unknown>;
      const processId = record["ProcessId"];
      const parentProcessId = record["ParentProcessId"];
      const executablePath = record["ExecutablePath"];
      const commandLine = record["CommandLine"];
      if (
        typeof processId !== "number" ||
        !Number.isSafeInteger(processId) ||
        processId <= 0 ||
        typeof parentProcessId !== "number" ||
        !Number.isSafeInteger(parentProcessId) ||
        parentProcessId < 0 ||
        typeof executablePath !== "string" ||
        !isAbsolute(executablePath) ||
        (commandLine !== null && typeof commandLine !== "string")
      ) {
        throw new Error(`Windows process inventory item ${index} has an invalid shape`);
      }
      return {
        ProcessId: processId,
        ParentProcessId: parentProcessId,
        ExecutablePath: executablePath,
        CommandLine: commandLine,
      };
    });
  }

  async function macApplicationProcesses(
    executablePath: string | undefined,
    installRoot: string,
    options: ApplicationProcessInventoryOptions,
  ): Promise<ProcessRecord[]> {
    const result = await runCommand("/bin/ps", ["-axo", "pid=,ppid=,command="]);
    const candidates = result.stdout.split(/\r?\n/u).flatMap((line): ApplicationProcessCandidate[] => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      if (!match?.[1] || !match[2] || !match[3]) return [];
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(parentPid)) return [];
      const commandLine = match[3];
      const target = executablePath ?? installRoot;
      const directlyOwned = commandLine.includes(target);
      return [{
        pid,
        parentPid,
        commandLine,
        directlyOwned,
        helper: isApplicationHelperCommand(commandLine),
      }];
    });
    return selectOwnedApplicationProcesses(candidates, options);
  }

  function selectOwnedApplicationProcesses(
    candidates: readonly ApplicationProcessCandidate[],
    options: ApplicationProcessInventoryOptions,
  ): ProcessRecord[] {
    const ownedPids = new Set(
      candidates.filter(({ directlyOwned }) => directlyOwned).map(({ pid }) => pid),
    );
    if (options.includeDescendants) {
      let addedDescendant = true;
      while (addedDescendant) {
        addedDescendant = false;
        for (const candidate of candidates) {
          if (ownedPids.has(candidate.pid) || !ownedPids.has(candidate.parentPid)) continue;
          ownedPids.add(candidate.pid);
          addedDescendant = true;
        }
      }
    }
    return candidates.flatMap((candidate): ProcessRecord[] => {
      if (!ownedPids.has(candidate.pid) || (!options.includeHelpers && candidate.helper)) return [];
      return [{
        pid: candidate.pid,
        parentPid: candidate.parentPid,
        commandLine: candidate.commandLine,
        ...(candidate.executablePath ? { executablePath: candidate.executablePath } : {}),
      }];
    });
  }

  function isApplicationHelperCommand(commandLine: string): boolean {
    return /(?:--type=|Helper|crashpad_handler)/u.test(commandLine);
  }

  function absoluteCommandArgumentPath(argument: string): string | undefined {
    if (isAbsolute(argument)) return argument;
    const separatorIndex = argument.indexOf("=");
    if (separatorIndex < 0) return undefined;
    const value = argument.slice(separatorIndex + 1);
    return isAbsolute(value) ? value : undefined;
  }

  function directlyOwnedLinuxCommand(
    arguments_: readonly string[],
    executablePath: string | undefined,
    installRoot: string,
  ): string | undefined {
    for (const argument of arguments_) {
      const path = absoluteCommandArgumentPath(argument);
      if (!path || !isPathInside(path, installRoot)) continue;
      if (!executablePath || samePath(path, executablePath)) return path;
    }
    return undefined;
  }

  function linuxParentPid(status: string): number | undefined {
    const parent = /^PPid:\s+(\d+)\s*$/mu.exec(status)?.[1];
    if (!parent) return undefined;
    const parentPid = Number(parent);
    return Number.isSafeInteger(parentPid) ? parentPid : undefined;
  }

  async function readLinuxEnvironment(pid: number): Promise<Buffer> {
    try {
      return await readFile(`/proc/${pid}/environ`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") return Buffer.alloc(0);
      throw error;
    }
  }

  async function linuxAppImageProcesses(
    executablePath: string | undefined,
    installRoot: string,
    options: ApplicationProcessInventoryOptions,
  ): Promise<ProcessRecord[]> {
    const entries = await readProcessEntries();
    const candidates = await Promise.all(entries.flatMap(
      (entry): Array<Promise<ApplicationProcessCandidate | undefined>> => {
        if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) return [];
        const pid = Number(entry.name);
        return [readLinuxAppImageProcess(pid, executablePath, installRoot, options)];
      },
    ));
    return selectOwnedApplicationProcesses(
      candidates.filter((record): record is ApplicationProcessCandidate => record !== undefined),
      options,
    );
  }

  async function readLinuxAppImageProcess(
    pid: number,
    executablePath: string | undefined,
    installRoot: string,
    options: ApplicationProcessInventoryOptions,
  ): Promise<ApplicationProcessCandidate | undefined> {
    try {
      const [environmentBuffer, commandBuffer, statusBuffer] = await Promise.all([
        readLinuxEnvironment(pid),
        readFile(`/proc/${pid}/cmdline`),
        readFile(`/proc/${pid}/status`),
      ]);
      const parentPid = linuxParentPid(statusBuffer.toString("utf8"));
      if (parentPid === undefined) return undefined;
      const environment = environmentBuffer.toString("utf8").split("\0");
      const appImage = environment.find((entry) => entry.startsWith("APPIMAGE="))?.slice("APPIMAGE=".length);
      const arguments_ = commandBuffer.toString("utf8").split("\0").filter(Boolean);
      const commandLine = arguments_.join(" ");
      const commandPath = directlyOwnedLinuxCommand(arguments_, executablePath, installRoot);
      const appImageOwned = Boolean(
        appImage &&
        isAbsolute(appImage) &&
        isPathInside(appImage, installRoot) &&
        (!executablePath || samePath(appImage, executablePath)),
      );
      const directlyOwned = appImageOwned || commandPath !== undefined;
      const helper = isApplicationHelperCommand(commandLine);
      if (!directlyOwned && !options.includeDescendants) return undefined;
      if (helper && !options.includeHelpers && !options.includeDescendants) return undefined;
      const ownedExecutable = appImageOwned ? appImage : commandPath;
      return {
        pid,
        parentPid,
        commandLine,
        directlyOwned,
        helper,
        ...(ownedExecutable ? { executablePath: ownedExecutable } : {}),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return undefined;
      throw error;
    }
  }

  async function terminateExactApplicationProcess(
    processRecord: ProcessRecord,
    expectedExecutablePath: string | undefined,
    installRoot: string,
  ): Promise<void> {
    const current = (await applicationProcesses(expectedExecutablePath, installRoot))
      .find(({ pid }) => pid === processRecord.pid);
    if (!current) return;
    if (platform === "win32") {
      await runCommand("taskkill.exe", ["/PID", String(current.pid), "/T"], { timeoutMs: 30_000 }).catch(() => undefined);
    } else {
      try {
        kill(current.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    try {
      await pollUntil(async () => {
        const matches = await applicationProcesses(expectedExecutablePath, installRoot);
        return matches.some(({ pid }) => pid === current.pid) ? undefined : true;
      }, 15_000, `application process ${current.pid} to exit`);
    } catch {
      const stillCurrent = (await applicationProcesses(expectedExecutablePath, installRoot))
        .some(({ pid }) => pid === current.pid);
      if (!stillCurrent) return;
      if (platform === "win32") {
        await runCommand("taskkill.exe", ["/PID", String(current.pid), "/T", "/F"], { timeoutMs: 30_000 });
      } else {
        kill(current.pid, "SIGKILL");
      }
    }
  }

  async function waitForNoApplicationProcesses(
    executablePath: string | undefined,
    installRoot: string,
    timeoutMs: number,
    options: ApplicationProcessInventoryOptions = {},
  ): Promise<void> {
    await pollUntil(async () => {
      const processes = await applicationProcesses(executablePath, installRoot, options);
      return processes.length === 0 ? true : undefined;
    }, timeoutMs, "the forced-relaunch process tree to exit");
  }

  async function terminateRemainingApplicationProcesses(installRoot: string): Promise<void> {
    const gracefulFailures = await terminateApplicationProcessSnapshot(installRoot, false);
    try {
      await waitForNoApplicationProcesses(
        undefined,
        installRoot,
        APPLICATION_PROCESS_GRACEFUL_EXIT_TIMEOUT_MS,
        BROAD_APPLICATION_PROCESS_INVENTORY,
      );
      return;
    } catch {
      // The bounded graceful phase is expected to expire for a stuck helper.
    }

    const forcedFailures = await terminateApplicationProcessSnapshot(installRoot, true);
    try {
      await waitForNoApplicationProcesses(
        undefined,
        installRoot,
        APPLICATION_PROCESS_FORCE_EXIT_TIMEOUT_MS,
        BROAD_APPLICATION_PROCESS_INVENTORY,
      );
    } catch (absenceError) {
      const remaining = await applicationProcesses(
        undefined,
        installRoot,
        BROAD_APPLICATION_PROCESS_INVENTORY,
      ).catch((inventoryError) => [{
        pid: -1,
        commandLine: `inventory failed: ${errorMessage(inventoryError)}`,
      }]);
      const failures = [...gracefulFailures, ...forcedFailures];
      throw new Error(
        `Test-owned application processes survived bounded cleanup: ${JSON.stringify(remaining)}` +
          `${failures.length > 0 ? `; termination failures: ${failures.join("; ")}` : ""}` +
          `; absence proof: ${errorMessage(absenceError)}`,
      );
    }
  }

  async function terminateApplicationProcessSnapshot(
    installRoot: string,
    force: boolean,
  ): Promise<string[]> {
    const processes = await applicationProcesses(
      undefined,
      installRoot,
      BROAD_APPLICATION_PROCESS_INVENTORY,
    );
    const failures: string[] = [];
    for (const processRecord of processes) {
      if (processRecord.pid === harnessPid) {
        failures.push(`refused to signal the harness process ${processRecord.pid}`);
        continue;
      }
      try {
        const stillOwned = (await applicationProcesses(
          undefined,
          installRoot,
          BROAD_APPLICATION_PROCESS_INVENTORY,
        )).some((current) => sameProcessIdentity(current, processRecord));
        if (!stillOwned) continue;
        if (platform === "win32") {
          await runCommand(
            "taskkill.exe",
            ["/PID", String(processRecord.pid), "/T", ...(force ? ["/F"] : [])],
            { timeoutMs: 30_000 },
          );
        } else {
          kill(processRecord.pid, force ? "SIGKILL" : "SIGTERM");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") continue;
        failures.push(`PID ${processRecord.pid}: ${errorMessage(error)}`);
      }
    }
    return failures;
  }

  function sameProcessIdentity(current: ProcessRecord, snapshot: ProcessRecord): boolean {
    if (current.pid !== snapshot.pid || current.commandLine !== snapshot.commandLine) return false;
    if (current.executablePath === undefined || snapshot.executablePath === undefined) {
      return current.executablePath === snapshot.executablePath;
    }
    return samePath(current.executablePath, snapshot.executablePath);
  }

  async function waitForProcessIdToExit(
    pid: number,
    executablePath: string,
    installRoot: string,
    timeoutMs: number,
  ): Promise<void> {
    await pollUntil(async () => {
      const processes = await applicationProcesses(executablePath, installRoot);
      return processes.some((processRecord) => processRecord.pid === pid) ? undefined : true;
    }, timeoutMs, `N-1 application process ${pid} to exit`);
  }

  function isPathInside(path: string, parent: string): boolean {
    const candidate = platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
    const root = platform === "win32" ? parent.toLocaleLowerCase("en-US") : parent;
    const relation = relative(root, candidate);
    return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
  }

  function samePath(left: string, right: string): boolean {
    return platform === "win32"
      ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
      : left === right;
  }

  return {
    applicationProcesses,
    waitForForcedRelaunch,
    terminateExactApplicationProcess,
    waitForNoApplicationProcesses,
    terminateRemainingApplicationProcesses,
    waitForProcessIdToExit,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
