// @vitest-environment node
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { beagleRuntimeEnvironment, captureBeagleExecutable, verifyBeagleExecutable } from "./beagle-runtime-loader.js";

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
