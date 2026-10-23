// @vitest-environment node
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beagleRuntimeEnvironment, captureBeagleExecutable, resolveVerifiedBeagleRuntime, verifyBeagleExecutable } from "./beagle-runtime-loader.js";
import type { NativeVerificationCommand } from "./native-runtime-loader.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: vi.fn(original.open) };
});

const directories: string[] = [];
const hash = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const failure = "The Beagle executable could not be verified. Choose the executable again or check the configured SHA-256.";

async function fixture(contents = "selected executable bytes") {
  const root = await mkdtemp(join(tmpdir(), "sliver-beagle-loader-"));
  directories.push(root);
  const path = join(root, process.platform === "win32" ? "beagle.exe" : "beagle");
  await writeFile(path, contents, { mode: 0o755 });
  await chmod(path, 0o755);
  return { root, path, contents };
}

beforeEach(async () => {
  const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(open).mockReset().mockImplementation(original.open);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Beagle executable identity", () => {
  it("captures canonical path, size and digest without executing the selected file", async () => {
    const entry = await fixture();
    const expected = { path: await realpath(entry.path), sha256: hash(entry.contents), size: Buffer.byteLength(entry.contents) };
    await expect(captureBeagleExecutable(entry.path)).resolves.toEqual(expected);
    await expect(verifyBeagleExecutable(entry.path, expected.sha256)).resolves.toEqual(expected);
    await expect(verifyBeagleExecutable(entry.path, expected.sha256.toUpperCase())).resolves.toEqual(expected);
  });

  it("rejects changed bytes against the previously captured pin", async () => {
    const entry = await fixture();
    const identity = await captureBeagleExecutable(entry.path);
    await writeFile(entry.path, "replacement executable");
    await expect(verifyBeagleExecutable(entry.path, identity.sha256)).rejects.toThrow(failure);
  });

  it.each(["", "a".repeat(63), "a".repeat(65), "g".repeat(64), ` ${"a".repeat(64)}`, `${"a".repeat(64)}\n`])(
    "rejects malformed expected digest %j before opening a file", async (digest) => {
      const entry = await fixture();
      await expect(verifyBeagleExecutable(entry.path, digest)).rejects.toThrow(failure);
      expect(open).not.toHaveBeenCalled();
    },
  );

  it.each(["beagle", "../beagle", "", "/tmp/beagle\u0000", "/tmp/beagle\n"])("rejects invalid executable path %j", async (path) => {
    await expect(captureBeagleExecutable(path)).rejects.toThrow(failure);
    expect(open).not.toHaveBeenCalled();
  });

  it("sanitizes missing-file errors instead of returning native paths", async () => {
    const entry = await fixture();
    await expect(captureBeagleExecutable(join(entry.root, "private-name"))).rejects.toEqual(new Error(failure));
  });

  it("rejects directories, empty files and files above the 256 MiB limit before opening", async () => {
    const entry = await fixture();
    await expect(captureBeagleExecutable(entry.root)).rejects.toThrow(failure);
    await truncate(entry.path, 0);
    await expect(captureBeagleExecutable(entry.path)).rejects.toThrow(failure);
    await truncate(entry.path, 256 * 1024 * 1024 + 1);
    await expect(captureBeagleExecutable(entry.path)).rejects.toThrow(failure);
    expect(open).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("rejects selected symlinks but canonicalizes parent directory aliases", async () => {
    const entry = await fixture();
    const link = join(entry.root, "linked-beagle");
    await symlink(entry.path, link);
    await expect(captureBeagleExecutable(link)).rejects.toThrow(failure);
    const alias = join(entry.root, "alias");
    await symlink(entry.root, alias);
    await expect(captureBeagleExecutable(join(alias, "beagle"))).resolves.toMatchObject({ path: await realpath(entry.path) });
  });

  it.skipIf(process.platform === "win32").each([0o644, 0o757])("rejects unsafe POSIX mode %o", async (mode) => {
    const entry = await fixture();
    await chmod(entry.path, mode);
    await expect(captureBeagleExecutable(entry.path)).rejects.toThrow(failure);
  });

  it.skipIf(process.platform === "win32")("permits an explicitly selected executable managed by a writable group", async () => {
    const entry = await fixture();
    await chmod(entry.path, 0o775);
    await expect(captureBeagleExecutable(entry.path)).resolves.toMatchObject({ sha256: hash(entry.contents) });
  });

  it("rejects a replacement between initial path inspection and opening", async () => {
    const entry = await fixture();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await rename(entry.path, join(entry.root, "previous"));
      await writeFile(entry.path, entry.contents, { mode: 0o755 });
      return original.open(...args);
    });
    await expect(captureBeagleExecutable(entry.path)).rejects.toThrow(failure);
  });

  it("rejects a path replacement even when the opened descriptor retains the originally selected bytes", async () => {
    const entry = await fixture();
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args);
      await rename(entry.path, join(entry.root, "previous"));
      await writeFile(entry.path, entry.contents, { mode: 0o755 });
      return handle;
    });
    await expect(captureBeagleExecutable(entry.path)).rejects.toThrow(failure);
  });

  it.skipIf(process.platform === "win32")("rejects a parent alias redirected during verification", async () => {
    const entry = await fixture();
    const nextDirectory = join(entry.root, "next");
    await mkdir(nextDirectory);
    await writeFile(join(nextDirectory, "beagle"), entry.contents, { mode: 0o755 });
    const alias = join(entry.root, "alias");
    await symlink(entry.root, alias);
    const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await original.open(...args);
      await rm(alias);
      await symlink(nextDirectory, alias);
      return handle;
    });
    await expect(captureBeagleExecutable(join(alias, "beagle"))).rejects.toThrow(failure);
  });
});

describe("Beagle runtime environment", () => {
  it("passes only OS, home, temporary-directory and explicit locale variables", () => {
    const environment = {
      HOME: "/operator", USERPROFILE: "C:\\Users\\operator", SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows",
      APPDATA: "roaming", LOCALAPPDATA: "local", TEMP: "temporary", TMP: "temp", TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8", LC_ALL: "C", LC_NUMERIC: "C", LANGUAGE: "en", TZ: "UTC", ignored: undefined,
    };
    expect(beagleRuntimeEnvironment(environment)).toEqual(Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)));
  });

  it("excludes executable search, loader/interpreter controls, application settings and cloud secrets", () => {
    const keys = ["PATH", "Path", "PATHEXT", "COMSPEC", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
      "PYTHONPATH", "PYTHONSTARTUP", "NODE_OPTIONS", "NODE_PATH", "AWS_SECRET_ACCESS_KEY", "AZURE_CLIENT_SECRET",
      "GRAPHQLITE_EXTENSION_PATH", "SLIVER_BEAGLE_BINARY", "SLIVER_BEAGLE_SHA256", "RUST_LOG", "RUST_BACKTRACE", "LOCPATH", "LC_SECRET"];
    expect(beagleRuntimeEnvironment(Object.fromEntries(keys.map((key) => [key, "sensitive"])))).toEqual({});
  });
});

async function bundledFixture(platform: NodeJS.Platform = "linux", packaged = false) {
  const root = await mkdtemp(join(tmpdir(), "sliver-beagle-bundled-"));
  directories.push(root);
  const resourcesPath = join(root, "Sliver GUI.app/Contents/Resources");
  const directory = packaged ? join(resourcesPath, "beagle") : join(root, "native/beagle/bin");
  const protocolPath = packaged ? join(resourcesPath, "app.asar/protocol/beagle-provenance.json") : join(root, "protocol/beagle-provenance.json");
  await mkdir(dirname(protocolPath), { recursive: true });
  await mkdir(directory, { recursive: true });
  const source = { repository: "https://github.com/sliverarmory/Beagle", commit: "a".repeat(40), tree: "b".repeat(40) };
  const manifest = { schemaVersion: 1, protocolVersion: 1, version: "0.1.0", source };
  const sourceBytes = JSON.stringify(manifest);
  const inputs = [{ path: "scripts/buildBeagleRuntime.mjs", sha256: "c".repeat(64) }];
  const buildIdentity = hash(JSON.stringify({ manifest, inputs }));
  const target = platform === "linux" ? "x86_64-unknown-linux-gnu" : platform === "win32" ? "x86_64-pc-windows-gnu" : "aarch64-apple-darwin";
  const filename = platform === "win32" ? "beagle.exe" : "beagle";
  const contents = "known Beagle executable image";
  const record = { schemaVersion: 1, protocolVersion: 1, source, inputs, sourceManifestSha256: hash(sourceBytes), buildIdentity,
    artifact: { fileName: filename, sha256: hash(contents), size: Buffer.byteLength(contents) },
    build: { target: platform === "linux" ? "linux-x64" : platform === "win32" ? "windows-x64" : "darwin-universal",
      slices: platform === "darwin" ? [{ target: "x86_64-apple-darwin" }, { target: "aarch64-apple-darwin" }] : [{ target }] } };
  const path = join(directory, filename);
  await writeFile(protocolPath, sourceBytes);
  await writeFile(join(directory, "source-provenance.json"), sourceBytes);
  await writeFile(join(directory, "provenance.json"), JSON.stringify(record));
  const packagedRecordPath = join(resourcesPath, "app.asar/native/beagle/packaged-provenance.json");
  if (packaged) {
    await mkdir(dirname(packagedRecordPath), { recursive: true });
    await writeFile(packagedRecordPath, JSON.stringify(record));
  }
  await writeFile(path, contents, { mode: 0o755 });
  await chmod(path, 0o755);
  const info = { name: "beagle", protocol: 1, version: "0.1.0", beagleRevision: source.commit, target };
  const execute = vi.fn<NativeVerificationCommand>().mockResolvedValue(JSON.stringify(info));
  const options = { isPackaged: packaged, resourcesPath, developmentRoot: root, platform,
    architecture: platform === "darwin" ? "arm64" : "x64", execute };
  return { root, directory, options, path, contents, protocolPath, packagedRecordPath, record, execute, info };
}

describe("bundled Beagle runtime loading", () => {
  it.each([false, true])("resolves the fixed helper with verified source, build and executable identity (packaged=%s)", async (packaged) => {
    const entry = await bundledFixture("linux", packaged);
    const path = await realpath(entry.path);
    await expect(resolveVerifiedBeagleRuntime(entry.options)).resolves.toEqual({ path, sha256: hash(entry.contents), size: Buffer.byteLength(entry.contents) });
    expect(entry.execute).toHaveBeenCalledExactlyOnceWith(path, ["--build-info"], expect.objectContaining({ timeout: 15_000, maxBuffer: 16 * 1024 }));
    expect(entry.execute.mock.calls[0]?.[2].env).not.toHaveProperty("PATH");
  });

  it.each(["name", "protocol", "version", "beagleRevision", "target"])("rejects a helper with incompatible %s build information", async (field) => {
    const entry = await bundledFixture();
    entry.execute.mockResolvedValue(JSON.stringify({ ...entry.info, [field]: "wrong" }));
    await expect(resolveVerifiedBeagleRuntime(entry.options)).rejects.toThrow(/bundled Beagle runtime could not be verified/u);
  });

  it.each([false, true])("rejects changed bytes before execution on Linux (packaged=%s)", async (packaged) => {
    const entry = await bundledFixture("linux", packaged);
    await writeFile(entry.path, "replacement");
    await expect(resolveVerifiedBeagleRuntime(entry.options)).rejects.toThrow();
    expect(entry.execute).not.toHaveBeenCalled();
  });

  it("rejects simultaneous packaged helper and external provenance replacement against the ASAR build record", async () => {
    const entry = await bundledFixture("linux", true);
    const replacement = "replacement helper";
    await writeFile(entry.path, replacement);
    entry.record.artifact.sha256 = hash(replacement);
    entry.record.artifact.size = Buffer.byteLength(replacement);
    await writeFile(join(entry.directory, "provenance.json"), JSON.stringify(entry.record));
    await expect(resolveVerifiedBeagleRuntime(entry.options)).rejects.toThrow();
    expect(entry.execute).not.toHaveBeenCalled();
  });

  it("rejects provenance-selected paths and source pin drift before executing a helper", async () => {
    const entry = await bundledFixture();
    entry.record.artifact.fileName = "../other-executable";
    await writeFile(join(entry.directory, "provenance.json"), JSON.stringify(entry.record));
    await expect(resolveVerifiedBeagleRuntime(entry.options)).rejects.toThrow();
    await writeFile(entry.protocolPath, "changed source pin");
    await expect(resolveVerifiedBeagleRuntime(entry.options)).rejects.toThrow();
    expect(entry.execute).not.toHaveBeenCalled();
  });

  it("rejects unsupported architectures and packaged builds missing a required universal slice", async () => {
    const entry = await bundledFixture("darwin", true);
    await expect(resolveVerifiedBeagleRuntime({ ...entry.options, architecture: "riscv64" })).rejects.toThrow();
    entry.record.build.slices = [{ target: "aarch64-apple-darwin" }];
    const bytes = JSON.stringify(entry.record);
    await writeFile(join(entry.directory, "provenance.json"), bytes);
    await writeFile(entry.packagedRecordPath, bytes);
    await expect(resolveVerifiedBeagleRuntime(entry.options)).rejects.toThrow();
    expect(entry.execute).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("rejects symlinked and non-executable bundled helpers", async () => {
    const entry = await bundledFixture();
    await chmod(entry.path, 0o644);
    await expect(resolveVerifiedBeagleRuntime(entry.options)).rejects.toThrow();
    const external = join(entry.root, "external");
    await writeFile(external, await readFile(entry.path), { mode: 0o755 });
    await rm(entry.path);
    await symlink(external, entry.path);
    await expect(resolveVerifiedBeagleRuntime(entry.options)).rejects.toThrow();
    expect(entry.execute).not.toHaveBeenCalled();
  });

  it("requires matching Windows signatures for signing changes and pins the installed bytes", async () => {
    const entry = await bundledFixture("win32", true);
    const signedBytes = "signed Beagle executable";
    await writeFile(entry.path, signedBytes);
    entry.execute.mockImplementation(async (file) => file === "powershell.exe" ? "verified" : JSON.stringify(entry.info));
    await expect(resolveVerifiedBeagleRuntime(entry.options)).resolves.toMatchObject({ sha256: hash(signedBytes), size: Buffer.byteLength(signedBytes) });
    expect(entry.execute.mock.calls[0]?.[0]).toBe("powershell.exe");
    expect(entry.execute.mock.calls[0]?.[1].at(-1)).toContain("$fingerprints[0] -cne $fingerprints[1]");
    entry.execute.mockClear().mockRejectedValue(new Error("private diagnostic"));
    await expect(resolveVerifiedBeagleRuntime(entry.options)).rejects.toThrow("The bundled Beagle runtime could not be verified. Rebuild or reinstall Sliver GUI.");
    expect(entry.execute).toHaveBeenCalledTimes(1);
  });

  it("verifies both macOS architectures against the application signer", async () => {
    const entry = await bundledFixture("darwin", true);
    await writeFile(entry.path, "signed Beagle executable");
    entry.execute.mockImplementation(async (file, args) => {
      if (file !== "/usr/bin/codesign") return JSON.stringify(entry.info);
      const extract = args.find((value) => value.startsWith("--extract-certificates="));
      if (extract) await writeFile(`${extract.slice("--extract-certificates=".length)}0`, "same certificate");
      return "";
    });
    await expect(resolveVerifiedBeagleRuntime(entry.options)).resolves.toMatchObject({ sha256: hash("signed Beagle executable") });
    const slices = entry.execute.mock.calls.filter(([, args]) => args.includes("--architecture")).map(([, args]) => args[args.indexOf("--architecture") + 1]);
    expect(slices).toEqual(["x86_64", "arm64"]);
  });

  it("rejects a helper replaced while build information was read", async () => {
    const entry = await bundledFixture();
    entry.execute.mockImplementation(async () => {
      await writeFile(entry.path, "replacement helper");
      return JSON.stringify(entry.info);
    });
    await expect(resolveVerifiedBeagleRuntime(entry.options)).rejects.toThrow();
  });
});
