import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, readlink, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const RDP_STAGED_SOURCE = "native/rdp/vendor/ironrdp";
export const RDP_SOURCE_PATCH = "native/rdp/patches/ironrdp-tcp-connect-address.patch";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function verifyRdpOverlayPatch(projectDirectory, manifest) {
  const overlay = manifest.source.localOverlay;
  if (!overlay || overlay.patch !== RDP_SOURCE_PATCH || !/^[a-f0-9]{64}$/u.test(overlay.sha256) || !/^[a-f0-9]{40}$/u.test(overlay.tree)) {
    throw new Error("Invalid IronRDP local source overlay");
  }
  const path = join(projectDirectory, overlay.patch);
  if (!(await lstat(path)).isFile() || digest(await readFile(path)) !== overlay.sha256) throw new Error("IronRDP overlay patch digest mismatch");
  return path;
}

/** Check both the immutable base and the exact reviewed, patched working tree. */
export async function verifyStagedRdpSource(directory, manifest, run, environment = process.env, platform = process.platform) {
  if (!(await lstat(directory)).isDirectory() || !(await lstat(join(directory, ".git"))).isDirectory()) throw new Error("Invalid staged IronRDP checkout");
  const git = async (...args) => (await run("git", ["-C", directory, ...args], { env: environment })).stdout.trim();
  const revision = (await git("rev-parse", "HEAD", "HEAD^{tree}")).split(/\r?\n/u);
  if (revision[0] !== manifest.source.commit || revision[1] !== manifest.source.tree ||
      await git("write-tree") !== manifest.source.localOverlay.tree) throw new Error("Staged IronRDP source does not match the pinned base and overlay tree");
  await git("diff", "--exit-code", "--no-ext-diff");
  if (await git("ls-files", "--others")) throw new Error("Staged IronRDP source contains untracked files");
  // Read bytes ourselves: Git's stat cache or assume-unchanged flags must not hide drift.
  const entries = (await git("ls-tree", "-r", "-z", "--full-tree", manifest.source.localOverlay.tree)).split("\0").filter(Boolean);
  for (let offset = 0; offset < entries.length; offset += 64) await Promise.all(entries.slice(offset, offset + 64).map(async (entry) => {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/u.exec(entry);
    if (!match) throw new Error("Unsupported staged IronRDP tree entry");
    const [, mode, expected, name] = match;
    const path = join(directory, name), metadata = await lstat(path);
    if (mode === "120000" ? !metadata.isSymbolicLink() : !metadata.isFile()) throw new Error(`Staged IronRDP source file type changed: ${JSON.stringify(name)}`);
    let bytes;
    if (mode === "120000") {
      const target = await readlink(path);
      // Git for Windows converts native symlink separators back to Git's '/'.
      // On POSIX a backslash is a literal filename byte and must stay distinct.
      bytes = Buffer.from(platform === "win32" ? target.replace(/\\/gu, "/") : target);
    } else bytes = await readFile(path);
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== expected) throw new Error(`Staged IronRDP source content changed: ${JSON.stringify(name)}`);
  }));
  if (digest(await readFile(join(directory, manifest.source.patchInventory))) !== manifest.source.patchInventorySha256) throw new Error("Staged IronRDP fork patch inventory mismatch");
  return directory;
}

async function cachedCheckout(manifest, environment) {
  const root = join(environment.CARGO_HOME ?? join(environment.HOME ?? homedir(), ".cargo"), "git/checkouts");
  for (const repository of await readdir(root).catch(() => [])) {
    if (!repository.startsWith("ironrdp-")) continue;
    for (const checkout of await readdir(join(root, repository)).catch(() => [])) {
      if (manifest.source.commit.startsWith(checkout) && checkout.length >= 7) return join(root, repository, checkout);
    }
  }
  return undefined;
}

/** Never edits Cargo's global checkout. Missing sources are fetched at the exact pinned commit. */
export async function prepareRdpSource({ projectDirectory, manifest, run, environment = process.env, sourceDirectory } = {}) {
  const patch = await verifyRdpOverlayPatch(projectDirectory, manifest);
  const destination = join(projectDirectory, RDP_STAGED_SOURCE);
  const existing = await lstat(destination).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (existing) return verifyStagedRdpSource(destination, manifest, run, environment);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  const options = { env: environment };
  try {
    const cached = sourceDirectory ?? await cachedCheckout(manifest, environment);
    if (cached) await run("git", ["clone", "--no-hardlinks", "--no-checkout", resolve(cached), temporary], options);
    else {
      await run("git", ["init", temporary], options);
      await run("git", ["-C", temporary, "fetch", "--depth=1", manifest.source.repository, manifest.source.commit], options);
    }
    // Patch bytes and the verified tree are identical on Windows and POSIX hosts.
    await run("git", ["-C", temporary, "config", "core.autocrlf", "false"], options);
    await run("git", ["-C", temporary, "checkout", "--detach", manifest.source.commit], options);
    await run("git", ["-C", temporary, "apply", "--index", "--whitespace=error", patch], options);
    await verifyStagedRdpSource(temporary, manifest, run, environment);
    await rename(temporary, destination);
    return destination;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
