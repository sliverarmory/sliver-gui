// @vitest-environment node

import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverSavedConfigs,
  MAX_SAVED_CONFIG_BYTES,
  readCurrentSavedConfig,
} from "./saved-config-catalog.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sliver-gui-configs-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("saved Sliver config discovery", () => {
  it("returns only safe metadata in deterministic recency order", async () => {
    const older = join(directory, "alpha.cfg");
    const newest = join(directory, "bravo.json");
    await writeFile(older, validConfig({ operator: "alice", lhost: "one.example" }));
    await writeFile(newest, validConfig({ operator: "bob", lhost: "two.example", wg: wireGuardConfig() }));
    await utimes(older, new Date("2026-01-01T00:00:00.000Z"), new Date("2026-01-01T00:00:00.000Z"));
    await utimes(newest, new Date("2026-02-01T00:00:00.000Z"), new Date("2026-02-01T00:00:00.000Z"));

    const summaries = (await discoverSavedConfigs(directory)).map((record) => record.summary);

    expect(summaries.map((summary) => summary.fileName)).toEqual(["bravo.json", "alpha.cfg"]);
    expect(summaries[0]).toMatchObject({
      displayName: "bravo",
      operator: "bob",
      lhost: "two.example",
      lport: 31337,
      transport: "wireguard",
      origin: "preexisting",
      removal: "detach",
      availability: "deferred",
      unavailableReason: "WireGuard operator connections are deferred for this milestone",
      modifiedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(summaries[1]?.transport).toBe("mtls");
    expect(summaries.every((summary) => /^[0-9a-f-]{36}$/u.test(summary.id))).toBe(true);

    const exposed = JSON.stringify(summaries);
    expect(exposed).not.toContain(directory);
    expect(exposed).not.toContain("TOP-SECRET-PRIVATE-KEY");
    expect(exposed).not.toContain("TOP-SECRET-TOKEN");
    expect(Object.keys(summaries[0] ?? {}).sort()).toEqual(
      [
        "availability",
        "displayName",
        "fileName",
        "id",
        "lhost",
        "lport",
        "modifiedAt",
        "operator",
        "origin",
        "removal",
        "transport",
        "unavailableReason",
      ].sort(),
    );
  });

  it("uses the file name as a deterministic tie-breaker", async () => {
    const bravo = join(directory, "bravo.cfg");
    const alpha = join(directory, "alpha.cfg");
    const timestamp = new Date("2026-03-01T00:00:00.000Z");
    await writeFile(bravo, validConfig());
    await writeFile(alpha, validConfig());
    await utimes(bravo, timestamp, timestamp);
    await utimes(alpha, timestamp, timestamp);

    expect((await discoverSavedConfigs(directory)).map((record) => record.summary.fileName)).toEqual([
      "alpha.cfg",
      "bravo.cfg",
    ]);
  });

  it("ignores invalid, oversized, directory, and symlink entries without hiding valid files", async () => {
    const validPath = join(directory, "valid.cfg");
    await writeFile(validPath, validConfig());
    await writeFile(join(directory, "invalid.cfg"), "not json");
    await writeFile(join(directory, "oversized.cfg"), Buffer.alloc(MAX_SAVED_CONFIG_BYTES + 1, 0x61));
    await mkdir(join(directory, "directory.cfg"));
    await symlink(validPath, join(directory, "linked.cfg"));

    const records = await discoverSavedConfigs(directory);

    expect(records.map((record) => record.summary.fileName)).toEqual(["valid.cfg"]);
  });

  it("sanitizes and bounds untrusted renderer-facing strings", async () => {
    await writeFile(
      join(directory, "unsafe.cfg"),
      validConfig({
        operator: `${"a".repeat(220)}\n\u202eoperator`,
        lhost: "server.example\r\nspoofed",
      }),
    );

    const summary = (await discoverSavedConfigs(directory))[0]?.summary;

    expect(summary?.operator).toHaveLength(200);
    expect(summary?.operator).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
    expect(summary?.lhost).toBe("server.example spoofed");
  });

  it("returns an empty catalog when the config directory is missing", async () => {
    expect(await discoverSavedConfigs(join(directory, "missing"))).toEqual([]);
  });

  it("rejects catalog records whose file content changed after refresh", async () => {
    const path = join(directory, "mutable.cfg");
    await writeFile(path, validConfig({ operator: "before" }));
    const record = (await discoverSavedConfigs(directory))[0];
    expect(record).toBeDefined();
    await writeFile(path, validConfig({ operator: "after" }));

    await expect(readCurrentSavedConfig(record!)).rejects.toThrow(/changed/);
  });
});

function validConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    operator: "operator",
    lhost: "localhost",
    lport: 31337,
    ca_certificate: "TOP-SECRET-CA",
    certificate: "TOP-SECRET-CERTIFICATE",
    private_key: "TOP-SECRET-PRIVATE-KEY",
    token: "TOP-SECRET-TOKEN",
    ...overrides,
  });
}

function wireGuardConfig(): Record<string, string> {
  return {
    server_pub_key: "server-key",
    client_private_key: "client-key",
    client_pub_key: "client-public-key",
    client_ip: "127.0.0.2",
    server_ip: "127.0.0.1",
  };
}
