import { isIP } from "node:net";

import type { CurrentEgressIpv4 } from "../../shared/cloud-deployment-ipc.js";

export const CURRENT_EGRESS_IPV4_URL = "https://ipv4.icanhazip.com/";
export const CURRENT_EGRESS_IPV4_TIMEOUT_MS = 8_000;
export const CURRENT_EGRESS_IPV4_MAX_RESPONSE_BYTES = 64;

export interface DetectCurrentEgressIpv4Options {
  readonly timeoutMs?: number;
}

export type CurrentEgressIpv4ErrorCode = "request-failed" | "invalid-response";

export class CurrentEgressIpv4Error extends Error {
  readonly code: CurrentEgressIpv4ErrorCode;

  constructor(code: CurrentEgressIpv4ErrorCode, message: string) {
    super(message);
    this.name = "CurrentEgressIpv4Error";
    this.code = code;
  }
}

/**
 * Resolves the machine's current public IPv4 address through one fixed endpoint.
 * The injected fetch keeps Electron's `net.fetch` in the main process and makes
 * the network boundary deterministic in tests.
 */
export async function detectCurrentEgressIpv4(
  fetchImpl: typeof fetch = globalThis.fetch,
  options: DetectCurrentEgressIpv4Options = {},
): Promise<CurrentEgressIpv4> {
  const timeoutMs = validTimeout(options.timeoutMs ?? CURRENT_EGRESS_IPV4_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(CURRENT_EGRESS_IPV4_URL, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        Accept: "text/plain",
      },
    });
    validateResponseMetadata(response);
    const address = (await readBoundedResponseBody(response)).trim();
    if (isIP(address) !== 4) throw invalidResponse();
    return Object.freeze({ address, cidr: `${address}/32` });
  } catch (error) {
    if (error instanceof CurrentEgressIpv4Error) throw error;
    throw new CurrentEgressIpv4Error(
      "request-failed",
      "Could not determine the current public IPv4 address.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function validTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("The public IPv4 lookup timeout must be a positive integer.");
  }
  return timeoutMs;
}

function validateResponseMetadata(response: Response): void {
  if (!response.ok || !response.body) throw invalidResponse();

  const contentType = response.headers.get("content-type");
  if (contentType && contentType.split(";", 1)[0]?.trim().toLowerCase() !== "text/plain") {
    throw invalidResponse();
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength === null) return;
  if (!/^\d+$/u.test(contentLength)) throw invalidResponse();
  const bytes = Number(contentLength);
  if (!Number.isSafeInteger(bytes) || bytes > CURRENT_EGRESS_IPV4_MAX_RESPONSE_BYTES) {
    throw invalidResponse();
  }
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw invalidResponse();

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength === 0) continue;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > CURRENT_EGRESS_IPV4_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw invalidResponse();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), receivedBytes).toString("utf8");
}

function invalidResponse(): CurrentEgressIpv4Error {
  return new CurrentEgressIpv4Error(
    "invalid-response",
    "The public IPv4 lookup returned an invalid response.",
  );
}
