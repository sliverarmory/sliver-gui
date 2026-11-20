import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { BeagleAPI } from "../shared/beagle-contracts.js";
import { captureBeagleExecutable } from "../main/beagle-runtime-loader.js";

interface BeagleBrowser {
  beagle: BeagleAPI;
  sliver?: unknown;
  network?: unknown;
  armory?: unknown;
  innerWidth: number;
  document: {
    documentElement: { scrollWidth: number };
    querySelector(selector: string): { disabled?: boolean; textContent?: string | null;
      selectedOptions?: ArrayLike<{ textContent: string | null }>;
      getAttribute(name: string): string | null } | null;
  };
}

const binary = process.env["SLIVER_BEAGLE_E2E_BINARY"];
const collection = process.env["SLIVER_BEAGLE_E2E_COLLECTION"];

test("AD Explorer imports real GOAD, executes Cypher and renders an isolated graph window", {
  timeout: 180_000, skip: !binary || !collection ? "Set SLIVER_BEAGLE_E2E_BINARY and SLIVER_BEAGLE_E2E_COLLECTION to run real backend validation" : false,
}, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const root = await mkdtemp(join(tmpdir(), "sliver-beagle-e2e-"));
  let application: ElectronApplication | undefined;
  let explorer: Page | undefined;
  try {
    const identity = await captureBeagleExecutable(binary!);
    for (const name of ["saved", "managed", "user-data", "client"]) await mkdir(join(root, name));
    application = await electron.launch({
      args: ["--enable-sandbox", join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`, `--saved-config-directory=${join(root, "saved")}`,
        `--managed-config-directory=${join(root, "managed")}`, `--user-data-directory=${join(root, "user-data")}`,
        `--console-client-root-directory=${join(root, "client")}`],
      env: { ...process.env, SLIVER_BEAGLE_BINARY: identity.path, SLIVER_BEAGLE_SHA256: identity.sha256 },
      cwd: repositoryRoot, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const workspace = await application.firstWindow();
    await workspace.waitForLoadState("domcontentloaded");
    const open = () => application!.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("beagle.open");
      if (!item) throw new Error("AD Explorer menu is missing");
      Reflect.apply(item.click, item, [item, undefined, {}]);
    });
    const windowPromise = application.waitForEvent("window");
    await open();
    explorer = await windowPromise;
    explorer.setDefaultTimeout(15_000);
    const errors: string[] = [];
    explorer.on("pageerror", (error) => errors.push(error.message));
    explorer.on("console", (message) => { if (/Content Security Policy/iu.test(message.text())) errors.push(message.text()); });
    await explorer.waitForURL("**?surface=beagle");
    await explorer.getByRole("button", { name: "New project", exact: true }).waitFor();
    await explorer.waitForFunction(() => !((globalThis as unknown as BeagleBrowser).document.querySelector('[aria-label="New project"]'))?.disabled);
    const bridges = await explorer.evaluate(() => ({ frozen: Object.isFrozen((globalThis as unknown as BeagleBrowser).beagle),
      sliver: typeof (globalThis as unknown as BeagleBrowser).sliver, network: typeof (globalThis as unknown as BeagleBrowser).network, armory: typeof (globalThis as unknown as BeagleBrowser).armory }));
    assert.deepEqual(bridges, { frozen: true, sliver: "undefined", network: "undefined", armory: "undefined" });
    assert.equal(await workspace.evaluate(() => typeof (globalThis as unknown as BeagleBrowser).beagle), "undefined");
    const count = application.windows().length;
    await open();
    assert.equal(application.windows().length, count);
    const nativeWindow = await application.browserWindow(explorer);
    const preferences = await nativeWindow.evaluate((window) => window.webContents.getLastWebPreferences());
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);

    await explorer.getByRole("button", { name: "New project", exact: true }).click();
    await explorer.getByLabel("Project name", { exact: true }).fill("GOAD verification");
    await explorer.getByRole("button", { name: "Create project", exact: true }).click();
    await explorer.waitForFunction(() => ((globalThis as unknown as BeagleBrowser).document.querySelector('[aria-label="Project"]'))?.selectedOptions?.[0]?.textContent === "GOAD verification");
    await application.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
    }, collection!);
    await explorer.getByRole("button", { name: "Import data", exact: true }).click();
    await explorer.waitForFunction(() => (globalThis as unknown as BeagleBrowser).document.querySelector('[aria-label="Project summary"]')?.textContent?.includes("8,889"), { timeout: 60_000 });
    const state = await explorer.evaluate(() => (globalThis as unknown as BeagleBrowser).beagle!.getState());
    assert.ok(state.ok && state.value);
    assert.equal(state.value.stats?.nodes, 814);
    assert.equal(state.value.stats?.edges, 8_889);
    const projectId = state.value.selectedProjectId;
    const catalog = await explorer.evaluate(() => (globalThis as unknown as BeagleBrowser).beagle!.getQueries());
    assert.ok(catalog.ok && catalog.value?.length === 177);

    await explorer.getByLabel("Cypher query", { exact: true }).fill("MATCH (u:User) RETURN count(u) AS users");
    await explorer.getByRole("button", { name: "Run query", exact: true }).click();
    await explorer.waitForFunction(() => (globalThis as unknown as BeagleBrowser).document.querySelector(".beagle-result-summary")?.textContent?.includes("1 rows"));
    await explorer.getByRole("tab", { name: "Table", exact: true }).click();
    const scalarCell = explorer.locator('table[aria-label="Cypher results"] tbody td').first();
    await scalarCell.waitFor();
    assert.equal((await scalarCell.innerText()).trim(), "54");
    await explorer.getByLabel("Cypher query", { exact: true }).fill("MATCH p=(u:User)-[:MemberOf]->(g:Group) RETURN p LIMIT 12");
    await explorer.getByRole("button", { name: "Run query", exact: true }).click();
    await explorer.waitForFunction(() => (globalThis as unknown as BeagleBrowser).document.querySelector(".beagle-result-summary")?.textContent?.includes("12 rows"));
    await explorer.getByRole("tab", { name: "Graph", exact: true }).click();
    await explorer.getByTestId("beagle-node").first().waitFor();
    await explorer.waitForFunction(() => (globalThis as unknown as BeagleBrowser).document.querySelector('[data-testid="beagle-graph"]')?.getAttribute("aria-busy") === "false");
    assert.ok(await explorer.locator(".react-flow__edge").count() > 0);
    await explorer.locator(".react-flow__edge").first().focus();
    await explorer.locator(".react-flow__edge").first().press("Enter");
    await explorer.getByRole("heading", { name: "Relationship details", exact: true }).waitFor();
    await explorer.getByTestId("beagle-node").first().click();
    await explorer.getByRole("heading", { name: "Object details", exact: true }).waitFor();
    assert.equal(await explorer.getByRole("button", { name: "Set source", exact: true }).isVisible(), true);
    await explorer.getByLabel("Saved query name", { exact: true }).fill("GOAD memberships");
    await explorer.getByRole("button", { name: "Save query", exact: true }).click();
    assert.equal(await explorer.getByRole("button", { name: "View report", exact: true }).count(), 0);

    const rejectedWrite = await explorer.evaluate(() => (globalThis as unknown as BeagleBrowser).beagle!.query({ cypher: "CREATE (n:User {name:'not allowed'}) RETURN n" }));
    assert.equal(rejectedWrite.ok, false);
    const unchanged = await explorer.evaluate(() => (globalThis as unknown as BeagleBrowser).beagle!.getState());
    assert.ok(unchanged.ok && unchanged.value?.stats?.nodes === 814);
    const sentinelPath = join(root, "query-sentinel.csv");
    await writeFile(sentinelPath, "value\nprivate-test-sentinel\n", { mode: 0o600 });
    const rejectedRead = await explorer.evaluate((file) => (globalThis as unknown as BeagleBrowser).beagle!.query({
      cypher: "LOAD CSV WITH HEADERS FROM $file AS row RETURN row", parameters: { file },
    }), sentinelPath);
    assert.equal(rejectedRead.ok, false);
    assert.match(rejectedRead.error ?? "", /file|CSV/iu);
    const parameterized = await explorer.evaluate(() => (globalThis as unknown as BeagleBrowser).beagle!.query({
      cypher: "MATCH (n:User) WHERE n.name CONTAINS $name RETURN n LIMIT 5", parameters: { name: "ADMIN" },
    }));
    assert.ok(parameterized.ok && parameterized.value && parameterized.value.graph.nodes.length > 0);
    assert.equal(parameterized.value.projectId, projectId);

    const exportPath = join(root, "graph.json");
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
    }, exportPath);
    const exported = await explorer.evaluate(() => (globalThis as unknown as BeagleBrowser).beagle!.exportGraph());
    assert.ok(exported.ok && exported.value?.cancelled === false);
    const graph = JSON.parse(await readFile(exportPath, "utf8")) as { nodes: unknown[]; edges: unknown[] };
    assert.equal(graph.nodes.length, 814);
    assert.equal(graph.edges.length, 8_889);

    const artifacts = join(repositoryRoot, "artifacts", "e2e");
    await mkdir(artifacts, { recursive: true });
    await explorer.getByRole("button", { name: "Fit graph", exact: true }).click();
    await explorer.screenshot({ path: join(artifacts, "beagle-goad-graph.png"), animations: "disabled" });
    await nativeWindow.evaluate((window) => window.setSize(1000, 760));
    await explorer.waitForFunction(() => (globalThis as unknown as BeagleBrowser).innerWidth <= 1000);
    assert.equal(await explorer.evaluate(() => (globalThis as unknown as BeagleBrowser).document.documentElement.scrollWidth <= (globalThis as unknown as BeagleBrowser).innerWidth), true);
    await explorer.getByRole("button", { name: "Fit graph", exact: true }).click();
    await explorer.screenshot({ path: join(artifacts, "beagle-goad-narrow.png"), animations: "disabled" });
    await explorer.reload();
    await explorer.getByRole("tab", { name: "Queries", exact: true }).click();
    await explorer.getByRole("button", { name: "GOAD memberships", exact: true }).waitFor();
    const reopened = await explorer.evaluate(() => (globalThis as unknown as BeagleBrowser).beagle!.getState());
    assert.ok(reopened.ok && reopened.value?.selectedProjectId === projectId && reopened.value.stats?.nodes === 814);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (explorer && !explorer.isClosed()) {
      const failureDirectory = join(repositoryRoot, "artifacts", "e2e");
      await mkdir(failureDirectory, { recursive: true });
      await explorer.screenshot({ path: join(failureDirectory, "beagle-failure.png"), animations: "disabled" }).catch(() => undefined);
      await writeFile(join(failureDirectory, "beagle-failure.txt"), await explorer.locator("body").innerText().catch(() => "unavailable"));
    }
    throw error;
  } finally {
    await application?.close();
    await rm(root, { recursive: true, force: true });
  }
});
