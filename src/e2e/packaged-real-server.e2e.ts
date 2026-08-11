import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { parseConfig, SliverClient, type SliverClientConfig } from "sliver-script";

import { IPC_INVOKE, type SliverDesktopAPI, type SliverSnapshot } from "../shared/contracts.js";

const OPTED_IN =
  Boolean(process.env["SLIVER_GUI_E2E_CONFIG"]) &&
  Boolean(process.env["SLIVER_GUI_E2E_LISTENER_PORT"]);
const MAX_OPERATOR_CONFIG_BYTES = 4 * 1024 * 1024;

test(
  "packaged production app starts and confirms/stops mTLS on a real Sliver server",
  {
    skip: OPTED_IN
      ? false
      : "Set SLIVER_GUI_E2E_CONFIG and SLIVER_GUI_E2E_LISTENER_PORT to opt in",
    timeout: 180_000,
  },
  async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const sourceConfigPath = requiredAbsoluteConfigPath();
    const listenerPort = requiredListenerPort();
    const executablePath = await findPackagedExecutable(repositoryRoot);
    const configBytes = await readBoundedOperatorConfig(sourceConfigPath);
    let config: SliverClientConfig;
    try {
      config = parseConfig(configBytes);
      if (config.wg !== undefined) {
        throw new Error("The packaged real-server smoke currently accepts mTLS operator configurations only");
      }
    } catch (error) {
      configBytes.fill(0);
      throw error;
    }

    let temporaryRoot: string;
    try {
      temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-packaged-real-server-e2e-"));
    } catch (error) {
      configBytes.fill(0);
      throw error;
    }
    const isolatedHome = join(temporaryRoot, "home");
    const savedConfigDirectory = join(isolatedHome, ".sliver-client", "configs");
    const userDataDirectory = join(temporaryRoot, "user-data");
    const copiedConfigPath = join(savedConfigDirectory, "m0-packaged-real-server.cfg");
    const artifactDirectory = join(repositoryRoot, "artifacts", "e2e");
    try {
      await Promise.all([
        mkdir(savedConfigDirectory, { recursive: true }),
        mkdir(userDataDirectory, { recursive: true }),
        mkdir(artifactDirectory, { recursive: true }),
      ]);
      await writeFile(copiedConfigPath, configBytes, { mode: 0o600 });
      if (process.platform !== "win32") {
        assert.equal((await stat(copiedConfigPath)).mode & 0o777, 0o600, "operator config copy must be mode 0600");
        await access(executablePath, constants.X_OK);
      }
    } catch (error) {
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Packaged real-server E2E setup failed and its isolated data could not be removed",
        );
      }
      throw error;
    } finally {
      configBytes.fill(0);
    }

    let electronApplication: ElectronApplication | undefined;
    let page: Page | undefined;
    let createdJobId: number | undefined;
    let listenerStartAttempted = false;
    let baselineJobIds = new Set<number>();
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    let primaryFailure: unknown;
    let hasPrimaryFailure = false;
    const cleanupFailures: unknown[] = [];
    try {
      electronApplication = await launchPackagedApplication({
        executablePath,
        isolatedHome,
        repositoryRoot,
        userDataDirectory,
      });
      page = await electronApplication.firstWindow();
      page.on("console", (message) => consoleMessages.push(message.text()));
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await assertPackagedRendererSecurity(electronApplication, page, executablePath);
      const connectDialog = page.getByRole("dialog", { name: /connect to sliver/i });
      await connectDialog.waitFor();
      const savedOption = connectDialog.getByRole("option", { name: /m0-packaged-real-server/i });
      await savedOption.waitFor();
      if ((await savedOption.getAttribute("aria-selected")) !== "true") await savedOption.click();
      await connectDialog.getByRole("button", { name: /^connect$/i }).click();

      try {
        await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor({ timeout: 30_000 });
      } catch (error) {
        const body = await page.locator("body").innerText();
        throw new Error(`Packaged app did not connect to the real server. ${redact(body, sensitiveValues(config, sourceConfigPath, copiedConfigPath, temporaryRoot))}`, {
          cause: error,
        });
      }

      const baseline = await rendererSnapshot(page);
      assert.ok(
        baseline.connection.status === "connected" ||
          baseline.connection.status === "degraded" ||
          baseline.connection.status === "reconnecting",
        `unexpected connected state: ${baseline.connection.status}`,
      );
      assert.equal(baseline.connection.operator, config.operator);
      assert.equal(baseline.connection.server, `${config.lhost}:${config.lport}`);
      assert.ok(
        !baseline.jobs.some((job) => job.port === listenerPort),
        `listener port ${listenerPort} is already represented by a server job`,
      );

      const compatibilityDialog = page.getByRole("dialog", { name: "Server build mismatch" });
      if (baseline.connection.capabilities?.compatibility === "degraded") {
        await compatibilityDialog.waitFor();
        const compatibilityText = await compatibilityDialog.innerText();
        assert.ok(
          compatibilityText.includes(
            baseline.connection.capabilities.serverVersion ?? baseline.connection.version ?? "Not reported",
          ),
          "compatibility notice must identify the connected server version",
        );
        assert.ok(
          compatibilityText.includes(baseline.connection.capabilities.baselineCommit.slice(0, 12)),
          "compatibility notice must identify the verified baseline",
        );
        assert.ok(
          !compatibilityText.includes("Current M0 features remain available"),
          "compatibility notice must not include the removed M0 availability copy",
        );
        await compatibilityDialog.getByRole("button", { name: "Continue" }).click();
        await compatibilityDialog.waitFor({ state: "hidden" });
      } else {
        assert.equal(await compatibilityDialog.count(), 0, "supported server must not show a mismatch notice");
      }
      assert.equal(await page.getByText("Backend degraded", { exact: true }).count(), 0);

      baselineJobIds = new Set(baseline.jobs.map((job) => job.id));
      listenerStartAttempted = true;
      createdJobId = await startMtlsListenerThroughRenderer(
        page,
        listenerPort,
        baselineJobIds,
      );
      await confirmAndStopThroughRenderer(page, createdJobId, listenerPort, baseline);
      await waitForJobState(page, createdJobId, false);

      const snapshotText = JSON.stringify(await rendererSnapshot(page));
      const bodyText = await page.locator("body").innerText();
      const screenshot = await page.screenshot({
        animations: "disabled",
        path: join(artifactDirectory, `packaged-real-server-${process.platform}-${process.arch}.png`),
      });
      const visibleText = [bodyText, snapshotText, ...consoleMessages, ...pageErrors].join("\n");
      for (const forbidden of sensitiveValues(config, sourceConfigPath, copiedConfigPath, temporaryRoot)) {
        if (!forbidden) continue;
        assert.ok(!visibleText.includes(forbidden), `packaged renderer exposed ${sensitiveLabel(forbidden, config)}`);
        assert.equal(screenshot.includes(Buffer.from(forbidden)), false, `screenshot exposed ${sensitiveLabel(forbidden, config)}`);
      }
      assert.deepEqual(pageErrors, []);

      await page.getByRole("button", { name: /^Current server:/i }).click();
      await page.getByRole("menuitem", { name: "Disconnect" }).click();
      await page.getByText("No server connected", { exact: true }).waitFor();
    } catch (error) {
      hasPrimaryFailure = true;
      primaryFailure = error;
    } finally {
      if (createdJobId !== undefined) {
        let applicationCleanupFailure: unknown;
        if (page) {
          try {
            if (!(await cleanupThroughApplication(page, createdJobId))) {
              applicationCleanupFailure = new Error(`The packaged application could not clean up job #${createdJobId}`);
            }
          } catch (error) {
            applicationCleanupFailure = error;
          }
        }
        try {
          await cleanupDirectly(config, {
            baselineJobIds,
            createdJobId,
            listenerPort,
            listenerStartAttempted,
          });
        } catch (error) {
          if (applicationCleanupFailure !== undefined) cleanupFailures.push(applicationCleanupFailure);
          cleanupFailures.push(new Error(`Direct cleanup verification failed for job #${createdJobId}`, { cause: error }));
        }
      } else if (listenerStartAttempted) {
        try {
          await cleanupDirectly(config, {
            baselineJobIds,
            listenerPort,
            listenerStartAttempted,
          });
        } catch (error) {
          cleanupFailures.push(
            new Error(`Direct cleanup verification failed for listener port ${listenerPort}`, { cause: error }),
          );
        }
      }
      if (electronApplication) {
        try {
          await electronApplication.close();
        } catch (error) {
          cleanupFailures.push(new Error("Packaged Electron application teardown failed", { cause: error }));
        }
      }
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(new Error("Isolated packaged-app test data cleanup failed", { cause: error }));
      }
    }

    if (hasPrimaryFailure) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [primaryFailure, ...cleanupFailures],
          "Packaged real-server E2E failed and cleanup was not fully verified",
        );
      }
      throw primaryFailure;
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "Packaged real-server E2E cleanup was not fully verified");
    }
  },
);

async function launchPackagedApplication(input: {
  executablePath: string;
  isolatedHome: string;
  repositoryRoot: string;
  userDataDirectory: string;
}): Promise<ElectronApplication> {
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !entry[0].startsWith("SLIVER_GUI_E2E_"),
    ),
  );
  return electron.launch({
    executablePath: input.executablePath,
    args: ["--enable-sandbox", `--user-data-dir=${input.userDataDirectory}`],
    bypassCSP: false,
    chromiumSandbox: true,
    cwd: input.repositoryRoot,
    env: {
      ...cleanEnvironment,
      HOME: input.isolatedHome,
      USERPROFILE: input.isolatedHome,
      XDG_CONFIG_HOME: join(input.isolatedHome, ".config"),
      // Production must ignore development-only renderer redirection.
      ELECTRON_RENDERER_URL: "http://127.0.0.1:65535/",
    },
  } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
}

async function assertPackagedRendererSecurity(
  electronApplication: ElectronApplication,
  page: Page,
  executablePath: string,
): Promise<void> {
  const expectedApiKeys = [
    ...Object.keys(IPC_INVOKE),
    "onSnapshotChanged",
    "onOperationChanged",
    "onBeaconTasksInvalidated",
    "onSessionShellsChanged",
  ].sort();
  const rendererState = await page.evaluate(async () => {
    const browserGlobal = globalThis as unknown as {
      sliver: object;
      process?: unknown;
      require?: unknown;
    };
    let externalFetchBlocked = false;
    try {
      await fetch("https://example.invalid/sliver-gui-packaged-real-server-e2e");
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
  assert.deepEqual(rendererState, {
    apiFrozen: true,
    apiKeys: expectedApiKeys,
    externalFetchBlocked: true,
    nodeProcessType: "undefined",
    nodeRequireType: "undefined",
  });

  const productionState = await electronApplication.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Expected an application window");
    const preferences = (window.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown>;
    }).getLastWebPreferences();
    return {
      appPath: app.getAppPath(),
      executablePath: process.execPath,
      isPackaged: app.isPackaged,
      preferences: {
        contextIsolation: preferences["contextIsolation"],
        nodeIntegration: preferences["nodeIntegration"],
        nodeIntegrationInWorker: preferences["nodeIntegrationInWorker"] ?? false,
        nodeIntegrationInSubFrames: preferences["nodeIntegrationInSubFrames"],
        sandbox: preferences["sandbox"],
        webSecurity: preferences["webSecurity"],
        webviewTag: preferences["webviewTag"],
      },
      rendererUrl: window.webContents.getURL(),
    };
  });
  assert.equal(productionState.isPackaged, true);
  assert.match(productionState.appPath, /app\.asar$/u);
  assert.match(productionState.rendererUrl, /^file:/u);
  assert.equal(await realpath(productionState.executablePath), await realpath(executablePath));
  assert.deepEqual(productionState.preferences, {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
  });
}

async function startMtlsListenerThroughRenderer(
  page: Page,
  listenerPort: number,
  baselineJobIds: ReadonlySet<number>,
): Promise<number> {
  await page.getByRole("button", { name: "New listener" }).click();
  const dialog = page.getByRole("dialog", { name: "Start a listener" });
  await dialog.waitFor();
  assert.ok(
    (await dialog.innerText()).includes("Authenticated Sliver transport over mutual TLS."),
    "listener dialog did not default to mutual TLS",
  );
  await dialog.getByRole("textbox", { name: "Bind host" }).fill("127.0.0.1");
  await dialog.getByRole("textbox", { name: "Listener port" }).fill(String(listenerPort));
  await dialog.getByRole("button", { name: "Start listener" }).click();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await rendererSnapshot(page);
    const candidate = snapshot.jobs.find(
      (job) => !baselineJobIds.has(job.id) && job.port === listenerPort,
    );
    if (candidate) {
      await page.getByText(`#${candidate.id}`, { exact: true }).waitFor();
      return candidate.id;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`The real server did not report the new mTLS listener on port ${listenerPort}`);
}

async function confirmAndStopThroughRenderer(
  page: Page,
  jobId: number,
  listenerPort: number,
  connectedSnapshot: SliverSnapshot,
): Promise<void> {
  await page.getByRole("button", { name: `Stop job ${jobId}` }).click();
  const confirmation = page.getByRole("alertdialog", { name: /stop this reviewed server job/i });
  await confirmation.waitFor();
  const confirmationText = await confirmation.innerText();
  for (const expected of [
    connectedSnapshot.connection.server,
    connectedSnapshot.connection.operator,
    connectedSnapshot.connection.configName,
    "Shared by 1 application window",
    `Job #${jobId}`,
    `port ${listenerPort}`,
  ]) {
    assert.ok(expected && confirmationText.includes(expected), `real-server stop confirmation omitted ${expected}`);
  }
  assert.match(confirmationText, /(?:all interfaces|127\.0\.0\.1)/iu);
  await confirmation.getByRole("button", { name: `Stop job #${jobId}` }).click();
}

async function cleanupThroughApplication(page: Page, jobId: number): Promise<boolean> {
  return page.evaluate(async ({ id }) => {
    const api = (globalThis as unknown as { sliver?: SliverDesktopAPI }).sliver;
    if (!api) return false;
    const snapshot = await api.getSnapshot();
    if (!snapshot.jobs.some((job) => job.id === id)) return true;
    const plan = await api.prepareStopJob(id);
    if (!plan.ok || !plan.value) return false;
    const stopped = await api.executeStopPlan(plan.value.token);
    return stopped.ok;
  }, { id: jobId });
}

async function cleanupDirectly(
  config: SliverClientConfig,
  cleanup: {
    baselineJobIds: ReadonlySet<number>;
    createdJobId?: number;
    listenerPort: number;
    listenerStartAttempted: boolean;
  },
): Promise<void> {
  const client = new SliverClient(config);
  let operationFailure: unknown;
  let hasOperationFailure = false;
  try {
    await client.connect();
    const jobs = await client.jobs();
    const candidates = jobs.filter((job) =>
      cleanup.createdJobId !== undefined
        ? job.ID === cleanup.createdJobId
        : cleanup.listenerStartAttempted &&
          !cleanup.baselineJobIds.has(job.ID) &&
          job.Port === cleanup.listenerPort,
    );
    const candidateIds = new Set(candidates.map((job) => job.ID));
    for (const job of candidates) {
      const result = await client.killJob(job.ID, 30);
      if (!result.Success) throw new Error(`Sliver refused fallback cleanup for job #${job.ID}`);
    }
    if (candidateIds.size > 0) {
      const remaining = (await client.jobs()).filter((job) => candidateIds.has(job.ID));
      if (remaining.length > 0) {
        throw new Error(`Fallback cleanup left active job IDs: ${remaining.map((job) => job.ID).join(", ")}`);
      }
    }
  } catch (error) {
    hasOperationFailure = true;
    operationFailure = error;
  }

  let disconnectFailure: unknown;
  try {
    await client.disconnect();
  } catch (error) {
    disconnectFailure = error;
  }
  if (hasOperationFailure && disconnectFailure !== undefined) {
    throw new AggregateError(
      [operationFailure, disconnectFailure],
      "Direct real-server cleanup and cleanup-client disconnect both failed",
    );
  }
  if (hasOperationFailure) throw operationFailure;
  if (disconnectFailure !== undefined) {
    throw new Error("Direct real-server cleanup client did not disconnect cleanly", { cause: disconnectFailure });
  }
}

async function waitForJobState(page: Page, jobId: number, present: boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const snapshot = await rendererSnapshot(page);
    if (snapshot.jobs.some((job) => job.id === jobId) === present) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Job #${jobId} did not become ${present ? "active" : "inactive"} within 30 seconds`);
}

async function rendererSnapshot(page: Page): Promise<SliverSnapshot> {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
    return api.getSnapshot();
  });
}

async function readBoundedOperatorConfig(path: string): Promise<Buffer> {
  const file = await lstat(path);
  if (!file.isFile()) throw new Error("SLIVER_GUI_E2E_CONFIG must name a regular file, not a symlink or special file");
  if (file.size <= 0 || file.size > MAX_OPERATOR_CONFIG_BYTES) {
    throw new Error(`SLIVER_GUI_E2E_CONFIG must be between 1 and ${MAX_OPERATOR_CONFIG_BYTES} bytes`);
  }
  return readFile(path);
}

function requiredAbsoluteConfigPath(): string {
  const configured = process.env["SLIVER_GUI_E2E_CONFIG"]?.trim();
  if (!configured) throw new Error("Set SLIVER_GUI_E2E_CONFIG to an mTLS operator configuration");
  if (!isAbsolute(configured)) throw new Error("SLIVER_GUI_E2E_CONFIG must be an absolute path");
  return configured;
}

function requiredListenerPort(): number {
  const configured = process.env["SLIVER_GUI_E2E_LISTENER_PORT"]?.trim();
  if (!configured || !/^\d+$/u.test(configured)) {
    throw new Error("Set SLIVER_GUI_E2E_LISTENER_PORT to an unused numeric port");
  }
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SLIVER_GUI_E2E_LISTENER_PORT must be between 1 and 65535");
  }
  return port;
}

async function findPackagedExecutable(repositoryRoot: string): Promise<string> {
  const configured = process.env["SLIVER_GUI_PACKAGED_EXECUTABLE"];
  if (configured) return resolve(configured);

  const releaseDirectory = join(repositoryRoot, "release");
  const files = await listFiles(releaseDirectory);
  const matches = files.filter((path) => {
    const normalized = path.replaceAll("\\", "/");
    if (process.platform === "darwin") return normalized.endsWith(".app/Contents/MacOS/Sliver GUI");
    if (process.platform === "win32") return /\/win-unpacked\/Sliver GUI\.exe$/iu.test(normalized);
    return /\/linux-unpacked\/sliver-gui$/u.test(normalized);
  });
  if (matches.length === 0) {
    throw new Error(`No packaged ${process.platform} Sliver GUI executable was found under ${releaseDirectory}`);
  }
  const dated = await Promise.all(
    matches.map(async (path) => ({ path, modifiedAt: (await stat(path)).mtimeMs })),
  );
  dated.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
  return dated[0]!.path;
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function sensitiveValues(
  config: SliverClientConfig,
  sourceConfigPath: string,
  copiedConfigPath: string,
  temporaryRoot: string,
): string[] {
  return [config.token, config.private_key, sourceConfigPath, copiedConfigPath, temporaryRoot];
}

function sensitiveLabel(value: string, config: SliverClientConfig): string {
  if (value === config.token) return "operator token";
  if (value === config.private_key) return "operator private key";
  return basename(value);
}

function redact(value: string, forbidden: readonly string[]): string {
  return forbidden.reduce(
    (result, secret) => (secret ? result.replaceAll(secret, "[redacted]") : result),
    value,
  );
}
