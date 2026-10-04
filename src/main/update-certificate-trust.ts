import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

const HELPER_FAILURE = "The bundled update signing certificate could not be verified.";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface UpdateCertificateTrust {
  ensureTrusted(manual: boolean): Promise<void>;
}

export class UpdateCertificateTrustRequiredError extends Error {
  readonly kind: "required" | "cancelled";

  constructor(kind: "required" | "cancelled" = "required") {
    super(kind === "cancelled"
      ? "Update certificate trust was cancelled. Use Check for Updates to try again."
      : "Update certificate trust is required. Use Check for Updates to review the developer certificate.");
    this.name = "UpdateCertificateTrustRequiredError";
    this.kind = kind;
  }
}

interface HelperOptions {
  readonly timeout: number;
  readonly maxBuffer: number;
}

type ExecuteHelper = (file: string, args: readonly string[], options: HelperOptions) => Promise<string>;

export interface CreateUpdateCertificateTrustOptions {
  readonly platform: NodeJS.Platform;
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly executeHelper?: ExecuteHelper;
}

function executeHelper(file: string, args: readonly string[], options: HelperOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error(HELPER_FAILURE));
      else resolve(stdout);
    });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedBundledFile(resourcesPath: string, relativePath: string, limit: number): Promise<Buffer> {
  const file = join(resourcesPath, relativePath);
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.size > limit) throw new Error(HELPER_FAILURE);
  const [root, actual] = await Promise.all([realpath(resourcesPath), realpath(file)]);
  if (!actual.startsWith(`${root}${sep}`)) throw new Error(HELPER_FAILURE);
  return readFile(file);
}

export function createUpdateCertificateTrust(options: CreateUpdateCertificateTrustOptions): UpdateCertificateTrust {
  if (!options.isPackaged || options.platform !== "darwin") {
    return { ensureTrusted: async () => undefined };
  }
  const run = options.executeHelper ?? executeHelper;
  return {
    async ensureTrusted(manual: boolean): Promise<void> {
      try {
        if (!isAbsolute(options.resourcesPath)) throw new Error(HELPER_FAILURE);
        const manifest: unknown = JSON.parse((await boundedBundledFile(
          options.resourcesPath, "update-signing/manifest.json", 16 * 1024,
        )).toString("utf8"));
        if (!record(manifest) || manifest["schemaVersion"] !== 1 || !record(manifest["macos"])) {
          throw new Error(HELPER_FAILURE);
        }
        const fingerprint = manifest["macos"]["sha256"];
        if (typeof fingerprint !== "string" || !SHA256_PATTERN.test(fingerprint)) throw new Error(HELPER_FAILURE);
        const certificate = await boundedBundledFile(options.resourcesPath, "update-signing/macos.cer", 64 * 1024);
        if (createHash("sha256").update(certificate).digest("hex") !== fingerprint) throw new Error(HELPER_FAILURE);
        const helper = join(options.resourcesPath, "updater-trust", "updater-trust");
        const helperMetadata = await lstat(helper);
        const [root, actualHelper] = await Promise.all([realpath(options.resourcesPath), realpath(helper)]);
        if (!helperMetadata.isFile() || !actualHelper.startsWith(`${root}${sep}`)) throw new Error(HELPER_FAILURE);

        const invoke = async (mode: "check" | "request"): Promise<"trusted" | "required" | "cancelled"> => {
          const response: unknown = JSON.parse(await run(helper, [mode, fingerprint], {
            timeout: mode === "request" ? 180_000 : 15_000,
            maxBuffer: 16 * 1024,
          }));
          if (!record(response) || response["schemaVersion"] !== 1 || response["sha256"] !== fingerprint) {
            throw new Error(HELPER_FAILURE);
          }
          const status = response["status"];
          if (status !== "trusted" && status !== "required" && status !== "cancelled") throw new Error(HELPER_FAILURE);
          return status;
        };

        const status = await invoke("check");
        if (status === "trusted") return;
        if (status !== "required") throw new Error(HELPER_FAILURE);
        if (!manual) throw new UpdateCertificateTrustRequiredError();
        const requested = await invoke("request");
        if (requested !== "trusted") throw new UpdateCertificateTrustRequiredError(requested === "cancelled" ? "cancelled" : "required");
        // Never accept a dialog's return value as evidence of persisted trust.
        if (await invoke("check") !== "trusted") throw new UpdateCertificateTrustRequiredError();
      } catch (error) {
        if (error instanceof UpdateCertificateTrustRequiredError) throw error;
        throw new Error(HELPER_FAILURE);
      }
    },
  };
}
