import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication } from "playwright-core";

test("new operator configs appear in the open selector without refreshing", { timeout: 60_000 }, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-config-watch-e2e-"));
  const clientRootDirectory = join(temporaryRoot, "sliver-client");
  const savedConfigDirectory = join(clientRootDirectory, "configs");
  const managedConfigDirectory = join(clientRootDirectory, "gui");
  const userDataDirectory = join(temporaryRoot, "user-data");
  await Promise.all([
    mkdir(clientRootDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
  ]);

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
        `--console-client-root-directory=${clientRootDirectory}`,
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
      timeout: 20_000,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const electronProcess = application.process();
    context.signal.addEventListener("abort", () => { electronProcess.kill("SIGKILL"); }, { once: true });

    const page = await application.firstWindow();
    const dialog = page.getByRole("dialog", { name: "Saved configurations" });
    await dialog.getByText("No saved configurations").waitFor();

    // The directory can be created after launch. A partial, invalid save
    // should not prevent the later valid config from being discovered.
    await mkdir(savedConfigDirectory);
    const configPath = join(savedConfigDirectory, "new-operator.cfg");
    await writeFile(configPath, "not a Sliver operator config", { mode: 0o600 });
    // Editors often save through a temporary file and atomic rename.
    const temporaryConfigPath = join(savedConfigDirectory, ".new-operator.cfg.tmp");
    await writeFile(temporaryConfigPath, JSON.stringify({
      operator: "watch-e2e-operator",
      lhost: "127.0.0.1",
      lport: 31337,
      ca_certificate: "FAKE_CA_WATCH_E2E",
      certificate: "FAKE_CERT_WATCH_E2E",
      private_key: "FAKE_PRIVATE_KEY_WATCH_E2E",
      token: "FAKE_TOKEN_WATCH_E2E",
    }), { mode: 0o600 });
    await rename(temporaryConfigPath, configPath);

    await dialog.getByRole("option", { name: /watch-e2e-operator/ }).waitFor({ timeout: 10_000 });
    assert.equal(await dialog.getByRole("option", { name: /watch-e2e-operator/ }).count(), 1);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
