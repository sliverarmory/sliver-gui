// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createUpdateCertificateTrust, UpdateCertificateTrustRequiredError } from "./update-certificate-trust.js";

const directories: string[] = [];
const certificate = Buffer.from("certificate bytes verified by the native helper");
const sha256 = createHash("sha256").update(certificate).digest("hex");

async function fixture() {
  const resourcesPath = await mkdtemp(join(tmpdir(), "update-certificate-trust-test-"));
  directories.push(resourcesPath);
  await mkdir(join(resourcesPath, "update-signing"));
  await mkdir(join(resourcesPath, "updater-trust"));
  await writeFile(join(resourcesPath, "update-signing", "macos.cer"), certificate);
  await writeFile(join(resourcesPath, "update-signing", "manifest.json"), JSON.stringify({ schemaVersion: 1, macos: { sha256 } }));
  await writeFile(join(resourcesPath, "updater-trust", "updater-trust"), "test helper");
  const executeHelper = vi.fn<(file: string, args: readonly string[], options: { timeout: number; maxBuffer: number }) => Promise<string>>();
  const trust = createUpdateCertificateTrust({ platform: "darwin", isPackaged: true, resourcesPath, executeHelper });
  return { resourcesPath, executeHelper, trust };
}

function response(status: string, fingerprint = sha256): string {
  return JSON.stringify({ schemaVersion: 1, status, sha256: fingerprint });
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("macOS updater certificate trust", () => {
  it("does not inspect files or launch helpers in development or on other platforms", async () => {
    const executeHelper = vi.fn();
    for (const options of [
      { platform: "darwin" as const, isPackaged: false },
      { platform: "win32" as const, isPackaged: true },
      { platform: "linux" as const, isPackaged: true },
    ]) {
      await createUpdateCertificateTrust({ ...options, resourcesPath: "/missing", executeHelper }).ensureTrusted(true);
    }
    expect(executeHelper).not.toHaveBeenCalled();
  });

  it("silently accepts persisted trust and uses a fixed executable with a bounded read-only invocation", async () => {
    const { trust, executeHelper, resourcesPath } = await fixture();
    executeHelper.mockResolvedValue(response("trusted"));
    await trust.ensureTrusted(false);
    expect(executeHelper).toHaveBeenCalledExactlyOnceWith(
      join(resourcesPath, "updater-trust", "updater-trust"), ["check", sha256], { timeout: 15_000, maxBuffer: 16 * 1024 },
    );
  });

  it("requires foreground interaction without launching the authorization UI in a background check", async () => {
    const { trust, executeHelper } = await fixture();
    executeHelper.mockResolvedValue(response("required"));
    await expect(trust.ensureTrusted(false)).rejects.toMatchObject({ name: "UpdateCertificateTrustRequiredError", kind: "required" });
    expect(executeHelper).toHaveBeenCalledTimes(1);
    expect(executeHelper.mock.calls[0]?.[1]).toEqual(["check", sha256]);
  });

  it("requests trust only after a manual check and independently rechecks persisted trust", async () => {
    const { trust, executeHelper } = await fixture();
    executeHelper.mockResolvedValueOnce(response("required")).mockResolvedValueOnce(response("trusted")).mockResolvedValueOnce(response("trusted"));
    await trust.ensureTrusted(true);
    expect(executeHelper.mock.calls.map((call) => call[1])).toEqual([["check", sha256], ["request", sha256], ["check", sha256]]);
    expect(executeHelper.mock.calls[1]?.[2]).toEqual({ timeout: 180_000, maxBuffer: 16 * 1024 });
  });

  it("does not accept the trust dialog alone as evidence of persisted trust", async () => {
    const { trust, executeHelper } = await fixture();
    executeHelper.mockResolvedValueOnce(response("required")).mockResolvedValueOnce(response("trusted")).mockResolvedValueOnce(response("required"));
    await expect(trust.ensureTrusted(true)).rejects.toBeInstanceOf(UpdateCertificateTrustRequiredError);
  });

  it("maps explicit cancellation without retrying or weakening validation", async () => {
    const { trust, executeHelper } = await fixture();
    executeHelper.mockResolvedValueOnce(response("required")).mockResolvedValueOnce(response("cancelled"));
    await expect(trust.ensureTrusted(true)).rejects.toMatchObject({ kind: "cancelled" });
    expect(executeHelper).toHaveBeenCalledTimes(2);
  });

  it("refuses a changed certificate before executing the helper", async () => {
    const { trust, executeHelper, resourcesPath } = await fixture();
    await writeFile(join(resourcesPath, "update-signing", "macos.cer"), "replacement certificate");
    await expect(trust.ensureTrusted(true)).rejects.toThrow("could not be verified");
    expect(executeHelper).not.toHaveBeenCalled();
  });

  it.each([
    "{}", "invalid json", response("trusted", "0".repeat(64)), response("unrecognized"), response("cancelled"),
  ])("rejects malformed or mismatched read-only helper responses: %s", async (output) => {
    const { trust, executeHelper } = await fixture();
    executeHelper.mockResolvedValue(output);
    await expect(trust.ensureTrusted(true)).rejects.toThrow("could not be verified");
    expect(executeHelper).toHaveBeenCalledTimes(1);
  });

  it("does not expose helper diagnostics or treat process failure as missing trust", async () => {
    const { trust, executeHelper } = await fixture();
    executeHelper.mockRejectedValue(new Error("private filesystem detail and helper stderr"));
    await expect(trust.ensureTrusted(true)).rejects.toThrow("The bundled update signing certificate could not be verified.");
    expect(executeHelper).toHaveBeenCalledTimes(1);
  });

  it("rejects a helper symlink instead of running a substituted executable", async () => {
    const { trust, executeHelper, resourcesPath } = await fixture();
    const helper = join(resourcesPath, "updater-trust", "updater-trust");
    await rm(helper);
    await symlink(join(resourcesPath, "update-signing", "macos.cer"), helper);
    await expect(trust.ensureTrusted(true)).rejects.toThrow("could not be verified");
    expect(executeHelper).not.toHaveBeenCalled();
  });

  it("rejects an unsupported manifest version and oversized public certificate", async () => {
    const { trust, executeHelper, resourcesPath } = await fixture();
    await writeFile(join(resourcesPath, "update-signing", "manifest.json"), JSON.stringify({ schemaVersion: 2, macos: { sha256 } }));
    await expect(trust.ensureTrusted(true)).rejects.toThrow("could not be verified");
    await writeFile(join(resourcesPath, "update-signing", "manifest.json"), JSON.stringify({ schemaVersion: 1, macos: { sha256 } }));
    await writeFile(join(resourcesPath, "update-signing", "macos.cer"), Buffer.alloc(65 * 1024));
    await expect(trust.ensureTrusted(true)).rejects.toThrow("could not be verified");
    expect(executeHelper).not.toHaveBeenCalled();
  });
});
