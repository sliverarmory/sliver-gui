import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { SliverClient, parseConfig, sliverpb, type clientpb } from "sliver-script";

import { adaptSliverClient, type SliverClientAdapter } from "../main/sliver-client-adapter.js";
import type { BofExecutionHistorySnapshot, BofExecutionRecord } from "../shared/bof-contracts.js";
import type { SliverDesktopAPI } from "../shared/contracts.js";

const DIRECT_ENABLED = process.env["SLIVER_GUI_BOF_EXISTING_BEACONS_E2E"] === "1";
const LEGACY_ENABLED = process.env["SLIVER_GUI_BOF_EXISTING_BEACON_LEGACY_E2E"] === "1";
const MINIMAL_LEGACY_ENABLED = process.env["SLIVER_GUI_BOF_EXISTING_BEACON_LEGACY_MINIMAL_E2E"] === "1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_FILE_BYTES = 16 * 1_024 * 1_024;
const POLL_MS = 3_000;
const MINIMAL_COMMAND = "legacy-bof-probe";
const MINIMAL_MARKER = "sliver-gui-legacy-bof-probe-ok";
const execFileAsync = promisify(execFile);
// Pinned protobuf/sliverpb/constants.go: append-only message numbers.
const MSG_REGISTER_EXTENSION_REQ = 90;
const MSG_CALL_EXTENSION_REQ = 91;

type Platform = "windows" | "linux";
type Mode = "direct" | "legacy" | "legacy-minimal";
interface Target { readonly id: string; readonly os: Platform; readonly beacon: clientpb.Beacon; }
interface Submitted { readonly target: Target; readonly taskId: string; readonly recordId: string; readonly objectHash: string; }

/**
 * This test touches only the exact IDs explicitly supplied by the operator.
 * It queues a read-only sa-dir(".", subdirs=0) and never prints, saves, copies,
 * screenshots, or adds the returned directory listing to Loot.
 */
test("production GUI runs direct sa-dir BOFs on explicitly selected Windows and Linux beacons", {
  skip: DIRECT_ENABLED ? false : "Set SLIVER_GUI_BOF_EXISTING_BEACONS_E2E=1 and the documented exact-target inputs to opt in",
  timeout: 2 * 60 * 60_000,
}, async () => {
  const targets = [
    { id: requiredId("SLIVER_GUI_BOF_E2E_WINDOWS_BEACON_ID"), os: "windows" as const },
    { id: requiredId("SLIVER_GUI_BOF_E2E_LINUX_BEACON_ID"), os: "linux" as const },
  ];
  assert.notEqual(targets[0]!.id, targets[1]!.id, "Probe target IDs must be distinct");
  await runProbe("direct", targets);
});

/** Legacy COFF-loader registration changes the selected beacon's in-memory extension registry. */
test("production GUI runs a separately opted-in legacy sa-dir BOF on one Windows beacon", {
  skip: LEGACY_ENABLED ? false : "Set SLIVER_GUI_BOF_EXISTING_BEACON_LEGACY_E2E=1 and the documented exact-target inputs to opt in",
  timeout: 2 * 60 * 60_000,
}, async () => {
  await runProbe("legacy", [{ id: requiredId("SLIVER_GUI_BOF_E2E_WINDOWS_BEACON_ID"), os: "windows" }]);
});

/** Compiles a fixed, no-argument BOF that only emits a marker through BeaconOutput. */
test("production GUI runs a separately opted-in minimal legacy BOF on one Windows beacon", {
  skip: MINIMAL_LEGACY_ENABLED ? false : "Set SLIVER_GUI_BOF_EXISTING_BEACON_LEGACY_MINIMAL_E2E=1 and the documented exact-target inputs to opt in",
  timeout: 2 * 60 * 60_000,
}, async () => {
  await runProbe("legacy-minimal", [{ id: requiredId("SLIVER_GUI_BOF_E2E_WINDOWS_BEACON_ID"), os: "windows" }]);
});

async function runProbe(mode: Mode, requested: readonly { id: string; os: Platform }[]): Promise<void> {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  await access(join(repositoryRoot, "dist", "main", "index.js"), constants.R_OK);
  const configPath = await regularFile("SLIVER_GUI_BOF_E2E_OPERATOR_CONFIG", 4 * 1_024 * 1_024);
  const armoryRoot = await regularDirectory("SLIVER_GUI_BOF_E2E_ARMORY_ROOT");
  const waitMs = waitBudget();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-bof-beacon-live-"));
  const home = join(temporaryRoot, "home");
  const clientRoot = join(temporaryRoot, "client");
  const userData = join(temporaryRoot, "user-data");
  const configDirectory = join(clientRoot, "configs");
  let client: SliverClient | undefined;
  let application: ElectronApplication | undefined;
  let failure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(configDirectory, { recursive: true, mode: 0o700 }),
      mkdir(userData, { recursive: true, mode: 0o700 }),
    ]);
    const configBytes = await readFile(configPath);
    try {
      const config = parseConfig(configBytes);
      if (config.wg) throw new Error("This probe requires an mTLS operator profile");
      client = new SliverClient(config);
      await writeFile(join(configDirectory, "isolated-bof-probe.cfg"), configBytes, { mode: 0o600 });
    } finally { configBytes.fill(0); }

    const { objectHashes } = mode === "legacy-minimal"
      ? await copyMinimalLegacyBof(repositoryRoot, clientRoot, temporaryRoot)
      : await copySaDir(armoryRoot, clientRoot, mode, requested);
    const loader = mode !== "direct" ? await copyCoffLoader(armoryRoot, clientRoot) : undefined;
    await client.connect();
    const inventory = (await client.getBeacons()).Beacons;
    const targets: Target[] = requested.map(({ id, os }) => {
      const beacon = inventory.find((candidate) => candidate.ID === id);
      assert.ok(beacon, `The exact ${os} beacon is unavailable in this operator profile`);
      assert.equal(beacon.OS.toLowerCase(), os, `The exact ${os} beacon has the wrong OS`);
      assert.equal(beacon.Arch.toLowerCase(), "amd64", `The exact ${os} beacon has the wrong architecture`);
      assert.match(beacon.Transport.toLowerCase(), /mtls/u, `The exact ${os} beacon is not on mTLS`);
      if (mode === "direct") {
        assert.ok((BigInt(beacon.Capabilities) & 1n) !== 0n, `The exact ${os} beacon lacks built-in BOF capability`);
      }
      return { id, os, beacon };
    });

    application = await launchApplication(repositoryRoot, home, clientRoot, userData);
    const page = await application.firstWindow();
    page.setDefaultTimeout(30_000);
    await connectOnlyCopiedProfile(page);

    const submitted: Submitted[] = [];
    for (const target of targets) {
      const priorTasks: ReadonlySet<string> | undefined = mode !== "direct"
        ? await beaconTaskIds(client, target.id) : undefined;
      const task = await queueBof(page, target, objectHashes.get(target.os)!,
        mode === "legacy-minimal" ? MINIMAL_COMMAND : "sa-dir");
      submitted.push(task);
      if (mode !== "direct") {
        assert.ok(priorTasks && loader);
        await waitForLegacyRegistration(client, target.id, priorTasks, loader.hash, Date.now() + waitMs);
      }
    }
    const deadline = Date.now() + waitMs;
    const taskClient = adaptSliverClient(client);
    for (const task of submitted) {
      const completed = await waitForCompletedTask(taskClient, task, deadline);
      assertCompletedOutput(completed, task, mode, loader);
      await inspectGuiOutput(page, task, deadline, mode === "legacy-minimal" ? MINIMAL_MARKER : undefined);
    }
  } catch (error) {
    failure = error;
  } finally {
    if (application) {
      try { await application.close(); }
      catch { cleanupFailures.push(new Error("Could not close the isolated BOF probe GUI")); }
    }
    if (client) {
      try { await client.disconnect(); }
      catch { cleanupFailures.push(new Error("Could not disconnect the BOF probe operator")); }
    }
    try { await rm(temporaryRoot, { recursive: true, force: true }); }
    catch { cleanupFailures.push(new Error("Could not remove the isolated BOF probe files")); }
  }
  if (failure !== undefined || cleanupFailures.length) {
    throw new AggregateError([...(failure === undefined ? [] : [failure]), ...cleanupFailures],
      "Live beacon BOF probe failed or exact cleanup was incomplete");
  }
}

async function queueBof(page: Page, target: Target, objectHash: string, commandName: string): Promise<Submitted> {
  await page.locator('[aria-label="Beacons"]:visible').click();
  await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Filter beacons", exact: true }).fill(target.id);
  const row = page.getByRole("grid", { name: "Sliver beacons", exact: true }).getByRole("row")
    .filter({ hasText: target.id });
  await row.waitFor();
  assert.equal(await row.count(), 1, "The exact target must have one visible beacon row");
  await row.getByRole("button", { name: `Interact with ${target.beacon.Name || target.beacon.Hostname || target.id}` }).click();
  await page.getByRole("heading", { name: target.beacon.Name || target.beacon.Hostname || target.id, exact: true }).waitFor();

  const composer = page.locator('[aria-labelledby="beacon-command-heading"]');
  await composer.locator('[data-slot="autocomplete-trigger"]').first().click();
  await page.getByRole("searchbox", { name: "Search beacon commands", exact: true }).fill("Execution");
  await page.getByRole("option", { name: /^Execution/iu }).click();
  await composer.getByRole("tablist", { name: "Execution type", exact: true })
    .getByRole("tab", { name: "BOFs", exact: true }).click();
  const form = composer.getByRole("region", { name: "Execute an Armory BOF", exact: true });
  await form.locator('[data-slot="autocomplete-trigger"]').click();
  await page.getByRole("searchbox", { name: "Search BOFs", exact: true }).fill(commandName);
  await page.getByRole("option", { name: new RegExp(`^${commandName}`, "u") }).click();
  if (commandName === "sa-dir") {
    await form.getByRole("textbox", { name: /targetdir/u }).fill(".");
    await form.getByRole("spinbutton", { name: /subdirs/u }).fill("0");
  }
  const before = await bofHistory(page);
  await composer.getByRole("button", { name: "Queue task", exact: true }).click();
  const deadline = Date.now() + 45_000;
  let record: BofExecutionRecord | undefined;
  while (!record && Date.now() < deadline) {
    const history = await bofHistory(page);
    record = history.records.find((candidate) => !before.records.some((prior) => prior.id === candidate.id) &&
      candidate.commandName === commandName && candidate.taskId);
    if (!record) await delay(250);
  }
  assert.ok(record?.taskId, "The GUI did not acknowledge an exact BOF task ID");
  return { target, taskId: record.taskId, recordId: record.id, objectHash };
}

async function waitForCompletedTask(client: SliverClientAdapter, submitted: Submitted, deadline: number): Promise<clientpb.BeaconTask> {
  while (Date.now() < deadline) {
    const task = await client.fetchBofBeaconTask(submitted.target.id, submitted.taskId, "CallExtensionReq", 20);
    let keep = false;
    try {
      const state = task.State.trim().toLowerCase();
      if (state === "completed") { keep = true; return task; }
      if (["failed", "cancelled", "canceled"].includes(state)) throw new Error("The exact BOF task failed on its beacon");
    } finally {
      if (!keep) { task.Request.fill(0); task.Response.fill(0); }
    }
    await delay(POLL_MS);
  }
  throw new Error("The exact BOF task did not complete before the configured deadline");
}

async function beaconTaskIds(client: SliverClient, beaconId: string): Promise<ReadonlySet<string>> {
  const inventory = await client.getBeaconTasks(beaconId, 20);
  try {
    assert.ok(inventory.Tasks.every((task) => task.BeaconID === beaconId), "Task inventory crossed beacon IDs");
    return new Set(inventory.Tasks.map((task) => task.ID));
  } finally {
    for (const task of inventory.Tasks) { task.Request.fill(0); task.Response.fill(0); }
  }
}

/** Inventory identifies the registration; the bounded BOF content fetch proves its result. */
async function waitForLegacyRegistration(
  client: SliverClient, beaconId: string, priorIds: ReadonlySet<string>, loaderHash: string, deadline: number,
): Promise<void> {
  while (Date.now() < deadline) {
    const inventory = await client.getBeaconTasks(beaconId, 20);
    let states: { id: string; state: string }[];
    try {
      assert.ok(inventory.Tasks.every((task) => task.BeaconID === beaconId), "Task inventory crossed beacon IDs");
      const matches = inventory.Tasks.filter((task) =>
        !priorIds.has(task.ID) && task.Description === "RegisterExtensionReq");
      states = matches.map((task) => ({ id: task.ID, state: task.State.trim().toLowerCase() }));
    } finally {
      for (const task of inventory.Tasks) { task.Request.fill(0); task.Response.fill(0); }
    }
    assert.ok(states.length <= 1, "Another loader registration made this probe ambiguous");
    if (states[0]?.state === "completed") {
      assert.ok(states[0].id, "The loader registration has no exact task ID");
      const task = await adaptSliverClient(client).fetchBofBeaconTask(beaconId, states[0].id,
        "RegisterExtensionReq", 20);
      try {
        assert.equal(task.State.trim().toLowerCase(), "completed", "The exact loader registration is not complete");
        const envelope = sliverpb.Envelope.decode(task.Request);
        try {
          assert.equal(envelope.Type, MSG_REGISTER_EXTENSION_REQ, "The loader registration has the wrong message type");
          const request = sliverpb.RegisterExtensionReq.decode(envelope.Data);
          try {
            assert.equal(request.Name, loaderHash, "The beacon registered a different loader");
            assert.equal(createHash("sha256").update(request.Data).digest("hex"), loaderHash,
              "The registered loader bytes differ from the installed loader");
          } finally { request.Data.fill(0); }
        } finally { envelope.Data.fill(0); }
        const response = sliverpb.RegisterExtension.decode(task.Response);
        assert.ok(response.Response, "The loader registration has no target response envelope");
        assert.ok(!response.Response.Err.trim(), "The beacon reported a loader registration error");
        assert.equal(response.Response.Async, false, "The loader registration is still an asynchronous acknowledgement");
      } finally { task.Request.fill(0); task.Response.fill(0); }
      return;
    }
    if (states[0] && ["failed", "cancelled", "canceled"].includes(states[0].state)) {
      throw new Error("The exact beacon loader registration failed");
    }
    await delay(POLL_MS);
  }
  throw new Error("The beacon loader registration did not complete before the configured deadline");
}

function assertCompletedOutput(task: clientpb.BeaconTask, submitted: Submitted, mode: Mode, loader?: LegacyLoader): void {
  try {
    assert.equal(task.Description, "CallExtensionReq", "The completed task is not a BOF call");
    const envelope = sliverpb.Envelope.decode(task.Request);
    try {
      assert.equal(envelope.Type, MSG_CALL_EXTENSION_REQ, "The task request has the wrong Sliver message type");
      assert.equal(envelope.UnknownMessageType, false);
      assert.ok(envelope.Data.length > 0, "The task request envelope is empty");
      const request = sliverpb.CallExtensionReq.decode(envelope.Data);
      try {
        // The server removes the nested target ID when storing the task. The
        // authoritative binding is the fetched task's exact BeaconID/TaskID.
        assert.equal(request.Request?.BeaconID, "");
        assert.equal(request.Request?.SessionID, "");
        assert.equal(request.Request?.Async, true);
        if (mode === "direct") {
          assert.equal(request.Export, "go");
          assert.equal(request.IsBOF, true);
          assert.equal(request.WantBOFOutputs, true);
          assert.equal(request.Name, submitted.objectHash);
          assert.equal(createHash("sha256").update(request.BOFData).digest("hex"), submitted.objectHash);
        } else {
          assert.ok(loader);
          assert.equal(request.IsBOF, false);
          assert.equal(request.WantBOFOutputs, false);
          assert.equal(request.BOFData.length, 0);
          assert.equal(request.Name, loader.hash);
          assert.equal(request.Export, loader.exportName);
          assert.equal(legacyBofObjectHash(request.Args, mode === "legacy-minimal"), submitted.objectHash,
            "The legacy loader received a different BOF object");
        }
      } finally { request.BOFData.fill(0); request.Args.fill(0); }
    } finally { envelope.Data.fill(0); }
    const response = sliverpb.CallExtension.decode(task.Response);
    try {
      assert.ok(response.Response, "The BOF result has no target response envelope");
      assert.ok(!response.Response.Err.trim(), "The beacon reported a BOF execution error");
      assert.equal(response.Response.Async, false, "The task response is still an asynchronous acknowledgement");
      assert.equal(response.Response.TaskID, "", "The task response contains another task ID");
      assert.equal(response.Response.BeaconID, "", "The task response contains another beacon ID");
      const bytes = response.BOFOutputs?.reduce((sum, item) => sum + item.Data.length, 0) ?? 0;
      assert.ok(bytes > 0 || response.Output.length > 0, "The BOF returned no output");
      if (mode === "legacy-minimal") {
        assert.ok(response.Output.includes(Buffer.from(MINIMAL_MARKER, "utf8")),
          "The minimal legacy BOF did not return its fixed marker");
      }
    } finally {
      response.Output.fill(0);
      for (const item of response.BOFOutputs ?? []) item.Data.fill(0);
    }
  } finally {
    task.Request.fill(0);
    task.Response.fill(0);
  }
}

/** Outer BOFArgsBuffer: length, then length-prefixed export, object, typed arguments. */
function legacyBofObjectHash(args: Uint8Array, requireNoArguments = false): string {
  const bytes = Buffer.from(args);
  try {
    if (bytes.length < 16 || bytes.readUInt32LE(0) !== bytes.length - 4) throw new Error("Invalid legacy BOF argument frame");
    let offset = 4;
    const parts: Buffer[] = [];
    for (let index = 0; index < 3; index += 1) {
      if (offset + 4 > bytes.length) throw new Error("Truncated legacy BOF argument frame");
      const length = bytes.readUInt32LE(offset);
      offset += 4;
      if (!length || length > bytes.length - offset) throw new Error("Invalid legacy BOF argument part");
      parts.push(bytes.subarray(offset, offset + length));
      offset += length;
    }
    if (offset !== bytes.length || parts[0]!.toString("utf8") !== "go\0") throw new Error("Invalid legacy BOF export");
    if (requireNoArguments && (parts[2]!.length !== 4 || parts[2]!.readUInt32LE(0) !== 0)) {
      throw new Error("The minimal legacy BOF received unexpected arguments");
    }
    return createHash("sha256").update(parts[1]!).digest("hex");
  } finally { bytes.fill(0); }
}

async function inspectGuiOutput(page: Page, submitted: Submitted, deadline: number, marker?: string): Promise<void> {
  await page.locator('[aria-label="Beacons"]:visible').click();
  await page.getByRole("searchbox", { name: "Filter beacons", exact: true }).fill(submitted.target.id);
  const row = page.getByRole("grid", { name: "Sliver beacons", exact: true }).getByRole("row")
    .filter({ hasText: submitted.target.id });
  await row.getByRole("button", { name: `Interact with ${submitted.target.beacon.Name || submitted.target.beacon.Hostname || submitted.target.id}` }).click();
  const queue = page.getByRole("grid", { name: "Beacon task queue", exact: true });
  const taskRow = queue.getByRole("row").filter({ hasText: submitted.taskId });
  while (Date.now() < deadline) {
    await page.getByRole("tab", { name: "Task queue", exact: true }).click();
    await page.getByRole("button", { name: "Refresh task queue", exact: true }).click();
    if (await taskRow.getByText("Completed", { exact: true }).count()) break;
    await delay(POLL_MS);
  }
  await taskRow.getByText("Completed", { exact: true }).waitFor({ timeout: 5_000 });
  await taskRow.click();
  const article = page.getByRole("tabpanel", { name: "Task output", exact: true })
    .getByRole("article", { name: `Task output ${submitted.taskId}`, exact: true });
  const terminal = article.getByRole("region", { name: "Beacon execution output", exact: true });
  await terminal.locator('[data-terminal-state="ready"]').waitFor({ timeout: 15_000 });
  const transcript = terminal.getByLabel("Execution output transcript", { exact: true });
  const output = await transcript.textContent() ?? "";
  assert.ok(output.length > 0, "The GUI did not render BOF output");
  if (marker) assert.ok(output.includes(marker), "The GUI did not render the minimal legacy BOF marker");
  await terminal.getByLabel("Execution output terminal", { exact: true }).locator("canvas").waitFor();
}

interface LegacyLoader { readonly hash: string; readonly exportName: string; }

async function copyMinimalLegacyBof(
  repositoryRoot: string, clientRoot: string, temporaryRoot: string,
): Promise<{ objectHashes: Map<Platform, string> }> {
  const buildDirectory = join(temporaryRoot, "fixture-build");
  await mkdir(buildDirectory, { mode: 0o700 });
  const objectPath = join(buildDirectory, "probe.o");
  const sourcePath = join(repositoryRoot, "src", "e2e", "fixtures", "legacy-bof-probe.c");
  try {
    await execFileAsync("x86_64-w64-mingw32-gcc", [
      "-c", "-Os", "-fno-stack-protector", "-fno-asynchronous-unwind-tables", "-fno-ident",
      "-frandom-seed=sliver-gui-legacy-bof-probe", "-o", objectPath, sourcePath,
    ], { timeout: 15_000, maxBuffer: 32_768 });
  } catch (error) {
    throw new Error("The fixed Windows BOF fixture could not be compiled with x86_64-w64-mingw32-gcc", { cause: error });
  }
  const object = await boundedRegularFile(objectPath, 1_000_000);
  const destination = join(clientRoot, "extensions", MINIMAL_COMMAND);
  try {
    assert.ok(object.length >= 20 && object.readUInt16LE(0) === 0x8664,
      "The compiled fixture is not an x64 COFF object");
    const hash = createHash("sha256").update(object).digest("hex");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const manifest = Buffer.from(JSON.stringify({
      name: "Legacy BOF probe", package_name: MINIMAL_COMMAND, version: "1",
      commands: [{
        command_name: MINIMAL_COMMAND,
        help: "Emit a fixed marker through BeaconOutput without reading files or network state.",
        bof_executor: "coff-loader", depends_on: "coff-loader", entrypoint: "go",
        files: [{ os: "windows", arch: "amd64", path: "probe.o" }], arguments: [],
      }],
    }), "utf8");
    try {
      await writeFile(join(destination, "extension.json"), manifest, { mode: 0o600 });
      await writeFile(join(destination, "probe.o"), object, { mode: 0o600 });
    } finally { manifest.fill(0); }
    return { objectHashes: new Map([["windows", hash]]) };
  } finally { object.fill(0); }
}

async function copySaDir(
  armoryRoot: string, clientRoot: string, mode: Exclude<Mode, "legacy-minimal">,
  targets: readonly { os: Platform }[],
): Promise<{ objectHashes: Map<Platform, string> }> {
  const source = join(armoryRoot, "sa-dir");
  const manifestBytes = await boundedRegularFile(join(source, "extension.json"), 1_000_000);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const commands = manifest["commands"];
  if (!Array.isArray(commands)) throw new Error("sa-dir has no Armory commands");
  const command = commands.find((candidate) => candidate?.["command_name"] === "sa-dir") as Record<string, unknown> | undefined;
  if (!command || command["bof_executor"] !== "reflektor" || command["entrypoint"] !== "go") {
    throw new Error("The installed sa-dir is not the expected direct BOF");
  }
  if (mode === "legacy") {
    assert.equal(command["depends_on"], "coff-loader", "sa-dir does not declare the legacy loader dependency");
    command["bof_executor"] = "coff-loader";
  }
  const files = command["files"];
  if (!Array.isArray(files)) throw new Error("sa-dir has no object inventory");
  const destination = join(clientRoot, "extensions", "sa-dir");
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const objectHashes = new Map<Platform, string>();
  for (const target of targets) {
    const selected = files.find((item) => item?.["os"] === target.os && item?.["arch"] === "amd64");
    const path = safeRelativePath(selected?.["path"]);
    const bytes = await boundedArtifact(source, path, MAX_FILE_BYTES);
    objectHashes.set(target.os, createHash("sha256").update(bytes).digest("hex"));
    await mkdir(join(destination, ...path.split("/").slice(0, -1)), { recursive: true, mode: 0o700 });
    await writeFile(join(destination, path), bytes, { mode: 0o600 });
    bytes.fill(0);
  }
  const copiedManifest = mode === "legacy" ? Buffer.from(JSON.stringify(manifest), "utf8") : manifestBytes;
  await writeFile(join(destination, "extension.json"), copiedManifest, { mode: 0o600 });
  if (mode === "legacy") copiedManifest.fill(0);
  manifestBytes.fill(0);
  return { objectHashes };
}

async function copyCoffLoader(armoryRoot: string, clientRoot: string): Promise<LegacyLoader> {
  const source = join(armoryRoot, "coff-loader");
  const manifestBytes = await boundedRegularFile(join(source, "extension.json"), 1_000_000);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  const files = manifest["files"];
  if (!Array.isArray(files) || manifest["command_name"] !== "coff-loader") throw new Error("coff-loader manifest is invalid");
  const selected = files.find((item) => item?.["os"] === "windows" && item?.["arch"] === "amd64");
  const path = safeRelativePath(selected?.["path"]);
  if (!path.toLowerCase().endsWith(".dll")) throw new Error("The legacy loader is not a Windows DLL");
  const exportName = manifest["entrypoint"];
  if (typeof exportName !== "string" || !exportName) throw new Error("The legacy loader has no entrypoint");
  const bytes = await boundedArtifact(source, path, MAX_FILE_BYTES);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const destination = join(clientRoot, "extensions", "coff-loader");
  await mkdir(join(destination, ...path.split("/").slice(0, -1)), { recursive: true, mode: 0o700 });
  await writeFile(join(destination, "extension.json"), manifestBytes, { mode: 0o600 });
  await writeFile(join(destination, path), bytes, { mode: 0o600 });
  bytes.fill(0);
  manifestBytes.fill(0);
  return { hash, exportName };
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("Armory artifact path is missing");
  const path = value.replace(/^\/+/, "");
  if (!path || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Armory artifact path is unsafe");
  }
  return path;
}

async function boundedArtifact(source: string, path: string, limit: number): Promise<Buffer> {
  const root = await realpath(source);
  const artifact = await realpath(join(source, path));
  const offset = relative(root, artifact);
  if (offset === ".." || offset.startsWith(`..${sep}`) || isAbsolute(offset)) throw new Error("Armory artifact escapes its package");
  return boundedRegularFile(artifact, limit);
}

async function boundedRegularFile(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) throw new Error("Invalid BOF probe input file");
  return readFile(path);
}

async function regularFile(name: string, limit: number): Promise<string> {
  const path = process.env[name]?.trim();
  if (!path || !isAbsolute(path)) throw new Error(`${name} must be an absolute regular file path`);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit || (info.mode & 0o077) !== 0) {
    throw new Error(`${name} must be a private (0600 or stricter), bounded regular file`);
  }
  return path;
}

async function regularDirectory(name: string): Promise<string> {
  const path = process.env[name]?.trim();
  if (!path || !isAbsolute(path)) throw new Error(`${name} must be an absolute regular directory path`);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${name} must be a regular directory`);
  return realpath(path);
}

function requiredId(name: string): string {
  const id = process.env[name]?.trim();
  if (!id || !UUID.test(id)) throw new Error(`${name} must name an exact UUID beacon ID`);
  return id;
}

function waitBudget(): number {
  const raw = process.env["SLIVER_GUI_BOF_E2E_MAX_WAIT_SECONDS"] ?? "900";
  if (!/^\d{2,4}$/u.test(raw)) throw new Error("SLIVER_GUI_BOF_E2E_MAX_WAIT_SECONDS must be an integer from 60 to 5400");
  const seconds = Number(raw);
  if (seconds < 60 || seconds > 5400) throw new Error("SLIVER_GUI_BOF_E2E_MAX_WAIT_SECONDS must be from 60 to 5400");
  return seconds * 1_000;
}

function isolatedEnvironment(home: string, clientRoot: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    typeof value === "string" && !name.startsWith("SLIVER_GUI_") &&
    !name.startsWith("SLIVER_CLIENT_") && name !== "SLIVER_ROOT_DIR"));
  return { ...inherited, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), SLIVER_CLIENT_ROOT_DIR: clientRoot };
}

async function launchApplication(repositoryRoot: string, home: string, clientRoot: string, userData: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["--enable-sandbox", repositoryRoot, `--user-data-dir=${userData}`],
    bypassCSP: false,
    chromiumSandbox: true,
    cwd: repositoryRoot,
    env: isolatedEnvironment(home, clientRoot),
  } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
}

async function connectOnlyCopiedProfile(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Saved configurations" });
  await dialog.waitFor();
  const listed = await invokeSliver(page, "listSavedConfigs");
  assert.equal(listed.ok, true, "The isolated operator profile could not be listed");
  assert.equal(listed.value?.length, 1, "The isolated client root must contain exactly one operator profile");
  assert.equal(listed.value[0]?.availability, "available", "The copied operator profile is unavailable");
  const options = dialog.getByRole("option");
  await options.first().waitFor();
  assert.equal(await options.count(), 1, "The isolated client root must contain exactly one operator profile");
  if ((await options.first().getAttribute("aria-selected")) !== "true") await options.first().click();
  await page.waitForFunction(() => (globalThis as unknown as { document: { querySelector: (selector: string) => unknown } }).document
    .querySelector('[role="dialog"] [role="option"][aria-selected="true"]') !== null);
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const mismatch = page.getByRole("dialog", { name: "Server version mismatch" });
  if (await mismatch.count()) await mismatch.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
}

async function bofHistory(page: Page): Promise<BofExecutionHistorySnapshot> {
  const result = await invokeSliver(page, "listBofExecutionHistory");
  assert.equal(result.ok, true, "The BOF execution history could not be loaded");
  assert.ok(result.value);
  return result.value;
}

type SliverMethod = keyof SliverDesktopAPI;
type SliverArgs<Method extends SliverMethod> = SliverDesktopAPI[Method] extends (...args: infer Args) => unknown ? Args : never;
type SliverResult<Method extends SliverMethod> = SliverDesktopAPI[Method] extends (...args: never[]) => infer Result ? Awaited<Result> : never;
async function invokeSliver<Method extends SliverMethod>(page: Page, method: Method, ...args: SliverArgs<Method>): Promise<SliverResult<Method>> {
  return page.evaluate(async ({ method: name, args: values }) => {
    const api = (globalThis as unknown as { sliver: Record<string, (...input: unknown[]) => Promise<unknown>> }).sliver;
    return api[name]!(...values);
  }, { method, args }) as Promise<SliverResult<Method>>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
