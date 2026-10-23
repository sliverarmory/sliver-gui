import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { BeagleAPI } from "../shared/beagle-contracts.js";

interface BeagleBrowser { beagle: BeagleAPI }

test("fresh AD Explorer uses bundled Beagle without a runtime setup prompt", { timeout: 90_000 }, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const executablePath = process.env["SLIVER_BEAGLE_E2E_APP"];
  const root = await mkdtemp(join(tmpdir(), "sliver-beagle-bundled-e2e-"));
  const artifacts = join(repositoryRoot, "artifacts/e2e");
  const artifactName = executablePath ? "beagle-bundled-packaged" : "beagle-bundled";
  const isolatedHome = join(root, "home");
  const userDataDirectory = join(root, "user-data");
  let application: ElectronApplication | undefined;
  let explorer: Page | undefined;
  const errors: string[] = [];
  try {
    await Promise.all(["saved", "managed", "user-data", "client"].map((name) => mkdir(join(root, name))));
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(root, "client/armories.json"), "[]", { mode: 0o600 });
    await mkdir(join(isolatedHome, ".sliver-client/configs"), { recursive: true });
    await writeFile(join(isolatedHome, ".sliver-client/armories.json"), "[]", { mode: 0o600 });
    const environment = { ...process.env };
    delete environment["SLIVER_BEAGLE_BINARY"];
    delete environment["SLIVER_BEAGLE_SHA256"];
    application = await electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        ...(executablePath ? [`--user-data-dir=${userDataDirectory}`] : [
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"), `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(root, "saved")}`, `--managed-config-directory=${join(root, "managed")}`,
        `--user-data-directory=${userDataDirectory}`, `--console-client-root-directory=${join(root, "client")}`])],
      env: {
        ...environment, HOME: isolatedHome, USERPROFILE: isolatedHome, XDG_CONFIG_HOME: join(isolatedHome, ".config"),
        ...(process.platform === "darwin" ? { CFFIXED_USER_HOME: isolatedHome } : {}),
      },
      cwd: repositoryRoot, timeout: 30_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => ownedProcess.kill("SIGKILL"), { once: true });
    const observe = (page: Page): void => {
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (/Content Security Policy/iu.test(message.text())) errors.push(message.text()); });
    };
    application.on("window", observe);
    const workspace = await application.firstWindow();
    observe(workspace);
    await workspace.waitForLoadState("domcontentloaded");
    if (executablePath) {
      const packaged = await application.evaluate(({ app }) => ({ isPackaged: app.isPackaged, appPath: app.getAppPath() }));
      assert.equal(packaged.isPackaged, true);
      assert.match(packaged.appPath, /app\.asar$/u);
    }
    const opened = application.waitForEvent("window");
    void opened.catch(() => undefined);
    await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("beagle.open");
      if (!item) throw new Error("AD Explorer menu is missing");
      Reflect.apply(item.click, item, [item, undefined, {}]);
    });
    explorer = await opened;
    await explorer.waitForURL("**?surface=beagle");
    await explorer.getByLabel("Cypher query", { exact: true }).waitFor();
    const state = await explorer.evaluate(() => (globalThis as unknown as BeagleBrowser).beagle.getState());
    assert.ok(state.ok, state.error ?? "Cannot read Beagle state");
    assert.equal(state.value.runtime.available, true, state.value.runtime.error ?? "Bundled runtime is unavailable");
    assert.equal(state.value.runtime.source, "Bundled Beagle");
    assert.equal(state.value.stats?.nodes, 0);
    assert.equal(state.value.stats?.edges, 0);
    await explorer.getByText("Beagle ready", { exact: true }).waitFor();
    assert.equal(await explorer.getByRole("dialog", { name: "Beagle runtime settings", exact: true }).isVisible(), false);

    await explorer.getByLabel("Cypher query", { exact: true }).fill("RETURN $value AS value");
    await explorer.getByLabel("Parameters (JSON)", { exact: true }).fill('{"value":"Bundled Beagle is ready"}');
    await explorer.getByRole("button", { name: "Run query", exact: true }).click();
    await explorer.getByRole("tab", { name: "Table", exact: true }).click();
    const result = explorer.getByRole("table", { name: "Cypher results", exact: true });
    const value = result.locator("tbody td").first();
    await value.waitFor();
    assert.equal((await value.innerText()).trim(), "Bundled Beagle is ready");
    assert.equal(await explorer.getByRole("dialog", { name: "Beagle runtime settings", exact: true }).isVisible(), false);
    const configuration = JSON.parse(await readFile(join(userDataDirectory, "beagle/projects.json"), "utf8")) as {
      binaryPath: string | null; binarySha256: string | null;
    };
    assert.equal(configuration.binaryPath, null, "bundled discovery must not persist a custom override");
    assert.equal(configuration.binarySha256, null);
    await explorer.screenshot({ path: join(artifacts, `${artifactName}.png`), animations: "disabled" });
    assert.deepEqual(errors, []);
  } catch (error) {
    if (explorer && !explorer.isClosed()) {
      await explorer.screenshot({ path: join(artifacts, `${artifactName}-failure.png`), animations: "disabled" }).catch(() => undefined);
      await writeFile(join(artifacts, `${artifactName}-failure.txt`), await explorer.locator("body").innerText().catch(() => "unavailable"));
    }
    throw error;
  } finally {
    await application?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
