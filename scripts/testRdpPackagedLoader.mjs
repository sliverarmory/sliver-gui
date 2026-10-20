import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createPackage } from "@electron/asar";

import { ROOT_DIRECTORY, runRdpCommand } from "./buildRdpRuntime.mjs";
import { verifyPreparedRdpRuntime } from "./verifyRdpRuntime.mjs";

// Exercise actual Electron ASAR descriptors, which ordinary Node unit fixtures
// cannot emulate. This invokes only --build-info; it never connects to a server.
await verifyPreparedRdpRuntime();
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "sliver-rdp-packaged-loader-"));
try {
  const resources = join(directory, "Sliver GUI.app/Contents/Resources");
  const source = join(directory, "asar-source");
  await mkdir(join(source, "protocol"), { recursive: true });
  await copyFile(join(ROOT_DIRECTORY, "protocol/ironrdp-provenance.json"), join(source, "protocol/ironrdp-provenance.json"));
  await mkdir(join(source, "native/rdp/bin"), { recursive: true });
  await copyFile(join(ROOT_DIRECTORY, "native/rdp/bin/provenance.json"), join(source, "native/rdp/bin/provenance.json"));
  await mkdir(resources, { recursive: true });
  await createPackage(source, join(resources, "app.asar"));
  await cp(join(ROOT_DIRECTORY, "native/rdp/bin"), join(resources, "rdp"), { recursive: true });
  await runRdpCommand(process.execPath, [join(ROOT_DIRECTORY, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.e2e.json",
    "--outDir", join(directory, "compiled"), "--tsBuildInfoFile", join(directory, "compiled.tsbuildinfo")], { cwd: ROOT_DIRECTORY });
  await writeFile(join(directory, "compiled/package.json"), '{"type":"module"}\n');
  const probe = join(directory, "probe.cjs");
  await writeFile(probe, `
const { app } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const options = ${JSON.stringify({ isPackaged: true, resourcesPath: resources, developmentRoot: ROOT_DIRECTORY })};
setTimeout(() => app.exit(2), 30000).unref();
app.whenReady().then(async () => {
  try {
    const { resolveVerifiedRdpRuntime } = await import("./compiled/src/main/rdp-runtime-loader.js");
    await resolveVerifiedRdpRuntime(options);
    const recordPath = join(options.resourcesPath, "rdp/provenance.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.protocolVersion = 999;
    await writeFile(recordPath, JSON.stringify(record));
    let rejected = false;
    try { await resolveVerifiedRdpRuntime(options); } catch { rejected = true; }
    if (!rejected) throw new Error("Changed packaged ABI was accepted");
    console.log("PACKAGED_RDP_LOADER_OK");
    app.exit(0);
  } catch (error) { console.error(error.message); app.exit(1); }
});
`);
  const { stdout } = await runRdpCommand(require("electron"), [probe], { cwd: directory, signal: AbortSignal.timeout(45_000) });
  assert.match(stdout, /PACKAGED_RDP_LOADER_OK/u);
  console.log("Verified RDP packaged loader with actual Electron ASAR, helper build identity and ABI rejection");
} finally { await rm(directory, { recursive: true, force: true }); }
