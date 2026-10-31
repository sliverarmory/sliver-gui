import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep, win32 } from "node:path";
import { parseAdCollectionArtifactInput, parseAdDomain, RUSTHOUND_ARMORY_COLLECTOR_ID, type AdCollectionArtifact } from "../shared/ad-explorer-contracts.js";
import { safeArmoryName } from "./armory-archive.js";
import { readBoundedRegularFile, writePrivateFileExclusiveAtomic } from "./secure-file.js";

interface Receipt extends AdCollectionArtifact { relativePath: string; sha256: string }
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const RECEIPT_KEYS = ["collectionId", "domain", "collectorId", "targetId", "createdAt", "relativePath", "sha256"];
const INVALID_RECEIPT = "The saved collection recovery record is invalid; use the original ZIP to recover this collection";
const MISSING_COLLECTION = "This saved collection is no longer available; refresh Saved collections and choose another collection";
const UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

/** Only these fixed, main-owned messages may cross the recovery IPC boundary. */
class RecoveryError extends Error {}

function recoveryFailure(error: unknown, fallback: string): RecoveryError {
  if (error instanceof RecoveryError) return error;
  if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return new RecoveryError(MISSING_COLLECTION);
  return new RecoveryError(fallback);
}

function validMetadataText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength &&
    value.trim() === value && !UNSAFE_TEXT.test(value);
}

function validCollectorId(value: unknown): boolean {
  if (!validMetadataText(value, 256)) return false;
  if (value === RUSTHOUND_ARMORY_COLLECTOR_ID || /^sharphound:(?:verified|custom):(?:file|script)$/u.test(value)) return true;
  const prefix = "sharphound:armory:aliases/";
  if (!value.startsWith(prefix)) return false;
  try { return safeArmoryName(value.slice(prefix.length)) === value.slice(prefix.length); }
  catch { return false; }
}

/** Durable recovery handles. Renderer requests never contain local paths. */
export class AdCollectionStore {
  constructor(private readonly root: string) {}

  async remember(value: { path: string; domain: string; collectorId: string; targetId: string }): Promise<AdCollectionArtifact> {
    try {
      const path = await this.checkedPath(value.path);
      const receipt = this.validateReceipt({ collectionId: randomUUID(), domain: parseAdDomain(value.domain),
        collectorId: value.collectorId, targetId: value.targetId, createdAt: new Date().toISOString(),
        relativePath: relative(await realpath(this.root), path), sha256: await this.digest(path) });
      const data = Buffer.from(JSON.stringify(receipt));
      try { await writePrivateFileExclusiveAtomic(this.receiptPath(receipt.collectionId), data); }
      finally { data.fill(0); }
      return this.summary(receipt);
    } catch (error) {
      throw recoveryFailure(error, "The collection recovery record could not be saved; check managed collection storage permissions and available disk space");
    }
  }

  async list(): Promise<AdCollectionArtifact[]> {
    let names: string[];
    try { await this.checkedRecoveryDirectory(); names = await readdir(join(this.root, ".pending")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw recoveryFailure(error, "Saved collections could not be listed; check managed collection storage permissions");
    }
    if (names.length > 1000) throw new RecoveryError("Too many pending collections; review managed collection storage");
    const entries: AdCollectionArtifact[] = [];
    for (const name of names.filter((name) => name.endsWith(".json"))) {
      try { entries.push(this.summary(await this.receipt(name.slice(0, -5)))); }
      catch { /* A damaged receipt must not hide other recoverable collections. */ }
    }
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async resolve(collectionId: string): Promise<AdCollectionArtifact & { path: string }> {
    parseAdCollectionArtifactInput({ collectionId });
    try {
      const receipt = await this.receipt(collectionId);
      const path = await this.checkedPath(join(this.root, receipt.relativePath));
      if (await this.digest(path) !== receipt.sha256) throw new RecoveryError("The saved collection changed; choose the original ZIP before importing");
      return { ...this.summary(receipt), path };
    } catch (error) {
      throw recoveryFailure(error, "The saved collection could not be read; check managed collection storage permissions or use the original ZIP");
    }
  }

  async imported(collectionId: string): Promise<void> {
    const path = this.receiptPath(collectionId);
    try { await this.checkedRecoveryDirectory(); await unlink(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw recoveryFailure(error, "The imported collection recovery record could not be removed; check managed collection storage permissions");
    }
  }

  private receiptPath(collectionId: string): string {
    parseAdCollectionArtifactInput({ collectionId });
    return join(this.root, ".pending", `${collectionId}.json`);
  }
  private async receipt(collectionId: string): Promise<Receipt> {
    const path = this.receiptPath(collectionId);
    await this.checkedRecoveryDirectory();
    const { data } = await readBoundedRegularFile(path, { label: "Collection recovery record", maxBytes: 4096, requirePrivateMode: true });
    try {
      const value = this.validateReceipt(JSON.parse(data.toString("utf8")));
      if (value.collectionId !== collectionId) throw new RecoveryError(INVALID_RECEIPT);
      return value;
    } catch {
      // JSON syntax errors may quote record contents, which can contain paths.
      throw new RecoveryError(INVALID_RECEIPT);
    } finally { data.fill(0); }
  }
  private validateReceipt(input: unknown): Receipt {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).length !== RECEIPT_KEYS.length || Object.keys(input).some((key) => !RECEIPT_KEYS.includes(key))) {
      throw new RecoveryError(INVALID_RECEIPT);
    }
    const value = input as Record<string, unknown>;
    try {
      parseAdCollectionArtifactInput({ collectionId: value["collectionId"] });
      if (parseAdDomain(value["domain"]) !== value["domain"] ||
          !validCollectorId(value["collectorId"]) || !validMetadataText(value["targetId"], 128) ||
          !/^[a-z0-9][a-z0-9._:-]*$/iu.test(value["targetId"]) ||
          typeof value["createdAt"] !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value["createdAt"]) ||
          new Date(value["createdAt"]).toISOString() !== value["createdAt"] ||
          typeof value["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(value["sha256"]) ||
          !validMetadataText(value["relativePath"], 1024) || isAbsolute(value["relativePath"]) || win32.isAbsolute(value["relativePath"]) ||
          value["relativePath"].split(/[\\/]/u).some((part) => !part || part === "." || part === "..") ||
          !value["relativePath"].toLowerCase().endsWith(".zip")) throw new RecoveryError(INVALID_RECEIPT);
    } catch { throw new RecoveryError(INVALID_RECEIPT); }
    return input as Receipt;
  }
  private async checkedRecoveryDirectory(): Promise<void> {
    const directory = await lstat(join(this.root, ".pending"));
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new RecoveryError("The collection recovery directory is invalid; restore managed collection storage before retrying");
    }
  }
  private summary(receipt: Receipt): AdCollectionArtifact {
    return { collectionId: receipt.collectionId, domain: receipt.domain, collectorId: receipt.collectorId,
      targetId: receipt.targetId, createdAt: receipt.createdAt };
  }
  private async checkedPath(path: string): Promise<string> {
    const [root, canonical, stat] = await Promise.all([realpath(this.root), realpath(path), lstat(path)]);
    const child = relative(root, canonical);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child) || !stat.isFile() || stat.isSymbolicLink() ||
        !canonical.toLowerCase().endsWith(".zip")) throw new RecoveryError("Saved collection must be a regular ZIP in managed collection storage");
    return canonical;
  }
  private async digest(path: string): Promise<string> {
    const { data } = await readBoundedRegularFile(path, { label: "Saved collection", maxBytes: MAX_ARCHIVE_BYTES, requirePrivateMode: true });
    try { return createHash("sha256").update(data).digest("hex"); } finally { data.fill(0); }
  }
}
