// @vitest-environment node
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { unpackArmoryArchive, parseArmoryManifest, safeArmoryPath, ARMORY_ARCHIVE_LIMITS } from "./armory-archive.js";
import { ArmoryService, armoryVersionIsNewer, DEFAULT_ARMORY_PUBLIC_KEY, DEFAULT_ARMORY_REPO_URL } from "./armory-service.js";
import { verifyArmoryMinisign, verifyArmorySignatureMetadata } from "./armory-signature.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function temporary(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "sliver-armory-test-")); roots.push(root); return root; }
function signer() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("0123456789abcdef", "hex");
  const key = Buffer.concat([Buffer.from("Ed"), keyId, publicKey.export({ format: "der", type: "spki" }).subarray(-32)]).toString("base64");
  return { key, sign(bytes: Buffer, comment: string, prehash = true): Buffer {
    const signature = sign(null, prehash ? createHash("blake2b512").update(bytes).digest() : bytes, privateKey);
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    return Buffer.from(`untrusted comment: Armory test\n${Buffer.concat([Buffer.from(prehash ? "ED" : "Ed"), keyId, signature]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`);
  } };
}
interface TarEntry { path: string; bytes?: Buffer; type?: string }
function tar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const bytes = entry.bytes ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    header.write("0000600\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii"); header.write("0000000\0", 116, "ascii");
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header.write("00000000000\0", 136, "ascii"); header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156, "ascii"); header.write("ustar\0", 257, "ascii"); header.write("00", 263, "ascii");
    header.write(`${header.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
function manifest(name = "test-bof", version = "1.0.0", dependsOn = "") {
  return { name: `Friendly ${name}`, command_name: name, version, help: `Description of ${name}`, repo_url: `https://packages.example/${name}`,
    depends_on: dependsOn, bof_executor: "reflektor", files: [{ os: "windows", arch: "amd64", path: "/dist/test.o" }] };
}
function packageFixture(name = "test-bof", version = "1.0.0", dependency = "", signatureKind = true,
  metadata: { original_author?: unknown; extension_author?: unknown; files?: ReturnType<typeof manifest>["files"] } = {}, isAlias = false) {
  const signing = signer();
  const raw = { ...manifest(name, version, dependency), ...metadata };
  const manifestBytes = Buffer.from(JSON.stringify(raw));
  const archive = tar([{ path: "./", type: "5" }, { path: isAlias ? "./alias.json" : "./extension.json", bytes: manifestBytes },
    { path: "./dist/", type: "5" }, { path: "./dist/test.o", bytes: Buffer.from("inert test BOF") }, { path: "./LICENSE", bytes: Buffer.from("unused") }]);
  return { signing, raw, manifestBytes, archive, isAlias, signature: signing.sign(archive, manifestBytes.toString("base64"), signatureKind) };
}
async function setupCatalog(fixtures = [packageFixture()]) {
  const root = await temporary();
  const indexSigning = signer();
  const packageEntry = (fixture: ReturnType<typeof packageFixture>) => ({ name: fixture.raw.name,
    command_name: fixture.raw.command_name, repo_url: fixture.raw.repo_url, public_key: fixture.signing.key });
  const index = Buffer.from(JSON.stringify({ aliases: fixtures.filter((fixture) => fixture.isAlias).map(packageEntry),
    extensions: fixtures.filter((fixture) => !fixture.isAlias).map(packageEntry),
    bundles: [{ name: "Test Bundle", packages: fixtures.map((fixture) => fixture.raw.command_name) }] }));
  const config = [{ name: "Testing", repo_url: "https://armory.example/index", public_key: indexSigning.key, enabled: true, authorization: "", authorization_cmd: "" }];
  await writeFile(join(root, "armories.json"), JSON.stringify(config));
  const requests: { url: string; init?: RequestInit }[] = [];
  const responses = new Map<string, Buffer>();
  responses.set(config[0]!.repo_url, Buffer.from(JSON.stringify({ armory_index: index.toString("base64"), minisig: indexSigning.sign(index, "index").toString("base64") })));
  for (const fixture of fixtures) {
    responses.set(fixture.raw.repo_url, Buffer.from(JSON.stringify({ minisig: fixture.signature.toString("base64"), tar_gz_url: `${fixture.raw.repo_url}.tar.gz` })));
    responses.set(`${fixture.raw.repo_url}.tar.gz`, fixture.archive);
  }
  let requestHook: ((url: string) => Promise<void>) | undefined;
  const fetcher: typeof globalThis.fetch = async (url, init) => {
    await requestHook?.(String(url));
    requests.push({ url: String(url), ...(init ? { init } : {}) });
    const response = responses.get(String(url));
    return new Response(response ? Uint8Array.from(response) : null, { status: response ? 200 : 404 });
  };
  return { root, indexSigning, fixtures, config, requests, responses, setRequestHook(hook: (url: string) => Promise<void>) { requestHook = hook; }, service: new ArmoryService({ rootPath: root, fetch: fetcher }) };
}

describe("Armory Minisign signatures", () => {
  it.each([true, false])("verifies signed metadata and the %s payload algorithm", (prehash) => {
    const fixture = packageFixture("test-bof", "1.0.0", "", prehash);
    expect(verifyArmoryMinisign(fixture.archive, fixture.signature, fixture.signing.key)).toBe(fixture.manifestBytes.toString("base64"));
    expect(() => verifyArmoryMinisign(Buffer.from("tampered"), fixture.signature, fixture.signing.key)).toThrow(/signature is invalid/u);
  });
  it("rejects tampered trusted comments before catalog metadata is trusted", async () => {
    const fixture = packageFixture();
    const changed = Buffer.from(fixture.signature.toString().replace(fixture.manifestBytes.toString("base64"), Buffer.from("{}").toString("base64")));
    expect(() => verifyArmorySignatureMetadata(changed, fixture.signing.key)).toThrow(/manifest signature is invalid/u);
    expect(() => verifyArmoryMinisign(fixture.archive, fixture.signature, signer().key)).toThrow(/signature/u);
    const setup = await setupCatalog([fixture]);
    setup.responses.set(fixture.raw.repo_url, Buffer.from(JSON.stringify({ minisig: changed.toString("base64"), tar_gz_url: `${fixture.raw.repo_url}.tar.gz` })));
    const catalog = await setup.service.refreshCatalog();
    expect(catalog.packages[0]?.error).toMatch(/manifest signature is invalid/u);
    expect(catalog.packages[0]).not.toHaveProperty("targets");
  });
});

describe("Armory in-memory archive validation", () => {
  it("supports console-rooted manifest artifact paths and both extension schemas", async () => {
    const fixture = packageFixture(); const files = await unpackArmoryArchive(fixture.archive);
    const legacy = parseArmoryManifest(files.get("extension.json")!, false);
    expect(legacy.directoryName).toBe("test-bof"); expect(legacy.name).toBe("test-bof"); expect(legacy.artifactPaths).toEqual(["dist/test.o"]);
    expect(legacy.targets).toEqual([{ os: "windows", arch: "amd64" }]);
    const multi = { name: "Friendly package", package_name: "test-package", version: "2", commands: [fixture.raw, { ...fixture.raw, command_name: "second-command" }] };
    expect(parseArmoryManifest(Buffer.from(JSON.stringify(multi)), false).directoryName).toBe("test-package");
    expect(safeArmoryPath("/dist/test.o", true)).toBe("dist/test.o");
  });
  it.each(["../escape", "/absolute", "C:/drive", "./a/../../escape", "a\\b", "a:stream", "a/CON.txt", "a./b", "//server/share"])("rejects unsafe archive path %s", async (path) => {
    await expect(unpackArmoryArchive(tar([{ path, bytes: Buffer.from("unsafe") }]))).rejects.toThrow(/Unsafe/u);
  });
  it.each(["1", "2", "3", "4", "6", "L", "K", "S"])("rejects tar entry type %s", async (type) => {
    await expect(unpackArmoryArchive(tar([{ path: "payload", type }]))).rejects.toThrow(/only contain/u);
  });
  it("rejects duplicate normalized names and conflicting paths", async () => {
    for (const paths of [["a", "./a"], ["A", "a"], ["dir/file", "dir"], ["dir", "dir/file"]]) {
      await expect(unpackArmoryArchive(tar(paths.map((path) => ({ path, bytes: Buffer.from("data") }))))).rejects.toThrow(/duplicate|conflicting/u);
    }
  });
  it("rejects corrupt headers, truncated data, oversize members, and unsafe PAX path overrides", async () => {
    const fixture = packageFixture(); const { gunzipSync } = await import("node:zlib");
    const raw = gunzipSync(fixture.archive); raw[0] = 88;
    await expect(unpackArmoryArchive(gzipSync(raw))).rejects.toThrow(/checksum/u);
    await expect(unpackArmoryArchive(gzipSync(gunzipSync(fixture.archive).subarray(0, 700)))).rejects.toThrow(/truncated/u);
    const pax = Buffer.from("22 path=../escape.txt\n");
    await expect(unpackArmoryArchive(tar([{ path: "pax", type: "x", bytes: pax }, { path: "normal", bytes: Buffer.from("data") }]))).rejects.toThrow(/Unsafe/u);
    await expect(unpackArmoryArchive(Buffer.alloc(ARMORY_ARCHIVE_LIMITS.compressedBytes + 1))).rejects.toThrow(/download limit/u);
  });
});

describe("Armory local package service", () => {
  it("propagates verified authors and target metadata into catalog and installed snapshots", async () => {
    const setup = await setupCatalog([packageFixture("authored-bof", "1", "", true, {
      original_author: "Original Developer", extension_author: "Extension Maintainer",
    })]);
    const catalog = await setup.service.refreshCatalog();
    expect(catalog.packages[0]).toMatchObject({ originalAuthor: "Original Developer", extensionAuthor: "Extension Maintainer",
      targets: [{ os: "windows", arch: "amd64" }] });
    const installed = await setup.service.install({ packageId: catalog.packages[0]!.id });
    expect(installed.installed[0]).toMatchObject({ originalAuthor: "Original Developer", extensionAuthor: "Extension Maintainer",
      targets: [{ os: "windows", arch: "amd64" }] });
    expect(await readFile(join(setup.root, "extensions/authored-bof/extension.json"))).toEqual(setup.fixtures[0]!.manifestBytes);
  });
  it("propagates alias authors and deduplicates its declared target pairs", async () => {
    const targets = [{ os: "windows", arch: "amd64" }, { os: "windows", arch: "386" }, { os: "linux", arch: "arm64" }];
    const setup = await setupCatalog([packageFixture("authored-alias", "1", "", true, {
      original_author: "Alias Developer", extension_author: "Not An Alias Schema Field",
      files: [...targets, targets[0]!].map((target) => ({ ...target, path: "/dist/test.o" })),
    }, true)]);
    const catalog = await setup.service.refreshCatalog();
    expect(catalog.packages[0]).toMatchObject({ kind: "alias", originalAuthor: "Alias Developer" });
    expect(catalog.packages[0]).not.toHaveProperty("extensionAuthor");
    expect(catalog.packages[0]?.targets).toEqual(targets);
    const installed = await setup.service.install({ packageId: catalog.packages[0]!.id });
    expect(installed.installed[0]).toMatchObject({ kind: "alias", originalAuthor: "Alias Developer" });
    expect(installed.installed[0]).not.toHaveProperty("extensionAuthor");
    expect(installed.installed[0]?.targets).toEqual(targets);
  });
  it("reads package authors and combines command targets for console-installed extensions", async () => {
    const root = await temporary(); const path = join(root, "extensions/multi-package"); await mkdir(path, { recursive: true });
    await writeFile(join(path, "extension.json"), JSON.stringify({ name: "Multi Package", package_name: "multi-package", version: "2",
      original_author: "Package Developer", extension_author: "Package Maintainer",
      commands: [{ ...manifest("first-command"), original_author: "Ignored Command Author", extension_author: "Ignored Command Maintainer" }, {
        ...manifest("second-command"), files: [
          { os: "linux", arch: "arm64", path: "/dist/linux.o" },
          { os: "windows", arch: "amd64", path: "/dist/second.o" },
          { os: "custom-OS", arch: "custom-Arch", path: "/dist/custom.o" },
        ],
      }] }));
    const snapshot = await new ArmoryService({ rootPath: root }).snapshot();
    expect(snapshot.installed[0]).toMatchObject({ commandNames: ["first-command", "second-command"],
      originalAuthor: "Package Developer", extensionAuthor: "Package Maintainer" });
    expect(snapshot.installed[0]?.targets).toEqual([
      { os: "windows", arch: "amd64" }, { os: "linux", arch: "arm64" }, { os: "custom-OS", arch: "custom-Arch" },
    ]);
  });
  it.each([{}, { original_author: "", extension_author: "  " }, { original_author: null, extension_author: null }])(
    "keeps packages compatible when author metadata is absent or blank: %j", async (authors) => {
      const setup = await setupCatalog([packageFixture("unattributed", "1", "", true, authors)]);
      const catalog = await setup.service.refreshCatalog();
      expect(catalog.packages[0]?.error).toBeUndefined();
      expect(catalog.packages[0]).not.toHaveProperty("originalAuthor"); expect(catalog.packages[0]).not.toHaveProperty("extensionAuthor");
      const installed = await setup.service.install({ packageId: catalog.packages[0]!.id });
      expect(installed.installed[0]).not.toHaveProperty("originalAuthor"); expect(installed.installed[0]).not.toHaveProperty("extensionAuthor");
    });
  it.each([42, "A".repeat(4097), "Author\u0000Name"])("rejects invalid author metadata without trusting it: %s", async (author) => {
    const setup = await setupCatalog([packageFixture("invalid-author", "1", "", true, { original_author: author })]);
    const catalog = await setup.service.refreshCatalog();
    expect(catalog.packages[0]?.error).toMatch(/Invalid Armory (?:text|author) field/u);
    expect(catalog.packages[0]).not.toHaveProperty("originalAuthor");
    expect(catalog.packages[0]).not.toHaveProperty("targets");
    expect(await readdir(setup.root)).toEqual(["armories.json"]);
  });
  it("uses the console trust roots and SLIVER_CLIENT_ROOT_DIR", async () => {
    const script = await readFile(new URL("../../scripts/buildSliverConsole.mjs", import.meta.url), "utf8");
    expect(script).toContain(DEFAULT_ARMORY_PUBLIC_KEY); expect(script).toContain(DEFAULT_ARMORY_REPO_URL);
    const service = new ArmoryService({ rootPath: await temporary() });
    expect((await service.snapshot()).sources[0]?.name).toBe("Default");
  });
  it("installs verified declared files into console paths and detects console disk changes", async () => {
    const setup = await setupCatalog(); const snapshot = await setup.service.refreshCatalog();
    expect(snapshot.packages[0]?.kind).toBe("bof");
    const installed = await setup.service.install({ packageId: snapshot.packages[0]!.id });
    const path = join(setup.root, "extensions", "test-bof");
    expect(await readFile(join(path, "extension.json"))).toEqual(setup.fixtures[0]!.manifestBytes);
    expect(await readFile(join(path, "dist/test.o"), "utf8")).toBe("inert test BOF");
    expect(await readdir(path)).toEqual(["dist", "extension.json"]);
    if (process.platform !== "win32") {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(path, "extension.json"))).mode & 0o777).toBe(0o600);
    }
    expect(installed.installed[0]?.id).toBe("extensions/test-bof");
    const changed = { ...setup.fixtures[0]!.raw, version: "0.9.0" };
    await writeFile(join(path, "extension.json"), JSON.stringify(changed));
    expect((await setup.service.snapshot()).installed[0]?.version).toBe("0.9.0");
    expect((await setup.service.snapshot()).installed[0]?.updateAvailable).toBe(true);
    await setup.service.uninstall({ installedId: "extensions/test-bof" });
    expect((await setup.service.snapshot()).installed).toEqual([]);
    expect((await readdir(setup.root)).some((name) => name.startsWith(".armory-"))).toBe(false);
  });
  it("verifies the complete download and manifest binding before any install writes", async () => {
    const setup = await setupCatalog(); const snapshot = await setup.service.refreshCatalog();
    setup.responses.set(`${setup.fixtures[0]!.raw.repo_url}.tar.gz`, Buffer.from("bad archive"));
    await expect(setup.service.install({ packageId: snapshot.packages[0]!.id })).rejects.toThrow(/signature is invalid/u);
    expect(await readdir(setup.root)).toEqual(["armories.json"]);
    const fixture = setup.fixtures[0]!;
    const mismatched = tar([{ path: "extension.json", bytes: Buffer.from(JSON.stringify({ ...fixture.raw, version: "99" })) }, { path: "dist/test.o", bytes: Buffer.from("valid") }]);
    setup.responses.set(`${fixture.raw.repo_url}.tar.gz`, mismatched);
    setup.responses.set(fixture.raw.repo_url, Buffer.from(JSON.stringify({ minisig: fixture.signing.sign(mismatched, fixture.manifestBytes.toString("base64")).toString("base64"), tar_gz_url: `${fixture.raw.repo_url}.tar.gz` })));
    await expect(setup.service.install({ packageId: snapshot.packages[0]!.id })).rejects.toThrow(/differs from the signed/u);
    expect(await readdir(setup.root)).toEqual(["armories.json"]);
  });
  it("installs aliases using the exact console manifest and alias command directory", async () => {
    const root = await temporary(); const signing = signer();
    const raw = { name: "Friendly Alias", command_name: "local-alias", version: "1", help: "An alias", files: [{ os: "windows", arch: "amd64", path: "/bin/tool.exe" }] };
    const bytes = Buffer.from(JSON.stringify(raw));
    const archive = tar([{ path: "alias.json", bytes }, { path: "bin/tool.exe", bytes: Buffer.from("inert alias test") }]);
    const archivePath = join(root, "alias.tar.gz"); const signaturePath = join(root, "alias.minisig");
    await writeFile(archivePath, archive); await writeFile(signaturePath, signing.sign(archive, bytes.toString("base64"), false));
    const service = new ArmoryService({ rootPath: join(root, "client") });
    const installed = await service.installLocal({ archivePath, signaturePath, publicKey: signing.key });
    expect(installed.installed[0]).toMatchObject({ id: "aliases/local-alias", name: "Friendly Alias", kind: "alias",
      targets: [{ os: "windows", arch: "amd64" }] });
    expect(await readFile(join(root, "client/aliases/local-alias/alias.json"))).toEqual(bytes);
    expect(await readFile(join(root, "client/aliases/local-alias/bin/tool.exe"), "utf8")).toBe("inert alias test");
  });
  it("rejects a signed package missing a declared artifact before disk writes", async () => {
    const setup = await setupCatalog(); const catalog = await setup.service.refreshCatalog(); const fixture = setup.fixtures[0]!;
    const archive = tar([{ path: "extension.json", bytes: fixture.manifestBytes }]);
    setup.responses.set(`${fixture.raw.repo_url}.tar.gz`, archive);
    setup.responses.set(fixture.raw.repo_url, Buffer.from(JSON.stringify({ minisig: fixture.signing.sign(archive, fixture.manifestBytes.toString("base64")).toString("base64"), tar_gz_url: `${fixture.raw.repo_url}.tar.gz` })));
    await expect(setup.service.install({ packageId: catalog.packages[0]!.id })).rejects.toThrow(/missing a required artifact/u);
    expect(await readdir(setup.root)).toEqual(["armories.json"]);
  });
  it("allows repairing packages when an unrelated console package has a missing dependency", async () => {
    const setup = await setupCatalog(); const path = join(setup.root, "extensions/unrelated"); await mkdir(path, { recursive: true });
    await writeFile(join(path, "extension.json"), JSON.stringify(manifest("unrelated", "1", "missing-loader")));
    const catalog = await setup.service.refreshCatalog();
    const installed = await setup.service.install({ packageId: catalog.packages[0]!.id });
    expect(installed.installed).toHaveLength(2);
  });
  it("preserves an existing installation when an update fails verification", async () => {
    const setup = await setupCatalog(); const catalog = await setup.service.refreshCatalog(); const id = catalog.packages[0]!.id;
    await setup.service.install({ packageId: id });
    setup.responses.set(`${setup.fixtures[0]!.raw.repo_url}.tar.gz`, Buffer.from("tampered update"));
    await expect(setup.service.install({ packageId: id, replace: true })).rejects.toThrow(/signature/u);
    expect(await readFile(join(setup.root, "extensions/test-bof/extension.json"))).toEqual(setup.fixtures[0]!.manifestBytes);
  });
  it("installs dependencies before packages, skips existing bundle members, and blocks removal of required packages", async () => {
    const setup = await setupCatalog([packageFixture("loader"), packageFixture("dependent", "1", "loader")]);
    const catalog = await setup.service.refreshCatalog();
    const installed = await setup.service.install({ packageId: catalog.packages.find((entry) => entry.commandName === "dependent")!.id });
    expect(installed.installed.map((entry) => entry.id)).toEqual(["extensions/dependent", "extensions/loader"]);
    await expect(setup.service.uninstall({ installedId: "extensions/loader" })).rejects.toThrow(/required by/u);
    expect((await setup.service.installBundle({ bundleId: catalog.bundles[0]!.id })).installed).toHaveLength(2);
  });
  it("refuses dependency cycles before writing packages", async () => {
    const setup = await setupCatalog([packageFixture("one", "1", "two"), packageFixture("two", "1", "one")]);
    const catalog = await setup.service.refreshCatalog();
    await expect(setup.service.install({ packageId: catalog.packages[0]!.id })).rejects.toThrow(/cycle/u);
    expect(await readdir(setup.root)).toEqual(["armories.json"]);
  });
  it("imports signed local archives and refuses symbolic-link install roots", async () => {
    const root = await temporary(); const fixture = packageFixture();
    const archivePath = join(root, "package.tar.gz"); const signaturePath = join(root, "package.minisig");
    await writeFile(archivePath, fixture.archive); await writeFile(signaturePath, fixture.signature);
    const installation = join(root, "client");
    const service = new ArmoryService({ rootPath: installation });
    expect((await service.installLocal({ archivePath, signaturePath, publicKey: fixture.signing.key })).installed[0]?.kind).toBe("bof");
    const outside = join(root, "outside"); await mkdir(outside);
    await rm(join(installation, "extensions"), { recursive: true });
    await symlink(outside, join(installation, "extensions"), process.platform === "win32" ? "junction" : "dir");
    await expect(service.installLocal({ archivePath, signaturePath, publicKey: fixture.signing.key })).rejects.toThrow(/symbolic links/u);
    expect(await readdir(outside)).toEqual([]);
  });
  it("shares source config without exposing credentials or executing authorization commands", async () => {
    const setup = await setupCatalog();
    await writeFile(join(setup.root, "armories.json"), JSON.stringify([{ ...setup.config[0], authorization: "Bearer secret", authorization_cmd: "/do-not-execute", custom: true }]));
    const snapshot = await setup.service.snapshot(); const source = snapshot.sources[0]!;
    expect(source.hasAuthorization).toBe(true); expect(source.hasAuthorizationCommand).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("Bearer secret"); expect(JSON.stringify(snapshot)).not.toContain("/do-not-execute");
    await setup.service.saveSource({ id: source.id, name: "Updated", repoUrl: source.repoUrl, publicKey: source.publicKey, enabled: true });
    const saved = JSON.parse(await readFile(join(setup.root, "armories.json"), "utf8")) as Record<string, unknown>[];
    expect(saved[0]).toMatchObject({ name: "Updated", authorization: "Bearer secret", authorization_cmd: "/do-not-execute", custom: true });
    const next = (await setup.service.snapshot()).sources[0]!;
    await setup.service.saveSource({ id: next.id, name: next.name, repoUrl: next.repoUrl, publicKey: next.publicKey, enabled: true, authorization: "" });
    expect(JSON.parse(await readFile(join(setup.root, "armories.json"), "utf8"))[0]).toMatchObject({ authorization: "", authorization_cmd: "" });
  });
  it("never sends source credentials to another origin or redirected download host", async () => {
    const setup = await setupCatalog();
    await writeFile(join(setup.root, "armories.json"), JSON.stringify([{ ...setup.config[0], authorization: "Bearer private" }]));
    await setup.service.refreshCatalog();
    const indexRequest = setup.requests.find((entry) => entry.url.includes("armory.example"));
    const packageRequest = setup.requests.find((entry) => entry.url.includes("packages.example"));
    expect(indexRequest?.init?.headers).toMatchObject({ Authorization: "Bearer private" });
    expect(packageRequest?.init?.headers).not.toHaveProperty("Authorization");
  });
  it("refuses malformed console configuration instead of overwriting it", async () => {
    const root = await temporary(); await writeFile(join(root, "armories.json"), "broken");
    const service = new ArmoryService({ rootPath: root });
    await expect(service.saveSource({ name: "test", repoUrl: "https://example.com", publicKey: signer().key, enabled: true })).rejects.toThrow();
    expect(await readFile(join(root, "armories.json"), "utf8")).toBe("broken");
  });
  it("refuses to install if the console changes source trust while a download is pending", async () => {
    const setup = await setupCatalog(); const catalog = await setup.service.refreshCatalog();
    setup.setRequestHook(async (url) => { if (url.endsWith(".tar.gz")) await writeFile(join(setup.root, "armories.json"), "[]"); });
    await expect(setup.service.install({ packageId: catalog.packages[0]!.id })).rejects.toThrow(/configuration changed during download/u);
    expect(await readdir(setup.root)).toEqual(["armories.json"]);
  });
  it("refuses commands installed by the console during a download", async () => {
    const setup = await setupCatalog(); const catalog = await setup.service.refreshCatalog();
    setup.setRequestHook(async (url) => {
      if (!url.endsWith(".tar.gz")) return;
      const path = join(setup.root, "extensions/console-package"); await mkdir(path, { recursive: true });
      await writeFile(join(path, "extension.json"), JSON.stringify({ name: "Console Package", package_name: "console-package", commands: [setup.fixtures[0]!.raw] }));
    });
    await expect(setup.service.install({ packageId: catalog.packages[0]!.id })).rejects.toThrow(/commands changed/u);
    expect(await readdir(join(setup.root, "extensions"))).toEqual(["console-package"]);
  });
  it("compares numeric versions and prereleases without offering downgrades", () => {
    expect(armoryVersionIsNewer("1.10", "1.9")).toBe(true);
    expect(armoryVersionIsNewer("1.9", "1.10")).toBe(false);
    expect(armoryVersionIsNewer("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true);
    expect(armoryVersionIsNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
    expect(armoryVersionIsNewer("v1.0.0", "1.0")).toBe(false);
  });
});
