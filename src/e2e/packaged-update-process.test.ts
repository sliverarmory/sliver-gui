// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  BROAD_APPLICATION_PROCESS_INVENTORY,
  createPackagedUpdateProcessController,
  type ProcessRecord,
} from "./packaged-update-process.js";

const windowsRoot = "C:\\isolated\\installed";
const windowsExecutable = `${windowsRoot}\\Sliver GUI.exe`;
const posixRoot = "/isolated/installed";
const posixExecutable = `${posixRoot}/Sliver GUI`;

function processFixture(platform: "darwin" | "win32", initial: ProcessRecord[] = []) {
  const state = { processes: initial };
  const inventory = vi.fn(() => state.processes);
  const signal = vi.fn((pid: number, _signal: NodeJS.Signals) => {
    state.processes = state.processes.filter((record) => record.pid !== pid);
  });
  const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === "taskkill.exe") {
      signal(Number(args[1]), args.includes("/F") ? "SIGKILL" : "SIGTERM");
      return { stdout: "", stderr: "" };
    }
    const records = inventory();
    if (command === "pwsh.exe") return {
      stdout: JSON.stringify(records.map((record) => ({
        ProcessId: record.pid, ParentProcessId: record.parentPid ?? 1,
        ExecutablePath: record.executablePath, CommandLine: record.commandLine,
      }))),
      stderr: "",
    };
    if (command === "/bin/ps") return {
      stdout: records.map(({ pid, parentPid = 1, commandLine }) => `${pid} ${parentPid} ${commandLine}`).join("\n"),
      stderr: "",
    };
    throw new Error(`Unexpected command: ${command}`);
  });
  const polls: { timeoutMs: number; label: string }[] = [];
  const controller = createPackagedUpdateProcessController({
    platform, harnessPid: 999, runCommand, kill: signal,
    readFile: async () => { throw new Error("Unexpected file read"); },
    readProcessEntries: async () => { throw new Error("Unexpected /proc inventory"); },
    async pollUntil<T>(operation: () => Promise<T | undefined | false>, timeoutMs: number, label: string): Promise<T> {
      polls.push({ timeoutMs, label });
      const value = await operation();
      if (value !== undefined && value !== false) return value;
      throw new Error(`Timed out waiting for ${label}`);
    },
  });
  return { controller, inventory, runCommand, signal, state, polls };
}

function application(platform: "darwin" | "win32", pid = 10): ProcessRecord {
  const executablePath = platform === "win32" ? windowsExecutable : posixExecutable;
  return { pid, parentPid: 1, executablePath, commandLine: executablePath };
}

function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`system error ${code}`), { code });
}

function linuxFixture(files: Record<string, string | Error>, pids: number[]) {
  const readFile = vi.fn(async (path: string): Promise<Buffer> => {
    const value = files[path];
    if (value instanceof Error) throw value;
    if (value === undefined) throw systemError("ENOENT");
    return Buffer.from(value);
  });
  const controller = createPackagedUpdateProcessController({
    platform: "linux", harnessPid: 999, readFile,
    readProcessEntries: async () => [
      ...pids.map((pid) => ({ name: String(pid), isDirectory: () => true })),
      { name: "self", isDirectory: () => true },
      { name: "1234", isDirectory: () => false },
    ],
    runCommand: async () => { throw new Error("Unexpected command"); },
    kill: () => { throw new Error("Unexpected signal"); },
    pollUntil: async () => { throw new Error("Unexpected poll"); },
  });
  return { controller, readFile };
}

function procFiles(pid: number, parent: number, args: string[], environment = ""): Record<string, string> {
  return {
    [`/proc/${pid}/cmdline`]: `${args.join("\0")}\0`,
    [`/proc/${pid}/environ`]: environment,
    [`/proc/${pid}/status`]: `Name:\tapplication\nPPid:\t${parent}\n`,
  };
}

describe("packaged updater process inventory", () => {
  it.each(["darwin", "win32"] as const)("includes only owned %s processes and requested helpers or descendants", async (platform) => {
    const root = platform === "win32" ? windowsRoot : posixRoot;
    const main = application(platform);
    const helper: ProcessRecord = { pid: 11, parentPid: 10, executablePath: `${root}/Helper`, commandLine: `${root}/Helper --type=renderer` };
    const child: ProcessRecord = { pid: 12, parentPid: 11, executablePath: platform === "win32" ? "C:\\other\\worker.exe" : "/other/worker", commandLine: "worker" };
    const unrelated: ProcessRecord = { pid: 20, parentPid: 1, executablePath: platform === "win32" ? "C:\\unrelated\\app.exe" : "/unrelated/app", commandLine: "/unrelated/app" };
    // Descendants precede parents to exercise traversal beyond one pass.
    const fixture = processFixture(platform, [child, helper, unrelated, main]);

    expect((await fixture.controller.applicationProcesses(main.executablePath, root)).map(({ pid }) => pid)).toEqual([10]);
    expect((await fixture.controller.applicationProcesses(undefined, root, { includeHelpers: true })).map(({ pid }) => pid)).toEqual([11, 10]);
    expect((await fixture.controller.applicationProcesses(undefined, root, { includeDescendants: true })).map(({ pid }) => pid)).toEqual([12, 10]);
    expect((await fixture.controller.applicationProcesses(undefined, root, BROAD_APPLICATION_PROCESS_INVENTORY)).map(({ pid }) => pid)).toEqual([12, 11, 10]);
    expect(fixture.signal).not.toHaveBeenCalled();
    if (platform === "darwin") expect(fixture.runCommand).toHaveBeenCalledWith("/bin/ps", ["-axo", "pid=,ppid=,command="]);
  });

  it("matches Windows paths case-insensitively without accepting a sibling directory", async () => {
    const main = application("win32");
    const fixture = processFixture("win32", [
      { ...main, executablePath: windowsExecutable.toUpperCase() },
      { ...main, pid: 11, executablePath: `${windowsRoot}-other\\Sliver GUI.exe` },
    ]);
    expect((await fixture.controller.applicationProcesses(windowsExecutable, windowsRoot)).map(({ pid }) => pid)).toEqual([10]);
    const call = fixture.runCommand.mock.calls[0]!;
    expect(call[0]).toBe("pwsh.exe");
    expect(call[1].slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(call[1][4]!, "base64").toString("utf16le");
    expect(script).toContain("Get-CimInstance Win32_Process -ErrorAction Stop");
    expect(script).toContain("Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine");
  });

  it.each([
    "{}", "null", "[null]", "[[]]", "[{}]",
    JSON.stringify([{ ProcessId: 0, ParentProcessId: 1, ExecutablePath: windowsExecutable, CommandLine: null }]),
    JSON.stringify([{ ProcessId: 10, ParentProcessId: -1, ExecutablePath: windowsExecutable, CommandLine: null }]),
    JSON.stringify([{ ProcessId: 10, ParentProcessId: 1, ExecutablePath: "relative.exe", CommandLine: null }]),
    JSON.stringify([{ ProcessId: 10, ParentProcessId: 1, ExecutablePath: windowsExecutable, CommandLine: 42 }]),
  ])("rejects malformed Windows inventory %s", async (stdout) => {
    const fixture = processFixture("win32");
    fixture.runCommand.mockResolvedValue({ stdout, stderr: "" });
    await expect(fixture.controller.applicationProcesses(undefined, windowsRoot)).rejects.toThrow("Windows process inventory");
  });

  it("rejects Windows stderr and command failures instead of claiming absence", async () => {
    const fixture = processFixture("win32");
    fixture.runCommand.mockResolvedValueOnce({ stdout: "[]", stderr: "CIM inventory failed" });
    await expect(fixture.controller.applicationProcesses(undefined, windowsRoot)).rejects.toThrow("Windows process inventory wrote stderr");
    fixture.runCommand.mockRejectedValueOnce(new Error("inventory command failed"));
    await expect(fixture.controller.applicationProcesses(undefined, windowsRoot)).rejects.toThrow("inventory command failed");
  });

  it("accepts a null Windows command line using the executable as identity", async () => {
    const fixture = processFixture("win32");
    fixture.runCommand.mockResolvedValue({ stdout: JSON.stringify([
      { ProcessId: 10, ParentProcessId: 1, ExecutablePath: windowsExecutable, CommandLine: null },
    ]), stderr: "" });
    await expect(fixture.controller.applicationProcesses(windowsExecutable, windowsRoot)).resolves.toEqual([
      { pid: 10, parentPid: 1, executablePath: windowsExecutable, commandLine: windowsExecutable },
    ]);
  });

  it("finds Linux AppImages from environment or exact arguments and follows their helper descendants", async () => {
    const executable = `${posixRoot}/Sliver.AppImage`;
    const fixture = linuxFixture({
      ...procFiles(10, 1, ["/tmp/.mount/application"], `APPIMAGE=${executable}\0`),
      ...procFiles(11, 10, ["/tmp/.mount/Helper", "--type=renderer"], `APPIMAGE=${executable}\0`),
      ...procFiles(12, 11, ["/usr/bin/worker"]),
      ...procFiles(13, 1, ["/usr/bin/runner", `--appimage=${executable}`]),
      ...procFiles(20, 1, [`${posixRoot}-other/Sliver.AppImage`]),
      ...procFiles(21, 1, ["/usr/bin/unrelated"], "APPIMAGE=relative.AppImage\0"),
    }, [12, 11, 20, 21, 13, 10]);
    expect((await fixture.controller.applicationProcesses(executable, posixRoot)).map(({ pid }) => pid)).toEqual([13, 10]);
    expect((await fixture.controller.applicationProcesses(executable, posixRoot, BROAD_APPLICATION_PROCESS_INVENTORY)).map(({ pid }) => pid)).toEqual([12, 11, 13, 10]);
    expect(fixture.readFile).toHaveBeenCalledWith("/proc/12/status");
    expect(fixture.readFile).not.toHaveBeenCalledWith("/proc/self/status");
    expect(fixture.readFile).not.toHaveBeenCalledWith("/proc/1234/status");
  });

  it.each(["EACCES", "EPERM"])("uses Linux command ownership when environment access is denied with %s", async (code) => {
    const executable = `${posixRoot}/Sliver.AppImage`;
    const fixture = linuxFixture({
      ...procFiles(10, 1, [executable]),
      "/proc/10/environ": systemError(code),
    }, [10]);
    expect((await fixture.controller.applicationProcesses(executable, posixRoot)).map(({ pid }) => pid)).toEqual([10]);
  });

  it("ignores vanished, inaccessible, and malformed Linux entries but propagates other read failures", async () => {
    const fixture = linuxFixture({
      ...procFiles(10, 1, [posixExecutable]),
      "/proc/10/status": "missing parent pid",
      ...procFiles(11, 1, [posixExecutable]),
      "/proc/11/cmdline": systemError("EACCES"),
    }, [10, 11, 12]);
    await expect(fixture.controller.applicationProcesses(undefined, posixRoot, BROAD_APPLICATION_PROCESS_INVENTORY)).resolves.toEqual([]);
    fixture.readFile.mockRejectedValueOnce(systemError("EIO"));
    await expect(fixture.controller.applicationProcesses(undefined, posixRoot)).rejects.toMatchObject({ code: "EIO" });
  });
});

describe("packaged updater process termination", () => {
  it.each(["darwin", "win32"] as const)("terminates owned %s helpers and descendants, then proves absence", async (platform) => {
    const root = platform === "win32" ? windowsRoot : posixRoot;
    const main = application(platform);
    const helper = { pid: 11, parentPid: 10, executablePath: `${root}/Helper`, commandLine: `${root}/Helper --type=renderer` };
    const child = { pid: 12, parentPid: 11, executablePath: platform === "win32" ? "C:\\other\\child.exe" : "/other/child", commandLine: "child" };
    const fixture = processFixture(platform, [child, helper, main]);
    await fixture.controller.terminateRemainingApplicationProcesses(root);
    expect(fixture.signal.mock.calls).toEqual([[12, "SIGTERM"], [11, "SIGTERM"], [10, "SIGTERM"]]);
    expect(fixture.polls.map(({ timeoutMs }) => timeoutMs)).toEqual([5_000]);
    expect(fixture.state.processes).toEqual([]);
  });

  it.each(["darwin", "win32"] as const)("rechecks ownership before forcing a stuck %s process", async (platform) => {
    const root = platform === "win32" ? windowsRoot : posixRoot;
    const fixture = processFixture(platform, [application(platform)]);
    fixture.signal.mockImplementation((_pid, signal) => { if (signal === "SIGKILL") fixture.state.processes = []; });
    await fixture.controller.terminateRemainingApplicationProcesses(root);
    expect(fixture.signal.mock.calls).toEqual([[10, "SIGTERM"], [10, "SIGKILL"]]);
    expect(fixture.polls.map(({ timeoutMs }) => timeoutMs)).toEqual([5_000, 15_000]);
    if (platform === "win32") {
      expect(fixture.runCommand).toHaveBeenCalledWith("taskkill.exe", ["/PID", "10", "/T"], { timeoutMs: 30_000 });
      expect(fixture.runCommand).toHaveBeenCalledWith("taskkill.exe", ["/PID", "10", "/T", "/F"], { timeoutMs: 30_000 });
    }
  });

  it.each(["command line", "executable", "pid"])("does not signal a replaced process with a changed %s", async (change) => {
    const original = application("win32");
    const replacement = {
      ...original,
      ...(change === "command line" ? { commandLine: `${windowsExecutable} --replacement` } : {}),
      ...(change === "executable" ? { executablePath: `${windowsRoot}\\replacement.exe` } : {}),
      ...(change === "pid" ? { pid: 21 } : {}),
    };
    const fixture = processFixture("win32");
    fixture.inventory.mockReturnValueOnce([original]).mockReturnValueOnce([replacement]);
    await fixture.controller.terminateRemainingApplicationProcesses(windowsRoot);
    expect(fixture.signal).not.toHaveBeenCalled();
  });

  it("accepts a Windows executable's case-only identity change", async () => {
    const original = application("win32");
    const fixture = processFixture("win32");
    fixture.inventory.mockReturnValueOnce([original]).mockReturnValueOnce([{ ...original, executablePath: windowsExecutable.toUpperCase() }]);
    await fixture.controller.terminateRemainingApplicationProcesses(windowsRoot);
    expect(fixture.signal).toHaveBeenCalledExactlyOnceWith(10, "SIGTERM");
  });

  it("never signals the harness and reports survivors after both bounded phases", async () => {
    const fixture = processFixture("darwin", [application("darwin", 999)]);
    await expect(fixture.controller.terminateRemainingApplicationProcesses(posixRoot)).rejects.toThrow("refused to signal the harness process 999");
    expect(fixture.signal).not.toHaveBeenCalled();
    expect(fixture.polls.map(({ timeoutMs }) => timeoutMs)).toEqual([5_000, 15_000]);
  });

  it("retains signal failures and the failed absence proof when cleanup cannot finish", async () => {
    const fixture = processFixture("darwin", [application("darwin")]);
    fixture.signal.mockImplementation(() => { throw systemError("EPERM"); });
    await expect(fixture.controller.terminateRemainingApplicationProcesses(posixRoot)).rejects.toThrow(/survived bounded cleanup.*PID 10: system error EPERM.*absence proof/u);
    expect(fixture.signal.mock.calls).toEqual([[10, "SIGTERM"], [10, "SIGKILL"]]);
  });

  it("tolerates ESRCH when a process exits between inventory and signaling", async () => {
    const fixture = processFixture("darwin", [application("darwin")]);
    fixture.signal.mockImplementation(() => { fixture.state.processes = []; throw systemError("ESRCH"); });
    await expect(fixture.controller.terminateRemainingApplicationProcesses(posixRoot)).resolves.toBeUndefined();
    expect(fixture.signal).toHaveBeenCalledOnce();
  });

  it.each(["darwin", "win32"] as const)("terminates only the tracked %s relaunch and uses force after a stalled graceful wait", async (platform) => {
    const root = platform === "win32" ? windowsRoot : posixRoot;
    const tracked = application(platform);
    const fixture = processFixture(platform, [tracked, application(platform, 20)]);
    fixture.signal.mockImplementation(() => undefined);
    await fixture.controller.terminateExactApplicationProcess(tracked, tracked.executablePath, root);
    expect(fixture.signal.mock.calls).toEqual([[10, "SIGTERM"], [10, "SIGKILL"]]);
    expect(fixture.polls.map(({ timeoutMs }) => timeoutMs)).toEqual([15_000]);
  });

  it("skips a tracked process that vanished before or after the graceful signal", async () => {
    const tracked = application("darwin");
    const fixture = processFixture("darwin");
    await fixture.controller.terminateExactApplicationProcess(tracked, tracked.executablePath, posixRoot);
    expect(fixture.signal).not.toHaveBeenCalled();
    fixture.state.processes = [tracked];
    await fixture.controller.terminateExactApplicationProcess(tracked, tracked.executablePath, posixRoot);
    expect(fixture.signal).toHaveBeenCalledExactlyOnceWith(10, "SIGTERM");
  });

  it("selects a new relaunch PID and keeps exit proof scoped to the old PID", async () => {
    const old = application("darwin");
    const current = application("darwin", 20);
    const fixture = processFixture("darwin", [old, current]);
    await expect(fixture.controller.waitForForcedRelaunch({ executablePath: posixExecutable, installRoot: posixRoot, excludedPids: new Set([10]), timeoutMs: 1_000 })).resolves.toMatchObject({ pid: 20 });
    await expect(fixture.controller.waitForProcessIdToExit(10, posixExecutable, posixRoot, 1_000)).rejects.toThrow("N-1 application process 10 to exit");
    fixture.state.processes = [current];
    await expect(fixture.controller.waitForProcessIdToExit(10, posixExecutable, posixRoot, 1_000)).resolves.toBeUndefined();
  });

  it("requires helpers and descendants to exit when broad absence proof is requested", async () => {
    const fixture = processFixture("darwin", [
      { pid: 11, parentPid: 1, commandLine: `${posixRoot}/Helper --type=renderer` },
    ]);
    await expect(fixture.controller.waitForNoApplicationProcesses(undefined, posixRoot, 1_000)).resolves.toBeUndefined();
    await expect(fixture.controller.waitForNoApplicationProcesses(undefined, posixRoot, 1_000, BROAD_APPLICATION_PROCESS_INVENTORY)).rejects.toThrow("process tree to exit");
  });
});
