import { createHash } from "node:crypto";

import { SESSION_EDITOR_MAX_BYTES } from "../shared/session-contracts.js";
import type { SliverClientAdapter } from "./sliver-client-adapter.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export class SessionFileEditConflictError extends Error {
  constructor(message = "The remote file changed after it was opened; reload it before saving") {
    super(message);
    this.name = "SessionFileEditConflictError";
  }
}

export class SessionFileEditPreflightError extends Error {
  constructor(message = "The remote file could not be verified before saving") {
    super(message);
    this.name = "SessionFileEditPreflightError";
  }
}

/**
 * Best-effort compare-before-write for the pinned unary Sliver file RPC.
 *
 * The upstream protocol has no atomic compare-and-swap. This preflight narrows
 * the race window, rejects files that outgrew the editor boundary, and always
 * clears returned remote bytes. Callers must still describe the final upload
 * as non-atomic in the confirmation plan.
 */
export async function verifySessionFileEditPrecondition(
  client: Pick<SliverClientAdapter, "downloadFileSession">,
  sessionId: string,
  remotePath: string,
  expectedSha256: string,
): Promise<void> {
  if (!SHA256_PATTERN.test(expectedSha256)) {
    throw new TypeError("Expected file digest must be lowercase SHA-256");
  }
  const maximumResponseBytes = SESSION_EDITOR_MAX_BYTES + 1;
  const response = await client.downloadFileSession(sessionId, remotePath, {
    maxBytes: maximumResponseBytes,
    fromEnd: false,
  });
  const data = response.Data;
  try {
    if (response.Response?.Err?.trim() || !response.Exists || response.IsDir) {
      throw new SessionFileEditPreflightError();
    }
    if (!Buffer.isBuffer(data) || data.length > SESSION_EDITOR_MAX_BYTES) {
      throw new SessionFileEditConflictError(
        "The remote file is now larger than the 64 KiB editor limit; reload it before saving",
      );
    }
    const actualSha256 = createHash("sha256").update(data).digest("hex");
    if (actualSha256 !== expectedSha256) throw new SessionFileEditConflictError();
  } finally {
    if (Buffer.isBuffer(data)) data.fill(0);
  }
}
