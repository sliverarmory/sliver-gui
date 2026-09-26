import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

const ARMORY_ASSEMBLY = Buffer.from("inert-armory-dotnet-assembly", "utf8");
const LOCAL_ASSEMBLY = Buffer.from("inert-local-dotnet-assembly", "utf8");

test(".NET executes installed and opened assemblies with exact CLI arguments and navigable history", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-dotnet-execution-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  const screenshotDirectory = join(repositoryRoot, "artifacts", "e2e");
  const localAssemblyPath = join(temporaryRoot, "local arguments.exe");
  const savedOutputPath = join(temporaryRoot, "dotnet-stdout.txt");
  await Promise.all([
    savedConfigDirectory, managedConfigDirectory, userDataDirectory, consoleClientRootDirectory, screenshotDirectory,
  ].map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(join(savedConfigDirectory, "dotnet-execution-e2e-operator.cfg"), fakeOperatorConfig(), { mode: 0o600 });
  await writeInstalledAssembly(consoleClientRootDirectory);
  await writeFile(localAssemblyPath, LOCAL_ASSEMBLY, { mode: 0o600 });

  let application: ElectronApplication | undefined;
  const rendererErrors: string[] = [];
  try {
    application = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${savedConfigDirectory}`,
        `--managed-config-directory=${managedConfigDirectory}`,
        `--user-data-directory=${userDataDirectory}`,
        `--console-client-root-directory=${consoleClientRootDirectory}`,
        "--registry-layout-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });

    const page = await openWindowsSession(application);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate((window) => window.setSize(1440, 950));
    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    assert.equal(await page.getByRole("radio", { name: "Payloads", exact: true }).count(), 0);
    assert.equal(await page.getByRole("radio", { name: "Remote", exact: true }).count(), 0);
    assert.equal(await page.getByRole("radio", { name: "Identity", exact: true }).count(), 0);
    await page.getByRole("radio", { name: ".NET", exact: true }).click();

    const workspace = page.getByRole("region", { name: ".NET assembly execution", exact: true });
    const history = workspace.getByRole("navigation", { name: ".NET execution history", exact: true });
    const form = workspace.getByRole("region", { name: "Execute a .NET assembly", exact: true });
    await form.waitFor();
    assert.equal(await history.getByRole("row").count(), 1);
    assert.equal(await history.getByRole("row", { name: "New Execution", exact: true }).count(), 1);
    await workspace.getByText("History · 0", { exact: true }).waitFor();
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "session-dotnet-new-execution.png") });
    await selectInstalledAssembly(page, form, "args-demo");
    await form.getByText("Deterministic .NET assembly arguments fixture", { exact: true }).waitFor();
    assert.equal(await form.getByText("1 assemblies for windows/amd64. Type to search or browse.", { exact: true }).count(), 0);
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "session-dotnet-selected-assembly.png") });
    await form.getByRole("textbox", { name: "Assembly arguments", exact: true })
      .fill('alpha "two words" --literal=\'x y\'');
    await executeAssembly(page, form);
    await assertAssemblyOutput(workspace);
    assert.equal(await page.getByText("Assembly execution completed.", { exact: true }).count(), 0);
    await history.getByRole("row", { name: /args-demo/iu }).waitFor();
    assert.equal(await history.getByRole("row").count(), 2);
    await workspace.getByText("History · 1", { exact: true }).waitFor();
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "session-dotnet-armory-output.png") });
    await application.evaluate(({ dialog }, outputPath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: outputPath })) as typeof dialog.showSaveDialog;
    }, savedOutputPath);
    await workspace.getByRole("region", { name: ".NET execution details", exact: true })
      .getByRole("button", { name: "Save stdout", exact: true }).click();
    await page.getByText("Output saved", { exact: true }).waitFor();
    assert.deepEqual(await readFile(savedOutputPath), Buffer.from("deterministic M4 assembly output\n"));
    assert.deepEqual(await assemblyCalls(application), [{
      targetMode: "session",
      targetId: "m1_session",
      assemblySha256: digest(ARMORY_ASSEMBLY),
      arguments: ["alpha", "two words", "--literal=x y"],
    }]);

    await history.getByRole("row", { name: "New Execution", exact: true }).click();
    await form.waitFor();
    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selectedPath] })) as typeof dialog.showOpenDialog;
    }, localAssemblyPath);
    await form.getByRole("button", { name: "Open assembly file", exact: true }).click();
    await form.getByRole("textbox", { name: "Assembly arguments", exact: true })
      .fill('--path "C:\\Program Files\\dotnet" "" --count=7');
    await executeAssembly(page, form);
    await assertAssemblyOutput(workspace);
    assert.equal(await page.getByText("Assembly execution completed.", { exact: true }).count(), 0);
    await history.getByRole("row", { name: /local arguments\.exe/iu }).waitFor();
    assert.equal(await history.getByRole("row").count(), 3);
    await workspace.getByText("History · 2", { exact: true }).waitFor();
    const latestDetails = workspace.getByRole("region", { name: ".NET execution details", exact: true });
    assert.match(await latestDetails.innerText(), /local arguments\.exe/iu);
    assert.match(await latestDetails.innerText(), /--count=7/u);
    assert.deepEqual(await assemblyCalls(application), [
      {
        targetMode: "session",
        targetId: "m1_session",
        assemblySha256: digest(ARMORY_ASSEMBLY),
        arguments: ["alpha", "two words", "--literal=x y"],
      },
      {
        targetMode: "session",
        targetId: "m1_session",
        assemblySha256: digest(LOCAL_ASSEMBLY),
        arguments: ["--path", "C:\\Program Files\\dotnet", "", "--count=7"],
      },
    ]);

    // History belongs to the target, so leaving and reopening the .NET tab
    // must retain both runs without redispatching either assembly.
    await page.getByRole("radio", { name: "BOFs", exact: true }).click();
    await page.getByRole("radio", { name: ".NET", exact: true }).click();
    const reopenedWorkspace = page.getByRole("region", { name: ".NET assembly execution", exact: true });
    const reopenedHistory = reopenedWorkspace.getByRole("navigation", { name: ".NET execution history", exact: true });
    await reopenedHistory.getByRole("row", { name: /local arguments\.exe/iu }).waitFor();
    assert.equal(await reopenedHistory.getByRole("row").count(), 3);
    await reopenedHistory.getByRole("row", { name: /args-demo/iu }).click();
    const earlierDetails = reopenedWorkspace.getByRole("region", { name: ".NET execution details", exact: true });
    await earlierDetails.getByRole("heading", { name: /args-demo/iu }).waitFor();
    const earlierText = await earlierDetails.innerText();
    assert.match(earlierText, /alpha/u);
    assert.match(earlierText, /two words/u);
    assert.doesNotMatch(earlierText, /local arguments\.exe/iu);
    await assertCapturedOutput(reopenedWorkspace);
    assert.equal((await assemblyCalls(application)).length, 2);

    await reopenedWorkspace.getByRole("button", { name: "Clear history", exact: true }).click();
    await reopenedHistory.getByRole("row", { name: /args-demo/iu }).waitFor({ state: "detached" });
    await reopenedHistory.getByRole("row", { name: /local arguments\.exe/iu }).waitFor({ state: "detached" });
    assert.equal(await reopenedHistory.getByRole("row").count(), 1);
    await reopenedWorkspace.getByText("History · 0", { exact: true }).waitFor();
    await reopenedWorkspace.getByRole("region", { name: "Execute a .NET assembly", exact: true }).waitFor();
    assert.equal(await reopenedWorkspace.getByRole("region", { name: ".NET execution details", exact: true }).count(), 0);
    await page.getByRole("radio", { name: "BOFs", exact: true }).click();
    await page.getByRole("radio", { name: ".NET", exact: true }).click();
    const clearedHistory = page.getByRole("navigation", { name: ".NET execution history", exact: true });
    await page.getByRole("region", { name: ".NET assembly execution", exact: true }).getByText("History · 0", { exact: true }).waitFor();
    assert.equal(await clearedHistory.getByRole("row").count(), 1);
    assert.equal((await assemblyCalls(application)).length, 2);
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function openWindowsSession(application: ElectronApplication): Promise<Page> {
  const page = await application.firstWindow();
  page.setDefaultTimeout(20_000);
  const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
  await savedConfigurations.waitFor();
  const savedOption = savedConfigurations.getByRole("option", { name: /dotnet-execution-e2e-operator/iu });
  await savedOption.waitFor();
  if (await savedOption.getAttribute("aria-selected") !== "true") await savedOption.click();
  await savedConfigurations.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.locator('[aria-label="Sessions"]:visible').click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
  await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
  return page;
}

async function selectInstalledAssembly(page: Page, form: Locator, commandName: string): Promise<void> {
  await form.locator('[data-slot="autocomplete-trigger"]').click();
  const search = page.getByRole("searchbox", { name: "Search assemblies", exact: true });
  await search.fill(commandName);
  await page.getByRole("option", { name: new RegExp(commandName, "u") }).click();
}

async function executeAssembly(page: Page, form: Locator): Promise<void> {
  assert.equal(await form.getByRole("button", { name: "Review", exact: true }).count(), 0);
  await form.getByRole("button", { name: "Execute", exact: true }).click();
  assert.equal(await page.getByRole("alertdialog", { name: "Execute this reviewed action?", exact: true }).count(), 0);
}

async function assertAssemblyOutput(workspace: Locator): Promise<void> {
  const details = workspace.getByRole("region", { name: ".NET execution details", exact: true });
  await details.waitFor();
  await details.getByRole("button", { name: "Save stdout", exact: true }).waitFor();
  assert.equal(await details.getByText("Source", { exact: true }).count(), 0);
  assert.equal(await details.getByText("Request", { exact: true }).count(), 0);
  assert.equal(await details.getByText("Assembly execution completed.", { exact: true }).count(), 0);
  await assertCapturedOutput(workspace);
}

async function assertCapturedOutput(workspace: Locator): Promise<void> {
  const output = workspace.getByRole("region", { name: ".NET execution output", exact: true });
  await output.getByLabel("Execution output transcript").waitFor();
  assert.match(await output.getByLabel("Execution output transcript").textContent() ?? "",
    /deterministic M4 assembly output/u);
}

async function assemblyCalls(application: ElectronApplication): Promise<Array<{
  targetMode: "session" | "beacon";
  targetId: string;
  assemblySha256: string;
  arguments: string[];
}>> {
  return application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.assemblyCalls.map((call) => ({
    targetMode: call.targetMode,
    targetId: call.targetId,
    assemblySha256: call.assemblySha256,
    arguments: call.options?.arguments ?? [],
  })));
}

async function writeInstalledAssembly(root: string): Promise<void> {
  const directory = join(root, "aliases", "args-demo");
  await mkdir(join(directory, "dist", "windows", "amd64"), { recursive: true });
  await writeFile(join(directory, "dist", "windows", "amd64", "args-demo.exe"), ARMORY_ASSEMBLY);
  await writeFile(join(directory, "alias.json"), JSON.stringify({
    name: "Argument Demo",
    command_name: "args-demo",
    version: "1.0.0",
    help: "Deterministic .NET assembly arguments fixture",
    is_assembly: true,
    files: [{ os: "windows", arch: "amd64", path: "/dist/windows/amd64/args-demo.exe" }],
  }));
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "dotnet-execution-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_DOTNET_CA_DO_NOT_RENDER",
    certificate: "FAKE_DOTNET_CERT_DO_NOT_RENDER",
    private_key: "FAKE_DOTNET_KEY_DO_NOT_RENDER",
    token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  });
}
