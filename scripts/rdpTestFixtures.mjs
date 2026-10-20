import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const patchInventory = "Reviewed test fork patches\n";

export const fixtureManifest = {
  schemaVersion: 1, component: "sliver-rdp", protocolVersion: 1,
  source: { repository: "https://github.com/sliverarmory/IronRDP", commit: "a".repeat(40), tree: "b".repeat(40),
    patchInventory: "SLIVER_GUI_EMBEDDING.md", patchInventorySha256: createHash("sha256").update(patchInventory).digest("hex") },
  toolchain: { rust: "1.94.1" },
  build: { macosDeploymentTarget: "13.0", windowsCrt: "static", linuxGlibcBaseline: "2.35", ironrdpClientFeatures: ["rustls", "clipboard-custom"], targets: [
    "x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu",
  ] },
};

export function nativeBinary(target) {
  const bytes = Buffer.alloc(512);
  if (target.includes("linux")) {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    bytes.writeUInt16LE(62, 18);
  } else if (target.includes("windows")) {
    bytes.writeUInt16LE(0x5a4d, 0);
    bytes.writeUInt32LE(128, 60);
    bytes.writeUInt32LE(0x4550, 128);
    bytes.writeUInt16LE(0x8664, 132);
    bytes.writeUInt16LE(0x20b, 152);
  } else {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target.startsWith("aarch64") ? 0x0100000c : 0x01000007, 4);
  }
  return bytes;
}

export function universalBinary() {
  const bytes = Buffer.alloc(1536);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(2, 4);
  for (const [index, target] of ["x86_64-apple-darwin", "aarch64-apple-darwin"].entries()) {
    const thin = nativeBinary(target);
    const cursor = 8 + 20 * index;
    bytes.writeUInt32BE(thin.readUInt32LE(4), cursor);
    bytes.writeUInt32BE((index + 1) * 512, cursor + 8);
    bytes.writeUInt32BE(512, cursor + 12);
    thin.copy(bytes, (index + 1) * 512);
  }
  return bytes;
}

export async function rdpFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "sliver-rdp-build-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "native/rdp/src"), { recursive: true });
  await mkdir(join(root, "protocol"));
  await mkdir(join(root, "dependency"));
  await writeFile(join(root, "LICENSE"), "GPL source license\n");
  await writeFile(join(root, "native/rdp/Cargo.toml"), "[package]\nname='sliver-rdp'\n");
  await writeFile(join(root, "native/rdp/Cargo.lock"), "version = 4\n");
  await writeFile(join(root, "native/rdp/src/main.rs"), "fn main() {}\n");
  await writeFile(join(root, "protocol/ironrdp-provenance.json"), JSON.stringify(fixtureManifest));
  await writeFile(join(root, "dependency/LICENSE"), "MIT dependency notice\n");
  await writeFile(join(root, "dependency/SLIVER_GUI_EMBEDDING.md"), patchInventory);
  const metadata = {
    packages: [
      { id: "root", name: "sliver-rdp", version: "0.1.0", license: "GPL-3.0-or-later", manifest_path: join(root, "native/rdp/Cargo.toml"), source: null },
      { id: "rdp", name: "ironrdp-client", version: "0.1.0", license: "MIT OR Apache-2.0", manifest_path: join(root, "dependency/Cargo.toml"), source: `git+${fixtureManifest.source.repository}?rev=${fixtureManifest.source.commit}#${fixtureManifest.source.commit}` },
      { id: "dev", name: "test-only", version: "0.1.0", manifest_path: "/never/read/dev/Cargo.toml", source: null },
    ],
    resolve: { root: "root", nodes: [
      { id: "root", features: [], deps: [{ pkg: "rdp", dep_kinds: [{ kind: null }] }, { pkg: "dev", dep_kinds: [{ kind: "dev" }] }] },
      { id: "rdp", features: ["rustls", "clipboard-custom"], deps: [] },
      { id: "dev", features: [], deps: [] },
    ] },
  };
  const calls = [];
  async function run(command, args, options) {
    calls.push({ command, args, options });
    if (command === "rustc") return { stdout: "rustc 1.94.1 (test)", stderr: "" };
    if (command === "cargo" && args[0] === "--version") return { stdout: "cargo 1.94.1 (test)", stderr: "" };
    if (command === "cargo" && args[0] === "metadata") return { stdout: JSON.stringify(metadata), stderr: "" };
    if (command === "git") return { stdout: args.includes("rev-parse") ? `${fixtureManifest.source.commit}\n${fixtureManifest.source.tree}\n` : "?? .cargo-ok\n", stderr: "" };
    if (command === "cargo" && args[0] === "build") {
      const target = args[args.indexOf("--target") + 1];
      const directory = join(root, "native/rdp/target", target, "release");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, target.includes("windows") ? "sliver-rdp.exe" : "sliver-rdp"), nativeBinary(target));
    } else if (command === "/usr/bin/lipo") await writeFile(args.at(-1), universalBinary());
    else throw new Error(`Unexpected fixture command ${command}`);
    return { stdout: "", stderr: "" };
  }
  return { root, metadata, calls, run };
}
