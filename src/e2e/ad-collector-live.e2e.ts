import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import { isCompleteZipEnvelope } from "../main/ad-collector.js";
import { installedRustHound, readInstalledRustHound, supportsRustHoundCurrentUser } from "../main/rusthound-armory.js";
import { collectedRustHoundDomain } from "../main/rusthound-domain.js";
import { AD_COLLECTOR_PHASES, RUSTHOUND_ARMORY_COLLECTOR_ID, RUSTHOUND_COLLECTION_METHODS, parseAdDomain, type AdCollectorProgress } from "../shared/ad-explorer-contracts.js";
import type { BeagleAPI } from "../shared/beagle-contracts.js";
import type { SliverDesktopAPI } from "../shared/contracts.js";
import type { TargetCatalogEntry, TargetMode, TargetSummary } from "../shared/target-contracts.js";

const ENABLED = process.env["SLIVER_GUI_AD_COLLECTOR_E2E"] === "1";
const PREFIX = "SLIVER_GUI_AD_COLLECTOR_E2E_";
const AUTHENTICATION = process.env[`${PREFIX}AUTH`] ?? "current-user";
const EXPECT_NO_CREDENTIALS = process.env[`${PREFIX}EXPECT_NO_CREDENTIALS`] === "1";
const EXPECTED_OUTCOME = EXPECT_NO_CREDENTIALS ? "no-usable-domain-credentials" : "populated-graph";
const NO_CREDENTIALS_MESSAGE = "The target's Windows logon has no usable domain credentials. Use a session or beacon started with a full domain logon, or choose AD credentials. A domain user name alone does not establish Kerberos authentication.";
const METHOD_LABELS = { LdapOnly: "LDAP only", DCOnly: "Domain controllers", All: "All supported methods" } as const;
type Method = (typeof RUSTHOUND_COLLECTION_METHODS)[number];
interface WorkspaceBrowser { sliver: SliverDesktopAPI }
interface ExplorerBrowser { beagle: BeagleAPI }
interface GraphBrowser { document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null } }
interface LiveRun {
  mode: TargetMode;
  method: Method;
  domain: string;
  archiveSha256: string;
  archiveBytes: number;
  projectId: string;
  nodes: number;
  edges: number;
  displayedNodes: number;
  elapsedMs: number;
}
interface NoCredentialsRun {
  mode: TargetMode;
  method: "LdapOnly";
  attempt: number;
  observedOutcome: "no-usable-domain-credentials";
  elapsedMs: number;
  archiveCount: number;
  recoveryArtifactCount: number;
  graphWindows: number;
}
type CollectionFailure = "native-collection-failed" | "collection-cancelled" | "automatic-import-failed" | "collector-or-import-deadline" | "cancellation-window-missed" | "cancellation-deadline" | "expected-no-credentials-deadline" | "unexpected-collection-outcome";
class LiveCollectionError extends Error {
  constructor(readonly kind: CollectionFailure) { super(kind); }
}

/** Explicit opt-in: uses only supplied existing GOAD targets, never provisions implants or changes their logon. */
for (const mode of ["session", "beacon"] as const) {
  test(EXPECT_NO_CREDENTIALS
    ? `GOAD ${mode}: current-user RustHound rejects missing domain credentials twice without artifacts`
    : `GOAD ${mode}: ${AUTHENTICATION === "credentials" ? "AD-credentials" : "current-user"} RustHound collection automatically opens a populated AD graph`, {
    skip: ENABLED && selectedModes().includes(mode) ? false : "Set SLIVER_GUI_AD_COLLECTOR_E2E=1 and the documented exact-target inputs",
    timeout: ENABLED ? waitBudget() * (EXPECT_NO_CREDENTIALS ? 2 : selectedMethods().length + 1) + 120_000 : 30_000,
  }, async (context) => {
    assert(AUTHENTICATION === "current-user" || AUTHENTICATION === "credentials", "AUTH must be current-user or credentials");
    assert(!(AUTHENTICATION === "credentials" && EXPECT_NO_CREDENTIALS), "EXPECT_NO_CREDENTIALS requires current-user authentication");
    const credentialsPath = AUTHENTICATION === "credentials" ? requiredPath("CREDENTIALS_FILE") : undefined;
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const profilePath = requiredPath("CONFIG");
    const armoryRoot = requiredPath("ARMORY_ROOT");
    const expectedDomain = parseAdDomain(required("DOMAIN"));
    const targetId = required(`${mode.toUpperCase()}_ID`);
    assert.match(targetId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu, "Specify an exact existing target UUID");
    const outputBase = process.env[`${PREFIX}OUTPUT_DIR`]?.trim();
    if (outputBase) { assert(isAbsolute(outputBase), "OUTPUT_DIR must be absolute"); await mkdir(outputBase, { recursive: true, mode: 0o700 }); }
    const root = await mkdtemp(join(outputBase ?? tmpdir(), `sliver-ad-${mode}-`));
    await chmod(root, 0o700);
    const home = join(root, "home");
    const clientRoot = join(root, "client");
    const userData = join(root, "user-data");
    const copiedProfile = join(clientRoot, "configs", "ad-live-operator.cfg");
    let application: ElectronApplication | undefined;
    let workspace: Page | undefined;
    let stage = "prepare isolated profile";
    const report = (message: string) => process.stdout.write(`[ad-collector-live ${mode} ${AUTHENTICATION} ${EXPECTED_OUTCOME}] ${message}\n`);
    const advance = (next: string) => { stage = next; report(next); };
    let failed = false;
    let failureKind = "";
    let pageErrors = 0;
    let cspErrors = 0;
    const runs: LiveRun[] = [];
    const noCredentialsRuns: NoCredentialsRun[] = [];
    let cancellation: { verified: true; elapsedMs: number } | undefined;
    let dllSha256 = "";
    try {
      advance(stage);
      for (const path of [home, userData, dirname(copiedProfile)]) await mkdir(path, { recursive: true, mode: 0o700 });
      const profileStat = await lstat(profilePath);
      assert(profileStat.isFile() && !profileStat.isSymbolicLink() && profileStat.size > 0 && profileStat.size <= 4 * 1024 * 1024,
        "CONFIG must be a bounded regular operator profile");
      if (process.platform !== "win32") assert.equal(profileStat.mode & 0o077, 0, "CONFIG must be private (0600)");
      const profile = await readFile(profilePath);
      try { await writeFile(copiedProfile, profile, { mode: 0o600, flag: "wx" }); }
      finally { profile.fill(0); }
      await writeFile(join(clientRoot, "armories.json"), "[]", { mode: 0o600 });

      advance("verify and copy the installed current-user collector");
      const installed = await installedRustHound(armoryRoot, { os: "windows", arch: "amd64" } as TargetSummary);
      assert(installed && supportsRustHoundCurrentUser(installed), "Install the admitted signed RustHound current-user build through Armory first");
      const dll = await readInstalledRustHound(installed);
      try {
        dllSha256 = createHash("sha256").update(dll).digest("hex");
        const destination = join(clientRoot, "extensions", "rusthound-ce");
        await mkdir(dirname(join(destination, installed.artifactPath)), { recursive: true, mode: 0o700 });
        await writeFile(join(destination, "extension.json"), await readFile(join(installed.packageDirectory, "extension.json")), { mode: 0o600 });
        await writeFile(join(destination, installed.artifactPath), dll, { mode: 0o600 });
      } finally { dll.fill(0); }

      advance("launch production Electron");
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !key.startsWith("SLIVER_") && key !== "ELECTRON_RUN_AS_NODE"));
      Object.assign(environment, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
        SLIVER_CLIENT_ROOT_DIR: clientRoot, ...(process.platform === "darwin" ? { CFFIXED_USER_HOME: home } : {}) });
      application = await electron.launch({
        args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
          repositoryRoot, `--user-data-dir=${userData}`],
        cwd: repositoryRoot, env: environment, bypassCSP: false, chromiumSandbox: true, timeout: 30_000,
      } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
      const ownedProcess = application.process();
      context.signal.addEventListener("abort", () => ownedProcess.kill("SIGTERM"), { once: true });
      const observe = (page: Page) => {
        page.setDefaultTimeout(30_000);
        page.on("pageerror", () => { pageErrors++; });
        page.on("console", (message) => { if (/Content Security Policy/iu.test(message.text())) cspErrors++; });
      };
      application.on("window", observe);
      workspace = await application.firstWindow();
      observe(workspace);
      advance("connect the isolated operator profile");
      await connect(workspace);
      await workspace.getByRole("treegrid", { name: "Data navigation" }).getByRole("row", { name: "AD Explorer", exact: true }).click();
      advance("select the exact authorized Windows target");
      const entry = await findTarget(workspace, mode, targetId);
      assert.equal(entry.target.os.toLowerCase(), "windows");
      assert.equal(entry.target.arch.toLowerCase(), "amd64");
      if (entry.target.mode === "session") assert.equal(entry.target.liveness, "active", "The exact session must be active");
      else assert.equal(entry.target.checkinStatus, "on-time", "Use a freshly checking-in beacon with a usable domain logon");
      await workspace.getByRole("button", { name: `Select ${mode} ${entry.target.hostname || entry.target.name || entry.target.id} (${targetId})`, exact: true }).click();
      advance("verify collector and current-user defaults");
      const catalog = await workspace.evaluate((target) => (globalThis as unknown as WorkspaceBrowser).sliver.listAdCollectors(target), entry.ref);
      assert(catalog.ok, "Collector catalog unavailable");
      assert.equal(catalog.value.collectors.find((item) => item.available && item.compatibility === "verified")?.id, RUSTHOUND_ARMORY_COLLECTOR_ID);
      await workspace.getByRole("button", { name: /Authentication/u }).waitFor();
      assert.match(await workspace.getByRole("button", { name: /Authentication/u }).innerText(), /Current user/u);
      assert.equal(await workspace.getByLabel("AD password", { exact: true }).count(), 0);
      advance("verify automatic domain suggestion or native discovery");
      const domainInput = workspace.getByRole("textbox", { name: "Windows domain", exact: true });
      if (mode === "session") {
        const hint = await workspace.evaluate((target) => (globalThis as unknown as WorkspaceBrowser).sliver.getAdTargetDomain(target), entry.ref);
        if (hint.ok && hint.value.domain) {
          assert.equal(hint.value.domain, expectedDomain);
          await waitForValue(domainInput, expectedDomain);
        }
      } else {
        // Exercise native discovery, including beacons that have no USERDNSDOMAIN hint.
        await domainInput.fill("");
      }
      assert.equal(await workspace.getByRole("textbox", { name: "LDAP server FQDN (optional)", exact: true }).inputValue(), "");
      if (credentialsPath) {
        advance("select explicit AD credentials after verifying current-user defaults");
        await workspace.getByRole("button", { name: /Authentication/u }).click();
        await workspace.getByRole("option", { name: "AD credentials", exact: true }).click();
        await domainInput.fill(expectedDomain);
        assert.equal(await workspace.getByLabel("AD password", { exact: true }).getAttribute("type"), "password", "AD password must be masked");
      }

      if (EXPECT_NO_CREDENTIALS) {
        advance("verify rejection of missing domain credentials without saved data");
        await workspace.getByRole("button", { name: /Collection method/u }).click();
        await workspace.getByRole("option", { name: METHOD_LABELS.LdapOnly, exact: true }).click();
        assert.equal((await managedZipFiles(clientRoot)).length, 0, "The negative scenario must start without managed ZIPs");
        assert.equal(await recoveryArtifactCount(workspace), 0, "The negative scenario must start without recovery artifacts");
        for (const attempt of [1, 2]) {
          advance(`expect no usable domain credentials on LDAP attempt ${attempt}`);
          const previous: AdCollectorProgress | null = await collectorProgress(workspace);
          const startedAt = Date.now();
          await workspace.getByRole("button", { name: "Run collector", exact: true }).click();
          await waitForNoCredentials(workspace, waitBudget(), targetId, previous?.runId, report);
          const archiveCount = (await managedZipFiles(clientRoot)).length;
          const recoveryCount = await recoveryArtifactCount(workspace);
          const graphWindows: number = application.windows().filter((page) => page.url().includes("surface=beagle")).length;
          assert.equal(archiveCount, 0, "Rejected authentication must not save a collection ZIP");
          assert.equal(recoveryCount, 0, "Rejected authentication must not create a recovery artifact");
          assert.equal(graphWindows, 0, "Rejected authentication must not open a graph");
          noCredentialsRuns.push({ mode, method: "LdapOnly", attempt, observedOutcome: "no-usable-domain-credentials",
            elapsedMs: Date.now() - startedAt, archiveCount, recoveryArtifactCount: recoveryCount, graphWindows });
          if (outputBase) await workspace.screenshot({ path: join(root, `expected-no-credentials-${attempt}.png`), animations: "disabled" });
          report(`LDAP attempt ${attempt}: expected credential rejection verified; no collection data created`);
        }
        advance("verify renderer and CSP diagnostics for expected credential rejection");
        assert.equal(pageErrors, 0, "Renderer errors occurred");
        assert.equal(cspErrors, 0, "CSP errors occurred");
        return;
      }

      advance("cancel an active native collection and confirm target resources are released");
      await workspace.getByRole("button", { name: /Collection method/u }).click();
      await workspace.getByRole("option", { name: METHOD_LABELS.All, exact: true }).click();
      const archiveDirectory = join(clientRoot, "gui", "ad-explorer", "collections", expectedDomain);
      const beforeCancellation = await readdir(archiveDirectory).catch(() => []);
      if (credentialsPath) await fillAdCredentials(workspace, credentialsPath);
      cancellation = { verified: true, elapsedMs: await cancelInFlight(workspace, targetId, waitBudget(), report) };
      if (credentialsPath) await verifyCredentialsCleared(workspace);
      assert.deepEqual(await readdir(archiveDirectory).catch(() => []), beforeCancellation, "Cancelling native collection must not save a ZIP");
      assert.equal(application.windows().filter((page) => page.url().includes("surface=beagle")).length, 0, "Cancelled collection must not open a project window");
      report("native cancellation confirmed; beginning collection matrix");

      let projectId: string | undefined;
      let projectWindow: Page | undefined;
      for (const method of selectedMethods()) {
        advance(`collect ${method} with ${AUTHENTICATION === "credentials" ? "explicit AD credentials" : "current-user authentication"}`);
        await workspace.getByRole("button", { name: /Collection method/u }).click();
        await workspace.getByRole("option", { name: METHOD_LABELS[method], exact: true }).click();
        const before = new Set(await readdir(archiveDirectory).catch(() => []));
        const previous: AdCollectorProgress | null = await collectorProgress(workspace);
        if (credentialsPath) await fillAdCredentials(workspace, credentialsPath);
        const startedAt = Date.now();
        await workspace.getByRole("button", { name: "Run collector", exact: true }).click();
        await waitForImport(workspace, waitBudget(), targetId, previous?.runId, report);
        if (credentialsPath) await verifyCredentialsCleared(workspace);
        advance(`verify automatic ${method} graph`);
        const explorers: Page[] = application.windows().filter((page) => page.url().includes("surface=beagle"));
        assert.equal(explorers.length, 1, "Collection must open or reuse exactly one project window");
        const explorer = explorers[0]!;
        if (projectWindow) assert.equal(explorer, projectWindow, "Repeated imports must refresh the existing graph window");
        projectWindow = explorer;
        // The fresh overview snapshot distinguishes a refreshed graph from a
        // previously visible canvas on repeated imports. No test query runs first.
        await explorer.waitForFunction(async (startedAt) => {
          const workspace = await (globalThis as unknown as ExplorerBrowser).beagle.getWorkspace();
          if (!workspace.ok) return false;
          const latest = workspace.value.history.entries.at(-1);
          return latest?.title === "Directory overview" && Date.parse(latest.createdAt) >= startedAt;
        }, startedAt);
        await explorer.getByTestId("beagle-node").first().waitFor();
        await explorer.waitForFunction(() => (globalThis as unknown as GraphBrowser).document.querySelector('[data-testid="beagle-graph"]')?.getAttribute("aria-busy") === "false");
        const state = await explorer.evaluate(() => (globalThis as unknown as ExplorerBrowser).beagle.getState());
        assert(state.ok, "Imported project state unavailable");
        assert.equal(state.value.projects.find((project) => project.id === state.value.selectedProjectId)?.name, `AD ${expectedDomain}`);
        assert(state.value.stats && state.value.stats.nodes > 0, "Imported dataset is empty");
        if (projectId) assert.equal(state.value.selectedProjectId, projectId, "Repeated collections must merge into the same domain project");
        projectId = state.value.selectedProjectId;
        const count = await explorer.evaluate(() => (globalThis as unknown as ExplorerBrowser).beagle.query({ cypher: "MATCH (n) RETURN count(n) AS nodes" }));
        assert(count.ok, "Imported graph query failed");
        assert.equal(Number(count.value.rows[0]?.["nodes"]), state.value.stats.nodes);
        advance(`verify ${method} managed ZIP and import provenance`);
        const archives = (await readdir(archiveDirectory)).filter((name) => name.endsWith(".zip") && !before.has(name));
        assert.equal(archives.length, 1, "Expected exactly one new managed ZIP");
        const archive = await readFile(join(archiveDirectory, archives[0]!));
        try {
          assert(isCompleteZipEnvelope(archive), "Managed ZIP envelope is incomplete");
          assert.equal(collectedRustHoundDomain(archive, expectedDomain), expectedDomain);
          const archiveSha256 = createHash("sha256").update(archive).digest("hex");
          assert(state.value.projectData?.history.some((record) => record.status === "complete" && record.files.some((file) => file.sha256 === archiveSha256)),
            "Beagle provenance must identify the untouched managed ZIP");
          runs.push({ mode, method, domain: expectedDomain, archiveSha256, archiveBytes: archive.length, projectId: state.value.selectedProjectId,
            nodes: state.value.stats.nodes, edges: state.value.stats.edges, displayedNodes: await explorer.getByTestId("beagle-node").count(), elapsedMs: Date.now() - startedAt });
        } finally { archive.fill(0); }
        if (outputBase) await explorer.screenshot({ path: join(root, `${method}-automatic-graph.png`), animations: "disabled" });
        report(`${method} collection, import, and populated graph verified`);
      }
      advance("verify renderer and CSP diagnostics");
      assert.equal(pageErrors, 0, "Renderer errors occurred");
      assert.equal(cspErrors, 0, "CSP errors occurred");
    } catch (cause) {
      failed = true;
      failureKind = classifyFailure(cause);
      if (AUTHENTICATION !== "credentials" && outputBase && workspace && !workspace.isClosed()) {
        await workspace.screenshot({ path: join(root, "failure.png"), animations: "disabled" }).catch(() => undefined);
      }
      // Never include the renderer body, raw RPC output, or operator credentials in a test failure.
      throw new Error(`Live AD collector test failed during: ${stage} (${failureKind}). ${outputBase ? `Private evidence: ${root}` : "Set OUTPUT_DIR to retain private evidence."}`);
    } finally {
      let cleanupFailed = false;
      if (failed && workspace && !workspace.isClosed()) {
        await workspace.evaluate(async () => {
          const api = (globalThis as unknown as WorkspaceBrowser).sliver;
          const progress = await api.getAdCollectorProgress();
          if (progress.ok && progress.value?.cancellable) await api.cancelAdCollector({ runId: progress.value.runId });
        }).catch(() => undefined);
      }
      if (credentialsPath && workspace && !workspace.isClosed()) await clearAdCredentialInputs(workspace).catch(() => undefined);
      await application?.close().catch(() => { failed = true; cleanupFailed = true; });
      await rm(copiedProfile, { force: true }).catch(() => { failed = true; cleanupFailed = true; });
      if (outputBase) await writeFile(join(root, "summary.json"), JSON.stringify({ mode, authentication: AUTHENTICATION, targetId, dllSha256, expectedOutcome: EXPECTED_OUTCOME,
        passed: !failed, successfulCollections: runs.length, stage, failureKind, pageErrors, cspErrors, cancellation, runs, noCredentialsRuns }, null, 2), { mode: 0o600 });
      else await rm(root, { recursive: true, force: true }).catch(() => { cleanupFailed = true; });
      if (cleanupFailed) throw new Error("Could not clean up the isolated live-test process or profile");
    }
  });
}

function required(name: string): string {
  const value = process.env[`${PREFIX}${name}`]?.trim();
  assert(value, `Set ${PREFIX}${name}`);
  return value;
}
function requiredPath(name: string): string {
  const value = required(name);
  assert(isAbsolute(value), `${PREFIX}${name} must be absolute`);
  return value;
}
function selectedModes(): TargetMode[] {
  const modes = (process.env[`${PREFIX}MODES`] ?? "session,beacon").split(",");
  assert(modes.length > 0 && modes.every((mode) => mode === "session" || mode === "beacon"), "MODES must contain session and/or beacon");
  return [...new Set(modes)] as TargetMode[];
}
function selectedMethods(): Method[] {
  const methods = (process.env[`${PREFIX}METHODS`] ?? "LdapOnly").split(",");
  assert(methods.length > 0 && methods.every((method) => RUSTHOUND_COLLECTION_METHODS.includes(method as Method)), "METHODS must contain LdapOnly, DCOnly, and/or All");
  return [...new Set(methods)] as Method[];
}
function waitBudget(): number {
  const value = Number(process.env[`${PREFIX}WAIT_MS`] ?? 20 * 60_000);
  assert(Number.isSafeInteger(value) && value >= 30_000 && value <= 4 * 60 * 60_000, "WAIT_MS must be between 30000 and 14400000");
  return value;
}
async function fillAdCredentials(page: Page, path: string): Promise<void> {
  const metadata = await lstat(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), "CREDENTIALS_FILE must be a regular file, not a symlink");
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const bytes = Buffer.alloc(16 * 1024 + 1);
  let parsed: Record<string, unknown> | undefined;
  try {
    const stat = await handle.stat();
    assert(stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024, "CREDENTIALS_FILE must be a nonempty regular file of at most 16 KiB");
    if (process.platform !== "win32") assert.equal(stat.mode & 0o777, 0o600, "CREDENTIALS_FILE must have private 0600 permissions");
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    assert(length === stat.size, "CREDENTIALS_FILE changed or exceeded its size limit while reading");
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    assert(value && typeof value === "object" && !Array.isArray(value), "CREDENTIALS_FILE must contain a credentials object");
    parsed = value as Record<string, unknown>;
    assert(Object.keys(parsed).length === 2 && Object.hasOwn(parsed, "username") && Object.hasOwn(parsed, "password"),
      "CREDENTIALS_FILE must contain only username and password");
    assert(typeof parsed["username"] === "string" && parsed["username"].length > 0 && parsed["username"].length <= 255 &&
      parsed["username"].trim() === parsed["username"] && Buffer.byteLength(parsed["username"], "utf8") <= 256 && !/[\\\x00-\x1f\x7f]/u.test(parsed["username"]),
    "CREDENTIALS_FILE must contain a valid AD username or UPN");
    assert(typeof parsed["password"] === "string" && parsed["password"].length > 0 &&
      Buffer.byteLength(parsed["password"], "utf8") <= 1024 && !parsed["password"].includes("\0"), "CREDENTIALS_FILE must contain a valid password");
    bytes.fill(0);
    const password = page.getByLabel("AD password", { exact: true });
    assert.equal(await password.getAttribute("type"), "password", "AD password must remain masked");
    await page.getByLabel("AD user", { exact: true }).fill(parsed["username"]);
    await password.fill(parsed["password"]);
  } finally {
    bytes.fill(0);
    if (parsed) { parsed["username"] = ""; parsed["password"] = ""; parsed = undefined; }
    await handle.close();
  }
}
async function verifyCredentialsCleared(page: Page): Promise<void> {
  const password = page.getByLabel("AD password", { exact: true });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await password.inputValue() === "") {
      await clearAdCredentialInputs(page);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("The application must clear the AD password after collection or cancellation");
}
async function clearAdCredentialInputs(page: Page): Promise<void> {
  for (const label of ["AD password", "AD user"]) {
    const input = page.getByLabel(label, { exact: true });
    if (await input.count()) await input.fill("", { timeout: 2_000 });
  }
}
async function connect(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Saved configurations", exact: true });
  await dialog.waitFor();
  const options = dialog.getByRole("option");
  assert.equal(await options.count(), 1, "The test profile must expose only one operator configuration");
  if (await options.first().getAttribute("aria-selected") !== "true") await options.first().click();
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 60_000 });
  const mismatch = page.getByRole("dialog", { name: "Server version mismatch", exact: true });
  await mismatch.waitFor({ timeout: 3_000 }).catch(() => undefined);
  if (await mismatch.isVisible()) await mismatch.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
}
async function findTarget(page: Page, mode: TargetMode, id: string): Promise<TargetCatalogEntry> {
  const response = await page.evaluate(({ mode, id }) => (globalThis as unknown as WorkspaceBrowser).sliver.listTargets({ mode, query: id, limit: 100 }), { mode, id });
  assert(response.ok, "Target inventory unavailable");
  const entry = response.value.items.find((item) => item.target.id === id);
  assert(entry, "The exact authorized target is unavailable");
  return entry;
}
async function waitForValue(input: ReturnType<Page["getByRole"]>, value: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await input.inputValue() === value) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await input.inputValue(), value, "The target's DNS domain was not filled automatically");
}
async function waitForImport(page: Page, milliseconds: number, targetId: string, previousRunId: string | undefined, report: (message: string) => unknown): Promise<void> {
  const success = page.getByText("RustHound data was saved and imported into AD Explorer.", { exact: true });
  const deadline = Date.now() + milliseconds;
  let lastPhase = "";
  let lastReport = 0;
  while (Date.now() < deadline) {
    const progress = await collectorProgress(page);
    // Old success text and terminal progress can survive until the renderer
    // submits the next request. Only that next run can satisfy this wait.
    if (progress && progress.runId !== previousRunId && progress.targetId === targetId) {
      if (AD_COLLECTOR_PHASES.includes(progress.phase) && (progress.phase !== lastPhase || Date.now() - lastReport >= 30_000)) {
        report(`collector phase: ${progress.phase}`);
        lastPhase = progress.phase; lastReport = Date.now();
      }
      if (progress.phase === "failed") throw new LiveCollectionError("native-collection-failed");
      if (progress.phase === "cancelled") throw new LiveCollectionError("collection-cancelled");
      if (progress.phase === "complete" && progress.result?.state === "saved") throw new LiveCollectionError("automatic-import-failed");
      if (progress.phase === "complete" && await success.isVisible()) return;
    }
    if (await page.getByText("Collection failed", { exact: true }).count()) throw new LiveCollectionError("native-collection-failed");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new LiveCollectionError("collector-or-import-deadline");
}
async function collectorProgress(page: Page): Promise<AdCollectorProgress | null> {
  const response = await page.evaluate(() => (globalThis as unknown as WorkspaceBrowser).sliver.getAdCollectorProgress());
  assert(response.ok, "Collection progress unavailable");
  return response.value;
}
async function waitForNoCredentials(page: Page, milliseconds: number, targetId: string, previousRunId: string | undefined, report: (message: string) => unknown): Promise<void> {
  const deadline = Date.now() + milliseconds;
  let lastPhase = "";
  let lastReport = 0;
  while (Date.now() < deadline) {
    const progress = await collectorProgress(page);
    if (progress && progress.runId !== previousRunId && progress.targetId === targetId) {
      if (AD_COLLECTOR_PHASES.includes(progress.phase) && (progress.phase !== lastPhase || Date.now() - lastReport >= 30_000)) {
        report(`expected rejection phase: ${progress.phase}`);
        lastPhase = progress.phase; lastReport = Date.now();
      }
      if (progress.phase === "failed") {
        assert.equal(progress.message, NO_CREDENTIALS_MESSAGE, "The native failure must be the fixed missing-domain-credentials error");
        assert.equal(progress.cancellable, false, "The rejected collection must be terminal");
        assert.equal(progress.result, undefined, "Rejected authentication must not return a collection result");
        const alert = page.getByRole("alert").filter({ hasText: NO_CREDENTIALS_MESSAGE }).first();
        await alert.waitFor();
        assert.equal(await alert.innerText(), NO_CREDENTIALS_MESSAGE, "The UI must show the exact fixed credential error");
        return;
      }
      if (progress.phase === "complete" || progress.phase === "cancelled") throw new LiveCollectionError("unexpected-collection-outcome");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new LiveCollectionError("expected-no-credentials-deadline");
}
async function managedZipFiles(clientRoot: string): Promise<string[]> {
  try {
    return (await readdir(join(clientRoot, "gui", "ad-explorer", "collections"), { recursive: true }))
      .filter((name) => name.toLowerCase().endsWith(".zip")).sort();
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
}
async function recoveryArtifactCount(page: Page): Promise<number> {
  const response = await page.evaluate(() => (globalThis as unknown as WorkspaceBrowser).sliver.listAdCollectionArtifacts());
  assert(response.ok, "Cannot verify saved collection recovery artifacts");
  return response.value.length;
}
async function cancelInFlight(page: Page, targetId: string, milliseconds: number, report: (message: string) => unknown): Promise<number> {
  const previous = await collectorProgress(page);
  const startedAt = Date.now();
  const deadline = startedAt + milliseconds;
  let runId: string | undefined;
  let lastPhase = "";
  let lastReport = 0;
  await page.getByRole("button", { name: "Run collector", exact: true }).click();
  while (Date.now() < deadline) {
    const progress = await collectorProgress(page);
    if (progress && progress.targetId === targetId && progress.runId !== previous?.runId) {
      if (AD_COLLECTOR_PHASES.includes(progress.phase) && (progress.phase !== lastPhase || Date.now() - lastReport >= 30_000)) {
        report(`cancellation exercise phase: ${progress.phase}`);
        lastPhase = progress.phase; lastReport = Date.now();
      }
      if (progress.phase === "failed") throw new LiveCollectionError("native-collection-failed");
      if (!runId) {
        if (["complete", "cancelled", "transferring", "saving", "importing", "opening"].includes(progress.phase)) throw new LiveCollectionError("cancellation-window-missed");
        if (progress.phase === "collecting" && progress.cancellable) {
          runId = progress.runId;
          await page.getByRole("button", { name: "Cancel collection", exact: true }).click();
        }
      } else if (progress.runId === runId) {
        if (progress.phase === "complete") throw new LiveCollectionError("cancellation-window-missed");
        if (progress.phase === "cancelled") {
          assert.equal(progress.result?.state, "cancelled", "Cancellation must have a terminal result");
          assert.equal(progress.cancellable, false);
          return Date.now() - startedAt;
        }
      }
    }
    if (await page.getByText("Collection failed", { exact: true }).count()) throw new LiveCollectionError("native-collection-failed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new LiveCollectionError("cancellation-deadline");
}
function classifyFailure(cause: unknown): string {
  if (cause instanceof LiveCollectionError) return cause.kind;
  if (cause instanceof assert.AssertionError) return "acceptance-assertion";
  if (cause instanceof Error && cause.name === "TimeoutError") return "UI-or-bridge-timeout";
  if (cause instanceof Error && cause.name === "AbortError") return "test-aborted";
  return "setup-or-bridge-failure";
}
