// @vitest-environment node

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LocalRedirectorRecord } from "../shared/software-deployment-contracts.js";
import { SoftwareDeploymentStore } from "./software-deployment-store.js";

const deploymentId = "5d759d8a-18e4-4a8c-83bb-d618169d5bc8";
const installationId = "7bfdb74e-9267-4f14-a29c-c5fc858347ab";
const timestamp = "2026-09-24T12:00:00.000Z";

let temporaryDirectory = "";
let stateRoot = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-software-state-"));
  stateRoot = join(temporaryDirectory, "gui", "software-deployment", "v1");
});

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

function record(id = installationId): LocalRedirectorRecord {
  return {
    id, deploymentId, recipeId: "caddy", category: "HTTP Redirectors", subcategory: "local",
    status: "active", publicIp: "203.0.113.10", domains: ["c2.example.test"],
    publicUrl: "https://c2.example.test", frontendPorts: [80, 443], ingressPortsOwned: [80, 443],
    listener: { ownership: "managed", kind: "http", host: "127.0.0.1", port: 8000, jobId: 8, domain: "" },
    serviceName: `sliver-gui-caddy-${id}.service`,
    createdAt: timestamp, updatedAt: timestamp, lastCheckedAt: timestamp, lastError: null,
  };
}

describe("SoftwareDeploymentStore", () => {
  it("loads empty state and atomically persists a private software file", async () => {
    const store = await SoftwareDeploymentStore.load(stateRoot);
    expect(store.getState()).toEqual({ v: 1, revision: 0, records: [] });
    await expect(lstat(store.filePath)).rejects.toMatchObject({ code: "ENOENT" });

    const saved = await store.put(record(), 0);
    expect(saved).toMatchObject({ v: 1, revision: 1, records: [{ id: installationId }] });
    expect(store.getState()).toBe(saved);
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(saved);
    expect(await readdir(stateRoot)).toEqual(["software.json"]);
    if (process.platform !== "win32") {
      expect((await lstat(stateRoot)).mode & 0o777).toBe(0o700);
      expect((await lstat(store.filePath)).mode & 0o777).toBe(0o600);
    }

    const reloaded = await SoftwareDeploymentStore.load(stateRoot);
    expect(reloaded.getState()).toEqual(saved);
  });

  it("serializes concurrent mutations and rejects stale revisions without changing disk", async () => {
    const store = await SoftwareDeploymentStore.load(stateRoot);
    const secondId = "fb94b349-b76a-435c-923e-2b185b2a1dd1";
    const [first, second] = await Promise.allSettled([
      store.put(record(), 0),
      store.put(record(secondId), 0),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") expect(String(second.reason)).toContain("Refresh and try again");
    expect(store.getState()).toMatchObject({ revision: 1, records: [{ id: installationId }] });
    const original = await readFile(store.filePath, "utf8");
    await expect(store.remove(installationId, 0)).rejects.toThrow(/Refresh and try again/u);
    expect(await readFile(store.filePath, "utf8")).toBe(original);
    expect(store.getState().revision).toBe(1);

    const removed = await store.remove(installationId, 1);
    expect(removed).toEqual({ v: 1, revision: 2, records: [] });
    expect(JSON.parse(await readFile(store.filePath, "utf8"))).toEqual(removed);
  });

  it("recovers interrupted installs and removals once, while preserving completed records", async () => {
    const installingId = "fb94b349-b76a-435c-923e-2b185b2a1dd1";
    const removingId = "0c81dd4f-fca2-46b0-815e-0bfde0dd952a";
    const store = await SoftwareDeploymentStore.load(stateRoot);
    await store.put({ ...record(installingId), status: "installing", lastCheckedAt: null });
    await store.put({ ...record(removingId), status: "removing" });
    await store.put(record());

    const restarted = await SoftwareDeploymentStore.load(stateRoot);
    const recovered = await restarted.recoverInterruptedTransitions(() => Date.parse("2026-09-25T12:00:00.000Z"));
    expect(recovered.revision).toBe(4);
    expect(recovered.records).toMatchObject([
      { id: installingId, status: "outcome-unknown", lastCheckedAt: null,
        lastError: expect.stringContaining("installation"), updatedAt: "2026-09-25T12:00:00.000Z" },
      { id: removingId, status: "outcome-unknown", lastCheckedAt: null,
        lastError: expect.stringContaining("removal"), updatedAt: "2026-09-25T12:00:00.000Z" },
      { id: installationId, status: "active", lastCheckedAt: timestamp,
        lastError: null, updatedAt: timestamp },
    ]);
    expect(JSON.parse(await readFile(restarted.filePath, "utf8"))).toEqual(recovered);
    expect(await restarted.recoverInterruptedTransitions(() => Date.parse("2026-09-26T12:00:00.000Z"))).toBe(recovered);
    expect((await SoftwareDeploymentStore.load(stateRoot)).getState()).toEqual(recovered);
  });

  it("does not create a state file when there is no interrupted transition", async () => {
    const store = await SoftwareDeploymentStore.load(stateRoot);
    expect(await store.recoverInterruptedTransitions()).toBe(store.getState());
    await expect(lstat(store.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid records before writing and can continue after a rejected mutation", async () => {
    const store = await SoftwareDeploymentStore.load(stateRoot);
    await expect(store.put({ ...record(), listener: { ...record().listener, host: "0.0.0.0" } } as unknown as LocalRedirectorRecord, 0)).rejects.toThrow();
    await expect(lstat(store.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await store.put(record(), 0)).revision).toBe(1);
  });

  it("fails closed on malformed, unsupported, and over-permissive state", async () => {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const path = join(stateRoot, "software.json");
    await writeFile(path, "{invalid json", { mode: 0o600 });
    await expect(SoftwareDeploymentStore.load(stateRoot)).rejects.toThrow();
    await writeFile(path, JSON.stringify({ v: 2, revision: 0, records: [] }), { mode: 0o600 });
    await expect(SoftwareDeploymentStore.load(stateRoot)).rejects.toThrow(/Invalid software deployment state/u);
    await writeFile(path, JSON.stringify({ v: 1, revision: 0, records: [], extra: true }), { mode: 0o600 });
    await expect(SoftwareDeploymentStore.load(stateRoot)).rejects.toThrow(/Unexpected record fields/u);

    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await expect(SoftwareDeploymentStore.load(stateRoot)).rejects.toThrow(/permissions must be private/u);
    }
  });

  it("refuses symbolic-link state and oversized files", async () => {
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const path = join(stateRoot, "software.json");
    const target = join(temporaryDirectory, "target.json");
    await writeFile(target, JSON.stringify({ v: 1, revision: 0, records: [] }), { mode: 0o600 });
    await symlink(target, path);
    await expect(SoftwareDeploymentStore.load(stateRoot)).rejects.toThrow(/bounded regular file/u);
    await rm(path);
    await writeFile(path, "x".repeat(512 * 1024 + 1), { mode: 0o600 });
    await expect(SoftwareDeploymentStore.load(stateRoot)).rejects.toThrow(/bounded regular file/u);
  });
});
