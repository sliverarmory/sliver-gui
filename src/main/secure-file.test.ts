// @vitest-environment node

import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readBoundedRegularFile,
  writePrivateArtifactFileAtomic,
  writePrivateFileAtomic,
} from "./secure-file.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sliver-gui-secure-file-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("bounded regular-file IO", () => {
  it("rejects links, directories, and oversized files before returning bytes", async () => {
    const file = join(directory, "operator.cfg");
    await writeFile(file, "secret", { mode: 0o600 });
    await symlink(file, join(directory, "operator-link.cfg"));

    await expect(
      readBoundedRegularFile(join(directory, "operator-link.cfg"), { label: "Config", maxBytes: 32 }),
    ).rejects.toThrow(/regular file/);
    await expect(readBoundedRegularFile(directory, { label: "Config", maxBytes: 32 })).rejects.toThrow(
      /regular file/,
    );
    await expect(readBoundedRegularFile(file, { label: "Config", maxBytes: 3 })).rejects.toThrow(/bounded/);
  });

  it.runIf(process.platform !== "win32")("enforces private-mode policy for secret inputs", async () => {
    const file = join(directory, "private.key");
    await writeFile(file, "secret", { mode: 0o644 });

    await expect(
      readBoundedRegularFile(file, { label: "Private key", maxBytes: 32, requirePrivateMode: true }),
    ).rejects.toThrow(/permissions must be private/);
  });

  it("atomically writes a verified private regular file", async () => {
    const destination = join(directory, "managed", "operator.cfg");
    const data = Buffer.from("secret", "utf8");
    await writePrivateFileAtomic(destination, data);

    expect(await readFile(destination, "utf8")).toBe("secret");
    const info = await stat(destination);
    expect(info.isFile()).toBe(true);
    if (process.platform !== "win32") expect(info.mode & 0o777).toBe(0o600);
  });

  it("writes a private artifact without changing its selected parent directory", async () => {
    const destination = join(directory, "session-report.bin");
    if (process.platform !== "win32") await chmod(directory, 0o755);

    await writePrivateArtifactFileAtomic(destination, Buffer.from("artifact"));

    expect(await readFile(destination, "utf8")).toBe("artifact");
    const fileInfo = await stat(destination);
    if (process.platform !== "win32") {
      expect(fileInfo.mode & 0o777).toBe(0o600);
      expect((await stat(directory)).mode & 0o777).toBe(0o755);
    }
  });

  it("does not replace a newer artifact when the commit guard rejects", async () => {
    const destination = join(directory, "session-report.bin");
    await writeFile(destination, "newer", { mode: 0o600 });

    await expect(writePrivateArtifactFileAtomic(
      destination,
      Buffer.from("stale"),
      () => { throw new Error("stale save intent"); },
    )).rejects.toThrow(/stale save intent/u);

    expect(await readFile(destination, "utf8")).toBe("newer");
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
