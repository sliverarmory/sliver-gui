import { gunzipSync } from "node:zlib";

import type { BeaconTaskResponse } from "../shared/operation-contracts.js";
import { isSensitiveSessionEnvironmentName } from "../shared/session-contracts.js";
import {
  BEACON_TASK_MESSAGE_SPECS,
  historicalBeaconTaskResponseCodec,
  verifyHistoricalBeaconTaskRequest,
  zeroizeBeaconTaskDecodedResponse,
} from "./historical-beacon-task.js";
import {
  BEACON_TASK_CONTENT_MAX_BYTES,
  BEACON_TASK_CONTENT_REQUEST_MAX_BYTES,
} from "./sliver-client-adapter.js";

export const BEACON_TASK_RESPONSE_PAGE_CHARACTERS = 64 * 1024;
const MAX_EXPANDED_RESPONSE_BYTES = 15 * 1024 * 1024;
const MAX_RENDERED_CHARACTERS = 64 * 1024 * 1024;
const MAX_RENDERED_VALUES = 1_000_000;
const MAX_RENDERED_DEPTH = 64;
const RESOURCE_LIMIT_MESSAGE = "The complete task response exceeds the safe response viewer resource limit";

type DecodedResponse = Pick<BeaconTaskResponse, "format" | "text">;

/** Decode the complete saved response without applying any preview limits.
 * Requests remain in main, and callers own/zeroize their source buffers.
 * Resource limits fail explicitly; they never produce silently clipped text. */
export function decodeBeaconTaskResponse(
  description: string,
  request: Uint8Array,
  response: Uint8Array,
  expectedPingNonce?: number,
): DecodedResponse {
  if (request.length > BEACON_TASK_CONTENT_REQUEST_MAX_BYTES ||
    request.length + response.length > BEACON_TASK_CONTENT_MAX_BYTES) {
    throw new Error(RESOURCE_LIMIT_MESSAGE);
  }
  const spec = Object.hasOwn(BEACON_TASK_MESSAGE_SPECS, description)
    ? BEACON_TASK_MESSAGE_SPECS[description] : undefined;
  if (!spec) return completeBytes(response);
  verifyHistoricalBeaconTaskRequest(request, spec[1]);
  if (response.length === 0) {
    return { format: "text", text: "The server stored no response payload for this completed task." };
  }

  const codec = historicalBeaconTaskResponseCodec(spec[0]);
  const decoded = codec.decode(response);
  let inflated: Buffer | undefined;
  try {
    const canonical = codec.encode(decoded).finish();
    try {
      if (canonical.length !== response.length || canonical.some((byte, index) => byte !== response[index])) {
        throw new Error("The saved task response did not match its response type");
      }
    } finally {
      canonical.fill(0);
    }
    const message = record(decoded);
    const envelope = message["Response"];
    if (envelope !== undefined) {
      const completed = record(envelope);
      if (completed["Async"] === true || nonempty(completed["BeaconID"]) || nonempty(completed["TaskID"])) {
        throw new Error("The saved task response is an asynchronous acknowledgement");
      }
    }
    if (description === "Ping" && expectedPingNonce !== undefined && message["Nonce"] !== expectedPingNonce) {
      throw new Error("The ping response did not match the submitted request");
    }
    if (description === "DownloadReq" && isBytes(message["Data"]) && message["Data"].length > 0) {
      const encoder = message["Encoder"];
      if (encoder === "gzip") {
        try {
          inflated = gunzipSync(message["Data"], { maxOutputLength: MAX_EXPANDED_RESPONSE_BYTES });
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
            throw new Error(RESOURCE_LIMIT_MESSAGE);
          }
          throw new Error("The complete file response could not be decompressed");
        }
      } else if (encoder !== "") {
        throw new Error("The saved file response uses an unsupported content encoding");
      }
    }
    const rendered = new FullResponseProjector(description, inflated).project(message);
    const text = JSON.stringify(rendered, null, 2);
    if (text.length > MAX_RENDERED_CHARACTERS) throw new Error(RESOURCE_LIMIT_MESSAGE);
    return { format: "json", text };
  } finally {
    inflated?.fill(0);
    zeroizeBeaconTaskDecodedResponse(decoded);
  }
}

export function pageBeaconTaskResponse(
  beaconId: string,
  taskId: string,
  response: DecodedResponse,
  offset: number,
): BeaconTaskResponse {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > response.text.length) {
    throw new Error("The task response page offset is invalid");
  }
  let end = Math.min(offset + BEACON_TASK_RESPONSE_PAGE_CHARACTERS, response.text.length);
  // Keep UTF-16 surrogate pairs together so a renderer page never displays a
  // replacement character where a Unicode character crosses a page boundary.
  if (end < response.text.length && isHighSurrogate(response.text.charCodeAt(end - 1)) &&
    isLowSurrogate(response.text.charCodeAt(end))) end -= 1;
  if (offset > 0 && isHighSurrogate(response.text.charCodeAt(offset - 1)) &&
    isLowSurrogate(response.text.charCodeAt(offset))) {
    throw new Error("The task response page offset splits a Unicode character");
  }
  return {
    beaconId, taskId, format: response.format,
    text: response.text.slice(offset, end),
    offset,
    totalCharacters: response.text.length,
    ...(end < response.text.length ? { nextOffset: end } : {}),
  };
}

class FullResponseProjector {
  private values = 0;
  private characters = 0;

  constructor(private readonly description: string, private readonly fileData: Buffer | undefined) {}

  project(value: unknown, depth = 0, path: readonly string[] = []): unknown {
    this.values += 1;
    if (this.values > MAX_RENDERED_VALUES || depth > MAX_RENDERED_DEPTH) throw new Error(RESOURCE_LIMIT_MESSAGE);
    if (typeof value === "string") {
      this.account(value.length);
      return value;
    }
    if (isBytes(value)) {
      const bytes = this.description === "DownloadReq" && path.length === 1 && path[0] === "Data"
        ? this.fileData ?? value : value;
      const decoded = completeBytes(bytes);
      this.account(decoded.text.length);
      return { encoding: decoded.format === "text" ? "utf-8" : "hex", bytes: bytes.length, data: decoded.text };
    }
    if (Array.isArray(value)) return value.map((item) => this.project(item, depth + 1, path));
    if (!value || typeof value !== "object") return value;
    const source = record(value);
    const sensitiveEnvironment = this.description === "EnvReq" && path.length === 1 && path[0] === "Variables" &&
      typeof source["Key"] === "string" && isSensitiveSessionEnvironmentName(source["Key"]);
    return Object.fromEntries(Object.entries(source)
      .filter(([key]) => key !== "Request")
      .map(([key, child]) => {
        this.account(key.length);
        return [key, sensitiveEnvironment && key === "Value"
          ? "[redacted]" : this.project(child, depth + 1, [...path, key])];
      }));
  }

  private account(characters: number): void {
    this.characters += characters;
    if (this.characters > MAX_RENDERED_CHARACTERS) throw new Error(RESOURCE_LIMIT_MESSAGE);
  }
}

function completeBytes(bytes: Uint8Array): DecodedResponse {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return { format: "text", text };
  } catch { /* Preserve non-text response bytes in full as hex. */ }
  return { format: "hex", text: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex") };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isBytes(value)) {
    throw new Error("The saved task response is not a response message");
  }
  return value as Record<string, unknown>;
}

function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && (value as Uint8Array).BYTES_PER_ELEMENT === 1;
}

function nonempty(value: unknown): boolean { return typeof value === "string" && value.length > 0; }
function isHighSurrogate(value: number): boolean { return value >= 0xd800 && value <= 0xdbff; }
function isLowSurrogate(value: number): boolean { return value >= 0xdc00 && value <= 0xdfff; }
