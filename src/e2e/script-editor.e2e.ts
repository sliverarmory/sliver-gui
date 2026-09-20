import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { SliverDesktopAPI } from "../shared/contracts.js";
import { cleanupOwnedApplication } from "./packaged-application-update-support.js";

const modifier = process.platform === "darwin" ? "Meta" : "Control";
const packagedExecutable = process.env["SCRIPT_EDITOR_PACKAGED_EXECUTABLE"];

test(`Script Editor works offline with real Monaco, QuickJS and Ghostty (${packagedExecutable ? "packaged" : "built"})`, {
  timeout: 180_000,
}, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporary = await mkdtemp(join(tmpdir(), "sliver-script-editor-e2e-"));
  const artifacts = join(repositoryRoot, "artifacts", "script-editor-e2e");
  const clientRoot = join(temporary, "client");
  const scriptRoot = join(clientRoot, "gui", "scripts");
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let previousClipboard: string | undefined;
  let assertionsPassed = false;
  const errors: string[] = [];
  const workers: string[] = [];
  try {
    await Promise.all(["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporary, name))));
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(clientRoot, "armories.json"), "[]", { mode: 0o600 });
    const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const flags = ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : [])];
    application = await electron.launch({
      ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
      args: packagedExecutable ? [...flags, `--user-data-dir=${join(temporary, "user-data")}`] : [
        ...flags, join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`, `--saved-config-directory=${join(temporary, "saved")}`,
        `--managed-config-directory=${join(temporary, "managed")}`, `--user-data-directory=${join(temporary, "user-data")}`,
        `--console-client-root-directory=${clientRoot}`,
      ],
      env: { ...cleanEnvironment, SLIVER_CLIENT_ROOT_DIR: clientRoot },
      cwd: repositoryRoot, timeout: 25_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const electronProcess = application.process();
    context.signal.addEventListener("abort", () => { electronProcess.kill("SIGKILL"); }, { once: true });
    page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || /Content Security Policy/iu.test(message.text())) {
        const description = `${message.text()} (${JSON.stringify(message.location())})`;
        if (!errors.includes(description)) errors.push(description);
      }
    });
    page.on("worker", (worker) => workers.push(worker.url()));
    previousClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
    await openEditor(page);
    await page.getByRole("heading", { name: "Hello World", exact: true }).waitFor();
    await page.locator(".monaco-editor").waitFor();
    await runAndWait(page, "Completed");
    assert.equal(await page.getByLabel("Script output transcript", { exact: true }).textContent(), "Hello, world!\n");
    const terminal = page.getByLabel("Script output terminal", { exact: true });
    await terminal.locator("canvas").waitFor();
    await page.getByRole("button", { name: "Copy output", exact: true }).click();
    await waitUntil(async () => (await application!.evaluate(({ clipboard }) => clipboard.readText())) === "Hello, world!\n");
    await waitUntil(() => terminalHasInk(page!));
    await page.screenshot({ path: join(artifacts, `${packagedExecutable ? "packaged" : "built"}-hello-world.png`) });
    await assertStableEditorResize(application, page);

    // Prove analysis/model synchronization through the actual Monaco worker.
    await editSource(page, "console.");
    await page.keyboard.press("Control+Space");
    await page.locator(".suggest-widget").getByText("log", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await editSource(page, 'console.log("analysis ready");');
    await page.locator(".monaco-editor .squiggly-error").first().waitFor({ state: "hidden" });
    await editSource(page, "window;");
    await page.locator(".monaco-editor .squiggly-error").first().waitFor();

    const entries = await readdir(scriptRoot);
    const filename = entries.find((entry) => entry.endsWith(".js"));
    assert.match(filename ?? "", /^[0-9a-f-]{36}\.js$/u);
    const id = filename!.slice(0, -3);
    const names = JSON.parse(await readFile(join(scriptRoot, "names.json"), "utf8")) as { names: Record<string, string> };
    assert.equal(names.names[id], "Hello World");

    await editSource(page, 'console.log("edited", { answer: 42 });');
    await page.getByText("Unsaved changes", { exact: true }).waitFor();
    await runAndWait(page, "Completed");
    assert.match(await page.getByLabel("Script output transcript", { exact: true }).textContent() ?? "", /edited.*answer: 42/u);
    assert.match(await readFile(join(scriptRoot, filename!), "utf8"), /Hello, world!/u, "Run must not implicitly save");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await waitUntil(async () => (await readFile(join(scriptRoot, filename!), "utf8")).includes("edited"));

    await page.getByRole("button", { name: "Script actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const rename = page.getByRole("dialog", { name: "Rename script", exact: true });
    const displayName = "../Hello <b>World</b>";
    await rename.getByRole("textbox", { name: "Script name" }).fill(displayName);
    await rename.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByRole("heading", { name: displayName, exact: true }).waitFor();
    assert.deepEqual((await readdir(scriptRoot)).sort(), entries.sort(), "Display names never change the UUID filename");
    assert.equal((JSON.parse(await readFile(join(scriptRoot, "names.json"), "utf8")) as { names: Record<string, string> }).names[id], displayName);
    await assertScriptFileTransfers(application, page, temporary, scriptRoot, filename!, displayName);
    await page.reload();
    await openEditor(page);
    await page.getByRole("heading", { name: displayName, exact: true }).waitFor();
    await runAndWait(page, "Completed");
    await assertScriptContextActions(application, page, temporary, scriptRoot, displayName, artifacts);

    // Exercise only denied local capabilities; no backend operations or targets.
    await editSource(page, 'console.log(typeof window, typeof document, typeof fetch, typeof process, typeof require, typeof sliver, typeof postMessage); console.warn("<b>literal</b>\\x1b]52;c;data\\x07");');
    await runAndWait(page, "Completed");
    const boundaryText = await page.getByLabel("Script output transcript", { exact: true }).textContent();
    assert.match(boundaryText ?? "", /undefined undefined undefined undefined undefined undefined undefined/u);
    assert.match(boundaryText ?? "", /<b>literal<\/b>\\u001b/u);
    assert.equal(await page.locator("b").filter({ hasText: "literal" }).count(), 0);

    await editSource(page, "while (true) {}");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await page.getByText("Running", { exact: true }).waitFor();
    // Renderer frames must keep advancing while the guest is busy in its worker.
    await page.evaluate(() => {
      const host = globalThis as unknown as { requestAnimationFrame(callback: () => void): number };
      return new Promise<void>((resolve) => host.requestAnimationFrame(() => host.requestAnimationFrame(resolve)));
    });
    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByText(/^Stopped ·/u).waitFor();
    await runAndWait(page, "Timed out");
    await editSource(page, 'for(let i=0;i<100000;i++) console.log("bounded output", i);');
    await runAndWait(page, "Output limit reached");
    assert.ok(new TextEncoder().encode(await page.getByLabel("Script output transcript", { exact: true }).textContent() ?? "").byteLength <= 1024 * 1024);
    await editSource(page, 'const blocks=[];for(let i=0;i<10000;i++)blocks.push(new Array(10000).fill(i));');
    await runAndWait(page, "Failed");
    await editSource(page, 'throw new Error("script error example")');
    await runAndWait(page, "Failed");
    await page.getByRole("alert").filter({ hasText: "script error example" }).waitFor();
    await editSource(page, 'console.log("Recovered after Stop and timeout");');
    await runAndWait(page, "Completed");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Saved", { exact: true }).waitFor();

    // Typing a draft, navigating away, and returning preserves it without saving.
    await editSource(page, 'console.log("unsaved navigation draft");');
    await assertKeepEditingRevealsDraft(application, page, displayName);
    await page.getByText("Unsaved changes", { exact: true }).waitFor();
    await runAndWait(page, "Completed");
    assert.match(await page.getByLabel("Script output transcript", { exact: true }).textContent() ?? "", /unsaved navigation draft/u);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Saved", { exact: true }).waitFor();

    // Both windows use the same serialized store and revision checks.
    const newWindow = application.waitForEvent("window");
    await page.evaluate(async () => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.openWindow({ inheritConnection: false }));
    const second = await newWindow;
    await openEditor(second);
    await second.getByRole("heading", { name: displayName, exact: true }).waitFor();
    await editSource(second, 'console.log("second-window draft");');
    await editSource(page, 'console.log("first-window saved");');
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await second.getByRole("alert").filter({ hasText: "changed in another window" }).waitFor();
    assert.equal(await second.getByRole("button", { name: "Save", exact: true }).isEnabled(), false);
    await second.getByRole("button", { name: "Script actions", exact: true }).click();
    await second.getByRole("menuitem", { name: "Reload from disk", exact: true }).click();
    await second.getByRole("alertdialog", { name: "Reload script?" }).getByRole("button", { name: "Reload", exact: true }).click();
    await second.getByText("Saved", { exact: true }).waitFor();
    await second.close();

    await page.getByRole("button", { name: "New script", exact: true }).click();
    const create = page.getByRole("dialog", { name: "New script" });
    await create.getByRole("textbox", { name: "Script name" }).fill("Delete me");
    await create.getByRole("button", { name: "Create", exact: true }).click();
    await page.getByRole("heading", { name: "Delete me", exact: true }).waitFor();
    await page.getByRole("button", { name: "Script actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Delete script?" }).getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("heading", { name: displayName, exact: true }).waitFor();
    assert.equal((await readdir(scriptRoot)).filter((entry) => entry.endsWith(".js")).length, 1);
    await runAndWait(page, "Completed");
    const transcriptBeforeTheme = await page.getByLabel("Script output transcript", { exact: true }).textContent();
    await page.evaluate(async () => {
      const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
      const settings = await api.getApplicationSettings();
      const result = await api.updateApplicationSettings({
        expectedRevision: settings.revision,
        settings: {
          theme: "dark", appIcon: settings.appIcon, reduceMotion: true,
          commandPaletteShortcut: settings.commandPaletteShortcut,
          keyboardShortcuts: settings.keyboardShortcuts, terminal: settings.terminal,
        },
      });
      if (!result.ok) throw new Error(result.error);
    });
    await page.locator("html.dark").waitFor();
    await terminal.locator("canvas").waitFor();
    await waitUntil(() => terminalHasInk(page!));
    assert.equal(await page.getByLabel("Script output transcript", { exact: true }).textContent(), transcriptBeforeTheme);
    await page.screenshot({ path: join(artifacts, `${packagedExecutable ? "packaged" : "built"}-dark.png`) });
    assert.ok(workers.some((url) => /script\.worker-/u.test(url)), "The actual QuickJS worker must run");
    assert.ok(workers.some((url) => /script-language\.worker-/u.test(url)), "The actual Monaco analysis worker must run");
    assert.ok(workers.every((url) => url.startsWith("sliver://app/")), "Workers must be packaged local assets");
    assert.equal(await application.evaluate(({ app }) => app.isPackaged), Boolean(packagedExecutable));
    assert.deepEqual(errors, [], "No renderer errors or CSP violations are permitted");
    assertionsPassed = true;
  } catch (error) {
    context.diagnostic(JSON.stringify(errors));
    if (page && !page.isClosed()) {
      context.diagnostic((await page.locator("body").innerText()).slice(-6000));
      await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (application) {
      if (previousClipboard !== undefined) await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard).catch(() => undefined);
      const ownedProcess = application.process();
      await cleanupOwnedApplication(application, "Script Editor E2E", 5_000);
      if (assertionsPassed) assert.equal(ownedProcess.signalCode, null, "The application must quit gracefully without the cleanup fallback killing it");
    }
    await rm(temporary, { recursive: true, force: true });
  }
});

async function openEditor(page: Page): Promise<void> {
  page.setDefaultTimeout(15_000);
  const dialog = page.getByRole("dialog", { name: "Saved configurations" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("row", { name: "Script Editor", exact: true }).click();
  await page.getByRole("heading", { name: "Script Editor", exact: true }).waitFor();
}
async function editSource(page: Page, source: string): Promise<void> {
  const editor = page.getByRole("textbox", { name: "Script source", exact: true });
  await editor.focus();
  await page.keyboard.press(`${modifier}+A`);
  await page.keyboard.insertText(source);
}
async function runAndWait(page: Page, status: string): Promise<void> {
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.getByText(new RegExp(`^${status} ·`, "u")).waitFor();
}
async function terminalHasInk(page: Page): Promise<boolean> {
  return page.getByLabel("Script output terminal", { exact: true }).locator("canvas").evaluate((element) => {
    const canvas = element as unknown as { width: number; height: number; getContext(kind: string): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } };
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i]! - pixels[0]!) + Math.abs(pixels[i + 1]! - pixels[1]!) + Math.abs(pixels[i + 2]! - pixels[2]!) > 30) ink++;
    return ink > 100;
  });
}
async function assertStableEditorResize(application: ElectronApplication, page: Page): Promise<void> {
  const window = await application.browserWindow(page);
  const bounds = await window.evaluate((window) => window.getBounds());
  const divider = page.getByRole("separator", { name: "Resize script output", exact: true });
  for (const [width, height] of [[1101, 801], [1203, 733], [1441, 921]]) {
    await window.evaluate((window, size) => window.setSize(size.width!, size.height!), { width, height });
    for (const fraction of [0.35, 0.501, 0.653, 0.8]) {
      const group = await page.locator("#script-editor-content").boundingBox();
      const handle = await divider.boundingBox();
      assert.ok(group && handle);
      const x = handle.x + handle.width / 2;
      await page.mouse.move(x, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, group.y + group.height * fraction, { steps: 3 });
      await page.mouse.up();
      const samples = await page.locator(".monaco-editor").evaluate(async (node) => {
        type Box = { width: number; height: number };
        type Element = { clientWidth: number; clientHeight: number; scrollWidth: number; scrollHeight: number; getBoundingClientRect(): Box; closest(selector: string): Element | null };
        const editor = node as unknown as Element;
        const panel = editor.closest(".resizable__panel")!;
        const host = globalThis as unknown as { requestAnimationFrame(callback: () => void): number };
        const samples: number[][] = [];
        for (let frame = 0; frame < 14; frame++) {
          await new Promise<void>((resolve) => host.requestAnimationFrame(resolve));
          if (frame < 2) continue;
          const box = editor.getBoundingClientRect();
          samples.push([panel.clientWidth, panel.clientHeight, panel.scrollWidth, panel.scrollHeight, box.width, box.height]);
        }
        return samples;
      });
      assert.ok(samples.every(([width, height, scrollWidth, scrollHeight]) => scrollWidth! <= width! && scrollHeight! <= height!),
        `No native panel overflow after resize at ${width}x${height}/${fraction}: ${JSON.stringify(samples)}`);
      assert.equal(new Set(samples.map((sample) => JSON.stringify(sample))).size, 1,
        `Editor dimensions must settle after resize at ${width}x${height}/${fraction}`);
    }
  }
  // Keep Monaco's own vertical and horizontal scrolling for real content.
  await editSource(page, Array.from({ length: 100 }, (_, index) => `// line ${index}`).join("\n") + `\n// ${"wide ".repeat(250)}`);
  await page.keyboard.press(`${modifier}+End`);
  const scrollbars = await page.locator(".monaco-editor .monaco-scrollable-element").first().evaluate((node) => {
    const element = node as unknown as { querySelector(selector: string): { getBoundingClientRect(): { width: number; height: number } } | null; getBoundingClientRect(): { width: number; height: number } };
    const vertical = element.querySelector(".scrollbar.vertical .slider")!.getBoundingClientRect();
    const horizontal = element.querySelector(".scrollbar.horizontal .slider")!.getBoundingClientRect();
    const viewport = element.getBoundingClientRect();
    return { vertical: vertical.height, horizontal: horizontal.width, viewportHeight: viewport.height, viewportWidth: viewport.width };
  });
  assert.ok(scrollbars.vertical > 0 && scrollbars.vertical < scrollbars.viewportHeight);
  assert.ok(scrollbars.horizontal > 0 && scrollbars.horizontal < scrollbars.viewportWidth);
  await editSource(page, 'console.log("Hello, world!");\n');
  await window.evaluate((window, bounds) => window.setBounds(bounds), bounds);
}
async function assertScriptFileTransfers(application: ElectronApplication, page: Page, temporary: string, scriptRoot: string, filename: string, displayName: string): Promise<void> {
  const exportedPath = join(temporary, "exported-draft.js");
  const draft = 'console.log("exported unsaved draft ✓");\n';
  const storedBeforeExport = await readFile(join(scriptRoot, filename), "utf8");
  await editSource(page, draft);
  await application.evaluate(({ dialog }, destination) => {
    const original = dialog.showSaveDialog;
    dialog.showSaveDialog = async (...args: unknown[]) => {
      dialog.showSaveDialog = original;
      const options = args[args.length - 1] as { defaultPath?: string; filters?: { extensions: string[] }[] };
      (globalThis as unknown as { __scriptExportSuggestion: unknown }).__scriptExportSuggestion = options;
      return { canceled: false, filePath: destination };
    };
  }, exportedPath);
  await page.getByRole("button", { name: "Script actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Export…", exact: true }).click();
  await waitUntil(async () => (await readFile(exportedPath, "utf8").catch(() => "")) === draft);
  const suggestion = await application.evaluate(() => (globalThis as unknown as {
    __scriptExportSuggestion: { defaultPath: string; filters: { extensions: string[] }[] };
  }).__scriptExportSuggestion);
  assert.ok(suggestion.defaultPath.endsWith(".js"));
  assert.doesNotMatch(suggestion.defaultPath, /[\\/\u0000-\u001f]/u, "The untrusted display name must become a basename before Save As");
  assert.ok(suggestion.filters.some((filter) => filter.extensions.includes("js")));
  assert.equal(await readFile(join(scriptRoot, filename), "utf8"), storedBeforeExport, "Export must not save the library draft");
  await page.getByText("Unsaved changes", { exact: true }).waitFor();
  await application.evaluate(({ dialog }, selectedPath) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [selectedPath] };
    };
  }, exportedPath);
  await page.getByRole("button", { name: "Import script", exact: true }).click();
  await page.getByRole("heading", { name: "exported-draft", exact: true }).waitFor();
  await page.getByText("Saved", { exact: true }).waitFor();
  await page.getByText("Ready", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Script output transcript", { exact: true }).textContent(), "", "Import must not execute the script");
  const files = (await readdir(scriptRoot)).filter((name) => name.endsWith(".js"));
  assert.equal(files.length, 2);
  const importedFile = files.find((name) => name !== filename)!;
  assert.match(importedFile, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.js$/u);
  assert.equal(await readFile(join(scriptRoot, importedFile), "utf8"), draft);
  await runAndWait(page, "Completed");
  assert.match(await page.getByLabel("Script output transcript", { exact: true }).textContent() ?? "", /exported unsaved draft ✓/u);
  await page.getByRole("button", { name: "Script actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Delete script?" }).getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("heading", { name: displayName, exact: true }).waitFor();
  await page.getByText("Unsaved changes", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Saved", { exact: true }).waitFor();
}
async function assertScriptContextActions(application: ElectronApplication, page: Page, temporary: string, scriptRoot: string, activeName: string, artifacts: string): Promise<void> {
  const labels = ["Rename", "Duplicate", "Export…", "Reload from disk", "Delete"];
  const menuIcons = async (menuName: string): Promise<(string | null)[]> => {
    const menu = page.getByRole("menu", { name: menuName, exact: true });
    const icons = [];
    for (const label of labels) {
      const item = menu.getByRole("menuitem", { name: label, exact: true });
      await item.waitFor();
      icons.push(await item.locator("svg[data-icon]").getAttribute("data-icon"));
    }
    assert.ok(icons.every(Boolean), "Every script action must have an icon");
    assert.equal(new Set(icons).size, labels.length, "Each script action has a distinct icon");
    return icons;
  };
  const contextAction = async (name: string, action: string): Promise<void> => {
    await page.getByRole("button", { name: `Open ${name}`, exact: true }).click({ button: "right" });
    await page.getByRole("menu", { name: "Application context menu", exact: true }).getByRole("menuitem", { name: action, exact: true }).click();
  };
  await page.getByRole("button", { name: "Script actions", exact: true }).click();
  const dropdownIcons = await menuIcons("Script actions");
  await page.locator(".dropdown__popover[data-entering]").waitFor({ state: "detached" });
  await page.screenshot({ path: join(artifacts, `${packagedExecutable ? "packaged" : "built"}-script-dropdown.png`) });
  await page.keyboard.press("Escape");
  await page.getByRole("menu", { name: "Script actions", exact: true }).waitFor({ state: "hidden" });

  // A script that has never been opened in this renderer still has working row actions.
  const savedSource = 'console.log("context target saved");\n';
  await page.evaluate(async (source) => {
    const result = await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.createScript({ name: "Context target", source });
    if (!result.ok) throw new Error(result.error);
  }, savedSource);
  await page.getByRole("button", { name: "Open Context target", exact: true }).click({ button: "right" });
  assert.deepEqual(await menuIcons("Application context menu"), dropdownIcons, "Context and dropdown actions share their icons");
  await page.locator(".context-menu__popover[data-entering]").waitFor({ state: "detached" });
  await page.screenshot({ path: join(artifacts, `${packagedExecutable ? "packaged" : "built"}-script-context-menu.png`) });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename script", exact: true });
  await rename.getByRole("textbox", { name: "Script name" }).fill("Context renamed");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByRole("button", { name: "Open Context renamed", exact: true }).waitFor();
  await page.getByRole("heading", { name: activeName, exact: true }).waitFor();
  await contextAction("Context renamed", "Duplicate");
  await page.getByRole("dialog", { name: "Save a copy", exact: true }).getByRole("button", { name: "Save copy", exact: true }).click();
  const copyName = "Context renamed copy";
  await page.getByRole("heading", { name: copyName, exact: true }).waitFor();
  const names = (JSON.parse(await readFile(join(scriptRoot, "names.json"), "utf8")) as { names: Record<string, string> }).names;
  const copyId = Object.keys(names).find((id) => names[id] === copyName)!;
  assert.equal(await readFile(join(scriptRoot, `${copyId}.js`), "utf8"), savedSource);
  const draft = 'console.log("context target unsaved");\n';
  await editSource(page, draft);
  await page.getByRole("button", { name: `Open ${activeName}`, exact: true }).click();
  await runAndWait(page, "Completed");
  const transcript = await page.getByLabel("Script output transcript", { exact: true }).textContent();
  const exportedPath = join(temporary, "context-export.js");
  await application.evaluate(({ dialog }, destination) => {
    const original = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => {
      dialog.showSaveDialog = original;
      return { canceled: false, filePath: destination };
    };
  }, exportedPath);
  await contextAction(copyName, "Export…");
  await waitUntil(async () => (await readFile(exportedPath, "utf8").catch(() => "")) === draft);
  assert.equal(await readFile(join(scriptRoot, `${copyId}.js`), "utf8"), savedSource, "Context export uses the clicked script's draft without saving");
  await contextAction(copyName, "Reload from disk");
  await page.getByRole("alertdialog", { name: "Reload script?" }).getByRole("button", { name: "Reload", exact: true }).click();
  await page.getByRole("heading", { name: activeName, exact: true }).waitFor();
  assert.equal(await page.getByLabel("Script output transcript", { exact: true }).textContent(), transcript, "Reloading another script preserves the current output");
  await page.getByRole("button", { name: `Open ${copyName}`, exact: true }).click();
  await page.getByText("Saved", { exact: true }).waitFor();
  await runAndWait(page, "Completed");
  assert.equal(await page.getByLabel("Script output transcript", { exact: true }).textContent(), "context target saved\n");
  await page.getByRole("button", { name: `Open ${activeName}`, exact: true }).click();
  await runAndWait(page, "Completed");
  for (const name of [copyName, "Context renamed"]) {
    await contextAction(name, "Delete");
    await page.getByRole("alertdialog", { name: "Delete script?" }).getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: `Open ${name}`, exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("heading", { name: activeName, exact: true }).waitFor();
    assert.equal(await page.getByLabel("Script output transcript", { exact: true }).textContent(), transcript, "Deleting another script preserves the current output");
  }
  assert.equal((await readdir(scriptRoot)).filter((name) => name.endsWith(".js")).length, 1);
}
async function assertKeepEditingRevealsDraft(application: ElectronApplication, page: Page, draftName: string): Promise<void> {
  const cleanName = "Clean close-guard script";
  const cleanScript = await page.evaluate(async (name) => {
    const result = await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.createScript({ name, source: "" });
    if (!result.ok || !result.value) throw new Error(result.error ?? "Could not create clean script");
    return result.value;
  }, cleanName);
  const window = await application.browserWindow(page);
  const windowId = await window.evaluate((window) => window.id);
  for (const action of ["close", "quit"] as const) {
    await page.getByRole("button", { name: `Open ${cleanName}`, exact: true }).click();
    await page.getByRole("heading", { name: cleanName, exact: true }).waitFor();
    await page.getByText("Saved", { exact: true }).waitFor();
    await page.getByRole("row", { name: "Overview", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    const prompts = await application.evaluate(({ app, BrowserWindow, dialog }, request) => {
      const original = dialog.showMessageBoxSync;
      const prompts: string[] = [];
      dialog.showMessageBoxSync = (...args: unknown[]) => {
        const options = args[args.length - 1] as { message: string; buttons: string[] };
        prompts.push(options.message);
        const keepEditing = options.buttons.indexOf("Keep Editing");
        if (keepEditing < 0) throw new Error("Expected Keep Editing in the unsaved script warning");
        return keepEditing;
      };
      try {
        if (request.action === "quit") app.quit();
        else BrowserWindow.fromId(request.windowId)!.close();
        return prompts;
      } finally { dialog.showMessageBoxSync = original; }
    }, { action, windowId });
    assert.deepEqual(prompts, ["Discard unsaved script changes?"], `${action} must warn about the other script's unsaved draft`);
    await page.getByRole("heading", { name: "Script Editor", exact: true }).waitFor();
    await page.getByRole("heading", { name: draftName, exact: true }).waitFor();
    await page.getByText("Unsaved changes", { exact: true }).waitFor();
    assert.equal(page.isClosed(), false, "Keep Editing must retain the original window");
    await runAndWait(page, "Completed");
    assert.equal(await page.getByLabel("Script output transcript", { exact: true }).textContent(), "unsaved navigation draft\n");
  }
  await page.evaluate(async (script) => {
    const result = await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.deleteScript({ id: script.id, expectedRevision: script.revision });
    if (!result.ok) throw new Error(result.error);
  }, cleanScript);
  await page.getByRole("button", { name: `Open ${cleanName}`, exact: true }).waitFor({ state: "hidden" });
}
async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Timed out waiting for expected application state");
}
