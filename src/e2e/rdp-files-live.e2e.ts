import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { readBoundedRegularFile } from "../main/secure-file.js";
import type { RdpFileTransferProgressEvent, RdpWindowAPI, RdpWindowState } from "../shared/rdp-contracts.js";
import { parseRdpConnect, rdpRecord, rdpString } from "../shared/rdp-validation.js";

const configFile = process.env["SLIVER_RDP_E2E_CONFIG_FILE"];
const sshHost = process.env["SLIVER_RDP_E2E_SSH_HOST"];
const transparent = process.env["SLIVER_RDP_E2E_TRANSPARENT"] === "1";
const execute = promisify(execFile);
interface FileEvidence { readonly name: string; readonly size: number; readonly sha256: string }

/** Explicit opt-in: the SSH alias and private configuration must name the same disposable Windows VM. */
test("RDP files paste in Windows Explorer and return through the native clipboard with progress", {
  skip: !configFile || !sshHost, timeout: 300_000,
}, async (context) => {
  if (!/^[a-z0-9][a-z0-9_.-]*$/iu.test(sshHost!)) throw new Error("Live file test requires an SSH host alias");
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const bytes = (await readBoundedRegularFile(configFile!, { label: "RDP live test configuration", maxBytes: 32_768, requirePrivateMode: true })).data;
  const raw = rdpRecord(JSON.parse(bytes.toString("utf8"))); bytes.fill(0);
  const config = parseRdpConnect(raw);
  const fingerprint = rdpString(raw["fingerprint"], 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(fingerprint) || config.password === undefined || !config.clipboard) {
    throw new Error("Live RDP file test requires an exact certificate fingerprint, password, and clipboard enabled");
  }
  const artifactPrefix = process.env["SLIVER_RDP_FILES_E2E_ARTIFACT_PREFIX"] ?? "rdp-files-live";
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/iu.test(artifactPrefix)) throw new Error("Invalid live file test artifact prefix");
  const runId = randomUUID();
  const remoteRoot = `C:\\Windows\\Temp\\sliver-rdp-files-${runId}`;
  const remoteFolder = `${remoteRoot}\\paste-${runId}`;
  const remoteScript = `${remoteRoot}\\clipboard.ps1`;
  const remoteTasks = [`sliver-rdp-files-${runId}-open`, `sliver-rdp-files-${runId}-copy`];
  const temporary = await mkdtemp(join(tmpdir(), "sliver-rdp-files-e2e-"));
  const artifacts = join(repositoryRoot, "artifacts", "e2e");
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let remoteCreated = false;
  const errors: string[] = [];
  let savedClipboard = false;
  let restoringClipboard: Promise<void> | undefined;
  let receivedPaths: string[] = [];
  let result: string | undefined;
  let primaryFailure = false;
  const restoreClipboard = (): Promise<void> => {
    if (!application || !savedClipboard) return Promise.resolve();
    return restoringClipboard ??= application.evaluate(async ({ clipboard }) => {
      const target = globalThis as unknown as { __rdpFilesPreviousClipboard?: Electron.ClipboardItem[] };
      if (target.__rdpFilesPreviousClipboard?.length) await clipboard.write(target.__rdpFilesPreviousClipboard);
      else await clipboard.clear();
      delete target.__rdpFilesPreviousClipboard;
    }).then(() => { savedClipboard = false; }).catch((error: unknown) => { restoringClipboard = undefined; throw error; });
  };
  const stopClipboardSync = async (): Promise<void> => {
    if (!application) return;
    try {
      if (page && !page.isClosed()) await page.evaluate(async () => {
        const api = (globalThis as unknown as { rdp: RdpWindowAPI }).rdp;
        const current = await api.getState();
        if (!current.ok) throw new Error("Unable to read RDP state before restoring clipboard");
        for (const tab of current.value.tabs) if (tab.state === "active") {
          const disconnected = await api.disconnect(tab.id);
          if (!disconnected.ok) throw new Error("Unable to disconnect RDP before restoring clipboard");
        }
      });
    } catch {
      // A hidden native window cannot synchronize its clipboard, even if its renderer stopped responding.
      await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    }
  };
  try {
    await Promise.all(["saved", "managed", "user-data", "client", "fixtures"].map((name) => mkdir(join(temporary, name))));
    await mkdir(artifacts, { recursive: true });
    await rm(join(artifacts, `${artifactPrefix}-result.json`), { force: true });
    await writeFile(join(temporary, "client", "armories.json"), "[]", { mode: 0o600 });
    const binary = Buffer.alloc(8 * 1024 * 1024);
    for (let index = 0; index < binary.length; index++) binary[index] = (index * 31 + (index >>> 8) + (index >>> 16)) & 255;
    const fixtures = [
      { name: "binary-8m.bin", contents: binary },
      { name: "clipboard-café-日本語.txt", contents: Buffer.from("RDP file clipboard — café Ω 日本語\r\n", "utf8") },
      { name: "empty.txt", contents: Buffer.alloc(0) },
    ];
    const expected: FileEvidence[] = fixtures.map(({ name, contents }) => ({ name, size: contents.length, sha256: hash(contents) }));
    await Promise.all(fixtures.map(({ name, contents }) => writeFile(join(temporary, "fixtures", name), contents, { mode: 0o600 })));
    const script = interactiveScript(remoteRoot, remoteFolder);
    remoteCreated = true;
    await remote(`New-Item -ItemType Directory -Path ${ps(remoteFolder)} -Force | Out-Null
[IO.File]::WriteAllText(${ps(remoteScript)}, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine())), (New-Object Text.UTF8Encoding($true)))`, `${Buffer.from(script, "utf8").toString("base64")}\n`);
    application = await electron.launch({
      args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"), `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporary, "saved")}`, `--managed-config-directory=${join(temporary, "managed")}`,
        `--user-data-directory=${join(temporary, "user-data")}`, `--console-client-root-directory=${join(temporary, "client")}`],
      cwd: repositoryRoot, timeout: 30_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => {
      void Promise.race([stopClipboardSync().then(restoreClipboard).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2_000))])
        .finally(() => { ownedProcess.kill("SIGKILL"); });
    }, { once: true });
    // Materialize every format now; a deferred native clipboard item can change after another app writes it.
    await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      const items = await clipboard.read();
      const snapshot = await Promise.all(items.map(async (item) => new ClipboardItem(Object.fromEntries(
        await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
      ))));
      (globalThis as unknown as { __rdpFilesPreviousClipboard: Electron.ClipboardItem[] }).__rdpFilesPreviousClipboard = snapshot;
    });
    savedClipboard = true;
    const workspace = await application.firstWindow();
    await workspace.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Cancel", exact: true }).click();
    const opened = application.waitForEvent("window");
    await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("rdp.open");
      if (!item?.click) throw new Error("RDP File menu is missing");
      item.click();
    });
    page = await opened;
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" || /Content Security Policy/iu.test(message.text())) errors.push(message.text()); });
    await page.getByRole("heading", { name: "Remote Desktop", exact: true }).waitFor();
    const window = await application.browserWindow(page);
    const focusWindow = async (): Promise<void> => {
      await application!.evaluate(({ app }) => { app.focus({ steal: true }); });
      await window.evaluate((win) => { win.show(); win.focus(); });
      const focus = await window.evaluate((win) => ({ focused: win.isFocused(), visible: win.isVisible(), minimized: win.isMinimized(), focusable: win.isFocusable() }));
      if (!focus.focused) process.stderr.write(`${JSON.stringify({ phase: "awaiting-native-window-focus", electronPid: ownedProcess.pid, ...focus })}\n`);
      await until(async () => window.evaluate((win) => win.isFocused()), "RDP window focus", 60_000);
    };
    await focusWindow();
    assert.deepEqual(await window.evaluate((win) => {
      const preferences = win.webContents.getLastWebPreferences();
      return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
    }), { sandbox: true, contextIsolation: true, nodeIntegration: false });
    await page.getByRole("button", { name: "New connection", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "New Remote Desktop" });
    await dialog.getByLabel("Connection name", { exact: true }).fill(config.label);
    await dialog.getByLabel("Computer", { exact: true }).fill(config.host);
    await dialog.getByLabel("Port", { exact: true }).fill(String(config.port));
    await dialog.getByLabel("Username", { exact: true }).fill(config.username);
    await dialog.getByLabel("Domain", { exact: true }).fill(config.domain);
    await dialog.getByRole("button", { name: "Desktop resolution", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Custom", exact: true }).click();
    assert.equal(await dialog.getByRole("button", { name: "Desktop resolution", exact: true }).getAttribute("data-selected-value"), "custom");
    await dialog.getByLabel("Desktop width", { exact: true }).fill(String(config.width));
    await dialog.getByLabel("Desktop height", { exact: true }).fill(String(config.height));
    const clipboardSwitch = dialog.getByRole("switch", { name: "Clipboard", exact: true });
    if (!await clipboardSwitch.isChecked()) await clipboardSwitch.press("Space");
    // Keep the password out of Playwright action logs and assertion output.
    await dialog.getByLabel("Password", { exact: true }).evaluate((element, password) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, password);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, config.password);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await until(async () => (await state(page!)).tabs.some((tab) => Boolean(tab.review)), "certificate review", 30_000);
    assert.equal((await state(page)).tabs[0]?.review?.fingerprint, fingerprint, "The endpoint certificate must match the explicitly configured fingerprint");
    await page.getByRole("button", { name: "Trust once", exact: true }).click();
    await until(async () => (await state(page!)).tabs[0]?.state === "active", "active connection", 30_000);
    await until(async () => Number(await page!.locator(".rdp-screen").getAttribute("data-frame-count")) > 0, "desktop frame");
    await until(async () => (await state(page!)).tabs[0]?.clipboardReady === true && (await state(page!)).tabs[0]?.clipboardFilesSupported === true, "file clipboard negotiation", 30_000);
    await page.evaluate(() => {
      const target = globalThis as unknown as { rdp: RdpWindowAPI; __rdpFileProgress: RdpFileTransferProgressEvent[]; __rdpFileToastHistory: string[] };
      const browser = globalThis as unknown as {
        document: { body: unknown; querySelectorAll(selector: string): Iterable<{ textContent: string | null }> };
        MutationObserver: new (callback: () => void) => { observe(element: unknown, options: Record<string, unknown>): void };
      };
      target.__rdpFileProgress = [];
      target.__rdpFileToastHistory = [];
      target.rdp.onFileTransferProgress((event) => target.__rdpFileProgress.push(event));
      const observer = new browser.MutationObserver(() => {
        for (const toast of browser.document.querySelectorAll(".toast:has(.rdp-transfer-toast)")) {
          const text = toast.textContent ?? "";
          if (!target.__rdpFileToastHistory.includes(text)) target.__rdpFileToastHistory.push(text);
        }
      });
      observer.observe(browser.document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-valuenow"] });
    });
    const focusInput = async (): Promise<void> => {
      await focusWindow();
      await page!.getByLabel(`Keyboard input for ${config.label}`, { exact: true }).focus();
      await page!.locator('.rdp-screen[data-input-capture="captured"]').waitFor();
    };
    const launchScript = async (action: "open" | "copy"): Promise<void> => {
      const taskName = remoteTasks[action === "open" ? 0 : 1]!;
      const principalName = config.domain ? `${config.domain}\\${config.username}` : config.username;
      const argumentsText = `-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "${remoteScript}" -Action ${action}`;
      const expectedSession = Number(await remote(`$sessions = @(& quser.exe ${ps(config.username)} 2>$null)
$active = @($sessions | ForEach-Object { if ($_ -match '^\\s*>?\\s*\\S+\\s+\\S+\\s+(\\d+)\\s+Active\\s+') { [int]$matches[1] } })
if ($active.Count -ne 1) { throw 'The configured test account must have exactly one active RDP desktop' }
$principal = New-ScheduledTaskPrincipal -UserId ${ps(principalName)} -LogonType Interactive -RunLevel Limited
$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument (${ps(argumentsText)} + ' -ExpectedSession ' + $active[0])
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 7)
Register-ScheduledTask -TaskName ${ps(taskName)} -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName ${ps(taskName)}
$active[0]`));
      assert.ok(Number.isSafeInteger(expectedSession) && expectedSession > 0, "Interactive test setup requires an active RDP session");
      let status: { ready?: boolean; error?: string; started?: { sessionId: number; pid: number } | null; scriptExists?: boolean; processes?: unknown } = {};
      try {
        await until(async () => {
          status = JSON.parse(await remote(`$errorFile = ${ps(`${remoteRoot}\\${action}-error`)}
$startedFile = ${ps(`${remoteRoot}\\${action}-started`)}
@{ ready=(Test-Path -LiteralPath ${ps(`${remoteRoot}\\${action}-ready`)}); started=$(if (Test-Path -LiteralPath $startedFile) { Get-Content -LiteralPath $startedFile -Raw | ConvertFrom-Json } else { $null }); scriptExists=(Test-Path -LiteralPath ${ps(remoteScript)}); error=$(if (Test-Path -LiteralPath $errorFile) { [IO.File]::ReadAllText($errorFile) } else { '' }) } | ConvertTo-Json -Compress`));
          return status.ready === true || Boolean(status.error);
        }, `interactive ${action} script`, 30_000);
        if (status.error) throw new Error(`Interactive ${action} script failed: ${status.error.slice(0, 500)}`);
        assert.equal(status.started?.sessionId, expectedSession, "Clipboard setup must run inside the connected interactive RDP session");
      } catch (error) {
        status.processes = JSON.parse(await remote(`@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${remoteRoot}*' } | Select-Object ProcessId, SessionId, Name) | ConvertTo-Json -Compress`).catch(() => "[]") || "[]");
        process.stderr.write(`${JSON.stringify({ phase: "interactive-script-diagnostic", action, ...status, scriptPath: remoteScript, expectedSession })}\n`);
        throw error;
      }
    };
    await launchScript("open");
    process.stderr.write(`${JSON.stringify({ phase: "explorer-ready", remoteRoot })}\n`);
    await application.evaluate(async ({ clipboard, ClipboardItem }, urls) => {
      await clipboard.write([new ClipboardItem({ "text/uri-list": new Blob([`${urls.join("\r\n")}\r\n`]) })]);
    }, fixtures.map(({ name }) => pathToFileURL(join(temporary, "fixtures", name)).href));
    if (transparent) {
      await page.getByRole("button", { name: "Configuration", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "Configuration", exact: true });
      const automatic = settings.getByRole("switch", { name: "Transparent clipboard", exact: true });
      if (!await automatic.isChecked()) await automatic.press("Space");
      await settings.getByRole("button", { name: "Done", exact: true }).click();
      await focusWindow();
    }
    if (transparent) await page.waitForTimeout(1_000); // Allow the OS clipboard polling interval to offer the files.
    else await page.getByRole("button", { name: "Send clipboard", exact: true }).click();
    await focusInput();
    await page.keyboard.press("Control+v");
    let uploaded: FileEvidence[] = [];
    await until(async () => {
      const output = await remote(`$files = @(Get-ChildItem -LiteralPath ${ps(remoteFolder)} -File)
@($files | ForEach-Object { @{ name=$_.Name; size=$_.Length; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant() } }) | ConvertTo-Json -Compress`);
      uploaded = output ? JSON.parse(output) as FileEvidence[] : [];
      if (!Array.isArray(uploaded)) uploaded = [uploaded];
      return JSON.stringify(sorted(uploaded)) === JSON.stringify(sorted(expected));
    }, "Explorer paste and remote SHA-256 verification", 90_000);
    process.stderr.write(`${JSON.stringify({ phase: "upload-hashes-verified", files: uploaded.length })}\n`);
    await until(async () => (await state(page!)).tabs[0]?.fileTransfer?.direction === "send" && (await state(page!)).tabs[0]?.fileTransfer?.phase === "completed", "upload completion");
    await page.screenshot({ path: join(artifacts, `${artifactPrefix}-upload.png`) });

    await launchScript("copy");
    await until(async () => (await state(page!)).tabs[0]?.clipboardFilesAvailable === true, "remote file clipboard offer");
    if (!transparent) await page.getByRole("button", { name: "Receive clipboard", exact: true }).click();
    await until(async () => (await state(page!)).tabs[0]?.fileTransfer?.direction === "receive" && (await state(page!)).tabs[0]?.fileTransfer?.phase === "completed", "download completion", 90_000);
    receivedPaths = (await application.evaluate(async ({ clipboard }) => {
      const items = await clipboard.read();
      const lists = await Promise.all(items.filter((item) => item.types.includes("text/uri-list")).map(async (item) => (await item.getType("text/uri-list")).text()));
      return lists.flatMap((list) => list.split(/\r?\n/u).filter((line) => line !== "" && !line.startsWith("#")));
    })).map((url) => fileURLToPath(url));
    assert.equal(receivedPaths.length, expected.length, "The OS clipboard must contain each received file");
    const downloaded = await Promise.all(receivedPaths.map(async (path): Promise<FileEvidence> => {
      assert.ok(!path.startsWith(join(temporary, "fixtures")), "Receive must publish staged remote files, not the original local paths");
      const data = await readFile(path);
      return { name: basename(path), size: data.length, sha256: hash(data) };
    }));
    assert.deepEqual(sorted(downloaded), sorted(expected), "Files received through the native clipboard must match every original byte");
    process.stderr.write(`${JSON.stringify({ phase: "download-hashes-verified", files: downloaded.length })}\n`);
    await page.getByText("Files received", { exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, `${artifactPrefix}-received.png`) });
    const observed = await page.evaluate(() => {
      const target = globalThis as unknown as { __rdpFileProgress: RdpFileTransferProgressEvent[]; __rdpFileToastHistory: string[] };
      return { progress: target.__rdpFileProgress, toastHistory: target.__rdpFileToastHistory };
    });
    const totalBytes = expected.reduce((total, file) => total + file.size, 0);
    for (const direction of ["send", "receive"] as const) {
      const events = observed.progress.filter((event) => event.progress.direction === direction).map((event) => event.progress);
      assert.ok(events.some((progress) => progress.phase === "transferring" && progress.transferredBytes > 0 && progress.transferredBytes < totalBytes), `${direction} must report intermediate byte progress`);
      assert.ok(events.some((progress) => progress.phase === "completed" && progress.transferredBytes === totalBytes && progress.completedFiles === expected.length), `${direction} must report all completed files and bytes`);
      assert.ok(!events.some((progress) => progress.phase === "failed" || progress.phase === "canceled"), `${direction} must finish without transfer failure`);
    }
    assert.ok(observed.toastHistory.some((text) => text.includes("Sending files")), "An upload progress toast must render");
    assert.ok(observed.toastHistory.some((text) => text.includes("Receiving files")), "A download progress toast must render");
    assert.ok(observed.toastHistory.some((text) => text.includes("Files sent")), "The upload toast must show completion");
    assert.ok(observed.toastHistory.some((text) => text.includes("Files received")), "The download toast must show completion");
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await until(async () => (await state(page!)).tabs[0]?.state === "disconnected", "disconnect");
    const persisted = await readFile(join(temporary, "client", "gui", "rdp.json"), "utf8").catch(() => "");
    assert.ok(!persisted.includes(config.password) && !persisted.includes(remoteRoot), "Credentials and remote clipboard paths must not be persisted");
    assert.deepEqual(errors, []);
    const build = JSON.parse(await readFile(join(repositoryRoot, "native", "rdp", "bin", "provenance.json"), "utf8")) as {
      source: { commit: string }; buildIdentity: string; artifact: { sha256: string };
    };
    result = JSON.stringify({ host: config.host, port: config.port, fingerprint, mode: transparent ? "transparent" : "manual",
      ironRdpRevision: build.source.commit, helperSha256: build.artifact.sha256, buildIdentity: build.buildIdentity,
      clientPlatform: process.platform, clientArchitecture: process.arch, clientKernel: release(),
      electronVersion: await application.evaluate(() => process.versions.electron),
      fixtures: sorted(expected), remoteHashes: sorted(uploaded), receivedHashes: sorted(downloaded),
      filenameComparison: "Unicode NFC canonical equivalence", remoteFileNames: uploaded.map(({ name }) => name), receivedFileNames: downloaded.map(({ name }) => name),
      explorerPaste: true, nativeClipboardReceive: true, uploadProgress: true, downloadProgress: true,
      progress: observed.progress.map(({ progress }) => progress), toastHistory: observed.toastHistory,
      clipboardRestored: true, localStagingRemoved: true, remoteTestFilesRemoved: true,
      checkedAt: new Date().toISOString() }, null, 2);
  } catch (error) {
    primaryFailure = true;
    context.diagnostic(JSON.stringify({ phase: "rdp-files-live-failure", remoteRoot }));
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(artifacts, `${artifactPrefix}-failure.png`) }).catch(() => undefined);
      const snapshot = await state(page).catch(() => undefined);
      context.diagnostic(JSON.stringify({ tabs: snapshot?.tabs.map(({ state, error, fileTransfer }) => ({ state, error, fileTransfer })), errors }));
    }
    throw error;
  } finally {
    let cleanupError: unknown;
    if (application) {
      // Stop automatic clipboard synchronization before restoring unrelated user clipboard contents.
      await stopClipboardSync().then(restoreClipboard).catch((error: unknown) => { cleanupError = error; });
      await application.close().catch(() => { application?.process().kill("SIGKILL"); });
      if (receivedPaths.length) await until(async () => (await Promise.all(receivedPaths.map(async (path) => {
        try { await lstat(path); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
      }))).every(Boolean), "received staging cleanup after application shutdown").catch((error: unknown) => { cleanupError = error; });
    }
    if (remoteCreated) await remote(`if (Test-Path -LiteralPath ${ps(remoteRoot)}) {
  [IO.File]::WriteAllText(${ps(`${remoteRoot}\\cleanup`)}, 'cleanup')
  $deadline = (Get-Date).AddSeconds(10)
  while ((Test-Path -LiteralPath ${ps(`${remoteRoot}\\open-ready`)}) -and !(Test-Path -LiteralPath ${ps(`${remoteRoot}\\cleanup-done`)}) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
  $acknowledged = !(Test-Path -LiteralPath ${ps(`${remoteRoot}\\open-ready`)}) -or (Test-Path -LiteralPath ${ps(`${remoteRoot}\\cleanup-done`)})
  foreach ($name in @(${remoteTasks.map(ps).join(",")})) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($null -ne $task) {
      if ($acknowledged -or $name -eq ${ps(remoteTasks[1]!)}) { Stop-ScheduledTask -InputObject $task }
      Unregister-ScheduledTask -InputObject $task -Confirm:$false
    }
  }
  if (!$acknowledged) { throw 'Interactive Explorer cleanup was not acknowledged; unique test folder retained' }
  Remove-Item -LiteralPath ${ps(remoteRoot)} -Recurse -Force
}`).catch((error: unknown) => { cleanupError ??= error; context.diagnostic("Remote test directory cleanup failed; remove the unique sliver-rdp-files directory created by this run."); });
    await rm(temporary, { recursive: true, force: true }).catch((error: unknown) => { cleanupError ??= error; });
    if (cleanupError) {
      context.diagnostic(JSON.stringify({ phase: "rdp-files-live-cleanup-failure", remoteRoot,
        error: cleanupError instanceof Error ? cleanupError.message : "Unknown cleanup failure" }));
      if (!primaryFailure) throw cleanupError;
    } else {
      process.stderr.write(`${JSON.stringify({ phase: "cleanup-complete", remoteRoot })}\n`);
      if (result) await writeFile(join(artifacts, `${artifactPrefix}-result.json`), result);
    }
  }
});

function interactiveScript(root: string, folder: string): string {
  return `param([ValidateSet('open','copy')][string]$Action, [int]$ExpectedSession)
$ErrorActionPreference = 'Stop'
try {
  if ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne $ExpectedSession) { throw 'The helper was launched outside the intended interactive RDP session' }
  [IO.File]::WriteAllText((Join-Path ${ps(root)} ($Action + '-started')), (@{ sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId; pid=$PID } | ConvertTo-Json -Compress))
  Add-Type -AssemblyName System.Windows.Forms
  if ($Action -eq 'open') {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class RdpFileTestWindow { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command); [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window); }'
    $shell = New-Object -ComObject Shell.Application
    $shell.Open(${ps(folder)})
    $deadline = (Get-Date).AddSeconds(20)
    do {
      Start-Sleep -Milliseconds 200
      $window = @($shell.Windows()) | Where-Object { try { $_.Document.Folder.Self.Path -eq ${ps(folder)} } catch { $false } } | Select-Object -First 1
    } until ($null -ne $window -or (Get-Date) -gt $deadline)
    if ($null -eq $window) { throw 'The test Explorer window did not open' }
    $ownedHwnd = [IntPtr]$window.HWND
    [RdpFileTestWindow]::ShowWindow($ownedHwnd, 5) | Out-Null
    [RdpFileTestWindow]::SetForegroundWindow($ownedHwnd) | Out-Null
    Start-Sleep -Milliseconds 500
    if ([RdpFileTestWindow]::GetForegroundWindow() -ne $ownedHwnd) { throw 'The test Explorer window did not become foreground' }
  } else {
    $files = @(Get-ChildItem -LiteralPath ${ps(folder)} -File | Sort-Object Name)
    if ($files.Count -ne 3) { throw 'The test paste must contain exactly three files' }
    $paths = New-Object System.Collections.Specialized.StringCollection
    foreach ($file in $files) { [void]$paths.Add($file.FullName) }
    [Windows.Forms.Clipboard]::SetFileDropList($paths)
  }
  [IO.File]::WriteAllText((Join-Path ${ps(root)} ($Action + '-ready')), 'ready')
  if ($Action -eq 'open') {
    # Remain in the interactive desktop: SSH's session cannot close this Explorer window.
    $deadline = (Get-Date).AddMinutes(6)
    while (!(Test-Path -LiteralPath ${ps(`${root}\\cleanup`)}) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    $window.Quit()
    $closeDeadline = (Get-Date).AddSeconds(5)
    while ([RdpFileTestWindow]::IsWindow($ownedHwnd) -and (Get-Date) -lt $closeDeadline) { Start-Sleep -Milliseconds 100 }
    if ([RdpFileTestWindow]::IsWindow($ownedHwnd)) { throw 'The test Explorer window did not close' }
    if (Test-Path -LiteralPath ${ps(root)}) { [IO.File]::WriteAllText(${ps(`${root}\\cleanup-done`)}, 'done') }
  }
} catch {
  $failure = $_.Exception.Message
  if ($Action -eq 'open' -and $null -ne $window) { try { $window.Quit() } catch {} }
  [IO.File]::WriteAllText((Join-Path ${ps(root)} ($Action + '-error')), $failure)
  exit 1
}
`;
}
async function remote(script: string, input?: string): Promise<string> {
  const command = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); ${script}`;
  const result = execute("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", sshHost!,
    "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
  { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
  result.child.stdin?.end(input);
  try {
    const { stdout } = await result;
    return stdout.replace(/^\uFEFF/u, "").trim();
  } catch (error) {
    throw remoteError(error, "SSH command");
  }
}
function remoteError(error: unknown, operation: string): Error {
  const failure = error as { code?: string | number; stderr?: string };
  const summary = failure.stderr?.replace(/\s+/gu, " ").trim().slice(0, 500) ?? "No diagnostic output";
  return new Error(`RDP live ${operation} failed (${String(failure.code ?? "unknown")}): ${summary}`);
}
function ps(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function sorted(files: readonly FileEvidence[]): FileEvidence[] {
  // macOS may publish decomposed file names; compare canonical equivalence without renaming any fixture.
  return files.map(({ name, size, sha256 }) => ({ name: name.normalize("NFC"), size, sha256 }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
async function state(page: Page): Promise<RdpWindowState> {
  return page.evaluate(async () => {
    const result = await (globalThis as unknown as { rdp: RdpWindowAPI }).rdp.getState();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });
}
async function until(predicate: () => Promise<boolean>, label: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`RDP live file condition timed out: ${label}`);
}
