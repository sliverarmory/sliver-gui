import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import { IPC_INVOKE, type SliverDesktopAPI, type SliverSnapshot } from "../shared/contracts.js";
import type { TargetOperationRecord } from "../shared/operation-contracts.js";
import type { TargetRef } from "../shared/target-contracts.js";

const PRIVATE_KEY_SECRET = "FAKE_PRIVATE_KEY_M0_DO_NOT_RENDER";
const TOKEN_SECRET = "FAKE_TOKEN_M0_DO_NOT_RENDER";
const EVENT_SECRET = "FAKE_EVENT_SECRET_M0_DO_NOT_RENDER";
const TARGET_SECRET = "FAKE_TARGET_SECRET_M1_DO_NOT_RENDER";
const TASK_SECRET = "FAKE_TASK_REQUEST_SECRET_M1_DO_NOT_RENDER";
const M2_ENV_SECRET = "FAKE_M2_ENV_SECRET_DO_NOT_RENDER";
const M2_FILE_CONTENT = "FAKE_M2_FILE_CONTENT_DO_NOT_JOURNAL";
const M2_INITIAL_FILE_TEXT = `${M2_FILE_CONTENT}\nsecond deterministic line\n`;
const M2_EDITED_CONTENT = "FAKE_M2_EDITED_CONTENT_DO_NOT_JOURNAL";
const M2_SEARCH_PATTERN = "FAKE_M2_SEARCH_PATTERN_DO_NOT_JOURNAL";

test("real renderer reaches an injected fake only through frozen preload and trusted IPC", { timeout: 90_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-electron-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const selectedConfigPath = join(temporaryRoot, "chosen-m0-operator.cfg");
  const artifactDirectory = join(repositoryRoot, "artifacts", "e2e");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ]);
  await writeFile(selectedConfigPath, fakeOperatorConfig(), { mode: 0o600 });

  let electronApplication: ElectronApplication | undefined;
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  try {
    electronApplication = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${savedConfigDirectory}`,
        `--managed-config-directory=${managedConfigDirectory}`,
        `--user-data-directory=${userDataDirectory}`,
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const page = await electronApplication.firstWindow();
    page.on("console", (message) => consoleMessages.push(message.text()));
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await assertRendererSecurity(electronApplication, page);
    await page.getByRole("dialog", { name: /connect to sliver/i }).waitFor();

    // Replace the native chooser from outside the app immediately before the
    // production renderer invokes it. No production switch or debug IPC is
    // needed for this deterministic selection.
    await electronApplication.evaluate(({ dialog }, configPath) => {
      dialog.showOpenDialog = async () => {
        globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls += 1;
        return { canceled: false, filePaths: [configPath] };
      };
    }, selectedConfigPath);
    await page.getByRole("button", { name: /choose.*file|connect (?:from |external )file/i }).click();

    await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Server build mismatch" }).count(), 0);
    await page.getByText("#41", { exact: true }).waitFor();
    await page.getByText("Seeded mTLS listener", { exact: true }).waitFor();

    const stateAfterConnect = await readFakeState(electronApplication);
    assert.equal(stateAfterConnect.configFactoryCalls, 1);
    assert.equal(stateAfterConnect.dialogCalls, 1);
    assert.deepEqual(stateAfterConnect.connectedConfig, {
      operator: "m0-e2e-operator",
      host: "127.0.0.1",
      port: 31337,
    });
    for (const method of ["connect", "getVersion", "jobs", "implantBuilds", "implantProfiles", "getCompiler"]) {
      assert.ok(stateAfterConnect.methods.includes(method), `expected ConnectionRegistry to call ${method}`);
    }

    await verifyM1TargetsAndOperations(electronApplication, page, artifactDirectory);

    await startAndStopMtlsListener(page);
    const stateAfterStop = await readFakeState(electronApplication);
    assert.ok(stateAfterStop.methods.includes("startMTLSListener"));
    assert.ok(stateAfterStop.methods.includes("killJob"));

    const snapshotText = await page.evaluate(async () => {
      const browserGlobal = globalThis as unknown as {
        sliver: { getSnapshot(): Promise<unknown> };
      };
      return JSON.stringify(await browserGlobal.sliver.getSnapshot());
    });
    const bodyText = await page.locator("body").innerText();
    const screenshot = await page.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, "current-slice.png"),
    });
    const observableText = [bodyText, snapshotText, ...consoleMessages].join("\n");
    for (const forbidden of [
      PRIVATE_KEY_SECRET,
      TOKEN_SECRET,
      EVENT_SECRET,
      TARGET_SECRET,
      TASK_SECRET,
      M2_ENV_SECRET,
      M2_FILE_CONTENT,
      M2_EDITED_CONTENT,
      M2_SEARCH_PATTERN,
      "/Users/e2e/workspace/notes.txt",
      selectedConfigPath,
    ]) {
      assert.ok(!observableText.includes(forbidden), `renderer-visible text exposed ${forbidden}`);
      assert.equal(screenshot.includes(Buffer.from(forbidden)), false, `screenshot bytes exposed ${forbidden}`);
    }
    assert.deepEqual(pageErrors, []);

    await page.getByRole("button", { name: /^Current server:/i }).click();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    await page.getByText("No server connected", { exact: true }).waitFor();
    assert.equal((await readFakeState(electronApplication)).disconnects, 1);
  } finally {
    await electronApplication?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function assertRendererSecurity(electronApplication: ElectronApplication, page: Page): Promise<void> {
  const expectedApiKeys = [
    ...Object.keys(IPC_INVOKE),
    "openStream",
    "onSnapshotChanged",
    "onOperationChanged",
    "onBeaconTasksInvalidated",
  ].sort();
  const rendererState = await page.evaluate(async () => {
    const browserGlobal = globalThis as unknown as {
      sliver: object;
      process?: unknown;
      require?: unknown;
    };
    let externalFetchBlocked = false;
    try {
      await fetch("https://example.invalid/sliver-gui-e2e");
    } catch {
      externalFetchBlocked = true;
    }
    return {
      apiFrozen: Object.isFrozen(browserGlobal.sliver),
      apiKeys: Object.keys(browserGlobal.sliver).sort(),
      externalFetchBlocked,
      nodeProcessType: typeof browserGlobal.process,
      nodeRequireType: typeof browserGlobal.require,
    };
  });
  assert.deepEqual(rendererState.apiKeys, expectedApiKeys);
  assert.equal(rendererState.apiFrozen, true);
  assert.equal(rendererState.externalFetchBlocked, true);
  assert.equal(rendererState.nodeProcessType, "undefined");
  assert.equal(rendererState.nodeRequireType, "undefined");

  const preferences = await electronApplication.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Expected an application window");
    const prefs = (window.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown>;
    }).getLastWebPreferences();
    return {
      contextIsolation: prefs["contextIsolation"],
      nodeIntegration: prefs["nodeIntegration"],
      nodeIntegrationInWorker: prefs["nodeIntegrationInWorker"] ?? false,
      nodeIntegrationInSubFrames: prefs["nodeIntegrationInSubFrames"],
      sandbox: prefs["sandbox"],
      webSecurity: prefs["webSecurity"],
      webviewTag: prefs["webviewTag"],
    };
  });
  assert.deepEqual(preferences, {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
  });
}

async function verifyM1TargetsAndOperations(
  electronApplication: ElectronApplication,
  page: Page,
  artifactDirectory: string,
): Promise<void> {
  const initial = await rendererSnapshot(page);
  assert.deepEqual(initial.sessions.map(({ id, name }) => ({ id, name })), [
    { id: "m1_session", name: "m1-session" },
  ]);
  assert.deepEqual(initial.beacons.map(({ id, name }) => ({ id, name })), [
    { id: "m1_beacon", name: "m1-beacon" },
  ]);
  assert.deepEqual(initial.operators.map(({ name, online }) => ({ name, online })), [
    { name: "m0-e2e-operator", online: true },
    { name: "m1-read-only-observer", online: true },
  ]);
  assert.equal(initial.sessions[0]?.remoteAddress, "127.0.0.1:41001");
  assert.equal(initial.beacons[0]?.activeC2, "https://127.0.0.1:4445");

  await page.locator('[aria-label="Sessions"]:visible').click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  const sessionsGrid = page.locator('[aria-label="Sliver sessions"]');
  await sessionsGrid.getByText("m1-session", { exact: true }).waitFor();
  assert.equal(await sessionsGrid.getByText("m1-beacon", { exact: true }).count(), 0);
  const sessionRef = requireTargetRef(initial, "session");
  await page.getByRole("row", { name: /m1-session/i }).click();
  await waitForSnapshot(page, (snapshot) => snapshot.targetContext.activeTarget?.id === sessionRef.id);
  await verifyM2SessionWorkspace(electronApplication, page, artifactDirectory);

  const sessionPing = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.ping",
  }));
  assert.equal(sessionPing.mode, "session");
  assert.equal(sessionPing.state, "completed");
  assert.deepEqual(sessionPing.progress, {
    completedUnits: 3,
    totalUnits: 3,
    message: "Operation completed",
  });
  assert.equal(sessionPing.ownership.origin, "local");
  assert.equal(sessionPing.disposition?.kind, "structured-detail");

  const sessionMutation = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.env-set",
    name: "SLIVER_GUI_M1_E2E",
    value: "session-value",
  }));
  assert.equal(sessionMutation.state, "completed");
  assert.equal((await readFakeState(electronApplication)).environment["SLIVER_GUI_M1_E2E"], "session-value");

  await verifyM2SessionActivityAndBack(page);

  // Moving through unrelated renderer views must not mutate main-owned target
  // selection or its epoch-bound reference.
  await page.locator('[aria-label="Generate"]:visible').click();
  await page.getByRole("heading", { name: "Generate implant" }).waitFor();
  await page.locator('[aria-label="Jobs & listeners"]:visible').click();
  await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor();
  assert.equal((await rendererSnapshot(page)).targetContext.activeTarget?.id, "m1_session");

  await page.locator('[aria-label="Sessions"]:visible').click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  await page.locator('[aria-label="Sliver sessions"]').getByText("m1-session", { exact: true }).waitFor();
  const beaconRef = requireTargetRef(await rendererSnapshot(page), "beacon");
  await page.locator('[aria-label="Beacons"]:visible').click();
  await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
  const beaconsGrid = page.locator('[aria-label="Sliver beacons"]');
  assert.equal(await beaconsGrid.getByText("m1-session", { exact: true }).count(), 0);
  await beaconsGrid.getByText("m1-beacon", { exact: true }).waitFor();
  await page.getByRole("row", { name: /m1-beacon/i }).click();
  const selectedBeacon = await waitForSnapshot(
    page,
    (snapshot) => snapshot.targetContext.activeTarget?.id === beaconRef.id,
  );
  assert.deepEqual(
    selectedBeacon.targetContext.capabilities.find(({ id }) => id === "beacon.open-session"),
    { id: "beacon.open-session", available: true },
    "a safe main-owned C2 endpoint must enable beacon session conversion",
  );

  await electronApplication.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true;
  });
  const queuedPing = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.ping",
  }));
  assert.equal(queuedPing.mode, "beacon");
  assert.equal(queuedPing.state, "running");
  assert.deepEqual(queuedPing.progress, {
    completedUnits: 2,
    totalUnits: 3,
    message: "Waiting for authoritative task completion",
  });
  const fakeAfterBeaconPing = await readFakeState(electronApplication);
  assert.ok(
    queuedPing.taskId,
    `beacon ping must expose an exact task correlation ID; state=${queuedPing.state}; ` +
      `message=${queuedPing.message ?? "none"}; fake=${JSON.stringify({
        tasks: fakeAfterBeaconPing.tasks,
        methods: fakeAfterBeaconPing.methods.slice(-8),
      })}`,
  );
  await page.locator('[aria-label="Generate"]:visible').click();
  await page.getByRole("heading", { name: "Generate implant" }).waitFor();
  await electronApplication.evaluate((_electron, taskId) => {
    globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(taskId, true);
  }, queuedPing.taskId!);
  await page.locator('[aria-label="Beacons"]:visible').click();
  await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
  const completedPing = await waitForOperation(page, queuedPing.requestId, "completed");
  assert.equal(completedPing.taskId, queuedPing.taskId);
  assert.equal(completedPing.disposition?.kind, "structured-detail");
  assert.deepEqual(completedPing.progress, {
    completedUnits: 3,
    totalUnits: 3,
    message: "Operation completed",
  });
  const completedPingRow = page.getByRole("row").filter({ hasText: queuedPing.requestId });
  await completedPingRow.waitFor();
  await completedPingRow.getByText("Completed", { exact: true }).waitFor();

  const completedTasks = await invokeSliver(page, "listBeaconTasks", { limit: 100 });
  assert.equal(completedTasks.ok, true);
  const correlatedTask = completedTasks.value?.items.find((task) => task.taskId === queuedPing.taskId);
  assert.equal(correlatedTask?.localRequestId, queuedPing.requestId);
  assert.equal(correlatedTask?.ownership.origin, "local");
  assert.equal(correlatedTask?.state, "completed");
  const taskDetail = await invokeSliver(page, "getBeaconTask", { taskId: queuedPing.taskId! });
  assert.equal(taskDetail.ok, true);
  assert.equal(taskDetail.value?.disposition?.kind, "structured-detail");

  const openSession = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "beacon.open-session",
    delaySeconds: 2,
  }));
  assert.equal(openSession.state, "running");
  assert.deepEqual(openSession.progress, {
    completedUnits: 2,
    totalUnits: 3,
    message: "Waiting for authoritative task completion",
  });
  assert.ok(openSession.taskId, "session conversion must retain its exact task binding");
  assert.deepEqual((await readFakeState(electronApplication)).openSessionRequests.at(-1), {
    beaconId: "m1_beacon",
    c2s: ["https://operator:FAKE_TARGET_SECRET_M1_DO_NOT_RENDER@127.0.0.1:4445/secret-path"],
    delayNanoseconds: "2000000000",
  });
  const completedOpenSession = await waitForOperation(page, openSession.requestId, "completed");
  assert.equal(completedOpenSession.taskId, openSession.taskId);
  assert.equal(completedOpenSession.disposition?.kind, "inline-text");

  await electronApplication.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true;
  });
  const cancelable = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.env-set",
    name: "SLIVER_GUI_M1_CANCEL",
    value: "cancel-me",
  }));
  assert.ok(cancelable.taskId);
  const canceled = requireOperation(await invokeSliver(page, "cancelTargetOperation", {
    requestId: cancelable.requestId,
  }));
  assert.equal(canceled.state, "canceled");
  assert.deepEqual(canceled.progress, {
    completedUnits: 3,
    totalUnits: 3,
    message: "Operation canceled",
  });
  assert.equal(
    (await readFakeState(electronApplication)).tasks.find((task) => task.id === cancelable.taskId)?.state,
    "canceled",
  );
  const canceledTasks = await invokeSliver(page, "listBeaconTasks", { limit: 100 });
  assert.equal(canceledTasks.ok, true);
  assert.equal(
    canceledTasks.value?.items.find((task) => task.taskId === cancelable.taskId)?.state,
    "canceled",
    "the authoritative task inventory must confirm cancellation",
  );

  const operationPage = await invokeSliver(page, "listTargetOperations", { limit: 1 });
  assert.equal(operationPage.ok, true);
  assert.ok(
    (operationPage.value?.page.total ?? 0) >= 30,
    "the unified history must retain the M1 records and the exercised M2 workbench activity",
  );
  assert.equal(operationPage.value?.page.truncated, true);
  assert.match(operationPage.value?.page.nextCursor ?? "", /^operation:v1:/u);
  const nextOperationPage = await invokeSliver(page, "listTargetOperations", {
    cursor: operationPage.value!.page.nextCursor!,
    limit: 1,
  });
  assert.equal(nextOperationPage.ok, true);
  assert.equal(nextOperationPage.value?.items.length, 1);
  assert.notEqual(nextOperationPage.value?.items[0]?.requestId, operationPage.value?.items[0]?.requestId);

  const taskPage = await invokeSliver(page, "listBeaconTasks", { limit: 1 });
  assert.equal(taskPage.ok, true);
  assert.equal(taskPage.value?.page.total, 3);
  assert.equal(taskPage.value?.page.truncated, true);
  assert.match(taskPage.value?.page.nextCursor ?? "", /^task:v2:/u);
  const nextTaskPage = await invokeSliver(page, "listBeaconTasks", {
    cursor: taskPage.value!.page.nextCursor!,
    limit: 1,
  });
  assert.equal(nextTaskPage.ok, true);
  assert.equal(nextTaskPage.value?.items.length, 1);
  assert.notEqual(nextTaskPage.value?.items[0]?.taskId, taskPage.value?.items[0]?.taskId);

  // Complete a held task without its server event, interrupt the event stream,
  // and prove the connected transition reconciles authoritative task state.
  await electronApplication.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true;
  });
  const reconnectTask = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.ping",
  }));
  assert.ok(reconnectTask.taskId);
  await electronApplication.evaluate((_electron, taskId) => {
    globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(taskId, false);
    globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("retrying");
  }, reconnectTask.taskId!);
  await waitForSnapshot(page, (snapshot) => snapshot.connection.status === "reconnecting");
  await electronApplication.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("connected");
  });
  await waitForOperation(page, reconnectTask.requestId, "completed");
  await page.locator('[aria-label="Jobs & listeners"]:visible').click();
  await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor();
  await page.locator('[aria-label="Beacons"]:visible').click();
  await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
  const reconnectRow = page.getByRole("row").filter({ hasText: reconnectTask.requestId });
  await reconnectRow.waitFor();
  await reconnectRow.getByText("Completed", { exact: true }).waitFor();

  const windowCount = electronApplication.windows().length;
  await page.getByRole("button", { name: "New window options" }).click();
  await page.getByRole("menuitem", { name: "Same server" }).click();
  const secondPage = await waitForAdditionalWindow(electronApplication, windowCount, page);
  await secondPage.getByRole("heading", { name: "Jobs & listeners" }).waitFor();
  try {
    const secondSnapshot = await rendererSnapshot(secondPage);
    const secondSessionRef = requireTargetRef(secondSnapshot, "session");
    const secondSelection = await invokeSliver(secondPage, "selectTarget", secondSessionRef);
    assert.equal(secondSelection.ok, true);
    assert.equal((await rendererSnapshot(page)).targetContext.activeTarget?.id, "m1_beacon");
    assert.equal((await rendererSnapshot(secondPage)).targetContext.activeTarget?.id, "m1_session");

    const secondPing = requireOperation(await invokeSliver(secondPage, "submitTargetOperation", {
      operationId: "target.ping",
    }));
    assert.equal(secondPing.state, "completed");
    assert.equal(secondPing.ownership.origin, "local");
    assert.notEqual(
      secondPing.ownership.origin === "local" ? secondPing.ownership.ownerWindowId : undefined,
      sessionPing.ownership.origin === "local" ? sessionPing.ownership.ownerWindowId : undefined,
    );
    const firstHistory = await invokeSliver(page, "listTargetOperations", { limit: 100 });
    assert.equal(firstHistory.ok, true);
    assert.ok(!firstHistory.value?.items.some((operation) => operation.requestId === secondPing.requestId));

    await secondPage.locator('[aria-label="Sessions"]:visible').click();
    await secondPage.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
    await secondPage.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
    await secondPage.getByRole("heading", { name: "m1-session", exact: true }).waitFor();

    // Leave a second-window shell detached, then remove its exact session.
    // Target disappearance must close the main-owned resource and quarantine
    // every renderer surface that could otherwise retain stale terminal data.
    await secondPage.getByRole("tab", { name: "Terminal", exact: true }).click();
    await secondPage.getByRole("heading", { name: "Managed Shells", exact: true }).waitFor();
    const secondShellStarts = fakeMethodCount(await readFakeState(electronApplication), "startShellSession");
    await secondPage.getByRole("button", { name: "New shell", exact: true }).first().click();
    await waitForFakeMethodCount(electronApplication, "startShellSession", secondShellStarts + 1);
    await secondPage.getByRole("textbox", { name: "Interactive shell for m1-session", exact: true }).waitFor();
    await secondPage.getByText("Attached", { exact: true }).waitFor();
    await secondPage.getByRole("tab", { name: "Overview", exact: true }).click();

    const closePlan = await invokeSliver(secondPage, "prepareTargetAction", { actionId: "session.close" });
    assert.equal(closePlan.ok, true);
    assert.equal(closePlan.value?.impact.targets.length, 1);
    assert.equal(closePlan.value?.impact.targets[0]?.id, "m1_session");
    assert.match(closePlan.value?.impact.warning ?? "", /interactive connection without killing the remote process/i);
    assert.ok(closePlan.value?.token, "destructive action review must issue a one-use confirmation token");

    await secondPage.getByRole("button", { name: "Close session", exact: true }).click();
    const closeReview = secondPage.getByRole("dialog", { name: /review close session/i });
    await closeReview.waitFor();
    const closeReviewText = await closeReview.innerText();
    assert.ok(closeReviewText.includes("m1-session"));
    assert.ok(closeReviewText.includes("m1_session"));
    assert.match(closeReviewText, /one-use review is bound to the exact backend epoch and target set/i);
    await closeReview.getByRole("button", { name: "Cancel", exact: true }).click();
    await closeReview.waitFor({ state: "hidden" });

    const shellClosesBeforeTargetLoss = fakeMethodCount(await readFakeState(electronApplication), "shell.close");
    const closeResult = await invokeSliver(secondPage, "executeTargetActionPlan", {
      token: closePlan.value!.token,
    });
    assert.equal(closeResult.ok, true);
    assert.equal(closeResult.value?.outcomes[0]?.status, "succeeded");
    await waitForFakeMethodCount(electronApplication, "shell.close", shellClosesBeforeTargetLoss + 1);
    await secondPage.getByRole("heading", { name: "Session workspace unavailable", exact: true }).waitFor();
    assert.equal(
      await secondPage.getByRole("textbox", { name: "Interactive shell for m1-session", exact: true }).count(),
      0,
      "session loss must dispose the stale terminal surface",
    );
    assert.equal(await secondPage.getByRole("tablist", { name: "Session interaction sections" }).count(), 0);
    const replay = await invokeSliver(secondPage, "executeTargetActionPlan", {
      token: closePlan.value!.token,
    });
    assert.equal(replay.ok, false, "destructive confirmation tokens must be one-use");
  } finally {
    await secondPage.close().catch(() => undefined);
  }
  await page.locator('[aria-label="Jobs & listeners"]:visible').click();
  await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor();
}

async function verifyM2SessionWorkspace(
  electronApplication: ElectronApplication,
  page: Page,
  artifactDirectory: string,
): Promise<void> {
  await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
  await page.getByRole("tablist", { name: "Session interaction sections" }).waitFor();
  assert.equal(
    await page.getByText("Selected session", { exact: true }).count(),
    0,
    "session row activation must replace the legacy selected-session card with a dedicated route",
  );

  await page.getByRole("heading", { name: "Identity", exact: true }).waitFor();
  await page.getByText("m1-session-host", { exact: true }).first().waitFor();
  await page.getByRole("heading", { name: "Network", exact: true }).waitFor();
  await page.getByText("en0", { exact: true }).waitFor();
  await page.getByText("ESTABLISHED", { exact: true }).waitFor();
  await page.getByText("Screenshot unavailable", { exact: true }).waitFor();

  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const filesystemMode = page.getByRole("radiogroup", { name: "Filesystem mode" });
  await filesystemMode.waitFor();
  const filesGrid = page.getByRole("grid", { name: "Files in /Users/e2e/workspace" });
  await filesGrid.waitFor();
  await filesGrid.getByText("notes.txt", { exact: true }).waitFor();
  await filesGrid.getByText("projects", { exact: true }).waitFor();

  const notesRow = filesGrid.getByRole("row").filter({ hasText: "notes.txt" });
  await notesRow.click();
  const inspector = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await inspector.waitFor();
  const fileViews = inspector.getByRole("radiogroup", { name: "File view" });
  await inspector.getByText(M2_INITIAL_FILE_TEXT, { exact: true }).waitFor();
  let downloadCount = fakeMethodCount(await readFakeState(electronApplication), "downloadFileSession");

  await fileViews.getByRole("radio", { name: "Head", exact: true }).click();
  downloadCount += 1;
  await waitForFakeMethodCount(electronApplication, "downloadFileSession", downloadCount);
  await fileViews.getByRole("radio", { name: "Tail", exact: true }).click();
  downloadCount += 1;
  await waitForFakeMethodCount(electronApplication, "downloadFileSession", downloadCount);
  await fileViews.getByRole("radio", { name: "Hex", exact: true }).click();
  downloadCount += 1;
  await waitForFakeMethodCount(electronApplication, "downloadFileSession", downloadCount);
  await inspector.getByText(Buffer.from(M2_INITIAL_FILE_TEXT, "utf8").toString("hex"), { exact: true }).waitFor();
  await fileViews.getByRole("radio", { name: "Cat", exact: true }).click();
  downloadCount += 1;
  await waitForFakeMethodCount(electronApplication, "downloadFileSession", downloadCount);
  await inspector.getByText(M2_INITIAL_FILE_TEXT, { exact: true }).waitFor();

  await inspector.getByRole("button", { name: "Edit", exact: true }).click();
  await inspector.getByRole("textbox", { name: "UTF-8 text", exact: true }).fill(M2_EDITED_CONTENT);
  await inspector.getByRole("button", { name: "Review save", exact: true }).click();
  const saveDialog = page.getByRole("alertdialog", { name: "Save changes to this remote file?", exact: true });
  await saveDialog.waitFor();
  const saveReviewText = await saveDialog.innerText();
  assert.ok(saveReviewText.includes("/Users/e2e/workspace/notes.txt"));
  assert.match(saveReviewText, /plan payload sha-256/i);
  assert.ok(!saveReviewText.includes(M2_EDITED_CONTENT), "review metadata must not echo staged editor content");
  await saveDialog.getByRole("button", { name: "Confirm action", exact: true }).click();
  await saveDialog.waitFor({ state: "hidden" });
  await waitForFakeMethodCount(electronApplication, "uploadSession", 1);
  await page.keyboard.press("Escape");
  await inspector.waitFor({ state: "hidden" });

  await notesRow.click();
  await inspector.waitFor();
  await inspector.getByText(M2_EDITED_CONTENT, { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await inspector.waitFor({ state: "hidden" });

  await page.getByLabel("New folder name").fill("m2-e2e-folder");
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  const createdFolderRow = filesGrid.getByRole("row").filter({ hasText: "m2-e2e-folder" });
  await createdFolderRow.waitFor();
  await createdFolderRow.getByRole("button", { name: "More actions for m2-e2e-folder", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Delete/u }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: "Delete this remote item?", exact: true });
  await deleteDialog.waitFor();
  const reviewText = await deleteDialog.innerText();
  assert.ok(reviewText.includes("/Users/e2e/workspace/m2-e2e-folder"));
  assert.match(reviewText, /backend.*payload change invalidates it/i);
  await deleteDialog.getByRole("button", { name: "Confirm action", exact: true }).click();
  await deleteDialog.waitFor({ state: "hidden" });
  await createdFolderRow.waitFor({ state: "hidden" });

  await filesystemMode.getByRole("radio", { name: "Search", exact: true }).click();
  await page.getByRole("textbox", { name: "Search path", exact: true }).fill("/Users/e2e/workspace");
  await page.getByRole("textbox", { name: "Pattern", exact: true }).fill(M2_SEARCH_PATTERN);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const searchGrid = page.getByRole("grid", { name: "Filesystem search results" });
  await searchGrid.waitFor();
  await searchGrid.getByText("/Users/e2e/workspace/match-001.txt", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load more matches", exact: true }).click();
  await searchGrid.getByText("/Users/e2e/workspace/match-105.txt", { exact: true }).waitFor();

  await filesystemMode.getByRole("radio", { name: "Storage", exact: true }).click();
  const mountsGrid = page.getByRole("grid", { name: "Session mounts" });
  await mountsGrid.waitFor();
  await mountsGrid.getByText("Macintosh HD", { exact: true }).waitFor();
  await page.getByText("Memory files unavailable", { exact: true }).waitFor();

  await page.getByRole("tab", { name: "Processes", exact: true }).click();
  const processesGrid = page.getByRole("grid", { name: "Session processes" });
  await processesGrid.waitFor();
  await processesGrid.getByText("launchd", { exact: true }).waitFor();
  await processesGrid.getByText("sliver-m2-session", { exact: true }).waitFor();
  await page.getByText("Loaded 100 of 108 processes · bounded", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load more processes", exact: true }).click();
  await page.getByText("Loaded 108 of 108 processes", { exact: true }).waitFor();

  const processViews = page.getByRole("radiogroup", { name: "Process view" });
  await processViews.getByRole("radio", { name: "Tree", exact: true }).click();
  const processTree = page.getByRole("grid", { name: "Session process tree" });
  await processTree.waitFor();
  await processTree.getByText("launchd", { exact: true }).waitFor();
  await processTree.getByText("sliver-m2-session", { exact: true }).waitFor();
  await processTree.getByText("zsh", { exact: true }).waitFor();
  const screenshotStateText = await page.locator("body").innerText();
  for (const forbidden of [M2_ENV_SECRET, M2_FILE_CONTENT, M2_EDITED_CONTENT, M2_SEARCH_PATTERN]) {
    assert.ok(!screenshotStateText.includes(forbidden), `M2 visual QA state exposed ${forbidden}`);
  }
  const m2Screenshot = await page.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "m2-session-workbench.png"),
  });
  for (const forbidden of [M2_ENV_SECRET, M2_FILE_CONTENT, M2_EDITED_CONTENT, M2_SEARCH_PATTERN]) {
    assert.equal(m2Screenshot.includes(Buffer.from(forbidden)), false, `M2 screenshot bytes exposed ${forbidden}`);
  }
  await processViews.getByRole("radio", { name: "List", exact: true }).click();
  await processesGrid.waitFor();
  await page.getByRole("searchbox", { name: "Filter processes" }).fill("zsh");
  await page.getByText("Loaded 1 of 1 processes matching “zsh”", { exact: true }).waitFor();
  await processesGrid.getByText("zsh", { exact: true }).waitFor();
  assert.equal(await processesGrid.getByText("launchd", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("radiogroup", { name: "Process inventory" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /^Dump process /u }).count(), 0);

  await page.getByRole("tab", { name: "Environment", exact: true }).click();
  const environmentGrid = page.getByRole("grid", { name: "Session environment variables" });
  await environmentGrid.waitFor();
  await environmentGrid.getByText("HOME", { exact: true }).waitFor();
  await environmentGrid.getByText("/Users/e2e", { exact: true }).waitFor();
  await page.getByText("Loaded 100 of 108 environment variables · bounded", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load more variables", exact: true }).click();
  await page.getByText("Loaded 108 of 108 environment variables", { exact: true }).waitFor();
  await environmentGrid.getByText("M2_PAGE_105", { exact: true }).waitFor();
  const sensitiveRow = environmentGrid.getByRole("row").filter({ hasText: "SLIVER_GUI_M2_API_TOKEN" });
  await sensitiveRow.waitFor();
  await sensitiveRow.getByText("Sensitive", { exact: true }).waitFor();
  assert.equal(await page.getByText(M2_ENV_SECRET, { exact: true }).count(), 0);
  await sensitiveRow.getByRole("button", { name: "Reveal", exact: true }).click();
  await sensitiveRow.getByText(M2_ENV_SECRET, { exact: true }).waitFor();

  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  assert.ok(!(await page.locator("body").innerText()).includes(M2_ENV_SECRET));
  const state = await readFakeState(electronApplication);
  for (const method of [
    "ifconfigSession",
    "netstatSession",
    "pwdSession",
    "lsSession",
    "downloadFileSession",
    "uploadSession",
    "grepSession",
    "mkdirSession",
    "rmSession",
    "mountsSession",
    "psSession",
    "listEnvSession",
    "revealEnvSession",
  ]) {
    assert.ok(state.methods.includes(method), `expected the M2 workbench to call ${method}`);
  }
  assert.equal(state.dialogCalls, 1, "the M2 journey must not invoke native file dialogs");
  assert.ok(!state.methods.includes("currentTokenOwnerSession"), "Darwin must quarantine the Windows-only token owner RPC");
  assert.ok(!state.methods.includes("screenshotSession"), "Darwin must quarantine the unsupported screenshot RPC");
  assert.ok(!state.methods.includes("processDumpSession"), "Darwin must quarantine the unsupported process dump RPC");
  assert.ok(!state.methods.includes("servicesSession"), "Darwin must quarantine Windows service inventory RPCs");
  assert.ok(!state.methods.includes("memfilesListSession"), "Darwin must quarantine Linux memory-file RPCs");

  await verifyM3SessionTerminal(electronApplication, page, artifactDirectory);
}

async function verifyM3SessionTerminal(
  electronApplication: ElectronApplication,
  page: Page,
  artifactDirectory: string,
): Promise<void> {
  const externalNetworkRequests: string[] = [];
  const observeRequest = (request: { url(): string }) => {
    if (/^https?:/iu.test(request.url())) externalNetworkRequests.push(request.url());
  };
  page.on("request", observeRequest);
  try {
    await installM3HostEffectGuards(page);
    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    await page.getByRole("heading", { name: "Managed Shells", exact: true }).waitFor();
    await page.getByText("No managed shells", { exact: true }).waitFor();

    const initialState = await readFakeState(electronApplication);
    const initialShellStarts = fakeMethodCount(initialState, "startShellSession");
    const initialEarlyPrompts = fakeMethodCount(initialState, "shell.early-output");
    const initialResizes = fakeMethodCount(initialState, "shell.resize");
    await page.getByRole("button", { name: "New shell", exact: true }).first().click();
    await waitForFakeMethodCount(electronApplication, "startShellSession", initialShellStarts + 1);
    await waitForFakeMethodCount(electronApplication, "shell.early-output", initialEarlyPrompts + 1);

    const terminal = page.getByRole("textbox", { name: "Interactive shell for m1-session", exact: true });
    await terminal.waitFor();
    await page.getByText("Attached", { exact: true }).waitFor();
    await waitForFakeMethodCount(electronApplication, "shell.resize", initialResizes + 1);
    await waitForNonZeroTerminalMetric(page, "Bytes in");

    const initialWhoamiCommands = fakeMethodCount(await readFakeState(electronApplication), "shell.command.whoami");
    try {
      await terminal.pressSequentially("whoami");
      await terminal.press("Enter", { timeout: 2_000 });
    } catch (error) {
      const calls = (await readFakeState(electronApplication)).methods.slice(-20).join(", ");
      throw new Error(`Ghostty input surface disappeared; recent fake calls: ${calls}`, { cause: error });
    }
    await waitForFakeMethodCount(electronApplication, "shell.command.whoami", initialWhoamiCommands + 1);

    const initialHostileCommands = fakeMethodCount(
      await readFakeState(electronApplication),
      "shell.command.hostile-output",
    );
    await terminal.pressSequentially("m3-hostile-output");
    await terminal.press("Enter");
    await waitForFakeMethodCount(
      electronApplication,
      "shell.command.hostile-output",
      initialHostileCommands + 1,
    );
    await waitForNonZeroTerminalMetric(page, "Bytes out");

    const m3Screenshot = await page.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, "m3-session-terminal.png"),
    });
    for (const forbidden of [
      PRIVATE_KEY_SECRET,
      TOKEN_SECRET,
      TARGET_SECRET,
      M2_ENV_SECRET,
      M2_FILE_CONTENT,
      M2_EDITED_CONTENT,
      M2_SEARCH_PATTERN,
      "MACHINE_CLIPBOARD_PROBE",
      "HOSTILE_DOWNLOAD_PROBE",
    ]) {
      assert.equal(m3Screenshot.includes(Buffer.from(forbidden)), false, `M3 screenshot bytes exposed ${forbidden}`);
    }
    assert.deepEqual(await readM3HostEffects(page), emptyM3HostEffects());
    assert.deepEqual(externalNetworkRequests, [], "terminal output must not initiate an external network request");

    await page.getByRole("button", { name: "Detach", exact: true }).click();
    await page.getByText("Shell is not attached", { exact: true }).waitFor();
    assert.equal(await terminal.count(), 0, "detaching must dispose the terminal surface and its payload-bearing state");

    await page.getByRole("button", { name: "Attach", exact: true }).first().click();
    await page.getByRole("textbox", { name: "Interactive shell for m1-session", exact: true }).waitFor();
    await page.getByText("Attached", { exact: true }).waitFor();
    const initialPwdCommands = fakeMethodCount(await readFakeState(electronApplication), "shell.command.pwd");
    const reattachedTerminal = page.getByRole("textbox", {
      name: "Interactive shell for m1-session",
      exact: true,
    });
    await reattachedTerminal.pressSequentially("pwd");
    await reattachedTerminal.press("Enter");
    await waitForFakeMethodCount(electronApplication, "shell.command.pwd", initialPwdCommands + 1);

    const initialShellCloses = fakeMethodCount(await readFakeState(electronApplication), "shell.close");
    await page
      .getByRole("toolbar", { name: "Terminal actions", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    const closeReview = page.getByRole("alertdialog", { name: "Close this managed shell?", exact: true });
    await closeReview.waitFor();
    const closeReviewText = await closeReview.innerText();
    assert.match(closeReviewText, /closes the local managed stream/i);
    assert.match(closeReviewText, /bounded best-effort exit and logout requests/i);
    assert.match(closeReviewText, /does not confirm remote process termination/i);
    await closeReview.getByRole("button", { name: "Close shell", exact: true }).click();
    await waitForFakeMethodCount(electronApplication, "shell.close", initialShellCloses + 1);
    await page.getByText("No managed shells", { exact: true }).waitFor();
    await page.getByText("No shell selected", { exact: true }).waitFor();
    assert.deepEqual(await readM3HostEffects(page), emptyM3HostEffects());
    assert.deepEqual(externalNetworkRequests, [], "the M3 journey must remain network inert");
    assert.equal(
      (await readFakeState(electronApplication)).dialogCalls,
      1,
      "terminal output and shell lifecycle actions must not invoke a native dialog",
    );
  } finally {
    page.off("request", observeRequest);
  }
}

interface M3HostEffects {
  clipboardWrites: number;
  dialogs: number;
  downloads: number;
  fetches: number;
  notifications: number;
  windowOpens: number;
}

function emptyM3HostEffects(): M3HostEffects {
  return {
    clipboardWrites: 0,
    dialogs: 0,
    downloads: 0,
    fetches: 0,
    notifications: 0,
    windowOpens: 0,
  };
}

async function installM3HostEffectGuards(page: Page): Promise<void> {
  await page.evaluate(() => {
    const effects = {
      clipboardWrites: 0,
      dialogs: 0,
      downloads: 0,
      fetches: 0,
      notifications: 0,
      windowOpens: 0,
    };
    const browserGlobal = globalThis as unknown as {
      __SLIVER_GUI_M3_HOST_EFFECTS__: typeof effects;
      alert: (message?: unknown) => void;
      confirm: (message?: unknown) => boolean;
      document: { createElement(name: string): object };
      fetch: typeof fetch;
      open: (...args: unknown[]) => unknown;
      prompt: (message?: unknown, defaultValue?: string) => string | null;
    };
    browserGlobal.__SLIVER_GUI_M3_HOST_EFFECTS__ = effects;

    const originalFetch = globalThis.fetch.bind(globalThis);
    browserGlobal.fetch = ((...args: Parameters<typeof fetch>) => {
      effects.fetches += 1;
      return originalFetch(...args);
    }) as typeof fetch;
    browserGlobal.open = (() => {
      effects.windowOpens += 1;
      return null;
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => "",
        writeText: async () => {
          effects.clipboardWrites += 1;
        },
      },
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: function NotificationProbe() {
        effects.notifications += 1;
      },
    });
    browserGlobal.alert = () => {
      effects.dialogs += 1;
    };
    browserGlobal.confirm = () => {
      effects.dialogs += 1;
      return false;
    };
    browserGlobal.prompt = () => {
      effects.dialogs += 1;
      return null;
    };
    const anchorPrototype = Object.getPrototypeOf(browserGlobal.document.createElement("a")) as { click(): void };
    anchorPrototype.click = function blockedM3Download() {
      effects.downloads += 1;
    };
  });
}

async function readM3HostEffects(page: Page): Promise<M3HostEffects> {
  return page.evaluate(() => structuredClone(
    (globalThis as unknown as { __SLIVER_GUI_M3_HOST_EFFECTS__: M3HostEffects })
      .__SLIVER_GUI_M3_HOST_EFFECTS__,
  ));
}

async function waitForNonZeroTerminalMetric(
  page: Page,
  label: "Bytes in" | "Bytes out",
  timeoutMs = 10_000,
): Promise<void> {
  const metric = page.getByText(label, { exact: true }).locator("..").locator("dd");
  const deadline = Date.now() + timeoutMs;
  let latest = "missing";
  while (Date.now() < deadline) {
    latest = (await metric.textContent().catch(() => null))?.trim() ?? "missing";
    if (latest !== "missing" && latest !== "0") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} did not become non-zero; latest value was ${latest}`);
}

async function verifyM2SessionActivityAndBack(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  const activityGrid = page.getByRole("grid", { name: "Session activity" });
  await activityGrid.waitFor();
  await activityGrid.getByText("Ping", { exact: true }).waitFor();
  await activityGrid.getByText("Set environment variable", { exact: true }).waitFor();
  await activityGrid.getByText("Stage text changes", { exact: true }).waitFor();
  const savedFileActivity = activityGrid.getByRole("row").filter({ hasText: "Save text file" });
  await savedFileActivity.waitFor();
  await savedFileActivity.getByText("Completed", { exact: true }).waitFor();
  const activityText = await activityGrid.innerText();
  for (const forbidden of [
    M2_ENV_SECRET,
    M2_FILE_CONTENT,
    M2_EDITED_CONTENT,
    M2_SEARCH_PATTERN,
    "/Users/e2e/workspace/notes.txt",
  ]) {
    assert.ok(!activityText.includes(forbidden), `Activity exposed sensitive operation input ${forbidden}`);
  }
  assert.doesNotMatch(activityText, /\/(?:Users|private|tmp|var)\//u, "Activity must not expose local or remote paths");

  await page.getByRole("button", { name: "Back to live sessions", exact: true }).click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  const sessionsGrid = page.locator('[aria-label="Sliver sessions"]');
  await sessionsGrid.getByText("m1-session", { exact: true }).waitFor();
  assert.equal(await page.getByRole("tablist", { name: "Session interaction sections" }).count(), 0);
  assert.equal(await page.getByText("Selected session", { exact: true }).count(), 0);

  await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
  await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
  const beaconRef = requireTargetRef(await rendererSnapshot(page), "beacon");
  const switchResult = await invokeSliver(page, "selectTarget", beaconRef);
  assert.equal(switchResult.ok, true);
  await page.getByRole("heading", { name: "Session workspace unavailable", exact: true }).waitFor();
  const quarantinedText = await page.locator("body").innerText();
  assert.ok(!quarantinedText.includes(M2_FILE_CONTENT));
  assert.ok(!quarantinedText.includes(M2_EDITED_CONTENT));
  assert.equal(await page.getByRole("tablist", { name: "Session interaction sections" }).count(), 0);

  await page.getByRole("button", { name: "Back to sessions", exact: true }).click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
  await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
  assert.equal((await rendererSnapshot(page)).targetContext.activeTarget?.id, "m1_session");
  await page.getByRole("button", { name: "Back to live sessions", exact: true }).click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
}

async function rendererSnapshot(page: Page): Promise<SliverSnapshot> {
  return invokeSliver(page, "getSnapshot");
}

type SliverMethod = keyof SliverDesktopAPI;
type SliverMethodArgs<Method extends SliverMethod> =
  SliverDesktopAPI[Method] extends (...args: infer Args) => unknown ? Args : never;
type SliverMethodResult<Method extends SliverMethod> =
  SliverDesktopAPI[Method] extends (...args: never[]) => infer Result ? Awaited<Result> : never;

async function invokeSliver<Method extends SliverMethod>(
  page: Page,
  method: Method,
  ...args: SliverMethodArgs<Method>
): Promise<SliverMethodResult<Method>> {
  return page.evaluate(async ({ method: rendererMethod, args: rendererArgs }) => {
    const api = (globalThis as unknown as { sliver: Record<string, (...values: unknown[]) => Promise<unknown>> }).sliver;
    return api[rendererMethod]!(...rendererArgs);
  }, { method, args }) as Promise<SliverMethodResult<Method>>;
}

function requireTargetRef(snapshot: SliverSnapshot, mode: "session" | "beacon"): TargetRef {
  const target = snapshot.targetContext.selectableTargets.find((candidate) => candidate.mode === mode);
  assert.ok(target, `expected a selectable ${mode}`);
  return target;
}

function requireOperation(result: Awaited<ReturnType<SliverDesktopAPI["submitTargetOperation"]>>): TargetOperationRecord;
function requireOperation(result: Awaited<ReturnType<SliverDesktopAPI["cancelTargetOperation"]>>): TargetOperationRecord;
function requireOperation(
  result: Awaited<ReturnType<SliverDesktopAPI["submitTargetOperation"]>> |
    Awaited<ReturnType<SliverDesktopAPI["cancelTargetOperation"]>>,
): TargetOperationRecord {
  assert.equal(result.ok, true, result.error ?? "operation request failed");
  assert.ok(result.value, "operation result must include a record");
  return result.value;
}

async function waitForOperation(
  page: Page,
  requestId: string,
  state: TargetOperationRecord["state"],
  timeoutMs = 15_000,
): Promise<TargetOperationRecord> {
  const deadline = Date.now() + timeoutMs;
  let latest: TargetOperationRecord | undefined;
  while (Date.now() < deadline) {
    const result = await invokeSliver(page, "getTargetOperation", { requestId });
    if (result.ok && result.value) {
      latest = result.value;
      if (latest.state === state) return latest;
      if (["failed", "canceled", "partial", "outcome-unknown", "target-disappeared"].includes(latest.state)) {
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Operation ${requestId} did not reach ${state}; latest state was ${latest?.state ?? "missing"}`);
}

async function waitForSnapshot(
  page: Page,
  predicate: (snapshot: SliverSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<SliverSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await rendererSnapshot(page);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for renderer snapshot state");
}

async function waitForAdditionalWindow(
  electronApplication: ElectronApplication,
  previousCount: number,
  firstPage: Page,
): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pages = electronApplication.windows();
    const additional = pages.find((candidate) => candidate !== firstPage);
    if (pages.length > previousCount && additional) return additional;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for inherited application window");
}

async function startAndStopMtlsListener(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New listener" }).click();
  const dialog = page.getByRole("dialog", { name: "Start a listener" });
  await dialog.getByRole("textbox", { name: "Bind host" }).fill("127.0.0.1");
  const port = dialog.getByRole("textbox", { name: "Listener port" });
  await port.fill("18888");
  await dialog.getByRole("button", { name: "Start listener" }).click();
  await page.getByText("#42", { exact: true }).waitFor();
  await page.getByText("Playwright-created mTLS listener", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Stop job 42" }).click();
  const confirmation = page.getByRole("alertdialog", { name: /stop this reviewed server job/i });
  await confirmation.waitFor();
  const confirmationText = await confirmation.innerText();
  for (const expected of [
    "127.0.0.1:31337",
    "m0-e2e-operator",
    "chosen-m0-operator.cfg",
    "Shared by 1 application window",
    "Job #42",
    "port 18888",
  ]) {
    assert.ok(confirmationText.includes(expected), `stop confirmation omitted ${expected}`);
  }
  await confirmation.getByRole("button", { name: "Stop job #42" }).click();
  await page.getByText("#42", { exact: true }).waitFor({ state: "detached" });
}

async function readFakeState(electronApplication: ElectronApplication): Promise<FakeStateSnapshot> {
  return electronApplication.evaluate(() => structuredClone(globalThis.__SLIVER_GUI_E2E_STATE__));
}

function fakeMethodCount(state: FakeStateSnapshot, method: string): number {
  return state.methods.filter((candidate) => candidate === method).length;
}

async function waitForFakeMethodCount(
  electronApplication: ElectronApplication,
  method: string,
  minimum: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest = 0;
  let latestMethods: string[] = [];
  while (Date.now() < deadline) {
    const state = await readFakeState(electronApplication);
    latestMethods = state.methods;
    latest = fakeMethodCount(state, method);
    if (latest >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${method} call ${minimum}; observed ${latest}; ` +
      `recent fake calls: ${latestMethods.slice(-20).join(", ") || "none"}`,
  );
}

interface FakeStateSnapshot {
  configFactoryCalls: number;
  dialogCalls: number;
  methods: string[];
  disconnects: number;
  holdNextBeaconTask: boolean;
  sessionName: string;
  beaconName: string;
  environment: Record<string, string>;
  openSessionRequests: Array<{ beaconId: string; c2s: string[]; delayNanoseconds: string }>;
  tasks: Array<{ id: string; beaconId: string; state: string; description: string }>;
  connectedConfig?: { operator: string; host: string; port: number };
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "m0-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_CA_M0_DO_NOT_RENDER",
    certificate: "FAKE_CERT_M0_DO_NOT_RENDER",
    private_key: PRIVATE_KEY_SECRET,
    token: TOKEN_SECRET,
  });
}
