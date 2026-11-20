import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createPackage } from "@electron/asar";

import { ROOT_DIRECTORY } from "./buildBeagleRuntime.mjs";
import { runRdpCommand } from "./buildRdpRuntime.mjs";
import { verifyPreparedBeagleRuntime } from "./verifyBeagleRuntime.mjs";

// Exercise actual Electron ASAR descriptors, which ordinary Node unit fixtures
// cannot emulate. Opens a disposable project and runs a local query without operator configuration.
await verifyPreparedBeagleRuntime();
const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "sliver-beagle-packaged-loader-"));
try {
  const resources = join(directory, "Sliver GUI.app/Contents/Resources");
  const source = join(directory, "asar-source");
  await mkdir(join(source, "protocol"), { recursive: true });
  await copyFile(join(ROOT_DIRECTORY, "protocol/beagle-provenance.json"), join(source, "protocol/beagle-provenance.json"));
  await mkdir(join(source, "native/beagle"), { recursive: true });
  await copyFile(join(ROOT_DIRECTORY, "native/beagle/packaged-provenance.json"), join(source, "native/beagle/packaged-provenance.json"));
  await mkdir(resources, { recursive: true });
  await createPackage(source, join(resources, "app.asar"));
  await cp(join(ROOT_DIRECTORY, "native/beagle/bin"), join(resources, "beagle"), { recursive: true });
  await runRdpCommand(process.execPath, [join(ROOT_DIRECTORY, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.e2e.json",
    "--outDir", join(directory, "compiled"), "--tsBuildInfoFile", join(directory, "compiled.tsbuildinfo")], { cwd: ROOT_DIRECTORY });
  await writeFile(join(directory, "compiled/package.json"), '{"type":"module"}\n');
  const probe = join(directory, "probe.cjs");
  await writeFile(probe, `
const { app } = require("electron");
const { readFile, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
let service;
const options = ${JSON.stringify({ isPackaged: true, resourcesPath: resources, developmentRoot: ROOT_DIRECTORY })};
setTimeout(() => app.exit(2), 30000).unref();
app.whenReady().then(async () => {
  try {
    const { resolveVerifiedBeagleRuntime } = await import("./compiled/src/main/beagle-runtime-loader.js");
    const { BeagleService } = await import("./compiled/src/main/beagle-service.js");
    service = new BeagleService({
      userDataPath: ${JSON.stringify(join(directory, "user-data"))},
      environment: { SLIVER_BEAGLE_BINARY: undefined, SLIVER_BEAGLE_SHA256: undefined },
      resolveBundledRuntime: () => resolveVerifiedBeagleRuntime(options),
    });
    const state = await service.getState();
    if (!state.runtime.available || state.runtime.source !== "Bundled Beagle") throw new Error(state.runtime.error ?? "Bundled runtime unavailable");
    const query = await service.query({ cypher: "RETURN $value AS value", parameters: { value: "bundled-release" } });
    if (query.rows[0]?.value !== "bundled-release") throw new Error("Bundled helper query failed");
    await service.dispose();
    service = undefined;
    const recordPath = join(options.resourcesPath, "beagle/provenance.json");
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.protocolVersion = 999;
    await writeFile(recordPath, JSON.stringify(record));
    let rejected = false;
    try { await resolveVerifiedBeagleRuntime(options); } catch { rejected = true; }
    if (!rejected) throw new Error("Changed packaged ABI was accepted");
    console.log("PACKAGED_BEAGLE_LOADER_OK");
    app.exit(0);
  } catch (error) { await service?.dispose(); console.error(error.message); app.exit(1); }
});
`);
  const { stdout } = await runRdpCommand(require("electron"), [probe], { cwd: directory, signal: AbortSignal.timeout(45_000) });
  assert.match(stdout, /PACKAGED_BEAGLE_LOADER_OK/u);
  console.log("Verified Beagle packaged loader with actual Electron ASAR, default project, local query and tamper rejection");
} finally { await rm(directory, { recursive: true, force: true }); }
