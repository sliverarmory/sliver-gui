import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT_DIRECTORY, RDP_SOURCE_MANIFEST, rdpBuildEnvironment, runRdpCommand, selectedCargoPackages, validateRdpSourceManifest } from "./buildRdpRuntime.mjs";
import { prepareRdpSource, verifyStagedRdpSource } from "./rdpSourceOverlay.mjs";

const manifest = validateRdpSourceManifest(JSON.parse(await readFile(join(ROOT_DIRECTORY, RDP_SOURCE_MANIFEST), "utf8")));
const env = rdpBuildEnvironment(process.env, manifest, "native-tests", ROOT_DIRECTORY, "native-tests");
const directory = await prepareRdpSource({ projectDirectory: ROOT_DIRECTORY, manifest, run: runRdpCommand, environment: env });
const cwd = join(ROOT_DIRECTORY, "native/rdp");
const host = (await runRdpCommand("rustc", ["-vV"], { cwd, env })).stdout.match(/^host: (\S+)$/mu)?.[1];
if (!host) throw new Error("Could not determine the native Rust test target");
const metadata = JSON.parse((await runRdpCommand("cargo", ["metadata", "--locked", "--format-version=1", "--filter-platform", host], { cwd, env })).stdout);
selectedCargoPackages(metadata, manifest);
const result = await runRdpCommand("cargo", ["test", "--locked", ...process.argv.slice(2)], { cwd, env });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
await verifyStagedRdpSource(directory, manifest, runRdpCommand, env);
