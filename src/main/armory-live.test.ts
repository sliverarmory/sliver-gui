// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ArmoryService } from "./armory-service.js";

// Explicit opt-in; downloads signed packages into an isolated temporary console root.
// Artifacts are inspected only and never loaded or executed.
it.skipIf(process.env["ARMORY_LIVE_TEST"] !== "1")("installs current official signed BOFs and their dependency into console layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "sliver-armory-live-"));
  const service = new ArmoryService({ rootPath: root });
  try {
    const catalog = await service.refreshCatalog();
    expect(catalog.sources[0]?.error).toBeUndefined();
    const selected = catalog.packages.find((entry) => entry.commandName === "sa-whoami");
    expect(selected?.error).toBeUndefined();
    expect(selected).toBeDefined();
    const installed = await service.install({ packageId: selected!.id });
    const bof = installed.installed.find((entry) => entry.commandNames.includes("sa-whoami"));
    expect(bof?.kind).toBe("bof");
    const manifest = JSON.parse(await readFile(join(root, "extensions/sa-whoami/extension.json"), "utf8")) as { command_name: string; depends_on: string; files: { path: string }[] };
    expect(manifest.command_name).toBe("sa-whoami");
    expect(installed.installed.some((entry) => entry.commandNames.includes(manifest.depends_on))).toBe(true);
    for (const file of manifest.files) expect((await readFile(join(root, "extensions/sa-whoami", file.path.replace(/^\//u, "")))).length).toBeGreaterThan(0);
    console.info(JSON.stringify({ packages: catalog.packages.length, bundles: catalog.bundles.length, packageMetadataErrors: catalog.packages.filter((entry) => entry.error).map((entry) => ({ name: entry.commandName, error: entry.error })), installed: installed.installed.map((entry) => ({ name: entry.name, kind: entry.kind, version: entry.version })), bofArtifacts: manifest.files.length }));
  } finally { service.dispose(); await rm(root, { recursive: true, force: true }); }
}, 300_000);
