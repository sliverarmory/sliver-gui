// @vitest-environment node
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveVerifiedRdpRuntime, type RdpVerificationCommand } from "./rdp-runtime-loader.js";

const directories: string[] = [];
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

async function fixture(platform: NodeJS.Platform = "linux", packaged = false) {
  const root = await mkdtemp(join(tmpdir(), "sliver-rdp-loader-"));
  directories.push(root);
  const resourcesPath = join(root, "Sliver GUI.app/Contents/Resources");
  const directory = packaged ? join(resourcesPath, "rdp") : join(root, "native/rdp/bin");
  const protocolPath = packaged ? join(resourcesPath, "app.asar/protocol/ironrdp-provenance.json") : join(root, "protocol/ironrdp-provenance.json");
  await mkdir(dirname(protocolPath), { recursive: true });
  await mkdir(directory, { recursive: true });
  const source = { repository: "https://github.com/sliverarmory/IronRDP", commit: "a".repeat(40) };
  const manifest = { schemaVersion: 1, protocolVersion: 1, source };
  const sourceBytes = JSON.stringify(manifest);
  const inputs = [{ path: "native/rdp/src/main.rs", sha256: "c".repeat(64) }];
  const buildIdentity = hash(JSON.stringify({ manifest, inputs }));
  const target = platform === "linux" ? "x86_64-unknown-linux-gnu" : platform === "win32" ? "x86_64-pc-windows-msvc" : "aarch64-apple-darwin";
  const filename = platform === "win32" ? "sliver-rdp.exe" : "sliver-rdp";
  const bytes = Buffer.from("known RDP executable image");
  const record = { schemaVersion: 1, protocolVersion: 1, source, inputs, sourceManifestSha256: hash(sourceBytes), buildIdentity,
    artifact: { fileName: filename, sha256: hash(bytes), size: bytes.length },
    build: { target: platform === "linux" ? "linux-x64" : platform === "win32" ? "windows-x64" : "darwin-universal",
      slices: platform === "darwin" ? [{ target: "x86_64-apple-darwin" }, { target: "aarch64-apple-darwin" }] : [{ target }] } };
  const executable = join(directory, filename);
  await writeFile(protocolPath, sourceBytes);
  await writeFile(join(directory, "source-provenance.json"), sourceBytes);
  await writeFile(join(directory, "provenance.json"), JSON.stringify(record));
  if (packaged) {
    await mkdir(join(resourcesPath, "app.asar/native/rdp"), { recursive: true });
    await writeFile(join(resourcesPath, "app.asar/native/rdp/packaged-provenance.json"), JSON.stringify(record));
  }
  await writeFile(executable, bytes, { mode: 0o755 });
  await chmod(executable, 0o755);
  const info = { name: "sliver-rdp", protocol: 1, ironrdpRevision: source.commit, buildIdentity, target };
  const execute = vi.fn<RdpVerificationCommand>().mockResolvedValue(JSON.stringify(info));
  const options = { isPackaged: packaged, resourcesPath, developmentRoot: root, platform, architecture: platform === "darwin" ? "arm64" : "x64", execute };
  return { root, directory, record, options, execute, executable, info, protocolPath };
}

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("verified RDP runtime loading", () => {
  it("chooses only the fixed bundled executable and verifies bounded build metadata before returning", async () => {
    const entry = await fixture();
    await expect(resolveVerifiedRdpRuntime(entry.options)).resolves.toBe(entry.executable);
    expect(entry.execute).toHaveBeenCalledExactlyOnceWith(entry.executable, ["--build-info"], expect.objectContaining({ timeout: 15_000, maxBuffer: 16 * 1024 }));
    expect(entry.execute.mock.calls[0]?.[2].env["RUST_LOG"]).toBe("off");
  });

  it.each(["protocol", "ironrdpRevision", "buildIdentity", "target"] as const)("rejects a helper reporting an incompatible %s", async (field) => {
    const entry = await fixture();
    entry.execute.mockResolvedValue(JSON.stringify({ ...entry.info, [field]: "wrong" }));
    await expect(resolveVerifiedRdpRuntime(entry.options)).rejects.toThrow(/could not be verified/u);
  });

  it("rejects altered binary bytes, provenance path selection and source pin drift before executing anything", async () => {
    const entry = await fixture();
    await writeFile(entry.executable, "replacement binary");
    await expect(resolveVerifiedRdpRuntime(entry.options)).rejects.toThrow();
    expect(entry.execute).not.toHaveBeenCalled();
    entry.record.artifact.fileName = "../other-executable";
    await writeFile(join(entry.directory, "provenance.json"), JSON.stringify(entry.record));
    await expect(resolveVerifiedRdpRuntime(entry.options)).rejects.toThrow();
    expect(entry.execute).not.toHaveBeenCalled();
    await writeFile(entry.protocolPath, "changed source pin");
    await expect(resolveVerifiedRdpRuntime(entry.options)).rejects.toThrow();
    expect(entry.execute).not.toHaveBeenCalled();
  });

  it("refuses symlinked helpers", async () => {
    const entry = await fixture();
    const other = join(entry.root, "external");
    await writeFile(other, await readFile(entry.executable));
    await rm(entry.executable);
    await symlink(other, entry.executable);
    await expect(resolveVerifiedRdpRuntime(entry.options)).rejects.toThrow();
    expect(entry.execute).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("refuses a helper without POSIX execute permissions before running it", async () => {
    const entry = await fixture();
    await chmod(entry.executable, 0o644);
    await expect(resolveVerifiedRdpRuntime(entry.options)).rejects.toThrow(/could not be verified/u);
    expect(entry.execute).not.toHaveBeenCalled();
  });

  it("accepts unchanged packaged Linux bytes but never substitutes signature checks for changed Linux content", async () => {
    const entry = await fixture("linux", true);
    await expect(resolveVerifiedRdpRuntime(entry.options)).resolves.toBe(entry.executable);
    entry.execute.mockClear();
    await writeFile(entry.executable, "replacement");
    await expect(resolveVerifiedRdpRuntime(entry.options)).rejects.toThrow();
    expect(entry.execute).not.toHaveBeenCalled();
  });

  it("rejects simultaneous helper and external provenance replacement against the ASAR build record", async () => {
    const entry = await fixture("linux", true);
    const replacement = "replacement helper";
    await writeFile(entry.executable, replacement);
    entry.record.artifact.sha256 = hash(replacement);
    entry.record.artifact.size = Buffer.byteLength(replacement);
    await writeFile(join(entry.directory, "provenance.json"), JSON.stringify(entry.record));
    await expect(resolveVerifiedRdpRuntime(entry.options)).rejects.toThrow();
    expect(entry.execute).not.toHaveBeenCalled();
  });

  it("requires valid matching Windows application/helper certificates before running a signed helper", async () => {
    const entry = await fixture("win32", true);
    await writeFile(entry.executable, "signed native image");
    entry.execute.mockImplementation(async (file) => file === "powershell.exe" ? "verified" : JSON.stringify(entry.info));
    await expect(resolveVerifiedRdpRuntime(entry.options)).resolves.toBe(entry.executable);
    expect(entry.execute.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(entry.execute.mock.calls[0]?.[1].at(-1)).toContain("$signature.Status -ne 'Valid'");
    expect(entry.execute.mock.calls[0]?.[1].at(-1)).toContain("$fingerprints[0] -cne $fingerprints[1]");
    expect(entry.execute.mock.calls[1]?.[0]).toBe(entry.executable);
    entry.execute.mockClear().mockRejectedValue(new Error("private diagnostic"));
    await expect(resolveVerifiedRdpRuntime(entry.options)).rejects.toThrow("The bundled RDP runtime could not be verified. Rebuild or reinstall Sliver GUI.");
    expect(entry.execute).toHaveBeenCalledTimes(1);
  });

  it("verifies both signed macOS slices against the outer application certificate", async () => {
    const entry = await fixture("darwin", true);
    await writeFile(entry.executable, "signed native image");
    entry.execute.mockImplementation(async (file, args) => {
      if (file === entry.executable) return JSON.stringify(entry.info);
      const extract = args.find((value) => value.startsWith("--extract-certificates="));
      if (extract) await writeFile(`${extract.slice("--extract-certificates=".length)}0`, "same certificate");
      return "";
    });
    await expect(resolveVerifiedRdpRuntime(entry.options)).resolves.toBe(entry.executable);
    const slices = entry.execute.mock.calls.filter(([, args]) => args.includes("--architecture")).map(([, args]) => args[args.indexOf("--architecture") + 1]);
    expect(slices).toEqual(["x86_64", "arm64"]);
    expect(entry.execute.mock.calls.at(-1)?.[0]).toBe(entry.executable);
  });
});
