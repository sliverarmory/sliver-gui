import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { ArmoryAPI } from "../shared/armory-contracts.js";

test("Armory shares local console packages through an isolated native window", { timeout: 90_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-armory-e2e-"));
  const clientRoot = join(temporaryRoot, "client");
  const repositoryUrl = "HTTPS://Packages.Example/fixture-bof?tab=readme#overview";
  const canonicalRepositoryUrl = "https://packages.example/fixture-bof?tab=readme#overview";
  let application: ElectronApplication | undefined;
  try {
    for (const name of ["saved", "managed", "user-data", "client"]) await mkdir(join(temporaryRoot, name));
    await writeFile(join(clientRoot, "armories.json"), "[]", { mode: 0o600 });
    const manifest = Buffer.from(JSON.stringify({
      name: "Fixture BOF", command_name: "fixture-bof", version: "1.0.0", help: "Harmless package fixture",
      original_author: "Fixture Original Author", extension_author: "Fixture Extension Author",
      repo_url: repositoryUrl,
      files: [{ os: "windows", arch: "amd64", path: "/fixture.x64.o" }],
    }));
    const artifact = Buffer.from("inert test fixture; never executed");
    const archive = gzipSync(Buffer.concat([
      tarFile("extension.json", manifest), tarFile("fixture.x64.o", artifact), Buffer.alloc(1024),
    ]));
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = Buffer.from("1234567890abcdef", "hex");
    const key = Buffer.concat([Buffer.from("Ed"), keyId, publicKey.export({ type: "spki", format: "der" }).subarray(-32)]).toString("base64");
    const messageSignature = sign(null, createHash("blake2b512").update(archive).digest(), privateKey);
    const comment = manifest.toString("base64");
    const signature = ["untrusted comment: E2E fixture", Buffer.concat([Buffer.from("ED"), keyId, messageSignature]).toString("base64"),
      `trusted comment: ${comment}`, sign(null, Buffer.concat([messageSignature, Buffer.from(comment)]), privateKey).toString("base64"), ""].join("\n");
    const archivePath = join(temporaryRoot, "fixture-bof.tar.gz");
    const signaturePath = join(temporaryRoot, "fixture-bof.minisig");
    await writeFile(archivePath, archive);
    await writeFile(signaturePath, signature);
    application = await electron.launch({
      args: ["--enable-sandbox", join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`, `--saved-config-directory=${join(temporaryRoot, "saved")}`,
        `--managed-config-directory=${join(temporaryRoot, "managed")}`, `--user-data-directory=${join(temporaryRoot, "user-data")}`,
        `--console-client-root-directory=${clientRoot}`],
      cwd: repositoryRoot, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const workspace = await application.firstWindow();
    await workspace.waitForLoadState("domcontentloaded");
    await menu(application, "armory.manage");
    const armory = await armoryPage(application);
    armory.setDefaultTimeout(10_000);
    const errors: string[] = [];
    armory.on("pageerror", (error) => errors.push(error.message));
    armory.on("console", (message) => {
      if (/Content Security Policy/iu.test(message.text())) errors.push(message.text());
    });
    await armory.getByRole("tab", { name: /^Manage/u }).waitFor();
    const bridge = await armory.evaluate(() => {
      const browser = globalThis as unknown as { armory: ArmoryAPI; sliver?: unknown; network?: unknown };
      return { frozen: Object.isFrozen(browser.armory), sliver: typeof browser.sliver, network: typeof browser.network };
    });
    assert.deepEqual(bridge, { frozen: true, sliver: "undefined", network: "undefined" });
    const windowCount = application.windows().length;
    await menu(application, "armory.install");
    await armory.locator('[role="tab"][aria-selected="true"]', { hasText: "Install" }).waitFor();
    assert.equal(application.windows().length, windowCount);
    await application.evaluate(({ dialog }, paths) => {
      let index = 0;
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [paths[index++]!] })) as typeof dialog.showOpenDialog;
    }, [archivePath, signaturePath]);
    await armory.getByRole("button", { name: "Import Signed Package", exact: true }).click();
    const importDialog = armory.getByRole("dialog", { name: "Import Signed Package", exact: true });
    await importDialog.getByLabel("Trusted Public Key", { exact: true }).fill(key);
    await importDialog.getByRole("button", { name: "Choose Archive and Signature", exact: true }).click();
    await importDialog.waitFor({ state: "hidden" });
    assert.deepEqual(await readFile(join(clientRoot, "extensions", "fixture-bof", "extension.json")), manifest);
    assert.deepEqual(await readFile(join(clientRoot, "extensions", "fixture-bof", "fixture.x64.o")), artifact);
    await menu(application, "armory.sources");
    await armory.locator('[role="tab"][aria-selected="true"]', { hasText: "Sources" }).waitFor();
    await menu(application, "armory.manage");
    await armory.getByText("fixture-bof", { exact: true }).first().waitFor();
    const fixtureRow = armory.getByRole("list", { name: "Installed packages" }).getByRole("listitem").filter({ hasText: "fixture-bof" });
    const fixturePlatforms = fixtureRow.getByRole("group", { name: "Supported platforms" });
    assert.equal(await fixturePlatforms.innerText(), "Windows · x64");
    assert.equal(await fixturePlatforms.locator('[data-icon="windows"]').count(), 1);
    await fixtureRow.getByRole("button", { name: "Details", exact: true }).click();
    const details = armory.getByRole("dialog", { name: "fixture-bof", exact: true });
    await details.getByText("Fixture Original Author", { exact: true }).waitFor();
    await details.getByText("Fixture Extension Author", { exact: true }).waitFor();
    await application.evaluate(({ clipboard, shell }) => {
      const state = globalThis as unknown as { __armoryClipboardWrites?: string[]; __armoryExternalUrls?: string[] };
      state.__armoryClipboardWrites = [];
      state.__armoryExternalUrls = [];
      clipboard.writeText = (text) => { state.__armoryClipboardWrites?.push(text); };
      shell.openExternal = async (url) => { state.__armoryExternalUrls?.push(url); };
    });
    const armoryUrl = armory.url();
    const windowsBeforeRepositoryClick = application.windows().length;
    await details.getByRole("link", { name: `${repositoryUrl} (opens in browser)`, exact: true }).click();
    const copyResult = await armory.evaluate((publicKey) =>
      (globalThis as unknown as { armory: ArmoryAPI }).armory.copyPublicKey({ publicKey }), key);
    const nativeEffects = await application.evaluate(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const state = globalThis as unknown as { __armoryClipboardWrites?: string[]; __armoryExternalUrls?: string[] };
      return { clipboardWrites: state.__armoryClipboardWrites ?? [], externalUrls: state.__armoryExternalUrls ?? [] };
    });
    assert.deepEqual(copyResult, { ok: true });
    assert.deepEqual(nativeEffects.clipboardWrites, [key]);
    assert.deepEqual(nativeEffects.externalUrls, [canonicalRepositoryUrl]);
    assert.equal(armory.url(), armoryUrl);
    assert.equal(application.windows().length, windowsBeforeRepositoryClick);
    assert.equal(await details.isVisible(), true);
    await details.getByRole("button", { name: "Close", exact: true }).click();
    await details.waitFor({ state: "hidden" });
    // Simulate the console installing aliases using its native on-disk schema.
    // Enough rows are included to exercise the bounded package-results viewport.
    const aliases = [
      { directory: "console-alias", name: "Console Alias", commandName: "console-alias" },
      ...Array.from({ length: 12 }, (_, index) => ({
        directory: `scroll-fixture-${index + 1}`,
        name: `Scroll Fixture ${String(index + 1).padStart(2, "0")}`,
        commandName: `scroll-fixture-${index + 1}`,
      })),
    ];
    for (const alias of aliases) {
      const aliasPath = join(clientRoot, "aliases", alias.directory);
      await mkdir(aliasPath, { recursive: true });
      await writeFile(join(aliasPath, "alias.json"), JSON.stringify({
        name: alias.name, command_name: alias.commandName, version: "1.2.0", help: "Installed by console fixture",
        files: [
          { os: "windows", arch: "amd64", path: "/payload" },
          { os: "windows", arch: "386", path: "/payload" },
          { os: "linux", arch: "amd64", path: "/payload" },
          { os: "darwin", arch: "arm64", path: "/payload" },
        ],
      }));
      await writeFile(join(aliasPath, "payload"), "inert fixture");
    }
    await armory.evaluate(() => (globalThis as unknown as { dispatchEvent(event: Event): boolean }).dispatchEvent(new Event("focus")));
    await armory.getByText("Console Alias", { exact: true }).first().waitFor();
    const consoleRow = armory.getByRole("list", { name: "Installed packages" }).getByRole("listitem").filter({ hasText: "Console Alias" });
    const consolePlatforms = consoleRow.getByRole("group", { name: "Supported platforms" });
    assert.equal(await consolePlatforms.getByTitle("windows/amd64, windows/386", { exact: true }).innerText(), "Windows · x64, x86");
    assert.equal(await consolePlatforms.getByTitle("linux/amd64", { exact: true }).innerText(), "Linux · x64");
    assert.equal(await consolePlatforms.getByTitle("darwin/arm64", { exact: true }).innerText(), "macOS · ARM64");
    await mkdir(join(repositoryRoot, "artifacts", "e2e"), { recursive: true });
    await armory.screenshot({ path: join(repositoryRoot, "artifacts", "e2e", "armory-platform-badges.png"), animations: "disabled" });
    const nativeWindow = await application.browserWindow(armory);
    const originalSize = await nativeWindow.evaluate((window) => window.getSize());
    await nativeWindow.evaluate((window) => window.setSize(880, 720));
    await armory.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth <= 880);
    assert.equal(await consoleRow.evaluate((row) => row.scrollWidth <= row.clientWidth), true);
    const filters = armory.getByRole("group", { name: "Package filters", exact: true });
    const filterBounds = await Promise.all([
      filters.getByRole("searchbox", { name: "Search packages" }).boundingBox(),
      filters.getByRole("combobox", { name: "Package type" }).boundingBox(),
      filters.getByRole("combobox", { name: "Operating system" }).boundingBox(),
      filters.getByRole("combobox", { name: "Architecture" }).boundingBox(),
    ]);
    const searchBounds = filterBounds[0];
    assert.ok(searchBounds && searchBounds.width > 150);
    for (const bounds of filterBounds) {
      assert.ok(bounds);
      assert.ok(Math.abs(bounds.y + bounds.height / 2 - searchBounds.y - searchBounds.height / 2) < 2);
    }
    assert.equal(await filters.evaluate((row) => row.scrollWidth <= row.clientWidth), true);
    const osFilter = filters.getByRole("combobox", { name: "Operating system" });
    const archFilter = filters.getByRole("combobox", { name: "Architecture" });
    await osFilter.selectOption("darwin");
    await archFilter.selectOption("arm64");
    await consoleRow.waitFor();
    assert.equal(await fixtureRow.count(), 0);
    await filters.getByRole("searchbox", { name: "Search packages" }).fill("console-alias");
    assert.equal(await armory.getByRole("list", { name: "Installed packages" }).getByRole("listitem").count(), 1);
    await osFilter.selectOption("windows");
    await armory.getByRole("heading", { name: "No Matching Packages", exact: true }).waitFor();
    await osFilter.selectOption("");
    await archFilter.selectOption("");
    await filters.getByRole("searchbox", { name: "Search packages" }).fill("");
    await consoleRow.waitFor();
    await armory.screenshot({ path: join(repositoryRoot, "artifacts", "e2e", "armory-platform-badges-narrow.png"), animations: "disabled" });
    await armory.emulateMedia({ colorScheme: "dark" });
    await armory.locator("html.dark").waitFor();
    await armory.getByTestId("armory-manage-controls").screenshot({ path: join(repositoryRoot, "artifacts", "e2e", "armory-platform-filters.png"), animations: "disabled" });
    await nativeWindow.evaluate((window, size) => window.setSize(size[0]!, size[1]!), originalSize);
    await consoleRow.screenshot({ path: join(repositoryRoot, "artifacts", "e2e", "armory-platform-badges-row.png"), animations: "disabled" });
    const packageResults = armory.getByRole("region", { name: "Installed package results" });
    await armory.waitForFunction(() => {
      const browser = globalThis as unknown as { document: { querySelector(selector: string): {
        clientHeight: number; scrollHeight: number; dataset: Record<string, string | undefined>;
      } | null } };
      const region = browser.document.querySelector('[data-testid="armory-manage-scroll"]');
      return Boolean(region && region.clientHeight > 0 && region.scrollHeight > region.clientHeight && region.dataset["bottomScroll"] === "true");
    });
    const controls = armory.getByTestId("armory-manage-controls");
    const controlsBefore = await controls.boundingBox();
    assert.ok(controlsBefore);
    await packageResults.evaluate((region) => { region.scrollTop = region.scrollHeight; region.dispatchEvent(new Event("scroll")); });
    await armory.waitForFunction(() => {
      const browser = globalThis as unknown as { document: { querySelector(selector: string): {
        scrollTop: number; dataset: Record<string, string | undefined>;
      } | null } };
      const region = browser.document.querySelector('[data-testid="armory-manage-scroll"]');
      return Boolean(region && region.scrollTop > 0 && region.dataset["topScroll"] === "true");
    });
    const controlsAfter = await controls.boundingBox();
    assert.ok(controlsAfter);
    assert.equal(controlsAfter.y, controlsBefore.y);
    const snapshot = await armory.evaluate(() => (globalThis as unknown as { armory: ArmoryAPI }).armory.snapshot());
    assert.ok(snapshot.ok && snapshot.value);
    const bof = snapshot.value.installed.find((item) => item.name === "fixture-bof");
    assert.ok(bof);
    const removed = await armory.evaluate((installedId) => (globalThis as unknown as { armory: ArmoryAPI }).armory.uninstall({ installedId }), bof.id);
    assert.equal(removed.ok, true);
    await assert.rejects(readFile(join(clientRoot, "extensions", "fixture-bof", "extension.json")), { code: "ENOENT" });
    await mkdir(join(repositoryRoot, "artifacts", "e2e"), { recursive: true });
    await armory.screenshot({ path: join(repositoryRoot, "artifacts", "e2e", "armory-window.png"), animations: "disabled" });
    assert.deepEqual(errors, []);
  } finally {
    await application?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function menu(application: ElectronApplication, id: string): Promise<void> {
  await application.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId);
    if (!item) throw new Error(`Missing menu ${itemId}`);
    Reflect.apply(item.click, item, [item, undefined, {}]);
  }, id);
}
async function armoryPage(application: ElectronApplication): Promise<Page> {
  const existing = application.windows().find((page) => page.url().includes("surface=armory"));
  if (existing) return existing;
  const page = await application.waitForEvent("window");
  await page.waitForURL("**?surface=armory");
  return page;
}
function tarFile(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write("0000600\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${content.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write("ustar\0", 257);
  header.write("00", 263);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}
