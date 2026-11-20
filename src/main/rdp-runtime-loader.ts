import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { RDP_PROTOCOL_VERSION } from "../shared/rdp-contracts.js";
import { rdpRecord } from "../shared/rdp-validation.js";
import { rdpRuntimeEnvironment } from "./rdp-runtime.js";
import { executeNativeVerification, readBundledNativeFile, verifySameApplicationSigner, type NativeVerificationCommand, type NativeVerificationCommandOptions } from "./native-runtime-loader.js";

const FAILURE = "The bundled RDP runtime could not be verified. Rebuild or reinstall Sliver GUI.";
const SHA256 = /^[a-f0-9]{64}$/u;
export type RdpVerificationCommand = NativeVerificationCommand;
export interface ResolveVerifiedRdpRuntimeOptions {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly developmentRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  /** Test seam; production always executes fixed helper and OS verifier paths. */
  readonly execute?: RdpVerificationCommand;
}

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
/** Reject missing, replaced and incompatible helpers before a connection sees credentials. */
export async function resolveVerifiedRdpRuntime(options: ResolveVerifiedRdpRuntimeOptions): Promise<string> {
  try {
    const platform = options.platform ?? process.platform;
    const architecture = options.architecture ?? process.arch;
    const triple = platform === "darwin" && architecture === "arm64" ? "aarch64-apple-darwin"
      : platform === "darwin" && architecture === "x64" ? "x86_64-apple-darwin"
        : platform === "win32" && architecture === "x64" ? "x86_64-pc-windows-msvc"
          : platform === "linux" && architecture === "x64" ? "x86_64-unknown-linux-gnu" : undefined;
    if (!triple || !isAbsolute(options.resourcesPath) || !isAbsolute(options.developmentRoot)) throw new Error(FAILURE);
    const root = options.isPackaged ? options.resourcesPath : options.developmentRoot;
    const directory = options.isPackaged ? join(root, "rdp") : join(root, "native/rdp/bin");
    const sourcePath = options.isPackaged ? join(root, "app.asar/protocol/ironrdp-provenance.json") : join(root, "protocol/ironrdp-provenance.json");
    const [sourceBytes, copiedSource, recordBytes] = await Promise.all([
      readBundledNativeFile(root, sourcePath, 64 * 1024, options.isPackaged),
      readBundledNativeFile(root, join(directory, "source-provenance.json"), 64 * 1024),
      readBundledNativeFile(root, join(directory, "provenance.json"), 2 * 1024 * 1024),
    ]);
    if (!sourceBytes.equals(copiedSource)) throw new Error(FAILURE);
    if (options.isPackaged && !recordBytes.equals(await readBundledNativeFile(root,
      join(root, "app.asar/native/rdp/packaged-provenance.json"), 2 * 1024 * 1024, true))) throw new Error(FAILURE);
    const manifest = rdpRecord(JSON.parse(sourceBytes.toString("utf8")));
    const source = rdpRecord(manifest["source"]);
    const record = rdpRecord(JSON.parse(recordBytes.toString("utf8")));
    const artifact = rdpRecord(record["artifact"]);
    const build = rdpRecord(record["build"]);
    const slices = build["slices"];
    const inputs = record["inputs"];
    const buildIdentity = record["buildIdentity"];
    const filename = platform === "win32" ? "sliver-rdp.exe" : "sliver-rdp";
    const expectedTarget = platform === "darwin" ? "darwin-universal" : platform === "win32" ? "windows-x64" : "linux-x64";
    if (manifest["schemaVersion"] !== 1 || manifest["protocolVersion"] !== RDP_PROTOCOL_VERSION ||
        source["repository"] !== "https://github.com/sliverarmory/IronRDP" || typeof source["commit"] !== "string" || !/^[a-f0-9]{40}$/u.test(source["commit"]) ||
        record["schemaVersion"] !== 1 || record["protocolVersion"] !== RDP_PROTOCOL_VERSION ||
        JSON.stringify(record["source"]) !== JSON.stringify(source) || record["sourceManifestSha256"] !== digest(sourceBytes) ||
        typeof buildIdentity !== "string" || !SHA256.test(buildIdentity) || artifact["fileName"] !== filename ||
        !Array.isArray(inputs) || inputs.length === 0 || buildIdentity !== digest(Buffer.from(JSON.stringify({ manifest, inputs }))) ||
        typeof artifact["sha256"] !== "string" || !SHA256.test(artifact["sha256"]) ||
        !Number.isSafeInteger(artifact["size"]) || (artifact["size"] as number) <= 0 ||
        !Array.isArray(slices) || !slices.some((slice: unknown) => rdpRecord(slice)["target"] === triple) ||
        (options.isPackaged && (build["target"] !== expectedTarget || slices.length !== (platform === "darwin" ? 2 : 1)))) throw new Error(FAILURE);
    const executablePath = join(directory, filename);
    const bytes = await readBundledNativeFile(root, executablePath, 256 * 1024 * 1024);
    const metadata = await lstat(executablePath);
    // Execute permission bits describe the host filesystem, not the artifact target.
    if (process.platform !== "win32" && !(metadata.mode & 0o111)) throw new Error(FAILURE);
    const run = options.execute ?? executeNativeVerification;
    const commandOptions: NativeVerificationCommandOptions = { timeout: 15_000, maxBuffer: 16 * 1024, env: rdpRuntimeEnvironment() };
    if (digest(bytes) !== artifact["sha256"] || bytes.length !== artifact["size"]) {
      if (!options.isPackaged || platform === "linux") throw new Error(FAILURE);
      await verifySameApplicationSigner(platform, options.resourcesPath, executablePath, run, commandOptions);
    }
    const info = rdpRecord(JSON.parse(await run(executablePath, ["--build-info"], commandOptions)));
    if (info["name"] !== "sliver-rdp" || info["protocol"] !== RDP_PROTOCOL_VERSION ||
        info["ironrdpRevision"] !== source["commit"] || info["buildIdentity"] !== buildIdentity || info["target"] !== triple) throw new Error(FAILURE);
    // Catch replacements during verification; all credential use occurs after this returns.
    const after = await lstat(executablePath);
    if (after.isSymbolicLink() || after.dev !== metadata.dev || after.ino !== metadata.ino || after.size !== metadata.size ||
        after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) throw new Error(FAILURE);
    return executablePath;
  } catch { throw new Error(FAILURE); }
}
