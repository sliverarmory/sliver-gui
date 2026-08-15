import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertPrivatePackagedUpdateConfiguration,
  attachCleanupFailure,
  cleanupOwnedApplication,
  observePromiseSettlement,
  packagedUpdateLaunchProfile,
  packagedUpdateProfileEnvironment,
  parsePackagedUpdateVersions,
  parseWindowsAuthenticodeInspection,
  windowsAuthenticodeInspectionCommand,
} from "./packaged-application-update-support.js";

describe("packaged application update E2E support", () => {
  it("destroys every unique Playwright stdio transport before bounded cleanup completes", async () => {
    let finishClose: (() => void) | undefined;
    const close = new Promise<void>((resolveClose) => { finishClose = resolveClose; });
    const kill = vi.fn(() => true);
    const destroyed: string[] = [];
    const destroy = (name: string) => vi.fn(() => {
      destroyed.push(name);
      if (destroyed.length === 4) finishClose?.();
    });
    const stdout = { destroy: destroy("stdout") };
    const stderr = { destroy: destroy("stderr") };
    const fd3 = { destroy: destroy("fd3") };
    const fd4 = { destroy: destroy("fd4") };
    const application = {
      close: vi.fn(() => close),
      process: vi.fn(() => ({
        exitCode: null,
        kill,
        signalCode: null,
        stdio: [null, stdout, stderr, fd3, fd4, stdout],
      })),
    };

    await expect(cleanupOwnedApplication(application, "test", 1)).resolves.toBeUndefined();
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(destroyed).toEqual(["stdout", "stderr", "fd3", "fd4"]);
    expect(stdout.destroy).toHaveBeenCalledTimes(1);
    expect(fd3.destroy).toHaveBeenCalledTimes(1);
    expect(fd4.destroy).toHaveBeenCalledTimes(1);
    expect(application.close).toHaveBeenCalledTimes(1);
  });

  it("attempts every owned transport cleanup before reporting a bounded failure", async () => {
    const destroyStdout = vi.fn();
    const destroyStderr = vi.fn();
    const destroyFd3 = vi.fn(() => { throw new Error("fd3 failure"); });
    const destroyFd4 = vi.fn();
    const stdout = { destroy: destroyStdout };
    const application = {
      close: vi.fn(() => new Promise<void>(() => undefined)),
      process: vi.fn(() => ({
        exitCode: null,
        kill: vi.fn(() => { throw new Error("kill failure"); }),
        signalCode: null,
        stdio: [null, stdout, { destroy: destroyStderr }, { destroy: destroyFd3 }, {
          destroy: destroyFd4,
        }, stdout],
      })),
    };

    await expect(cleanupOwnedApplication(application, "test", 1)).rejects.toThrow(/owned stdio\[3\].*fd3/u);
    expect(destroyStdout).toHaveBeenCalledTimes(1);
    expect(destroyStderr).toHaveBeenCalledTimes(1);
    expect(destroyFd3).toHaveBeenCalledTimes(1);
    expect(destroyFd4).toHaveBeenCalledTimes(1);
  });

  it("attaches cleanup context without replacing or mutating the original failure shape", () => {
    const original = new Error("launch failure");
    const cleanup = new Error("cleanup failure");

    expect(() => attachCleanupFailure(original, cleanup)).not.toThrow();
    expect((original as Error & { cleanupError?: unknown }).cleanupError).toBe(cleanup);
    expect(Object.keys(original)).not.toContain("cleanupError");
    expect(() => attachCleanupFailure(Object.freeze(new Error("frozen")), cleanup)).not.toThrow();
    expect(() => attachCleanupFailure("primitive launch failure", cleanup)).not.toThrow();
  });

  it("observes a rejected Playwright close waiter without creating a rejected promise", async () => {
    const reason = new Error("transport remained open");

    await expect(observePromiseSettlement(Promise.reject(reason))).resolves.toEqual({
      reason,
      status: "rejected",
    });
  });

  it("requires native updater process proofs before Playwright close settlement", () => {
    const source = readFileSync(resolve("src/e2e/packaged-application-update.e2e.ts"), "utf8");
    const start = source.indexOf('recordPhase(diagnostics, "installing-and-forced-relaunch")');
    const end = source.indexOf("const updatedTrust = await verifyPlatformTrust", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const transition = source.slice(start, end);
    const markers = [
      "observePromiseSettlement(",
      'getByRole("button", { name: "Restart and update", exact: true }).click()',
      "await waitForProcessIdToExit(",
      "await waitForUpdatedExecutable(",
      "await waitForForcedRelaunch({",
      "await terminateExactApplicationProcess(",
      "await waitForNoApplicationProcesses(",
      "forcedRelaunch = undefined",
      "await requireObservedApplicationClose(",
      "firstApplication = undefined",
    ];
    const positions = markers.map((marker) => transition.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(transition).toContain('waitForEvent("close", { timeout: 0 })');
    expect(transition).toContain("BROAD_APPLICATION_PROCESS_INVENTORY");
    expect(transition).not.toContain("await oldApplicationClosed");

    const cleanupStart = source.indexOf("} finally {", end);
    const cleanupEnd = source.indexOf("\n});", cleanupStart);
    const cleanup = source.slice(cleanupStart, cleanupEnd);
    const cleanupTerminate = cleanup.indexOf("terminateExactApplicationProcess(");
    const cleanupConnectionClose = cleanup.indexOf("cleanupOwnedApplication(application");
    const cleanupDescendants = cleanup.indexOf("terminateRemainingApplicationProcesses(installRoot)");
    const cleanupTemporaryRoot = cleanup.indexOf("await rm(temporaryRoot");
    expect(cleanupTerminate).toBeGreaterThanOrEqual(0);
    expect(cleanupConnectionClose).toBeGreaterThan(cleanupTerminate);
    expect(cleanupDescendants).toBeGreaterThan(cleanupConnectionClose);
    expect(cleanupTemporaryRoot).toBeGreaterThan(cleanupDescendants);
    expect(cleanup).toContain("let processAbsenceProved = false");
    expect(cleanup).toContain("if (!processAbsenceProved)");
    expect(cleanup).toContain("Retaining the packaged updater temporary directory");
    expect(cleanup).not.toContain("firstApplication?.close()");
    expect(cleanup).not.toContain("secondApplication?.close()");
  });

  it("uses bounded cleanup for partial launches while preserving the original error", () => {
    const source = readFileSync(resolve("src/e2e/packaged-application-update.e2e.ts"), "utf8");
    const start = source.indexOf("async function launchApplication(");
    const end = source.indexOf("function isolatedApplicationEnvironment", start);
    const launch = source.slice(start, end);

    expect(launch).toContain("await cleanupOwnedApplication(");
    expect(launch).toContain("APPLICATION_CLEANUP_SETTLE_TIMEOUT_MS");
    expect(launch).toContain("attachCleanupFailure(error, cleanupError)");
    expect(launch).toContain("throw error;");
    expect(launch.indexOf("cleanupOwnedApplication(")).toBeLessThan(launch.indexOf("throw error;"));
    expect(launch).not.toContain("application.close()");
  });

  it("includes helpers and descendants in broad diagnostics, shutdown proof, and final teardown", () => {
    const source = readFileSync(resolve("src/e2e/packaged-application-update.e2e.ts"), "utf8");

    expect(source).toContain("includeDescendants: true");
    expect(source).toContain("includeHelpers: true");
    expect(source).toContain("Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine");
    expect(source).toContain("$ErrorActionPreference = 'Stop'");
    expect(source).toContain("Get-CimInstance Win32_Process -ErrorAction Stop");
    expect(source).toContain("Windows process inventory wrote stderr");
    expect(source).toContain("Windows process inventory must return a JSON array");
    expect(source).toContain('["-axo", "pid=,ppid=,command="]');
    expect(source).toContain("readFile(`/proc/${pid}/status`)");
    expect(source).toContain("ownedPids.has(candidate.parentPid)");
    expect(source).toContain("!options.includeHelpers && candidate.helper");
    const failureDiagnostics = source.slice(
      source.indexOf('diagnostics["failure"]'),
      source.indexOf("const diagnosticPage"),
    );
    expect(failureDiagnostics).toContain("BROAD_APPLICATION_PROCESS_INVENTORY");
    const termination = source.slice(
      source.indexOf("async function terminateRemainingApplicationProcesses"),
      source.indexOf("async function waitForProcessIdToExit"),
    );
    expect(termination).toContain("BROAD_APPLICATION_PROCESS_INVENTORY");
    expect(termination).toContain('process.kill(processRecord.pid, force ? "SIGKILL" : "SIGTERM")');
    expect(termination).toContain('["/PID", String(processRecord.pid), "/T", ...(force ? ["/F"] : [])]');
    expect(termination).toContain("APPLICATION_PROCESS_GRACEFUL_EXIT_TIMEOUT_MS");
    expect(termination).toContain("APPLICATION_PROCESS_FORCE_EXIT_TIMEOUT_MS");
    expect(termination).toContain("sameProcessIdentity(current, processRecord)");
    expect(termination).toContain("current.commandLine !== snapshot.commandLine");
    expect(source).toContain('new AggregateError(cleanupFailures, "Packaged updater E2E cleanup failed")');
  });

  it("pins controlled application launches to one explicit user-data directory", () => {
    const profileRoot = resolve("private", "tmp", "e2e-profile");
    const userDataDirectory = join(profileRoot, "user-data");

    expect(packagedUpdateLaunchProfile(profileRoot)).toEqual({
      arguments: [
        "--enable-sandbox",
        `--user-data-dir=${userDataDirectory}`,
      ],
      userDataDirectory,
    });
  });

  it("uses the Core Foundation home override for isolated macOS launches", () => {
    const environment = packagedUpdateProfileEnvironment("/private/tmp/e2e-profile", "darwin");

    expect(environment).toMatchObject({
      CFFIXED_USER_HOME: "/private/tmp/e2e-profile",
      HOME: "/private/tmp/e2e-profile",
    });
    expect(packagedUpdateProfileEnvironment("/tmp/e2e-profile", "linux")).not.toHaveProperty(
      "CFFIXED_USER_HOME",
    );
  });

  it("encodes a fail-closed Windows Authenticode inspection without shell-interpolating its path", () => {
    const executablePath = String.raw`D:\a\_temp\installed\Sliver GUI.exe`;
    const invocation = windowsAuthenticodeInspectionCommand(executablePath);
    const encodedCommand = invocation.arguments.at(-1) ?? "";
    const script = Buffer.from(encodedCommand, "base64").toString("utf16le");
    const encodedPath = Buffer.from(executablePath, "utf16le").toString("base64");

    expect(invocation.executable).toBe("pwsh.exe");
    expect(invocation.arguments.slice(0, -1)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(script).toContain(`FromBase64String('${encodedPath}')`);
    expect(script).not.toContain(executablePath);
    expect(script).toContain("$ErrorActionPreference = 'Stop'");
    expect(script).toContain("Test-Path -LiteralPath $path -PathType Leaf");
    expect(script).toContain("Get-AuthenticodeSignature -LiteralPath $path -ErrorAction Stop");
    expect(script).toContain("$signature.Status.ToString()");
    expect(script).toContain("$signature.StatusMessage.ToString()");
    expect(script).toContain("$null -eq $signature.SignerCertificate");
    expect(script).toContain("$signature.SignerCertificate.Thumbprint.ToString()");
  });

  it("strictly parses complete Windows Authenticode diagnostics", () => {
    expect(parseWindowsAuthenticodeInspection(JSON.stringify({
      Status: "Valid",
      StatusMessage: "Signature verified.",
      Subject: "CN=Sliver GUI Updater E2E, O=Sliver Armory E2E",
      Thumbprint: "0123456789abcdef0123456789abcdef01234567",
    }))).toEqual({
      status: "Valid",
      statusMessage: "Signature verified.",
      subject: "CN=Sliver GUI Updater E2E, O=Sliver Armory E2E",
      thumbprint: "0123456789ABCDEF0123456789ABCDEF01234567",
    });
  });

  it.each([
    "[]",
    JSON.stringify({ Status: "Valid", Subject: "publisher", Thumbprint: "0".repeat(40) }),
    JSON.stringify({
      Status: "Valid",
      StatusMessage: "Signature verified.",
      Subject: "publisher",
      Thumbprint: "not-a-thumbprint",
    }),
    JSON.stringify({
      Status: "Valid",
      StatusMessage: "Signature verified.",
      Subject: "publisher",
      Thumbprint: "0".repeat(40),
      Unexpected: true,
    }),
  ])("rejects malformed Windows Authenticode diagnostics: %s", (content) => {
    expect(() => parseWindowsAuthenticodeInspection(content)).toThrow();
  });

  it("accepts an increasing prerelease pair", () => {
    expect(parsePackagedUpdateVersions("0.1.0-updater-e2e.1", "0.1.0-updater-e2e.2")).toEqual({
      from: "0.1.0-updater-e2e.1",
      to: "0.1.0-updater-e2e.2",
    });
  });

  it.each([
    ["0.1.0", "0.1.1-updater-e2e.1"],
    ["0.1.0-updater-e2e.2", "0.1.0-updater-e2e.1"],
    ["0.1.0-updater-e2e.01", "0.1.0-updater-e2e.2"],
    ["0.1.0-updater-e2e.1+local", "0.1.0-updater-e2e.2"],
  ])("rejects an unsafe update pair %s -> %s", (from, to) => {
    expect(() => parsePackagedUpdateVersions(from, to)).toThrow();
  });

  it("accepts a private provider flag without a packaged credential", () => {
    expect(() => assertPrivatePackagedUpdateConfiguration([
      "owner: sliverarmory",
      "repo: sliver-gui",
      "provider: github",
      "private: true",
      "channel: latest",
      "updaterCacheDirName: sliver-gui-updater",
      "",
    ].join("\n"), "github_pat_runtime_only")).not.toThrow();
  });

  it("requires the exact latest channel used by private GitHub metadata", () => {
    const content = [
      "owner: sliverarmory",
      "repo: sliver-gui",
      "provider: github",
      "private: true",
      "channel: beta",
      "updaterCacheDirName: sliver-gui-updater",
      "",
    ].join("\n");
    expect(() => assertPrivatePackagedUpdateConfiguration(content, "github_pat_runtime_only")).toThrow(
      /channel beta does not match latest/u,
    );
  });

  it.each([
    "token: github_pat_runtime_only",
    "authorization: Bearer github_pat_runtime_only",
    "requestHeaders: unsafe",
    "  accessToken: unsafe",
  ])("rejects packaged credentials: %s", (credentialLine) => {
    const content = [
      "owner: sliverarmory",
      "repo: sliver-gui",
      "provider: github",
      "private: true",
      "channel: latest",
      "updaterCacheDirName: sliver-gui-updater",
      credentialLine,
      "",
    ].join("\n");
    expect(() => assertPrivatePackagedUpdateConfiguration(content, "github_pat_runtime_only")).toThrow();
  });

  it.each([
    "host: attacker.example",
    "protocol: http",
    "provider: github",
    "<<: {host: attacker.example, protocol: http}",
  ])("rejects an unexpected or duplicate routing field: %s", (routingLine) => {
    const content = [
      "owner: sliverarmory",
      "repo: sliver-gui",
      "provider: github",
      "private: true",
      "channel: latest",
      "updaterCacheDirName: sliver-gui-updater",
      routingLine,
      "",
    ].join("\n");
    expect(() => assertPrivatePackagedUpdateConfiguration(content, "github_pat_runtime_only")).toThrow();
  });
});
