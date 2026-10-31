// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AdCollectionStore } from "./ad-collection-store.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ad-recovery-")); roots.push(root);
  const collections = join(root, "collections"); await mkdir(join(collections, "example.local"), { recursive: true });
  const path = join(collections, "example.local", "collection.zip"); await writeFile(path, "original collection", { mode: 0o600 });
  return { root, collections, path, store: new AdCollectionStore(collections) };
}
it("persists opaque recovery handles across restart, verifies bytes, and removes successful imports", async () => {
  const { collections, path, store } = await fixture();
  const artifact = await store.remember({ path, domain: "example.local", collectorId: "rusthound:armory:extensions/rusthound-ce", targetId: "target-1" });
  const restarted = new AdCollectionStore(collections);
  expect(await restarted.list()).toEqual([artifact]);
  expect(JSON.stringify(artifact)).not.toContain(path);
  expect(await restarted.resolve(artifact.collectionId)).toEqual({ ...artifact, path: await realpath(path) });
  await writeFile(path, "replacement");
  await expect(restarted.resolve(artifact.collectionId)).rejects.toThrow(/changed/u);
  await restarted.imported(artifact.collectionId);
  expect(await restarted.list()).toEqual([]);
});
it("rejects forged handles, out-of-root paths and symlinked collection files", async () => {
  const { root, collections, path, store } = await fixture();
  await expect(store.resolve("../../config")).rejects.toThrow(/valid saved collection/u);
  const outside = join(root, "outside.zip"); await writeFile(outside, "private", { mode: 0o600 });
  const input = { domain: "example.local", collectorId: "sharphound:verified:file", targetId: "target-1" };
  await expect(store.remember({ ...input, path: outside })).rejects.toThrow(/managed collection/u);
  const link = join(collections, "link.zip"); await symlink(path, link);
  await expect(store.remember({ ...input, path: link })).rejects.toThrow(/regular ZIP/u);
});

it("reports missing records and archives without disclosing filesystem paths", async () => {
  const { path, collections, store } = await fixture();
  const input = { path, domain: "example.local", collectorId: "sharphound:verified:file", targetId: "target-1" };
  const artifact = await store.remember(input);
  await unlink(path);
  const message = "This saved collection is no longer available; refresh Saved collections and choose another collection";
  await expect(store.resolve(artifact.collectionId)).rejects.toThrow(message);
  await unlink(join(collections, ".pending", `${artifact.collectionId}.json`));
  await expect(store.resolve(artifact.collectionId)).rejects.toThrow(message);
  await expect(store.remember(input)).rejects.toThrow(message);
  await store.imported(artifact.collectionId);
  await rm(join(collections, ".pending"), { recursive: true });
  await expect(store.resolve(artifact.collectionId)).rejects.toThrow(message);
  expect(await store.list()).toEqual([]);
});

it("rejects malformed JSON with a fixed message and keeps other valid recovery entries", async () => {
  const { path, collections, store } = await fixture();
  const input = { path, domain: "example.local", collectorId: "sharphound:verified:file", targetId: "target-1" };
  const damaged = await store.remember(input);
  const valid = await store.remember(input);
  const receiptPath = join(collections, ".pending", `${damaged.collectionId}.json`);
  await writeFile(receiptPath, `{"privatePath": "${path}", "privateContent": "DO_NOT_ECHO", broken}`);
  await expect(store.resolve(damaged.collectionId)).rejects.toThrow(
    "The saved collection recovery record is invalid; use the original ZIP to recover this collection",
  );
  expect(await store.list()).toEqual([valid]);
});

it("validates recovery metadata before returning summaries or resolving ZIPs", async () => {
  const { path, collections, store } = await fixture();
  const artifact = await store.remember({ path, domain: "example.local", collectorId: "rusthound:armory:extensions/rusthound-ce", targetId: "target-1" });
  const receiptPath = join(collections, ".pending", `${artifact.collectionId}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  const malformed: unknown[] = [null, [], "record", {},
    { ...receipt, extra: "unexpected" },
    { ...receipt, collectionId: "00000000-0000-4000-8000-000000000001" },
    { ...receipt, domain: "EXAMPLE.LOCAL" },
    { ...receipt, createdAt: 1234 },
    { ...receipt, createdAt: "October 25, 2026" },
    { ...receipt, createdAt: "2026-02-30T00:00:00.000Z" },
    { ...receipt, sha256: 1234 },
    { ...receipt, sha256: [receipt["sha256"]] },
    { ...receipt, collectorId: "" },
    { ...receipt, collectorId: "unknown:collector" },
    { ...receipt, collectorId: "sharphound:armory:aliases/../private" },
    { ...receipt, targetId: "target\nDO_NOT_ECHO" },
    { ...receipt, targetId: "/private/secret" },
    { ...receipt, relativePath: "../outside.zip" },
    { ...receipt, relativePath: "example.local/../example.local/collection.zip" },
    { ...receipt, relativePath: "/private/collection.zip" },
    { ...receipt, relativePath: "C:\\private\\collection.zip" },
    { ...receipt, relativePath: "example.local/collection.json" },
  ];
  for (const value of malformed) {
    await writeFile(receiptPath, JSON.stringify(value));
    await expect(store.resolve(artifact.collectionId)).rejects.toThrow(
      "The saved collection recovery record is invalid; use the original ZIP to recover this collection",
    );
    expect(await store.list()).toEqual([]);
  }
  await writeFile(receiptPath, JSON.stringify(receipt));
  expect(await store.list()).toEqual([artifact]);
});

it("sanitizes filesystem write failures and refuses a symlinked recovery directory", async () => {
  const { root, path, collections, store } = await fixture();
  const input = { path, domain: "example.local", collectorId: "sharphound:verified:file", targetId: "target-1" };
  const pendingPath = join(collections, ".pending");
  await writeFile(pendingPath, "not a directory", { mode: 0o600 });
  await expect(store.remember(input)).rejects.toThrow(
    "The collection recovery record could not be saved; check managed collection storage permissions and available disk space",
  );
  await expect(store.list()).rejects.toThrow("The collection recovery directory is invalid; restore managed collection storage before retrying");
  await unlink(pendingPath);
  const outside = join(root, "outside");
  await mkdir(outside);
  const collectionId = "00000000-0000-4000-8000-000000000001";
  const externalReceipt = join(outside, `${collectionId}.json`);
  await writeFile(externalReceipt, "must remain untouched", { mode: 0o600 });
  await symlink(outside, pendingPath, "dir");
  await expect(store.list()).rejects.toThrow(/recovery directory is invalid/u);
  await expect(store.resolve(collectionId)).rejects.toThrow(/recovery directory is invalid/u);
  await expect(store.imported(collectionId)).rejects.toThrow(/recovery directory is invalid/u);
  expect(await readFile(externalReceipt, "utf8")).toBe("must remain untouched");
});
