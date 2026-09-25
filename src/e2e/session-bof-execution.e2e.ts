import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import { assertExecutionOutputLayout } from "./execution-layout-assertions.js";

test("session and beacon BOFs render Armory arguments, dispatch packed invocations, and capture output", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-bof-execution-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  const screenshotDirectory = join(repositoryRoot, "artifacts", "e2e");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
    mkdir(screenshotDirectory, { recursive: true }),
  ]);
  await writeFile(join(savedConfigDirectory, "bof-execution-e2e-operator.cfg"), fakeOperatorConfig(), { mode: 0o600 });
  await Promise.all([
    writeBofFixture(consoleClientRootDirectory, "sa-dir", "dir", "inert-sa-dir-bof-object", [
      { name: "targetdir", type: "string", desc: "Directory to list", optional: true, default: "." },
      { name: "subdirs", type: "short", desc: "Include subdirectories", optional: true, default: 0 },
    ]),
    writeBofFixture(consoleClientRootDirectory, "sa-nslookup", "nslookup", "inert-sa-nslookup-bof-object", [
      { name: "hostname", type: "string", desc: "Hostname to query", optional: false },
      { name: "server", type: "string", desc: "DNS server", optional: true },
      { name: "type", type: "short", desc: "Record type", optional: true, default: 1 },
    ]),
  ]);

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
        "--bof-execution-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });

    const page = await application.firstWindow();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate((window) => window.setSize(1440, 950));

    const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
    await savedConfigurations.waitFor();
    const savedOption = savedConfigurations.getByRole("option", { name: /bof-execution-e2e-operator/iu });
    await savedOption.waitFor();
    if (await savedOption.getAttribute("aria-selected") !== "true") await savedOption.click();
    await savedConfigurations.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Sessions"]:visible').click();
    await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
    await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
    await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    await page.getByRole("radio", { name: "BOFs", exact: true }).click();

    const workspace = page.getByRole("region", { name: "BOF execution history and output" });
    const history = workspace.getByRole("navigation", { name: "BOF execution history" });
    const form = workspace.getByRole("region", { name: "Execute an Armory BOF" });
    await form.waitFor();
    assert.equal(await history.getByRole("row").count(), 1);
    assert.equal(await workspace.getByRole("row", { name: "New Execution", exact: true }).count(), 1);

    await selectInstalledBof(page, form, "sa-dir");
    assert.equal(await form.getByRole("textbox", { name: /targetdir/u }).inputValue(), ".");
    assert.equal(await form.getByRole("spinbutton", { name: /subdirs/u }).inputValue(), "0");
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "session-bof-new-execution.png") });
    await form.getByRole("textbox", { name: /targetdir/u }).fill("/tmp/BOF e2e");
    await form.getByRole("spinbutton", { name: /subdirs/u }).fill("2");
    await form.getByRole("button", { name: "Execute", exact: true }).click();
    await assertOutput(workspace, "deterministic sa-dir stdout");
    await assertExecutionOutputLayout(workspace, history, workspace.locator('[aria-label="Execution output terminal"]'), "BOF");
    assert.equal(await history.getByRole("row").count(), 2);
    assert.equal(await workspace.getByRole("button", { name: "Save stdout" }).count(), 1);
    assert.equal(await workspace.getByRole("button", { name: "Add stdout to Loot" }).count(), 1);
    await workspace.getByRole("button", { name: "Copy output" }).click();
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), "deterministic sa-dir stdout\n");
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "session-bof-dir-output.png") });

    await history.getByRole("row", { name: "New Execution", exact: true }).click();
    await form.waitFor();
    await selectInstalledBof(page, form, "sa-nslookup");
    assert.equal(await form.getByRole("textbox", { name: /hostname/u }).count(), 1);
    assert.equal(await form.getByRole("spinbutton", { name: /type/u }).inputValue(), "1");
    await form.getByRole("textbox", { name: /hostname/u }).fill("localhost");
    await form.getByRole("button", { name: "Execute", exact: true }).click();
    await assertOutput(workspace, "deterministic sa-nslookup stdout");
    await workspace.getByRole("radio", { name: "Stderr" }).click();
    await assertOutput(workspace, "deterministic sa-nslookup stderr");
    await workspace.getByRole("button", { name: "Copy output" }).click();
    assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), "deterministic sa-nslookup stderr\n");
    assert.equal(await history.getByRole("row").count(), 3);
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "session-bof-nslookup-output.png") });

    const calls = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.bofCalls);
    assert.deepEqual(calls, [
      {
        targetMode: "session", targetId: "m1_session",
        objectSha256: sha256Of("inert-sa-dir-bof-object"),
        objectHex: Buffer.from("inert-sa-dir-bof-object").toString("hex"),
        argumentsHex: packedArguments([stringArgument("/tmp/BOF e2e"), shortArgument(2)]).toString("hex"),
        entrypoint: "go", timeoutSeconds: 60,
      },
      {
        targetMode: "session", targetId: "m1_session",
        objectSha256: sha256Of("inert-sa-nslookup-bof-object"),
        objectHex: Buffer.from("inert-sa-nslookup-bof-object").toString("hex"),
        argumentsHex: packedArguments([stringArgument("localhost"), stringArgument(""), shortArgument(1)]).toString("hex"),
        entrypoint: "go", timeoutSeconds: 60,
      },
    ]);

    await page.locator('[aria-label="Beacons"]:visible').click();
    await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
    await page.getByRole("row", { name: /m1-beacon/iu }).click();
    await page.getByRole("heading", { name: "m1-beacon", exact: true }).waitFor();
    await page.getByRole("button", { name: "Show advanced execution", exact: true }).click();
    await page.getByRole("heading", { name: "Execution workbench", exact: true }).waitFor();
    await page.getByRole("radio", { name: "BOFs", exact: true }).click();
    const beaconWorkspace = page.getByRole("region", { name: "BOF execution history and output" });
    const beaconForm = beaconWorkspace.getByRole("region", { name: "Execute an Armory BOF" });
    assert.equal(await beaconWorkspace.getByRole("navigation", { name: "BOF execution history" }).getByRole("row").count(), 1);
    await selectInstalledBof(page, beaconForm, "sa-dir");
    await beaconForm.getByRole("textbox", { name: /targetdir/u }).fill("/tmp/beacon-BOF");
    await beaconForm.getByRole("button", { name: "Execute", exact: true }).click();
    await beaconWorkspace.getByRole("button", { name: "Refresh result" }).waitFor();
    await waitForFakeBofTaskCompletion(application);
    await assertOutput(beaconWorkspace, "deterministic sa-dir stdout");
    const beaconCalls = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.bofCalls);
    assert.deepEqual(beaconCalls.at(-1), {
      targetMode: "beacon", targetId: "m1_beacon",
      objectSha256: sha256Of("inert-sa-dir-bof-object"),
      objectHex: Buffer.from("inert-sa-dir-bof-object").toString("hex"),
      argumentsHex: packedArguments([stringArgument("/tmp/beacon-BOF"), shortArgument(0)]).toString("hex"),
      entrypoint: "go", timeoutSeconds: 60,
    });
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Windows session BOFs dispatch a legacy installed COFF loader", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-legacy-bof-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
  ]);
  await writeFile(join(savedConfigDirectory, "legacy-bof-e2e-operator.cfg"), fakeOperatorConfig(), { mode: 0o600 });
  await writeLegacyBofFixtures(consoleClientRootDirectory);

  let application: ElectronApplication | undefined;
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
        "--bof-execution-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const page = await application.firstWindow();
    page.setDefaultTimeout(20_000);
    const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
    await savedConfigurations.waitFor();
    const savedOption = savedConfigurations.getByRole("option", { name: /legacy-bof-e2e-operator/iu });
    await savedOption.waitFor();
    if (await savedOption.getAttribute("aria-selected") !== "true") await savedOption.click();
    await savedConfigurations.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Sessions"]:visible').click();
    await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
    await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    await page.getByRole("radio", { name: "BOFs", exact: true }).click();

    const workspace = page.getByRole("region", { name: "BOF execution history and output" });
    const form = workspace.getByRole("region", { name: "Execute an Armory BOF" });
    await selectInstalledBof(page, form, "legacy-probe");
    await form.getByRole("textbox", { name: /marker/u }).fill("legacy-e2e");
    await form.getByRole("button", { name: "Execute", exact: true }).click();
    await assertOutput(workspace, "deterministic legacy BOF stdout");

    const object = Buffer.from("inert-legacy-bof-object");
    const inner = packedArguments([stringArgument("legacy-e2e")]);
    const expectedEnvelope = packedArguments([stringArgument("go"), dataArgument(object), dataArgument(inner)]);
    assert.deepEqual(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.legacyBofCalls), [
      {
        phase: "register", targetMode: "session", targetId: "m1_session",
        loaderHex: Buffer.from("inert-coff-loader").toString("hex"),
        init: "", os: "windows", timeoutSeconds: 60,
      },
      {
        phase: "call", targetMode: "session", targetId: "m1_session",
        loaderHex: Buffer.from("inert-coff-loader").toString("hex"),
        argumentsHex: expectedEnvelope.toString("hex"), exportName: "LoadAndRun", timeoutSeconds: 60,
      },
    ]);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function selectInstalledBof(page: Page, form: Locator, commandName: string): Promise<void> {
  await form.locator('[data-slot="autocomplete-trigger"]').click();
  const search = page.getByRole("searchbox", { name: "Search installed BOFs", exact: true });
  await search.fill(commandName);
  await page.getByRole("option", { name: new RegExp(commandName, "u") }).click();
}

async function assertOutput(workspace: Locator, text: string): Promise<void> {
  const transcript = workspace.getByLabel("Execution output transcript");
  try {
    await transcript.waitFor({ timeout: 10_000 });
  } catch {
    throw new Error(`BOF output transcript did not appear. Workspace: ${(await workspace.innerText()).slice(0, 2_000)}`);
  }
  assert.match(await transcript.textContent() ?? "", new RegExp(text, "u"));
  await workspace.locator('[aria-label="Execution output terminal"] canvas').waitFor();
}

async function waitForFakeBofTaskCompletion(application: ElectronApplication): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const complete = await application.evaluate(() =>
      globalThis.__SLIVER_GUI_E2E_STATE__.tasks.some((task) =>
        task.beaconId === "m1_beacon" && task.description === "CallExtensionReq" && task.state === "completed"));
    if (complete) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Fake CallExtensionReq task for m1_beacon did not complete");
}

async function writeBofFixture(root: string, name: string, objectName: string, marker: string, args: readonly object[]): Promise<void> {
  const directory = join(root, "extensions", name);
  const artifact = `dist/darwin/arm64/${objectName}.o`;
  await mkdir(join(directory, "dist", "darwin", "arm64"), { recursive: true });
  await writeFile(join(directory, artifact), marker);
  await writeFile(join(directory, "extension.json"), JSON.stringify({
    name,
    package_name: name,
    version: "1.0.0",
    commands: [{
      command_name: name,
      help: `E2E ${name} manifest fixture`,
      entrypoint: "go",
      bof_executor: "reflektor",
      files: [{ os: "darwin", arch: "arm64", path: `/${artifact}` }],
      arguments: args,
    }],
  }));
}

async function writeLegacyBofFixtures(root: string): Promise<void> {
  const extensions = join(root, "extensions");
  const loader = join(extensions, "coff-loader");
  const bof = join(extensions, "legacy-probe");
  await Promise.all([mkdir(loader, { recursive: true }), mkdir(join(bof, "dist", "windows", "amd64"), { recursive: true })]);
  await Promise.all([
    writeFile(join(loader, "COFFLoader.x64.dll"), "inert-coff-loader"),
    writeFile(join(loader, "extension.json"), JSON.stringify({
      name: "coff-loader", command_name: "coff-loader", help: "E2E COFF loader",
      entrypoint: "LoadAndRun", files: [{ os: "windows", arch: "amd64", path: "/COFFLoader.x64.dll" }],
    })),
    writeFile(join(bof, "dist", "windows", "amd64", "probe.o"), "inert-legacy-bof-object"),
    writeFile(join(bof, "extension.json"), JSON.stringify({
      name: "legacy-probe", command_name: "legacy-probe", help: "E2E legacy BOF",
      entrypoint: "go", depends_on: "coff-loader", bof_executor: "coff-loader",
      files: [{ os: "windows", arch: "amd64", path: "/dist/windows/amd64/probe.o" }],
      arguments: [{ name: "marker", type: "string", desc: "E2E marker", optional: false }],
    })),
  ]);
}

function packedArguments(argumentsBytes: readonly Buffer[]): Buffer {
  const body = Buffer.concat(argumentsBytes);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}

function stringArgument(value: string): Buffer {
  const data = Buffer.from(`${value}\0`, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([length, data]);
}

function dataArgument(data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([length, data]);
}

function shortArgument(value: number): Buffer {
  const data = Buffer.alloc(2);
  data.writeInt16LE(value);
  return data;
}

function sha256Of(value: string): string {
  // The adapter must name BOF data by SHA-256, as Sliver's console does.
  return createHash("sha256").update(value).digest("hex");
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "bof-execution-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_BOF_CA_DO_NOT_RENDER",
    certificate: "FAKE_BOF_CERT_DO_NOT_RENDER",
    private_key: "FAKE_BOF_KEY_DO_NOT_RENDER",
    token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  });
}
