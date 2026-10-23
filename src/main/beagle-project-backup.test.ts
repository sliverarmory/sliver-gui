// @vitest-environment node
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashBeagleFile, readBeagleBackup, writeBeagleBackup } from "./beagle-project-backup.js";

describe("complete project backup container", () => {
  let root: string;
  const database = Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(2_100_000, 42)]);
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "beagle-backup-")); await writeFile(join(root, "source.db"), database); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("streams exact database bytes and metadata with private permissions", async () => {
    const metadata = { project: { name: "Range" }, queries: [{ name: "Owned" }], provenance: ["digest"] };
    await writeBeagleBackup(join(root, "project.beagle"), join(root, "source.db"), metadata);
    expect(await readBeagleBackup(join(root, "project.beagle"), join(root, "restored.db"))).toEqual(metadata);
    expect(await readFile(join(root, "restored.db"))).toEqual(database);
    expect((await hashBeagleFile(join(root, "restored.db"), database.length)).bytes).toBe(database.length);
    if (process.platform !== "win32") expect((await stat(join(root, "project.beagle"))).mode & 0o777).toBe(0o600);
  });
  it("rejects corruption and removes incomplete output", async () => {
    await writeBeagleBackup(join(root, "project.beagle"), join(root, "source.db"), {});
    const bytes = await readFile(join(root, "project.beagle")); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await writeFile(join(root, "project.beagle"), bytes);
    await expect(readBeagleBackup(join(root, "project.beagle"), join(root, "restored.db"))).rejects.toThrow("checksum mismatch");
    await expect(stat(join(root, "restored.db"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects truncation, trailing data, links and oversized files", async () => {
    await writeBeagleBackup(join(root, "project.beagle"), join(root, "source.db"), {});
    const bytes = await readFile(join(root, "project.beagle"));
    for (const altered of [bytes.subarray(0, 12), bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.from("x")])]) {
      await writeFile(join(root, "bad.beagle"), altered);
      await expect(readBeagleBackup(join(root, "bad.beagle"), join(root, "restored.db"))).rejects.toThrow();
    }
    await symlink(join(root, "source.db"), join(root, "linked.db"));
    await expect(hashBeagleFile(join(root, "linked.db"), database.length)).rejects.toThrow("regular file");
    await expect(hashBeagleFile(join(root, "source.db"), 100)).rejects.toThrow("limit");
  });
  it("honors cancellation without leaving a partial restore or clobbering an existing output", async () => {
    await writeBeagleBackup(join(root, "project.beagle"), join(root, "source.db"), {});
    await expect(readBeagleBackup(join(root, "project.beagle"), join(root, "restored.db"), AbortSignal.abort())).rejects.toThrow("cancelled");
    await expect(stat(join(root, "restored.db"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(root, "existing.beagle"), "keep");
    await expect(writeBeagleBackup(join(root, "existing.beagle"), join(root, "source.db"), {})).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(root, "existing.beagle"), "utf8")).toBe("keep");
  });
});
