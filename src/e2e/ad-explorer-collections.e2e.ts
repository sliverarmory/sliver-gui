import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import { resolveVerifiedBeagleRuntime } from "../main/beagle-runtime-loader.js";
import { BeagleService } from "../main/beagle-service.js";
import type { BeagleAPI } from "../shared/beagle-contracts.js";
import type { SliverDesktopAPI } from "../shared/contracts.js";

interface ExplorerBrowser {
  beagle: BeagleAPI;
  document: { querySelector(selector: string): { value?: string; disabled?: boolean } | null };
}
interface MainBrowser { sliver: SliverDesktopAPI }

const NORTH = { name: "AD north.example", user: "ALICE@NORTH.EXAMPLE" };
const SOUTH = { name: "AD south.example", user: "BOB@SOUTH.EXAMPLE" };

test("AD Explorer collections open independent dataset windows and preserve their selections", { timeout: 150_000 }, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const root = await mkdtemp(join(tmpdir(), "sliver-ad-collections-e2e-"));
  const artifacts = join(repositoryRoot, "artifacts/e2e");
  const userDataPath = join(root, "user-data");
  const isolatedHome = join(root, "home");
  const errors: string[] = [];
  let application: ElectronApplication | undefined;
  let workspace: Page | undefined;
  const explorers: Page[] = [];
  try {
    await Promise.all(["saved", "managed", "user-data", "client", "home"].map((name) => mkdir(join(root, name))));
    await mkdir(artifacts, { recursive: true });
    await mkdir(join(isolatedHome, ".sliver-client/configs"), { recursive: true });
    await Promise.all([
      writeFile(join(root, "client/armories.json"), "[]", { mode: 0o600 }),
      writeFile(join(isolatedHome, ".sliver-client/armories.json"), "[]", { mode: 0o600 }),
      writeFile(join(root, "saved/collections.cfg"), JSON.stringify({
        operator: "ad-collections-e2e", lhost: "127.0.0.1", lport: 31337,
        ca_certificate: "FAKE_CA_DO_NOT_RENDER", certificate: "FAKE_CERT_DO_NOT_RENDER",
        private_key: "FAKE_KEY_DO_NOT_RENDER", token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
      }), { mode: 0o600 }),
    ]);
    // Production imports create real local databases before launch. Only the
    // Sliver connection is a fixture; no live target or collection is used.
    const projects = await seedCollections(repositoryRoot, root, userDataPath);
    const environment = { ...process.env };
    delete environment["SLIVER_BEAGLE_BINARY"];
    delete environment["SLIVER_BEAGLE_SHA256"];
    application = await electron.launch({
      args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"), `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(root, "saved")}`, `--managed-config-directory=${join(root, "managed")}`,
        `--user-data-directory=${userDataPath}`, `--console-client-root-directory=${join(root, "client")}`],
      env: { ...environment, HOME: isolatedHome, USERPROFILE: isolatedHome, XDG_CONFIG_HOME: join(isolatedHome, ".config"),
        ...(process.platform === "darwin" ? { CFFIXED_USER_HOME: isolatedHome } : {}) },
      cwd: repositoryRoot, timeout: 30_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => ownedProcess.kill("SIGKILL"), { once: true });
    const observe = (page: Page): void => {
      page.setDefaultTimeout(20_000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (/Content Security Policy/iu.test(message.text())) errors.push(message.text()); });
    };
    application.on("window", observe);
    workspace = await application.firstWindow();
    observe(workspace);
    const mainWindow = await application.browserWindow(workspace);
    await mainWindow.evaluate((window) => window.setSize(1440, 950));
    await workspace.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Connect", exact: true }).click();
    await workspace.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    const themed = await workspace.evaluate(async () => {
      const api = (globalThis as unknown as MainBrowser).sliver;
      const { v: _version, revision, ...settings } = await api.getApplicationSettings();
      return api.updateApplicationSettings({ expectedRevision: revision, settings: { ...settings, theme: "dark" } });
    });
    assert.equal(themed.ok, true, themed.error ?? "Cannot select the fixture theme");
    await workspace.locator("html.dark").waitFor();
    await workspace.locator('[aria-label="AD Explorer"]:visible').click();
    await workspace.getByRole("heading", { name: "AD Explorer", exact: true }).waitFor();
    await workspace.locator(".page-heading .eyebrow").getByText("Active Directory", { exact: true }).waitFor();
    const targetsTab = workspace.getByRole("tab", { name: "Windows Targets", exact: true });
    const collectionsTab = workspace.getByRole("tab", { name: "Collections", exact: true });
    assert.equal(await targetsTab.getAttribute("aria-selected"), "true");
    await collectionsTab.click();
    assert.equal(await collectionsTab.getAttribute("aria-selected"), "true");
    await workspace.getByRole("button", { name: `Open collection ${NORTH.name}`, exact: true }).waitFor();
    await workspace.getByRole("button", { name: `Open collection ${SOUTH.name}`, exact: true }).waitFor();
    const catalog = await workspace.evaluate(() => (globalThis as unknown as MainBrowser).sliver.listAdCollections());
    assert.equal(catalog.ok, true, catalog.error ?? "Collection listing failed");
    assert.equal(application.windows().length, 1, "listing collections must not open an explorer");
    await workspace.mouse.move(0, 0);
    await workspace.getByText("Connected", { exact: true }).waitFor({ state: "hidden" });
    await workspace.screenshot({ path: join(artifacts, "ad-explorer-collections.png"), animations: "disabled" });
    await mainWindow.evaluate((window) => window.setSize(1000, 760));
    await workspace.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth === 1000);
    assert.equal(await workspace.evaluate(() => {
      const browser = globalThis as unknown as { innerWidth: number; document: { documentElement: { scrollWidth: number } } };
      return browser.document.documentElement.scrollWidth <= browser.innerWidth;
    }), true);
    await workspace.screenshot({ path: join(artifacts, "ad-explorer-collections-narrow.png"), animations: "disabled" });
    await mainWindow.evaluate((window) => window.setSize(1440, 950));

    const openCollection = async (name: string, id: string): Promise<Page> => {
      const opened = application!.waitForEvent("window");
      void opened.catch(() => undefined);
      await workspace!.getByRole("button", { name: `Open collection ${name}`, exact: true }).click();
      const explorer = await opened;
      explorers.push(explorer);
      await explorer.waitForURL("**?surface=beagle");
      await waitForProject(explorer, id);
      const state = await explorer.evaluate(() => (globalThis as unknown as ExplorerBrowser).beagle.getState());
      assert.ok(state.ok, state.error ?? "Cannot read selected dataset");
      assert.equal(state.value.selectedProjectId, id, "dataset must be selected when its window opens");
      assert.equal(state.value.runtime.source, "Bundled Beagle");
      assert.equal(state.value.stats?.nodes, 1);
      const nativeWindow = await application!.browserWindow(explorer);
      const preferences = await nativeWindow.evaluate((window) => window.webContents.getLastWebPreferences());
      assert.equal(preferences.sandbox, true);
      assert.equal(preferences.contextIsolation, true);
      assert.equal(preferences.nodeIntegration, false);
      return explorer;
    };
    const north = await openCollection(NORTH.name, projects.north);
    const south = await openCollection(SOUTH.name, projects.south);
    assert.equal(application.windows().length, 3);
    await Promise.all([
      assertDataset(north, projects.north, NORTH.user),
      assertDataset(south, projects.south, SOUTH.user),
    ]);
    await showDatasetQuery(north, NORTH.user);
    await showDatasetQuery(south, SOUTH.user);
    await north.screenshot({ path: join(artifacts, "ad-explorer-north-window.png"), animations: "disabled" });
    await south.screenshot({ path: join(artifacts, "ad-explorer-south-window.png"), animations: "disabled" });

    // A dataset switch in one window must not change another window's runtime,
    // query result, or selected project, including after a renderer reload.
    await south.getByLabel("Project", { exact: true }).selectOption(projects.north);
    await waitForProject(south, projects.north);
    await assertDataset(south, projects.north, NORTH.user);
    await south.getByLabel("Project", { exact: true }).selectOption(projects.south);
    await waitForProject(south, projects.south);
    await Promise.all([
      assertDataset(north, projects.north, NORTH.user),
      assertDataset(south, projects.south, SOUTH.user),
    ]);
    assert.equal((await north.getByRole("table", { name: "Cypher results", exact: true }).locator("tbody td").first().innerText()).trim(), NORTH.user);
    await north.reload();
    await waitForProject(north, projects.north);
    await assertDataset(north, projects.north, NORTH.user);
    await assertDataset(south, projects.south, SOUTH.user);

    const reused = await workspace.evaluate((projectId) => (globalThis as unknown as MainBrowser).sliver.openBeagleWindow({ projectId }), projects.north);
    assert.equal(reused.ok, true, reused.error ?? "Cannot focus existing dataset window");
    assert.equal(application.windows().length, 3, "opening an already-visible collection must focus its existing window");
    const ordinaryOpen = await workspace.evaluate(() => (globalThis as unknown as MainBrowser).sliver.openBeagleWindow());
    assert.equal(ordinaryOpen.ok, true, ordinaryOpen.error ?? "Cannot open explorer");
    assert.equal(application.windows().length, 3, "ordinary Open Explorer must reuse an existing window");
    await verifyCollapsibleCypher(application, north, artifacts);
    await north.close();
    await assertDataset(south, projects.south, SOUTH.user);
    assert.deepEqual(errors, []);
  } catch (error) {
    for (const [index, page] of [workspace, ...explorers].entries()) {
      if (!page || page.isClosed()) continue;
      await page.screenshot({ path: join(artifacts, `ad-explorer-collections-failure-${index}.png`), animations: "disabled" }).catch(() => undefined);
      await writeFile(join(artifacts, `ad-explorer-collections-failure-${index}.txt`), await page.locator("body").innerText().catch(() => "unavailable"));
    }
    throw error;
  } finally {
    await application?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function seedCollections(repositoryRoot: string, root: string, userDataPath: string): Promise<{ north: string; south: string }> {
  const service = new BeagleService({ userDataPath,
    environment: { SLIVER_BEAGLE_BINARY: undefined, SLIVER_BEAGLE_SHA256: undefined },
    resolveBundledRuntime: () => resolveVerifiedBeagleRuntime({ isPackaged: false, resourcesPath: repositoryRoot, developmentRoot: repositoryRoot }),
  });
  try {
    const initial = await service.getState();
    assert.equal(initial.runtime.available, true, initial.runtime.error ?? "Bundled Beagle is unavailable");
    const north = initial.selectedProjectId;
    await service.renameProject({ id: north, name: NORTH.name });
    const importDataset = async (name: string, user: string): Promise<void> => {
      const path = join(root, `${name}.json`);
      await writeFile(path, JSON.stringify({ meta: { type: "users", version: 6, count: 1 }, data: [
        { ObjectIdentifier: `USER-${name}`, Properties: { name: user, enabled: true } },
      ] }), { mode: 0o600 });
      assert.equal((await service.importFiles([path])).state.stats?.nodes, 1);
    };
    await importDataset("north", NORTH.user);
    const south = (await service.createProject({ name: SOUTH.name })).selectedProjectId;
    await importDataset("south", SOUTH.user);
    return { north, south };
  } finally { await service.dispose(); }
}

async function waitForProject(page: Page, projectId: string): Promise<void> {
  await page.waitForFunction((id) => {
    const select = (globalThis as unknown as ExplorerBrowser).document.querySelector('[aria-label="Project"]');
    return select?.value === id && select.disabled === false;
  }, projectId);
}

async function assertDataset(page: Page, projectId: string, user: string): Promise<void> {
  const result = await page.evaluate(() => (globalThis as unknown as ExplorerBrowser).beagle.query({
    cypher: "MATCH (u:User) RETURN u.name AS name ORDER BY name",
  }));
  assert.ok(result.ok, result.error ?? "Dataset query failed");
  assert.equal(result.value.projectId, projectId);
  assert.deepEqual(result.value.rows, [{ name: user }]);
  const state = await page.evaluate(() => (globalThis as unknown as ExplorerBrowser).beagle.getState());
  assert.ok(state.ok, state.error ?? "Cannot read selected dataset");
  assert.equal(state.value.selectedProjectId, projectId);
}

async function showDatasetQuery(page: Page, user: string): Promise<void> {
  await page.getByLabel("Cypher query", { exact: true }).fill("MATCH (u:User) RETURN u.name AS name ORDER BY name");
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await page.getByRole("tab", { name: "Table", exact: true }).click();
  const cell = page.getByRole("table", { name: "Cypher results", exact: true }).locator("tbody td").first();
  await cell.waitFor();
  assert.equal((await cell.innerText()).trim(), user);
}

async function verifyCollapsibleCypher(application: ElectronApplication, page: Page, artifacts: string): Promise<void> {
  const query = page.getByLabel("Cypher query", { exact: true });
  const parameters = page.getByLabel("Parameters (JSON)", { exact: true });
  await query.fill("MATCH (u:User) WHERE u.name = $name RETURN u");
  await parameters.fill(JSON.stringify({ name: NORTH.user }));
  await page.getByRole("button", { name: "Run query", exact: true }).click();
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  await page.getByTestId("beagle-node").first().waitFor();

  // Unsaved text must survive collapsing the controls independently of the
  // currently displayed query result and its saved investigation history.
  const draftQuery = "MATCH (u:User) WHERE u.name = $name RETURN u LIMIT 10";
  const draftParameters = JSON.stringify({ name: NORTH.user }, null, 2);
  const drafts = [
    ["Saved query name", "North investigation draft"],
    ["Saved query category", "Directory review"],
    ["Saved query description", "Keep this unsaved description when collapsing the editor."],
  ] as const;
  await query.fill(draftQuery);
  await parameters.fill(draftParameters);
  for (const [label, value] of drafts) await page.getByLabel(label, { exact: true }).fill(value);
  const nativeWindow = await application.browserWindow(page);
  const measurements: { width: number; expanded: number; collapsed: number; gained: number }[] = [];
  for (const [width, height] of [[1440, 920], [1000, 760]] as const) {
    await nativeWindow.evaluate((window, size) => window.setSize(size.width, size.height), { width, height });
    await page.waitForFunction((expectedWidth) => (globalThis as unknown as { innerWidth: number }).innerWidth === expectedWidth, width);
    const graph = page.getByTestId("beagle-graph");
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(artifacts, `ad-explorer-cypher-expanded-${width}.png`), animations: "disabled" });
    const expanded = await graph.boundingBox();
    assert.ok(expanded, "expanded editor must leave a visible graph");
    await page.getByRole("button", { name: "Collapse Cypher editor", exact: true }).click();
    await page.getByRole("button", { name: "Expand Cypher editor", exact: true }).waitFor();
    await query.waitFor({ state: "hidden" });
    assert.equal(await parameters.isVisible(), false);
    await page.waitForFunction((before) => {
      const browser = globalThis as unknown as { document: { querySelector(selector: string): { getBoundingClientRect(): { height: number } } | null } };
      return (browser.document.querySelector('[data-testid="beagle-graph"]')?.getBoundingClientRect().height ?? 0) > before;
    }, expanded.height);
    assert.equal(await page.getByTestId("beagle-node").first().isVisible(), true, "collapsing must keep the current graph visible");
    if (width === 1440) {
      const previousResults = await page.getByLabel("Resume investigation", { exact: true }).locator("option").count();
      await page.getByRole("button", { name: "Run query", exact: true }).click();
      await page.waitForFunction((previous) => {
        const browser = globalThis as unknown as { document: { querySelector(selector: string): { options: { length: number } } | null } };
        return (browser.document.querySelector('[aria-label="Resume investigation"]')?.options.length ?? 0) > previous;
      }, previousResults);
      await graph.getByText(NORTH.user, { exact: true }).waitFor();
      assert.equal(await query.isVisible(), false, "running from the collapsed toolbar must not reopen the editor");
    }
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(artifacts, `ad-explorer-cypher-collapsed-${width}.png`), animations: "disabled" });
    const collapsed = await graph.boundingBox();
    assert.ok(collapsed);
    measurements.push({ width, expanded: expanded.height, collapsed: collapsed.height, gained: collapsed.height - expanded.height });
    await page.getByRole("button", { name: "Expand Cypher editor", exact: true }).click();
    await query.waitFor();
    assert.equal(await query.inputValue(), draftQuery);
    assert.equal(await parameters.inputValue(), draftParameters);
    for (const [label, value] of drafts) assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), value);
  }
  await writeFile(join(artifacts, "ad-explorer-cypher-measurements.json"), JSON.stringify(measurements, null, 2));
}
