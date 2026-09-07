import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type {
  SliverReleaseDownloadEvent,
  SliverReleaseTarget,
} from "../shared/release-contracts.js";
import {
  SLIVER_RELEASE_MINISIGN_PUBLIC_KEY,
  verifySliverReleaseMinisign,
} from "./sliver-release-signature.js";

const LATEST_RELEASE_URL = "https://api.github.com/repos/BishopFox/sliver/releases/latest";
const RELEASE_DOWNLOAD_PATH_PREFIX = "/BishopFox/sliver/releases/download/";
const MAX_RELEASE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RELEASE_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_RELEASE_SIGNATURE_BYTES = 16 * 1024;
const RELEASE_REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 100;
const ASSET_NAME_PATTERN = /^sliver-(server|client)_([a-z0-9]+)-([a-z0-9]+)(\.exe)?$/u;
const VERSION_PATTERN = /^v?[0-9][0-9A-Za-z.+-]{0,63}$/u;

export interface SliverReleaseAsset extends SliverReleaseTarget {
  readonly fileName: string;
  readonly size: number;
  readonly downloadUrl: string;
  readonly signature: SliverReleaseSignatureAsset | null;
}

export interface SliverReleaseSignatureAsset {
  readonly fileName: string;
  readonly size: number;
  readonly downloadUrl: string;
}

export interface SliverReleaseCatalog {
  readonly version: string;
  readonly assets: readonly SliverReleaseAsset[];
}

export interface StagedSliverRelease {
  readonly version: string;
  readonly fileName: string;
  readonly path: string;
  readonly size: number;
}

interface SliverReleaseDownloadOptions {
  readonly downloadsDirectory: string;
  readonly fetch: typeof fetch;
  readonly createDownloadId?: () => string;
  readonly now?: () => number;
  /** Test-only trust-root override. Production callers must omit this. */
  readonly trustedMinisignPublicKey?: string;
}

export class SliverReleaseDownloader {
  private readonly downloadsDirectory: string;
  private readonly fetch: typeof fetch;
  private readonly createDownloadId: () => string;
  private readonly now: () => number;
  private readonly trustedMinisignPublicKey: string;
  private readonly abortControllers = new Set<AbortController>();
  private catalogPromise: Promise<SliverReleaseCatalog> | undefined;

  constructor(options: SliverReleaseDownloadOptions) {
    this.downloadsDirectory = options.downloadsDirectory;
    this.fetch = options.fetch;
    this.createDownloadId = options.createDownloadId ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.trustedMinisignPublicKey =
      options.trustedMinisignPublicKey ?? SLIVER_RELEASE_MINISIGN_PUBLIC_KEY;
  }

  latestRelease(forceRefresh = false): Promise<SliverReleaseCatalog> {
    if (forceRefresh) this.catalogPromise = undefined;
    this.catalogPromise ??= this.fetchLatestRelease().catch((error: unknown) => {
      this.catalogPromise = undefined;
      throw error;
    });
    return this.catalogPromise;
  }

  async download(
    target: SliverReleaseTarget,
    onEvent: (event: SliverReleaseDownloadEvent) => void,
  ): Promise<void> {
    const downloadId = safeDownloadId(this.createDownloadId());
    const base = { downloadId, ...target };
    onEvent({ ...base, status: "started" });
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let temporaryPath: string | undefined;
    try {
      const catalog = await this.latestRelease(true);
      const asset = catalog.assets.find((candidate) => sameTarget(candidate, target));
      if (!asset) throw new ReleaseDownloadError("That OS and architecture are not available in the latest release");
      await mkdir(this.downloadsDirectory, { recursive: true });
      temporaryPath = join(this.downloadsDirectory, `.${asset.fileName}.${downloadId}.download`);
      const response = await this.fetch(asset.downloadUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "Sliver-GUI",
        },
      });
      if (!response.ok || !response.body) {
        throw new ReleaseDownloadError(`GitHub returned HTTP ${response.status} for the release download`);
      }
      validateDownloadResponse(response, asset);
      const file = await open(temporaryPath, "wx", 0o600);
      let receivedBytes = 0;
      let lastProgressAt = 0;
      try {
        const reader = response.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value.byteLength === 0) continue;
          receivedBytes += chunk.value.byteLength;
          if (receivedBytes > asset.size || receivedBytes > MAX_RELEASE_ASSET_BYTES) {
            await reader.cancel();
            throw new ReleaseDownloadError("The release download exceeded its advertised size");
          }
          await writeAll(file, chunk.value);
          const timestamp = this.now();
          if (timestamp - lastProgressAt >= PROGRESS_INTERVAL_MS || receivedBytes === asset.size) {
            lastProgressAt = timestamp;
            onEvent(progressEvent(base, catalog.version, asset, receivedBytes));
          }
        }
        await file.sync();
      } finally {
        await file.close();
      }
      if (receivedBytes !== asset.size) {
        throw new ReleaseDownloadError("The release download ended before all bytes were received");
      }
      const destinationPath = await moveToAvailableDownloadPath(temporaryPath, this.downloadsDirectory, asset.fileName);
      temporaryPath = undefined;
      try {
        await setPrivateExecutableMode(destinationPath);
      } catch (error) {
        await unlink(destinationPath).catch(() => undefined);
        throw error;
      }
      onEvent({
        ...progressEvent(base, catalog.version, asset, receivedBytes),
        status: "completed",
        fileName: basename(destinationPath),
      });
    } catch (error) {
      onEvent({
        ...base,
        status: "failed",
        error: releaseDownloadErrorMessage(error),
      });
    } finally {
      clearTimeout(timeout);
      this.abortControllers.delete(controller);
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    }
  }

  /**
   * Stage one allowlisted release asset at a main-process-selected private path.
   * Cloud provisioning uses this instead of exposing a Downloads path or release
   * bytes to a renderer. The caller owns deleting the returned file.
   */
  async stagePrivate(
    target: SliverReleaseTarget,
    destinationPath: string,
    onProgress: (receivedBytes: number, totalBytes: number) => void = () => undefined,
  ): Promise<StagedSliverRelease> {
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let temporaryPath: string | undefined;
    try {
      const catalog = await this.latestRelease(true);
      const asset = catalog.assets.find((candidate) => sameTarget(candidate, target));
      if (!asset) throw new ReleaseDownloadError("That OS and architecture are not available in the latest release");
      if (!asset.signature) {
        throw new ReleaseDownloadError("The official Sliver release is missing its Minisign signature");
      }
      const signature = await this.fetchReleaseSignature(asset.signature, controller.signal);
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
      temporaryPath = join(
        dirname(destinationPath),
        `.${basename(destinationPath)}.${safeDownloadId(this.createDownloadId())}.unverified`,
      );
      const response = await this.fetch(asset.downloadUrl, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "application/octet-stream",
          "User-Agent": "Sliver-GUI",
        },
      });
      if (!response.ok || !response.body) {
        throw new ReleaseDownloadError(`GitHub returned HTTP ${response.status} for the release download`);
      }
      validateDownloadResponse(response, asset);
      const file = await open(temporaryPath, "wx", 0o600);
      let receivedBytes = 0;
      try {
        const reader = response.body.getReader();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (chunk.value.byteLength === 0) continue;
          receivedBytes += chunk.value.byteLength;
          if (receivedBytes > asset.size || receivedBytes > MAX_RELEASE_ASSET_BYTES) {
            await reader.cancel();
            throw new ReleaseDownloadError("The release download exceeded its advertised size");
          }
          await writeAll(file, chunk.value);
          onProgress(receivedBytes, asset.size);
        }
        if (receivedBytes !== asset.size) {
          throw new ReleaseDownloadError("The release download ended before all bytes were received");
        }
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await verifySliverReleaseMinisign(
          temporaryPath,
          signature,
          asset.fileName,
          this.trustedMinisignPublicKey,
        );
      } catch {
        throw new ReleaseDownloadError("The Sliver release failed Minisign verification");
      }
      if (process.platform !== "win32") await setPrivateExecutableMode(temporaryPath);
      await commitPrivateStage(temporaryPath, destinationPath);
      temporaryPath = undefined;
      return {
        version: catalog.version,
        fileName: asset.fileName,
        path: destinationPath,
        size: asset.size,
      };
    } catch (error) {
      if (error instanceof ReleaseDownloadError) throw error;
      if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new ReleaseDownloadError("The release download timed out or was cancelled");
      }
      throw new ReleaseDownloadError("The Sliver release download failed");
    } finally {
      clearTimeout(timeout);
      this.abortControllers.delete(controller);
      if (temporaryPath) await unlink(temporaryPath).catch(() => undefined);
    }
  }

  stop(): void {
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
  }

  private async fetchLatestRelease(): Promise<SliverReleaseCatalog> {
    const response = await this.fetch(LATEST_RELEASE_URL, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(RELEASE_REQUEST_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Sliver-GUI",
      },
    });
    if (!response.ok || !response.body) {
      throw new ReleaseDownloadError(`GitHub returned HTTP ${response.status} for the latest release`);
    }
    const text = await readBoundedResponseText(response, MAX_RELEASE_RESPONSE_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ReleaseDownloadError("GitHub returned an invalid latest-release response");
    }
    return parseLatestRelease(value);
  }

  private async fetchReleaseSignature(
    asset: SliverReleaseSignatureAsset,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const response = await this.fetch(asset.downloadUrl, {
      method: "GET",
      redirect: "follow",
      signal,
      headers: {
        Accept: "text/plain, application/octet-stream",
        "User-Agent": "Sliver-GUI",
      },
    });
    if (!response.ok || !response.body) {
      throw new ReleaseDownloadError(`GitHub returned HTTP ${response.status} for the release signature`);
    }
    validateDownloadResponse(response, asset, "release signature");
    return readExactResponseBytes(response, asset.size, MAX_RELEASE_SIGNATURE_BYTES, "release signature");
  }
}

export function parseLatestRelease(value: unknown): SliverReleaseCatalog {
  const release = requireRecord(value, "latest release");
  const version = requireString(release["tag_name"], "release version", 64);
  if (!VERSION_PATTERN.test(version)) throw new ReleaseDownloadError("GitHub returned an invalid release version");
  if (!Array.isArray(release["assets"])) throw new ReleaseDownloadError("GitHub returned no release assets");
  const releaseAssets = release["assets"];
  const signatures = new Map<string, SliverReleaseSignatureAsset>();
  for (const candidate of releaseAssets) {
    const record = requireRecord(candidate, "release asset");
    const fileName = requireString(record["name"], "release asset name", 220);
    if (!fileName.endsWith(".minisig")) continue;
    const signedFileName = fileName.slice(0, -".minisig".length);
    if (!ASSET_NAME_PATTERN.test(signedFileName)) continue;
    if (signatures.has(signedFileName)) {
      throw new ReleaseDownloadError("GitHub returned duplicate release signatures");
    }
    signatures.set(
      signedFileName,
      parseReleaseSignatureAsset(record, fileName),
    );
  }

  const assets: SliverReleaseAsset[] = [];
  const targetKeys = new Set<string>();
  for (const candidate of releaseAssets) {
    const record = requireRecord(candidate, "release asset");
    const fileName = requireString(record["name"], "release asset name", 200);
    const match = ASSET_NAME_PATTERN.exec(fileName);
    if (!match) continue;
    const artifact = match[1] === "server" ? "server" : "client";
    const os = match[2];
    const arch = match[3];
    if (!artifact || !os || !arch) continue;
    const size = record["size"];
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_RELEASE_ASSET_BYTES) {
      throw new ReleaseDownloadError("GitHub returned an invalid release asset size");
    }
    const downloadUrl = requireString(record["browser_download_url"], "release asset URL", 2_048);
    if (!isTrustedSliverReleaseDownloadUrl(downloadUrl)) {
      throw new ReleaseDownloadError("GitHub returned an untrusted release asset URL");
    }
    const key = `${artifact}:${os}:${arch}`;
    if (targetKeys.has(key)) throw new ReleaseDownloadError("GitHub returned duplicate release targets");
    targetKeys.add(key);
    assets.push({
      artifact,
      os,
      arch,
      fileName,
      size,
      downloadUrl,
      signature: signatures.get(fileName) ?? null,
    });
  }
  if (assets.length === 0) throw new ReleaseDownloadError("The latest GitHub release has no downloadable Sliver binaries");
  return { version, assets: assets.sort(compareAssets) };
}

export function isTrustedSliverReleaseDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.startsWith(RELEASE_DOWNLOAD_PATH_PREFIX);
  } catch {
    return false;
  }
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ReleaseDownloadError("GitHub returned an empty latest-release response");
  const decoder = new TextDecoder();
  let result = "";
  let received = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new ReleaseDownloadError("GitHub returned an oversized latest-release response");
    }
    result += decoder.decode(chunk.value, { stream: true });
  }
  return result + decoder.decode();
}

async function readExactResponseBytes(
  response: Response,
  expectedBytes: number,
  maximumBytes: number,
  label: string,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new ReleaseDownloadError(`GitHub returned an empty ${label}`);
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (chunk.value.byteLength === 0) continue;
    receivedBytes += chunk.value.byteLength;
    if (receivedBytes > expectedBytes || receivedBytes > maximumBytes) {
      await reader.cancel();
      throw new ReleaseDownloadError(`The ${label} exceeded its advertised size`);
    }
    chunks.push(Buffer.from(chunk.value));
  }
  if (receivedBytes !== expectedBytes) {
    throw new ReleaseDownloadError(`The ${label} ended before all bytes were received`);
  }
  return Buffer.concat(chunks, receivedBytes);
}

function validateDownloadResponse(
  response: Response,
  asset: Pick<SliverReleaseAsset, "size">,
  label = "release download",
): void {
  const finalUrl = response.url;
  if (finalUrl) {
    const url = new URL(finalUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new ReleaseDownloadError(`GitHub redirected the ${label} to an unsafe URL`);
    }
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed !== asset.size) {
      throw new ReleaseDownloadError(`The ${label} size did not match GitHub metadata`);
    }
  }
}

function parseReleaseSignatureAsset(
  record: Record<string, unknown>,
  fileName: string,
): SliverReleaseSignatureAsset {
  const size = record["size"];
  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_RELEASE_SIGNATURE_BYTES
  ) {
    throw new ReleaseDownloadError("GitHub returned an invalid release signature size");
  }
  const downloadUrl = requireString(record["browser_download_url"], "release signature URL", 2_048);
  if (!isTrustedSliverReleaseDownloadUrl(downloadUrl)) {
    throw new ReleaseDownloadError("GitHub returned an untrusted release signature URL");
  }
  return { fileName, size, downloadUrl };
}

async function moveToAvailableDownloadPath(
  temporaryPath: string,
  directory: string,
  fileName: string,
): Promise<string> {
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidateName = suffix === 0 ? fileName : suffixedFileName(fileName, suffix);
    const candidatePath = join(directory, candidateName);
    try {
      await link(temporaryPath, candidatePath);
    } catch (error) {
      if (isAlreadyExistsError(error)) continue;
      throw error;
    }
    try {
      await unlink(temporaryPath);
      return candidatePath;
    } catch (error) {
      await unlink(candidatePath).catch(() => undefined);
      throw error;
    }
  }
  throw new ReleaseDownloadError("No available filename remained in Downloads");
}

async function commitPrivateStage(temporaryPath: string, destinationPath: string): Promise<void> {
  await link(temporaryPath, destinationPath);
  try {
    await unlink(temporaryPath);
  } catch (error) {
    await unlink(destinationPath).catch(() => undefined);
    throw error;
  }
}

async function setPrivateExecutableMode(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}

function suffixedFileName(fileName: string, suffix: number): string {
  return fileName.endsWith(".exe")
    ? `${fileName.slice(0, -4)} (${suffix}).exe`
    : `${fileName} (${suffix})`;
}

function sameTarget(asset: SliverReleaseAsset, target: SliverReleaseTarget): boolean {
  return asset.artifact === target.artifact && asset.os === target.os && asset.arch === target.arch;
}

function safeDownloadId(value: string): string {
  if (!/^[A-Za-z0-9-]{1,128}$/u.test(value)) {
    throw new ReleaseDownloadError("The release download identifier is invalid");
  }
  return value;
}

function progressEvent(
  base: { readonly downloadId: string } & SliverReleaseTarget,
  version: string,
  asset: SliverReleaseAsset,
  receivedBytes: number,
): Extract<SliverReleaseDownloadEvent, { status: "progress" }> {
  return {
    ...base,
    status: "progress",
    version,
    fileName: asset.fileName,
    receivedBytes,
    totalBytes: asset.size,
  };
}

function compareAssets(left: SliverReleaseAsset, right: SliverReleaseAsset): number {
  return left.artifact.localeCompare(right.artifact) ||
    left.os.localeCompare(right.os) ||
    left.arch.localeCompare(right.arch);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReleaseDownloadError(`GitHub returned an invalid ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
    throw new ReleaseDownloadError(`GitHub returned an invalid ${label}`);
  }
  return value;
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function releaseDownloadErrorMessage(error: unknown): string {
  if (error instanceof ReleaseDownloadError) return error.message;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "The release download timed out or was cancelled";
  }
  return "The Sliver release download failed";
}

async function writeAll(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await file.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten < 1) throw new ReleaseDownloadError("The release download could not be written to disk");
    offset += result.bytesWritten;
  }
}

class ReleaseDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseDownloadError";
  }
}
