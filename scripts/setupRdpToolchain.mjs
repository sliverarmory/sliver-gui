import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ROOT_DIRECTORY, RDP_SOURCE_MANIFEST, RDP_TARGETS, rdpTargetForHost, runRdpCommand, validateRdpSourceManifest } from "./buildRdpRuntime.mjs";

const manifest = validateRdpSourceManifest(JSON.parse(await readFile(join(ROOT_DIRECTORY, RDP_SOURCE_MANIFEST), "utf8")));
const target = rdpTargetForHost(process.platform, process.arch, process.argv.includes("--host"));
await runRdpCommand("rustup", ["toolchain", "install", manifest.toolchain.rust, "--profile", "minimal"]);
await runRdpCommand("rustup", ["target", "add", "--toolchain", manifest.toolchain.rust, ...RDP_TARGETS[target]]);
console.log(`Prepared Rust ${manifest.toolchain.rust} for ${target}`);
