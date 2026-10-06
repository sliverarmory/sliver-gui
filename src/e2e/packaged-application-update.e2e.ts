import assert from "node:assert/strict";
import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import { parseApplicationUpdateState, type ApplicationUpdateState } from "../shared/application-update-contracts.js";
import { windowsPowerShellEnvironment } from "../shared/windows-powershell-environment.js";
import { redactDiagnosticText, stringifyRedactedDiagnostics } from "./diagnostic-redaction.js";
import {
  assertPrivatePackagedUpdateConfiguration,
  assertPublicPackagedUpdateConfiguration,
  attachCleanupFailure,
  boundedUpdateDiagnostic,
  cleanupOwnedApplication,
  observePromiseSettlement,
  packagedUpdateLaunchProfile,
  packagedUpdateApplicationEnvironment,
  packagedUpdateGithubToken,
  parsePackagedUpdateFeed,
  parsePackagedUpdateVersions,
  parseWindowsAuthenticodeInspection,
  type ObservedPromiseSettlement,
  type PackagedUpdateVersions,
  type PackagedUpdateFeed,
  windowsAuthenticodeInspectionCommand,
} from "./packaged-application-update-support.js";

const ENABLE_VARIABLE = "SLIVER_GUI_UPDATE_E2E";
const TEST_TIMEOUT_MS = 20 * 60 * 1_000;
const UPDATE_TIMEOUT_MS = 10 * 60 * 1_000;
const PLAYWRIGHT_CLOSE_SETTLE_TIMEOUT_MS = 30_000;
const APPLICATION_CLEANUP_SETTLE_TIMEOUT_MS = 5_000;
const APPLICATION_PROCESS_GRACEFUL_EXIT_TIMEOUT_MS = 5_000;
const APPLICATION_PROCESS_FORCE_EXIT_TIMEOUT_MS = 15_000;
const PROCESS_POLL_INTERVAL_MS = 250;
const COMMAND_OUTPUT_LIMIT = 64 * 1_024;
const FAILURE_DIAGNOSTIC_TIMEOUT_MS = 5_000;
const PROCESS_DIAGNOSTIC_LIMIT = 4_096;

const BROAD_APPLICATION_PROCESS_INVENTORY = {
  includeDescendants: true,
  includeHelpers: true,
} as const;

const enableValue = process.env[ENABLE_VARIABLE];
if (enableValue !== undefined && enableValue !== "" && enableValue !== "0" && enableValue !== "1") {
  throw new Error(`${ENABLE_VARIABLE} must be 1 to enable the native updater E2E or 0/unset to skip it`);
}
const ENABLED = enableValue === "1";

test("packaged application updates from N-1 to N through its configured GitHub feed", {
  skip: !ENABLED,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const input = await readInput(repositoryRoot);
  const diagnosticsDirectory = join(repositoryRoot, "artifacts", "e2e", "packaged-update");
  await rm(diagnosticsDirectory, { recursive: true, force: true });
  const temporaryRoot = await mkdtemp(join(input.runnerTemp, `sliver-gui-update-${process.platform}-`));
  const profileRoot = join(temporaryRoot, "profile");
  const installRoot = join(temporaryRoot, "installed");
  const redactions = [input.githubToken, input.baseArtifact, temporaryRoot, input.runnerTemp]
    .filter((value): value is string => typeof value === "string" && value !== "");
  const diagnostics: Record<string, unknown> = {
    platform: process.platform,
    architecture: process.arch,
    fromVersion: input.versions.from,
    toVersion: input.versions.to,
    feed: input.feed,
    phases: [],
  };
  await Promise.all([
    mkdir(diagnosticsDirectory, { recursive: true }),
    mkdir(profileRoot, { recursive: true }),
    mkdir(installRoot, { recursive: true }),
  ]);

  let firstApplication: ElectronApplication | undefined;
  let firstPage: Page | undefined;
  let secondApplication: ElectronApplication | undefined;
  let secondPage: Page | undefined;
  let forcedRelaunch: ProcessRecord | undefined;
  let testFailed = false;
  let testFailure: unknown;
  try {
    recordPhase(diagnostics, "installing-n-minus-one");
    const installation = await installBaseApplication(input, installRoot, temporaryRoot);
    diagnostics["initialExecutable"] = installation.executablePath;
    const initialTrust = await verifyPlatformTrust(installation.executablePath, input);
    diagnostics["initialSignature"] = initialTrust;

    recordPhase(diagnostics, "launching-n-minus-one");
    const firstLaunch = await launchApplication(
      installation.executablePath,
      profileRoot,
      input.githubToken,
      diagnostics,
      "nMinusOne",
    );
    firstApplication = firstLaunch.application;
    firstPage = firstLaunch.page;
    attachPageDiagnostics(firstPage, diagnostics);
    const initialState = await inspectApplication(firstApplication);
    assert.equal(initialState.isPackaged, true, "N-1 must be a packaged application");
    if (input.feed === "public") assert.equal(initialState.githubCredentialPresent, false, "public N-1 launch must be anonymous");
    assert.equal(initialState.version, input.versions.from, "installed application version must match N-1");
    await assertCanonicalPathEqual(
      initialState.userDataPath,
      firstLaunch.userDataDirectory,
      "N-1 user-data path",
    );
    if (process.platform === "linux") {
      assert.ok(initialState.appImagePath, "N-1 AppImage runtime must set APPIMAGE");
      assert.ok(
        samePath(initialState.appImagePath, installation.executablePath),
        "N-1 APPIMAGE must identify the installed AppImage",
      );
    }
    await assertPackagedUpdateConfig(initialState.resourcesPath, input);
    diagnostics["nMinusOne"] = initialState;

    const sentinelPath = join(initialState.userDataPath, "packaged-updater-e2e-sentinel.json");
    const sentinelContent = `${JSON.stringify({
      id: randomUUID(),
      from: input.versions.from,
      to: input.versions.to,
    })}\n`;
    await mkdir(dirname(sentinelPath), { recursive: true });
    await writeFile(sentinelPath, sentinelContent, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") {
      assert.equal((await stat(sentinelPath)).mode & 0o777, 0o600, "user-data sentinel must be private");
    }

    await closeSavedConfigSelector(firstPage);
    const preUpdateProcesses = new Set(
      (await applicationProcesses(installation.executablePath, installRoot)).map(({ pid }) => pid),
    );

    recordPhase(diagnostics, "checking-and-downloading");
    await triggerApplicationUpdateCheck(firstPage);
    await firstPage.getByText(`Update ${input.versions.to} ready`, { exact: true }).waitFor({
      timeout: UPDATE_TIMEOUT_MS,
    });
    const firstStates = await capturedUpdateStates(firstPage);
    assertUpdateTransition(firstStates, input.versions);
    diagnostics["nMinusOneUpdateStates"] = firstStates;
    await firstPage.screenshot({
      animations: "disabled",
      path: join(diagnosticsDirectory, `ready-${process.platform}-${process.arch}.png`),
    });

    recordPhase(diagnostics, "confirming-restart-dialog");
    await firstPage.getByRole("button", { name: "Restart", exact: true }).click();
    const restartDialog = firstPage.getByRole("alertdialog", { name: "Restart to apply the update?" });
    await restartDialog.waitFor();
    await restartDialog.getByText(/closes every Sliver Desktop window and all managed shells/u).waitFor();
    await restartDialog.getByRole("button", { name: "Later", exact: true }).click();
    await restartDialog.waitFor({ state: "hidden" });
    await firstPage.getByRole("button", { name: "Restart", exact: true }).click();
    await restartDialog.waitFor();
    await firstPage.screenshot({
      animations: "disabled",
      path: join(diagnosticsDirectory, `restart-confirmation-${process.platform}-${process.arch}.png`),
    });

    recordPhase(diagnostics, "installing-and-forced-relaunch");
    const oldApplicationClose = observePromiseSettlement(
      firstApplication.waitForEvent("close", { timeout: 0 }),
    );
    await restartDialog.getByRole("button", { name: "Restart and update", exact: true }).click();
    await waitForProcessIdToExit(
      initialState.pid,
      installation.executablePath,
      installRoot,
      30_000,
    );

    const updatedExecutable = await waitForUpdatedExecutable(installation, input.versions, UPDATE_TIMEOUT_MS);
    diagnostics["updatedExecutable"] = updatedExecutable;
    // Native updater relaunches do not preserve the controlled launch's
    // --user-data-dir argument. Verify that native process and executable here,
    // then terminate it; profile identity is asserted only after the second
    // controlled Playwright launch below.
    forcedRelaunch = await waitForForcedRelaunch({
      executablePath: updatedExecutable,
      installRoot,
      excludedPids: preUpdateProcesses,
      timeoutMs: UPDATE_TIMEOUT_MS,
    });
    diagnostics["forcedRelaunch"] = forcedRelaunch;
    await terminateExactApplicationProcess(forcedRelaunch, updatedExecutable, installRoot);
    await waitForNoApplicationProcesses(
      undefined,
      installRoot,
      30_000,
      BROAD_APPLICATION_PROCESS_INVENTORY,
    );
    forcedRelaunch = undefined;
    await requireObservedApplicationClose(oldApplicationClose, PLAYWRIGHT_CLOSE_SETTLE_TIMEOUT_MS);
    firstApplication = undefined;
    firstPage = undefined;

    const updatedTrust = await verifyPlatformTrust(updatedExecutable, input);
    diagnostics["updatedSignature"] = updatedTrust;
    assert.equal(
      updatedTrust.signerIdentity,
      initialTrust.signerIdentity,
      "N must retain the N-1 platform signing identity",
    );
    if (process.platform === "linux") {
      assert.equal(await pathExists(installation.executablePath), false, "N-1 AppImage must be removed after update");
      assert.equal((await stat(updatedExecutable)).mode & 0o777, 0o755, "updated AppImage must be mode 0755");
    }

    recordPhase(diagnostics, "launching-and-verifying-n");
    const secondLaunch = await launchApplication(updatedExecutable, profileRoot, input.githubToken, diagnostics, "n");
    secondApplication = secondLaunch.application;
    secondPage = secondLaunch.page;
    attachPageDiagnostics(secondPage, diagnostics);
    const updatedState = await inspectApplication(secondApplication);
    assert.equal(updatedState.isPackaged, true, "N must be a packaged application");
    if (input.feed === "public") assert.equal(updatedState.githubCredentialPresent, false, "public N launch must be anonymous");
    assert.equal(updatedState.version, input.versions.to, "restarted application version must match N");
    await assertCanonicalPathEqual(
      updatedState.userDataPath,
      secondLaunch.userDataDirectory,
      "N user-data path",
    );
    assert.equal(
      updatedState.userDataPath,
      initialState.userDataPath,
      "application user-data path must survive update",
    );
    assert.equal(await readFile(sentinelPath, "utf8"), sentinelContent, "user-data sentinel must survive update");
    if (process.platform === "linux") {
      assert.ok(updatedState.appImagePath, "N AppImage runtime must set APPIMAGE");
      assert.ok(
        samePath(updatedState.appImagePath, updatedExecutable),
        "N APPIMAGE must identify the updater-installed AppImage",
      );
    }
    await assertPackagedUpdateConfig(updatedState.resourcesPath, input);
    diagnostics["n"] = updatedState;

    await closeSavedConfigSelector(secondPage);
    await triggerApplicationUpdateCheck(secondPage);
    const upToDateName = `Up to date · ${input.versions.to}`;
    // The harness also replays older immutable releases with the original label.
    await secondPage.getByRole("button", {
      name: `${upToDateName}. Check again`,
      exact: true,
    }).or(secondPage.getByRole("button", {
      name: upToDateName,
      exact: true,
    })).waitFor({ timeout: UPDATE_TIMEOUT_MS });
    const secondStates = await capturedUpdateStates(secondPage);
    assertUpToDateTransition(secondStates, input.versions);
    diagnostics["nUpdateStates"] = secondStates;
    await secondPage.screenshot({
      animations: "disabled",
      path: join(diagnosticsDirectory, `up-to-date-${process.platform}-${process.arch}.png`),
    });

    recordPhase(diagnostics, "complete");
    await writeDiagnosticFile(diagnosticsDirectory, "success", diagnostics, redactions);
  } catch (error) {
    testFailed = true;
    testFailure = error;
    diagnostics["failure"] = errorMessage(error);
    diagnostics["processes"] = await boundedUpdateDiagnostic("process inventory", () => applicationProcesses(
      undefined, installRoot, BROAD_APPLICATION_PROCESS_INVENTORY,
    ), FAILURE_DIAGNOSTIC_TIMEOUT_MS);
    const diagnosticPage = secondPage ?? firstPage;
    const diagnosticApplication = secondApplication ?? firstApplication;
    const probes: Promise<void>[] = [];
    if (diagnosticApplication) probes.push((async () => {
      diagnostics["nativeWindows"] = await boundedUpdateDiagnostic("native window state", () =>
        diagnosticApplication.evaluate(({ app, BrowserWindow }) => ({
          hidden: process.platform === "darwin" ? app.isHidden() : null,
          focusedWindowId: BrowserWindow.getFocusedWindow()?.id ?? null,
          windows: BrowserWindow.getAllWindows().map((window) => ({
            id: window.id,
            visible: window.isVisible(),
            focused: window.isFocused(),
            minimized: window.isMinimized(),
            bounds: window.getBounds(),
            rendererDestroyed: window.webContents.isDestroyed(),
            rendererLoading: !window.webContents.isDestroyed() && window.webContents.isLoading(),
          })),
        })), FAILURE_DIAGNOSTIC_TIMEOUT_MS);
    })());
    if (diagnosticPage && !diagnosticPage.isClosed()) {
      probes.push((async () => {
        diagnostics["failureUpdateStates"] = await boundedUpdateDiagnostic("renderer update states", () =>
          capturedUpdateStates(diagnosticPage), FAILURE_DIAGNOSTIC_TIMEOUT_MS);
      })(), (async () => {
        diagnostics["rendererState"] = await boundedUpdateDiagnostic("renderer visibility", () =>
          diagnosticPage.evaluate(() => {
            const { document } = globalThis as unknown as {
              document: { visibilityState: string; readyState: string; hasFocus(): boolean };
            };
            return { visibility: document.visibilityState, focused: document.hasFocus(), readyState: document.readyState };
          }), FAILURE_DIAGNOSTIC_TIMEOUT_MS);
      })(), (async () => {
        diagnostics["body"] = await diagnosticPage.locator("body").innerText({
          timeout: FAILURE_DIAGNOSTIC_TIMEOUT_MS,
        }).catch(errorMessage);
      })(), (async () => {
        diagnostics["failureScreenshot"] = await diagnosticPage.screenshot({
          animations: "disabled",
          path: join(diagnosticsDirectory, `failure-${process.platform}-${process.arch}.png`),
          timeout: FAILURE_DIAGNOSTIC_TIMEOUT_MS,
        }).then(() => "captured", errorMessage);
      })());
    }
    await Promise.all(probes);
    await writeDiagnosticFile(diagnosticsDirectory, "failure", diagnostics, redactions).catch((diagnosticError) => {
      console.error("Failed to write packaged updater diagnostics", errorMessage(diagnosticError));
    });
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    // A native relaunch can inherit Playwright's transport descriptor. Stop it
    // before asking the original connection to close, including failure paths.
    if (forcedRelaunch) {
      await terminateExactApplicationProcess(forcedRelaunch, undefined, installRoot).catch((cleanupError) => {
        console.error("Failed to terminate the tracked updater relaunch", errorMessage(cleanupError));
      });
    }
    for (const [label, application] of [
      ["N", secondApplication],
      ["N-1", firstApplication],
    ] as const) {
      if (!application) continue;
      await cleanupOwnedApplication(application, label, APPLICATION_CLEANUP_SETTLE_TIMEOUT_MS).catch((cleanupError) => {
        cleanupFailures.push(cleanupError);
        console.error(`Failed to close the controlled ${label} application`, errorMessage(cleanupError));
      });
    }
    let processAbsenceProved = false;
    await terminateRemainingApplicationProcesses(installRoot).then(() => {
      processAbsenceProved = true;
    }).catch((cleanupError) => {
      cleanupFailures.push(cleanupError);
      console.error("Failed to terminate every packaged updater application process", errorMessage(cleanupError));
    });
    if (!processAbsenceProved) {
      console.error("Retaining the packaged updater temporary directory because process absence was not proved");
    } else {
      await rm(temporaryRoot, { recursive: true, force: true }).catch((cleanupError: NodeJS.ErrnoException) => {
        cleanupFailures.push(cleanupError);
        console.error("Failed to clean the packaged updater temporary directory", cleanupError.code ?? "unknown");
      });
    }
    if (cleanupFailures.length > 0) {
      const cleanupError = new AggregateError(cleanupFailures, "Packaged updater E2E cleanup failed");
      if (testFailed) attachCleanupFailure(testFailure, cleanupError);
      else throw cleanupError;
    }
  }
});

interface TestInput {
  readonly baseArtifact: string;
  readonly feed: PackagedUpdateFeed;
  readonly githubToken: string | undefined;
  readonly macSigningAuthority?: string;
  readonly macSigningSha256?: string;
  readonly runnerTemp: string;
  readonly versions: PackagedUpdateVersions;
  readonly windowsPublisher?: string;
  readonly windowsSigningThumbprint?: string;
}

interface Installation {
  readonly executablePath: string;
  readonly installRoot: string;
}

interface ApplicationState {
  readonly appImagePath: string | null;
  readonly executablePath: string;
  readonly isPackaged: boolean;
  readonly githubCredentialPresent: boolean;
  readonly pid: number;
  readonly resourcesPath: string;
  readonly userDataPath: string;
  readonly version: string;
}

interface ProcessRecord {
  readonly pid: number;
  readonly parentPid?: number;
  readonly executablePath?: string;
  readonly commandLine: string;
}

interface ApplicationProcessInventoryOptions {
  readonly includeDescendants?: boolean;
  readonly includeHelpers?: boolean;
}

interface ApplicationProcessCandidate extends ProcessRecord {
  readonly directlyOwned: boolean;
  readonly helper: boolean;
  readonly parentPid: number;
}

async function readInput(repositoryRoot: string): Promise<TestInput> {
  if (process.env["CI"] !== "true" || process.env["GITHUB_ACTIONS"] !== "true") {
    throw new Error(`${ENABLE_VARIABLE}=1 is restricted to the intended GitHub Actions updater E2E`);
  }
  if (process.env["GITHUB_REPOSITORY"] !== "sliverarmory/sliver-gui") {
    throw new Error(`${ENABLE_VARIABLE}=1 is restricted to the sliverarmory/sliver-gui GitHub repository`);
  }
  const runnerTempValue = requiredEnvironment("RUNNER_TEMP");
  if (!isAbsolute(runnerTempValue)) throw new Error("RUNNER_TEMP must be an absolute path");
  const runnerTemp = await realpath(runnerTempValue);
  const artifactValue = requiredEnvironment("SLIVER_GUI_UPDATE_E2E_BASE_ARTIFACT");
  if (!isAbsolute(artifactValue)) throw new Error("SLIVER_GUI_UPDATE_E2E_BASE_ARTIFACT must be an absolute path");
  const baseArtifact = await realpath(artifactValue);
  const artifactMetadata = await stat(baseArtifact);
  if (!artifactMetadata.isFile() || artifactMetadata.size === 0) {
    throw new Error("SLIVER_GUI_UPDATE_E2E_BASE_ARTIFACT must be a non-empty regular file");
  }
  if (isPathInside(baseArtifact, repositoryRoot)) {
    throw new Error("The N-1 artifact must be downloaded outside the source checkout");
  }

  const feed = parsePackagedUpdateFeed(process.env["SLIVER_GUI_UPDATE_E2E_FEED"]);
  const githubToken = packagedUpdateGithubToken(feed);
  const versions = parsePackagedUpdateVersions(
    requiredEnvironment("SLIVER_GUI_UPDATE_E2E_FROM_VERSION"),
    requiredEnvironment("SLIVER_GUI_UPDATE_E2E_TO_VERSION"),
    feed,
  );
  if (!basename(baseArtifact).includes(versions.from)) {
    throw new Error("The N-1 artifact filename must contain SLIVER_GUI_UPDATE_E2E_FROM_VERSION");
  }

  if (process.platform === "darwin") {
    if (!/\.dmg$/iu.test(baseArtifact)) throw new Error("macOS updater E2E requires an N-1 DMG");
    if (feed === "public") {
      const certificate = await pinnedPublicCertificate(repositoryRoot, "macos");
      const macSigningSha256 = createHash("sha256").update(certificate.raw).digest("hex");
      return { baseArtifact, feed, githubToken, macSigningSha256, runnerTemp, versions };
    }
    const macSigningAuthority = requiredEnvironment("SLIVER_GUI_UPDATE_E2E_MAC_SIGNING_AUTHORITY");
    if (!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/u.test(macSigningAuthority)) {
      throw new Error(
        "SLIVER_GUI_UPDATE_E2E_MAC_SIGNING_AUTHORITY must be the exact Developer ID Application authority",
      );
    }
    return { baseArtifact, feed, githubToken, macSigningAuthority, runnerTemp, versions };
  }
  if (process.platform === "win32") {
    if (!/-setup\.exe$/iu.test(baseArtifact)) {
      throw new Error("Windows updater E2E requires an N-1 NSIS Setup executable");
    }
    const windowsPublisher = requiredEnvironment("SLIVER_GUI_UPDATE_E2E_WINDOWS_PUBLISHER");
    if (!windowsPublisher.includes("=") || /[\r\n\0]/u.test(windowsPublisher)) {
      throw new Error("SLIVER_GUI_UPDATE_E2E_WINDOWS_PUBLISHER must be the exact Authenticode subject");
    }
    const windowsSigningThumbprint = feed === "public"
      ? createHash("sha1").update((await pinnedPublicCertificate(repositoryRoot, "windows")).raw).digest("hex").toUpperCase()
      : undefined;
    return {
      baseArtifact, feed, githubToken, runnerTemp, versions, windowsPublisher,
      ...(windowsSigningThumbprint ? { windowsSigningThumbprint } : {}),
    };
  }
  if (process.platform === "linux") {
    if (!/\.AppImage$/u.test(baseArtifact)) throw new Error("Linux updater E2E requires an N-1 AppImage");
    return { baseArtifact, feed, githubToken, runnerTemp, versions };
  }
  throw new Error(`Packaged updater E2E does not support ${process.platform}`);
}

async function pinnedPublicCertificate(repositoryRoot: string, platform: "macos" | "windows"): Promise<X509Certificate> {
  const directory = join(repositoryRoot, "build", "update-signing");
  const manifest: unknown = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  assert.ok(manifest && typeof manifest === "object" && "schemaVersion" in manifest && manifest.schemaVersion === 1);
  const entry = (manifest as Record<string, unknown>)[platform];
  assert.ok(entry && typeof entry === "object" && "sha256" in entry);
  assert.match(String(entry.sha256), /^[0-9a-f]{64}$/u);
  const certificate = new X509Certificate(await readFile(join(directory, `${platform}.cer`)));
  assert.equal(createHash("sha256").update(certificate.raw).digest("hex"), entry.sha256);
  return certificate;
}

async function installBaseApplication(
  input: TestInput,
  installRoot: string,
  temporaryRoot: string,
): Promise<Installation> {
  if (process.platform === "darwin") return installMacApplication(input.baseArtifact, installRoot, temporaryRoot);
  if (process.platform === "win32") return installWindowsApplication(input.baseArtifact, installRoot);
  return installLinuxApplication(input.baseArtifact, installRoot);
}

async function installMacApplication(
  dmgPath: string,
  installRoot: string,
  temporaryRoot: string,
): Promise<Installation> {
  const mountPoint = join(temporaryRoot, "mounted-dmg");
  await mkdir(mountPoint);
  await runCommand("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mountPoint, dmgPath], {
    timeoutMs: 120_000,
  });
  try {
    const applications = (await readdir(mountPoint, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    assert.equal(applications.length, 1, "N-1 DMG must contain exactly one application bundle");
    const source = join(mountPoint, applications[0]?.name ?? "");
    const destination = join(installRoot, applications[0]?.name ?? "");
    await runCommand("/usr/bin/ditto", [source, destination], { timeoutMs: 120_000 });
    const executablePath = join(destination, "Contents", "MacOS", "Sliver GUI");
    await access(executablePath, constants.X_OK);
    return { executablePath, installRoot };
  } finally {
    await runCommand("/usr/bin/hdiutil", ["detach", mountPoint], { timeoutMs: 60_000 }).catch(async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
      await runCommand("/usr/bin/hdiutil", ["detach", mountPoint], { timeoutMs: 60_000 });
    });
  }
}

async function installWindowsApplication(installerPath: string, installRoot: string): Promise<Installation> {
  await runCommand(installerPath, ["/S", `/D=${installRoot}`], { timeoutMs: 5 * 60_000 });
  const candidates = (await recursiveFiles(installRoot)).filter((path) =>
    /(?:^|[\\/])Sliver GUI\.exe$/iu.test(path) && !/uninstall/iu.test(path));
  assert.equal(candidates.length, 1, "N-1 NSIS installer must install exactly one Sliver GUI executable");
  const executablePath = await realpath(candidates[0] ?? "");
  await access(executablePath, constants.X_OK);
  return { executablePath, installRoot };
}

async function installLinuxApplication(appImagePath: string, installRoot: string): Promise<Installation> {
  const executablePath = join(installRoot, basename(appImagePath));
  await copyFile(appImagePath, executablePath, constants.COPYFILE_EXCL);
  await chmod(executablePath, 0o755);
  await access(executablePath, constants.X_OK);
  return { executablePath, installRoot };
}

interface PlatformTrust {
  readonly details: Readonly<Record<string, unknown>>;
  readonly signerIdentity: string;
}

async function verifyPlatformTrust(executablePath: string, input: TestInput): Promise<PlatformTrust> {
  if (process.platform === "darwin") {
    const applicationBundle = resolve(dirname(executablePath), "..", "..");
    assert.ok(basename(applicationBundle).endsWith(".app"), "macOS executable must be inside an application bundle");
    assert.ok(
      samePath(executablePath, join(applicationBundle, "Contents", "MacOS", "Sliver GUI")),
      "macOS executable must use the expected bundle layout",
    );
    await runCommand("/usr/bin/codesign", ["--verify", "--all-architectures", "--deep", "--strict", "--verbose=2", applicationBundle]);
    if (input.feed === "public") {
      assert.ok(input.macSigningSha256);
      const temporaryDirectory = await mkdtemp(join(input.runnerTemp, "sliver-update-certificates-"));
      try {
        for (const architecture of ["x86_64", "arm64"]) {
          const prefix = join(temporaryDirectory, `${architecture}-`);
          await runCommand("/usr/bin/codesign", ["--display", "--architecture", architecture, `--extract-certificates=${prefix}`, applicationBundle]);
          const fingerprint = createHash("sha256").update(await readFile(`${prefix}0`)).digest("hex");
          assert.equal(fingerprint, input.macSigningSha256, `macOS ${architecture} app must use the pinned public certificate`);
        }
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      return { signerIdentity: input.macSigningSha256, details: { sha256: input.macSigningSha256 } };
    }
    const details = await runCommand("/usr/bin/codesign", ["--display", "--verbose=4", applicationBundle]);
    const combined = `${details.stdout}\n${details.stderr}`;
    const authorities = [...combined.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1]?.trim()).filter(
      (authority): authority is string => Boolean(authority),
    );
    assert.ok(authorities.length > 0, "macOS application must expose a signing authority");
    assert.equal(
      authorities[0],
      input.macSigningAuthority,
      "macOS application must use the expected updater E2E signing authority",
    );
    return {
      signerIdentity: authorities[0] ?? "",
      details: { authorities },
    };
  }
  if (process.platform === "win32") {
    const inspection = windowsAuthenticodeInspectionCommand(executablePath);
    const result = await runCommand(inspection.executable, inspection.arguments);
    const signature = parseWindowsAuthenticodeInspection(result.stdout);
    assert.equal(
      signature.status,
      "Valid",
      `Windows application signature must be valid: ${signature.statusMessage}`,
    );
    assert.equal(signature.subject, input.windowsPublisher, "Windows application publisher must remain unchanged");
    if (input.feed === "public") {
      assert.equal(signature.thumbprint, input.windowsSigningThumbprint, "Windows application must use the pinned public certificate");
    }
    return {
      signerIdentity: `${signature.subject} (${signature.thumbprint})`,
      details: { ...signature },
    };
  }
  const metadata = await stat(executablePath);
  assert.equal(metadata.mode & 0o777, 0o755, "AppImage must be mode 0755");
  return {
    signerIdentity: "unsigned-linux-appimage",
    details: { mode: "0755", size: metadata.size },
  };
}

async function launchApplication(
  executablePath: string,
  profileRoot: string,
  githubToken: string | undefined,
  diagnostics: Record<string, unknown>,
  phase: "nMinusOne" | "n",
): Promise<{ application: ElectronApplication; page: Page; userDataDirectory: string }> {
  const environment = isolatedApplicationEnvironment(profileRoot, githubToken);
  const launchProfile = packagedUpdateLaunchProfile(profileRoot, process.platform);
  await mkdir(launchProfile.userDataDirectory, { recursive: true });
  const application = await electron.launch({
    executablePath,
    args: launchProfile.arguments,
    bypassCSP: false,
    chromiumSandbox: true,
    cwd: dirname(executablePath),
    env: environment,
    timeout: 120_000,
  } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
  const processDiagnostics = { stdout: "", stderr: "" };
  diagnostics[`${phase}ProcessOutput`] = processDiagnostics;
  for (const stream of ["stdout", "stderr"] as const) {
    application.process()[stream]?.on("data", (chunk: Buffer | string) => {
      processDiagnostics[stream] = `${processDiagnostics[stream]}${chunk.toString()}`.slice(-PROCESS_DIAGNOSTIC_LIMIT);
    });
  }
  try {
    const page = await application.firstWindow({ timeout: 120_000 });
    await beginUpdateStateCapture(page, diagnostics, phase);
    await page.emulateMedia({ reducedMotion: "reduce" });
    return { application, page, userDataDirectory: launchProfile.userDataDirectory };
  } catch (error) {
    await cleanupOwnedApplication(
      application,
      "partially launched",
      APPLICATION_CLEANUP_SETTLE_TIMEOUT_MS,
    ).catch((cleanupError) => {
      console.error("Failed to clean a partially launched application", errorMessage(cleanupError));
      attachCleanupFailure(error, cleanupError);
    });
    throw error;
  }
}

function isolatedApplicationEnvironment(profileRoot: string, githubToken: string | undefined): Record<string, string> {
  return packagedUpdateApplicationEnvironment(profileRoot, process.platform, githubToken);
}

async function inspectApplication(application: ElectronApplication): Promise<ApplicationState> {
  return application.evaluate(({ app }) => ({
    appImagePath: process.env["APPIMAGE"] ?? null,
    executablePath: process.execPath,
    isPackaged: app.isPackaged,
    githubCredentialPresent: Boolean(process.env["GH_TOKEN"] || process.env["GITHUB_TOKEN"]),
    pid: process.pid,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
    version: app.getVersion(),
  }));
}

async function assertPackagedUpdateConfig(resourcesPath: string, input: TestInput): Promise<void> {
  const configPath = join(resourcesPath, "app-update.yml");
  const content = await readFile(configPath, "utf8");
  if (input.feed === "public") assertPublicPackagedUpdateConfiguration(content);
  else assertPrivatePackagedUpdateConfiguration(content, input.githubToken ?? "");
}

async function closeSavedConfigSelector(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Saved configurations" });
  await dialog.waitFor({ timeout: 60_000 });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

async function beginUpdateStateCapture(
  page: Page,
  diagnostics: Record<string, unknown>,
  phase: "nMinusOne" | "n",
): Promise<void> {
  // Mirror bounded state history outside the renderer before any interaction.
  // It remains available even when renderer evaluation itself stops responding.
  const observedStates: unknown[] = [];
  diagnostics[`${phase}ObservedUpdateStates`] = observedStates;
  await page.exposeFunction("__SLIVER_GUI_UPDATE_E2E_DIAGNOSTIC_STATE__", (value: unknown) => {
    if (observedStates.length >= 128) observedStates.shift();
    try { observedStates.push(parseApplicationUpdateState(value)); }
    catch (error) { observedStates.push({ error: errorMessage(error) }); }
  });
  await page.waitForFunction(() => {
    const host = globalThis as unknown as {
      sliver?: {
        getApplicationUpdateState?: unknown;
        onApplicationUpdateChanged?: unknown;
      };
    };
    return typeof host.sliver?.getApplicationUpdateState === "function" &&
      typeof host.sliver.onApplicationUpdateChanged === "function";
  }, undefined, { timeout: 60_000 });
  await page.evaluate(async () => {
    const host = globalThis as unknown as {
      __SLIVER_GUI_UPDATE_E2E_STATES__?: unknown[];
      __SLIVER_GUI_UPDATE_E2E_DIAGNOSTIC_STATE__(value: unknown): Promise<void>;
      sliver: {
        getApplicationUpdateState(): Promise<unknown>;
        onApplicationUpdateChanged(listener: (state: unknown) => void): () => void;
      };
    };
    const states: unknown[] = [];
    host.__SLIVER_GUI_UPDATE_E2E_STATES__ = states;
    let highestRevision = -1;
    const recordState = (state: unknown): void => {
      states.push(state);
      void host.__SLIVER_GUI_UPDATE_E2E_DIAGNOSTIC_STATE__(state).catch(() => undefined);
    };
    const acceptState = (value: unknown): void => {
      const state = structuredClone(value);
      if (!state || typeof state !== "object" || !("revision" in state) ||
          !Number.isSafeInteger(state.revision) || (state.revision as number) < 0) {
        recordState(state);
        return;
      }
      const revision = state.revision as number;
      if (revision <= highestRevision) return;
      highestRevision = revision;
      recordState(state);
    };
    // Subscribe before reading the snapshot so a concurrent main-process event
    // cannot be overwritten by an older invoke result.
    host.sliver.onApplicationUpdateChanged(acceptState);
    acceptState(await host.sliver.getApplicationUpdateState());
  });
}

async function triggerApplicationUpdateCheck(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Check for updates", exact: true });
  if (await button.isVisible()) await button.click();
}

async function capturedUpdateStates(page: Page): Promise<ApplicationUpdateState[]> {
  const values = await page.evaluate(() => {
    const host = globalThis as unknown as { __SLIVER_GUI_UPDATE_E2E_STATES__?: unknown[] };
    return structuredClone(host.__SLIVER_GUI_UPDATE_E2E_STATES__ ?? []);
  });
  return values.map((value) => parseApplicationUpdateState(value));
}

function assertUpdateTransition(states: ApplicationUpdateState[], versions: PackagedUpdateVersions): void {
  assertMonotonicStatusSuffix(
    states,
    ["idle", "checking", "available", "downloading", "ready"],
    "N-1 update",
  );
  for (const state of states) {
    assert.equal(state.currentVersion, versions.from, "N-1 update state must retain the installed current version");
    if (state.status === "available" || state.status === "downloading" || state.status === "ready") {
      assert.equal(state.availableVersion, versions.to, "N-1 must discover only the intended N version");
    }
  }
}

function assertUpToDateTransition(
  states: ApplicationUpdateState[],
  versions: PackagedUpdateVersions,
): void {
  assertMonotonicStatusSuffix(states, ["idle", "checking", "up-to-date"], "N update");
  for (const state of states) {
    assert.equal(state.currentVersion, versions.to, "N update state must retain the installed current version");
  }
}

function assertMonotonicStatusSuffix(
  states: ApplicationUpdateState[],
  expectedOrder: readonly ApplicationUpdateState["status"][],
  label: string,
): void {
  assert.ok(states.length > 0, `${label} state history must not be empty`);
  const statuses = states.map(({ status }) => status);
  const ranks = statuses.map((status) => expectedOrder.indexOf(status));
  assert.ok(
    ranks.every((rank) => rank >= 0),
    `${label} state history contains an unexpected state: ${statuses.join(", ")}`,
  );
  assert.ok(
    ranks.every((rank, index) => index === 0 || rank >= (ranks[index - 1] ?? -1)),
    `${label} states must be monotonic: ${statuses.join(", ")}`,
  );
  const firstRank = ranks[0] ?? -1;
  const finalRank = expectedOrder.length - 1;
  assert.equal(ranks.at(-1), finalRank, `${label} must finish in ${expectedOrder[finalRank]}`);
  for (let rank = firstRank; rank <= finalRank; rank += 1) {
    assert.ok(ranks.includes(rank), `${label} did not observe ${expectedOrder[rank]} after attachment`);
  }
  for (let index = 1; index < states.length; index += 1) {
    assert.ok(
      states[index]!.revision > states[index - 1]!.revision,
      `${label} revisions must strictly increase`,
    );
  }
}

async function waitForUpdatedExecutable(
  installation: Installation,
  versions: PackagedUpdateVersions,
  timeoutMs: number,
): Promise<string> {
  if (process.platform !== "linux") {
    await pollUntil(async () => pathExists(installation.executablePath), timeoutMs, "updated executable to exist");
    return installation.executablePath;
  }
  return pollUntil(async () => {
    const candidates = (await readdir(installation.installRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".AppImage"))
      .map((entry) => join(installation.installRoot, entry.name));
    if (candidates.length !== 1) return undefined;
    const candidate = candidates[0];
    if (!candidate || !basename(candidate).includes(versions.to)) return undefined;
    await access(candidate, constants.X_OK);
    return realpath(candidate);
  }, timeoutMs, "updated AppImage to replace N-1");
}

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
  if (process.platform === "win32") {
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

  if (process.platform === "linux") {
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
  const entries = await readdir("/proc", { withFileTypes: true });
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
  if (process.platform === "win32") {
    await runCommand("taskkill.exe", ["/PID", String(current.pid), "/T"], { timeoutMs: 30_000 }).catch(() => undefined);
  } else {
    try {
      process.kill(current.pid, "SIGTERM");
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
    if (process.platform === "win32") {
      await runCommand("taskkill.exe", ["/PID", String(current.pid), "/T", "/F"], { timeoutMs: 30_000 });
    } else {
      process.kill(current.pid, "SIGKILL");
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
    if (processRecord.pid === process.pid) {
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
      if (process.platform === "win32") {
        await runCommand(
          "taskkill.exe",
          ["/PID", String(processRecord.pid), "/T", ...(force ? ["/F"] : [])],
          { timeoutMs: 30_000 },
        );
      } else {
        process.kill(processRecord.pid, force ? "SIGKILL" : "SIGTERM");
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

function attachPageDiagnostics(page: Page, diagnostics: Record<string, unknown>): void {
  const consoleMessages = diagnostics["consoleMessages"] ?? [];
  const pageErrors = diagnostics["pageErrors"] ?? [];
  assert.ok(Array.isArray(consoleMessages));
  assert.ok(Array.isArray(pageErrors));
  diagnostics["consoleMessages"] = consoleMessages;
  diagnostics["pageErrors"] = pageErrors;
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("pageerror", (error) => pageErrors.push(error.message));
}

function recordPhase(diagnostics: Record<string, unknown>, phase: string): void {
  const phases = diagnostics["phases"];
  assert.ok(Array.isArray(phases));
  phases.push({ phase, at: new Date().toISOString() });
}

async function writeDiagnosticFile(
  directory: string,
  outcome: "success" | "failure",
  diagnostics: Record<string, unknown>,
  redactions: string[],
): Promise<void> {
  const content = stringifyRedactedDiagnostics(diagnostics, redactions);
  await writeFile(join(directory, `${outcome}-${process.platform}-${process.arch}.json`), `${content}\n`, {
    mode: 0o600,
  });
}

interface CommandOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveCommand, rejectCommand) => {
    const environment = options.env ? { ...process.env, ...options.env } : process.env;
    const child = spawn(command, [...args], {
      env: process.platform === "win32" ? windowsPowerShellEnvironment(environment) : environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const append = (current: string, chunk: Buffer): string =>
      `${current}${chunk.toString("utf8")}`.slice(-COMMAND_OUTPUT_LIMIT);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs ?? 120_000);
    timeout.unref?.();
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectCommand(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        rejectCommand(new Error(`${basename(command)} timed out`));
        return;
      }
      if (code !== 0) {
        rejectCommand(new Error(
          `${basename(command)} exited with ${code ?? signal ?? "unknown"}: ${
            redactDiagnosticText(stderr || stdout, [], 4_096)
          }`,
        ));
        return;
      }
      resolveCommand({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function recursiveFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) result.push(path);
    }
  }
  return result;
}

async function pollUntil<T>(
  operation: () => Promise<T | undefined | false>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined && result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, PROCESS_POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${errorMessage(lastError)}` : ""}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() !== value || /[\r\n\0]/u.test(value)) {
    throw new Error(`${name} must be set to one safe non-empty line without surrounding whitespace`);
  }
  return value;
}

async function assertCanonicalPathEqual(path: string, expected: string, label: string): Promise<void> {
  const [canonicalPath, canonicalExpected] = await Promise.all([realpath(path), realpath(expected)]);
  if (!samePath(canonicalPath, canonicalExpected)) {
    throw new Error(`${label} must exactly match the controlled user-data directory`);
  }
}

async function requireObservedApplicationClose(
  observation: Promise<ObservedPromiseSettlement<unknown>>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for the controlled Playwright application connection to close"));
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    const outcome = await Promise.race([observation, timeoutResult]);
    if (outcome.status === "rejected") {
      throw new Error(`Controlled Playwright application close failed: ${errorMessage(outcome.reason)}`);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function isPathInside(path: string, parent: string): boolean {
  const candidate = process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
  const root = process.platform === "win32" ? parent.toLocaleLowerCase("en-US") : parent;
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
