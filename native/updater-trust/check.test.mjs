import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));

test("native helper checks an untrusted certificate and rejects replacements without requesting trust", { skip: process.platform !== "darwin" }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "native-updater-trust-test-"));
  try {
    const resources = join(temporary, "Resources");
    const signing = join(resources, "update-signing");
    await mkdir(signing, { recursive: true });
    await mkdir(join(resources, "updater-trust"));
    const helper = join(resources, "updater-trust", "updater-trust");
    await copyFile(join(directory, "build", "updater-trust"), helper);
    const pem = join(temporary, "certificate.pem");
    await execute("/usr/bin/openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", `/CN=Updater trust read-only test ${Date.now()}`,
      "-keyout", join(temporary, "private.key"), "-out", pem,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const certificatePath = join(signing, "macos.cer");
    await execute("/usr/bin/openssl", ["x509", "-in", pem, "-outform", "DER", "-out", certificatePath], { timeout: 10_000 });
    const sha256 = createHash("sha256").update(await readFile(certificatePath)).digest("hex");
    await writeFile(join(signing, "manifest.json"), JSON.stringify({ schemaVersion: 1, macos: { sha256 } }));
    const result = await execute(helper, ["check", sha256], { timeout: 15_000 });
    assert.deepEqual(JSON.parse(result.stdout), { schemaVersion: 1, status: "required", sha256 });
    await assert.rejects(execute(helper, ["request", "0".repeat(64)], { timeout: 15_000 }), (error) => {
      assert.equal(JSON.parse(error.stdout).status, "error");
      return true;
    });
    await writeFile(certificatePath, "not a certificate");
    await assert.rejects(execute(helper, ["check", sha256], { timeout: 15_000 }), (error) => {
      assert.equal(JSON.parse(error.stdout).status, "error");
      return true;
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
