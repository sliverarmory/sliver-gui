import { sliverpb } from "sliver-script";

import type { BeaconTaskDetail, OperationDisposition } from "../shared/operation-contracts.js";

type HistoricalTaskResult = Pick<BeaconTaskDetail, "disposition" | "error" | "errorKind">;
type MessageSpec = readonly [responseName: string, requestType: number];

const MAX_DECODE_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_CHECK_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1024;
const MAX_HEX_BYTES = 256;
const MAX_TEXT_CHARS = 16 * 1024;
const MAX_FIELDS = 96;
const MAX_ITEMS = 24;
const MAX_DEPTH = 5;

/** Request descriptions, response messages, and append-only message numbers from
 * the pinned Sliver services.proto and sliverpb/constants.go. The response
 * name is deliberately explicit: several requests do not share its name. */
const MESSAGE_SPECS: Readonly<Record<string, MessageSpec>> = Object.freeze({
  Ping: ["Ping", 3],
  TaskReq: ["Task", 2],
  LsReq: ["Ls", 5],
  DownloadReq: ["Download", 7],
  UploadReq: ["Upload", 9],
  CdReq: ["Pwd", 11],
  PwdReq: ["Pwd", 12],
  RmReq: ["Rm", 14],
  MkdirReq: ["Mkdir", 16],
  PsReq: ["Ps", 18],
  ShellReq: ["Shell", 20],
  ProcessDumpReq: ["ProcessDump", 24],
  ImpersonateReq: ["Impersonate", 26],
  RunAsReq: ["RunAs", 28],
  RevToSelfReq: ["RevToSelf", 31],
  InvokeGetSystemReq: ["GetSystem", 32],
  InvokeExecuteAssemblyReq: ["ExecuteAssembly", 34],
  ExecuteAssemblyReq: ["ExecuteAssembly", 35],
  InvokeMigrateReq: ["Migrate", 37],
  SideloadReq: ["Sideload", 38],
  SpawnDllReq: ["SpawnDll", 40],
  IfconfigReq: ["Ifconfig", 42],
  ExecuteReq: ["Execute", 44],
  TerminateReq: ["Terminate", 45],
  ScreenshotReq: ["Screenshot", 47],
  NetstatReq: ["Netstat", 49],
  PivotStartListenerReq: ["PivotListener", 50],
  PivotListenersReq: ["PivotListeners", 52],
  StartServiceReq: ["ServiceInfo", 60],
  StopServiceReq: ["ServiceInfo", 62],
  RemoveServiceReq: ["ServiceInfo", 63],
  MakeTokenReq: ["MakeToken", 64],
  EnvReq: ["EnvInfo", 66],
  SetEnvReq: ["SetEnv", 68],
  ExecuteWindowsReq: ["Execute", 70],
  RegistryReadReq: ["RegistryRead", 71],
  RegistryWriteReq: ["RegistryWrite", 72],
  RegistryCreateKeyReq: ["RegistryCreateKey", 73],
  WGPortForwardStartReq: ["WGPortForward", 74],
  WGPortForwardStopReq: ["WGPortForward", 75],
  WGSocksStartReq: ["WGSocks", 76],
  WGSocksStopReq: ["WGSocks", 77],
  WGTCPForwardersReq: ["WGTCPForwarders", 78],
  WGSocksServersReq: ["WGSocksServers", 79],
  PortfwdReq: ["Portfwd", 80],
  ReconfigureReq: ["Reconfigure", 83],
  UnsetEnvReq: ["UnsetEnv", 85],
  SSHCommandReq: ["SSHCommand", 86],
  GetPrivsReq: ["GetPrivs", 87],
  RegistrySubKeyListReq: ["RegistrySubKeyList", 88],
  RegistryListValuesReq: ["RegistryValuesList", 89],
  RegisterExtensionReq: ["RegisterExtension", 90],
  CallExtensionReq: ["CallExtension", 91],
  ListExtensionsReq: ["ListExtensions", 92],
  OpenSession: ["OpenSession", 95],
  RegistryDeleteKeyReq: ["RegistryDeleteKey", 97],
  MvReq: ["Mv", 98],
  CurrentTokenOwnerReq: ["CurrentTokenOwner", 100],
  InvokeInProcExecuteAssemblyReq: ["ExecuteAssembly", 102],
  RportFwdStopListenerReq: ["RportFwdListener", 103],
  RportFwdStartListenerReq: ["RportFwdListener", 104],
  RportFwdListenersReq: ["RportFwdListeners", 107],
  RPortfwdReq: ["RPortfwd", 108],
  ChmodReq: ["Chmod", 109],
  ChownReq: ["Chown", 111],
  ChtimesReq: ["Chtimes", 113],
  MemfilesListReq: ["Ls", 115],
  MemfilesAddReq: ["MemfilesAdd", 116],
  MemfilesRmReq: ["MemfilesRm", 118],
  RegisterWasmExtensionReq: ["RegisterWasmExtension", 120],
  ListWasmExtensionsReq: ["ListWasmExtensions", 123],
  ExecWasmExtensionReq: ["ExecWasmExtension", 125],
  CpReq: ["Cp", 127],
  GrepReq: ["Grep", 129],
  ServicesReq: ["Services", 130],
  ServiceDetailReq: ["ServiceDetail", 131],
  StartServiceByNameReq: ["ServiceInfo", 132],
  RegistryReadHiveReq: ["RegistryReadHive", 133],
  MountReq: ["Mount", 134],
  ExecuteChildrenReq: ["ExecuteChildren", 136],
});

interface MessageCodec {
  decode(input: Uint8Array): unknown;
  encode(message: unknown): { finish(): Uint8Array };
}

/** Decodes saved server response content into a bounded renderer-safe preview.
 * The caller owns and zeroizes request and response on every path. */
export function decodeHistoricalBeaconTask(
  description: string,
  request: Uint8Array,
  response: Uint8Array,
): HistoricalTaskResult {
  if (response.length === 0) {
    return inline("The server stored no response payload for this completed task.");
  }

  const spec = MESSAGE_SPECS[description];
  if (!spec) return opaqueResponse(response, "The saved task type has no response decoder in this client.");

  try {
    checkRequestEnvelope(request, spec[1]);
    if (response.length > MAX_DECODE_BYTES) {
      return opaqueResponse(response, "The saved response is too large to decode in the task view.");
    }
    const codec = responseCodec(spec[0]);
    const decoded = codec.decode(response);
    try {
      const canonical = codec.encode(decoded).finish();
      try {
        if (!sameBytes(response, canonical)) throw new Error("Noncanonical response");
      } finally {
        canonical.fill(0);
      }
      const message = asRecord(decoded);
      const envelope = message["Response"];
      if (envelope !== undefined) {
        const completed = asRecord(envelope);
        if (completed["Async"] === true || nonempty(completed["BeaconID"]) || nonempty(completed["TaskID"])) {
          throw new Error("Task response is an asynchronous acknowledgement");
        }
      }
      const result = description === "CallExtensionReq"
        ? extensionResponse(message)
        : structuredResponse(description, message);
      if (envelope !== undefined && nonempty(asRecord(envelope)["Err"])) {
        return {
          ...result,
          errorKind: "target-reported",
          error: "The beacon task response reported an error",
        };
      }
      return result;
    } finally {
      zeroizeDecoded(decoded);
    }
  } catch {
    return {
      errorKind: "decode-uncertain",
      error: "The saved beacon task response could not be decoded safely",
    };
  }
}

function checkRequestEnvelope(request: Uint8Array, expectedType: number): void {
  // A few historic server paths omitted the request. The fetched task ID and
  // description still bind the response; validate the envelope when present.
  if (request.length === 0 || request.length > MAX_REQUEST_CHECK_BYTES) return;
  const envelope = sliverpb.Envelope.decode(request);
  try {
    if (envelope.Type !== expectedType || envelope.UnknownMessageType) {
      throw new Error("Task request type mismatch");
    }
    const canonical = sliverpb.Envelope.encode(envelope).finish();
    try {
      if (!sameBytes(request, canonical)) throw new Error("Noncanonical task request");
    } finally {
      canonical.fill(0);
    }
  } finally {
    envelope.Data.fill(0);
  }
}

function responseCodec(name: string): MessageCodec {
  const candidate: unknown = (sliverpb as unknown as Record<string, unknown>)[name];
  if (!candidate || typeof candidate !== "object" ||
    !("decode" in candidate) || typeof candidate.decode !== "function" ||
    !("encode" in candidate) || typeof candidate.encode !== "function") {
    throw new Error("Missing pinned response decoder");
  }
  return candidate as MessageCodec;
}

function extensionResponse(message: Record<string, unknown>): HistoricalTaskResult {
  const records = message["BOFOutputs"];
  const legacy = message["Output"];
  const lines = ["Extension output:"];
  const collector = new TextCollector();
  if (Array.isArray(records) && records.length > 0) {
    for (const record of records.slice(0, MAX_ITEMS)) {
      const output = asRecord(record);
      const channel = output["Type"];
      const data = output["Data"];
      if (!isByteArray(data) || typeof channel !== "number") throw new Error("Invalid extension output record");
      const preview = previewBytes(data);
      collector.add(`${channel === 0x0d ? "stderr" : channel === 0 ? "stdout" : `channel ${channel}`}: ${preview.text}`);
      collector.truncated ||= preview.truncated;
    }
    if (records.length > MAX_ITEMS) collector.truncated = true;
  } else if (isByteArray(legacy) && legacy.length > 0) {
    const preview = previewBytes(legacy);
    collector.add(`output: ${preview.text}`);
    collector.truncated ||= preview.truncated;
  } else {
    collector.add("No extension output bytes were saved.");
  }
  lines.push(...collector.lines);
  return inline(lines.join("\n"), collector.truncated);
}

function structuredResponse(description: string, message: Record<string, unknown>): HistoricalTaskResult {
  const collector = new TextCollector();
  collectFields(message, "", 0, collector);
  if (collector.lines.length === 0) {
    collector.add("No result fields were present in the saved response.");
  }
  return inline(`${description} response:\n${collector.lines.join("\n")}`, collector.truncated);
}

class TextCollector {
  readonly lines: string[] = [];
  private characters = 0;
  truncated = false;

  add(line: string): void {
    if (this.lines.length >= MAX_FIELDS || this.characters >= MAX_TEXT_CHARS) {
      this.truncated = true;
      return;
    }
    const remaining = MAX_TEXT_CHARS - this.characters;
    const bounded = line.slice(0, remaining);
    if (bounded.length !== line.length) this.truncated = true;
    this.lines.push(bounded);
    this.characters += bounded.length;
  }
}

function collectFields(value: Record<string, unknown>, prefix: string, depth: number, collector: TextCollector): void {
  if (depth >= MAX_DEPTH) {
    collector.truncated = true;
    return;
  }
  for (const [key, field] of Object.entries(value)) {
    if (key === "Response" || key === "Request" || field === undefined || field === null || field === "") continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isByteArray(field)) {
      const preview = previewBytes(field);
      collector.add(`${path}: ${preview.text}`);
      collector.truncated ||= preview.truncated;
    } else if (Array.isArray(field)) {
      if (field.length === 0) continue;
      for (const [index, item] of field.slice(0, MAX_ITEMS).entries()) {
        if (item && typeof item === "object" && !isByteArray(item)) {
          collectFields(asRecord(item), `${path}[${index}]`, depth + 1, collector);
        } else if (isByteArray(item)) {
          const preview = previewBytes(item);
          collector.add(`${path}[${index}]: ${preview.text}`);
          collector.truncated ||= preview.truncated;
        } else {
          collector.add(`${path}[${index}]: ${escapeText(String(item))}`);
        }
      }
      if (field.length > MAX_ITEMS) collector.truncated = true;
    } else if (typeof field === "object") {
      collectFields(asRecord(field), path, depth + 1, collector);
    } else {
      collector.add(`${path}: ${escapeText(String(field))}`);
    }
  }
}

function opaqueResponse(response: Uint8Array, heading: string): HistoricalTaskResult {
  const preview = previewBytes(response);
  return inline(`${heading}\n${preview.text}`, preview.truncated);
}

function previewBytes(bytes: Uint8Array): { text: string; truncated: boolean } {
  if (bytes.length === 0) return { text: "0 bytes", truncated: false };
  const preview = bytes.subarray(0, Math.min(bytes.length, MAX_PREVIEW_BYTES));
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(preview);
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
      return {
        text: `${escapeText(text)}${bytes.length > preview.length ? ` … (${bytes.length} bytes total)` : ""}`,
        truncated: bytes.length > preview.length,
      };
    }
  } catch { /* Binary output receives a hex preview. */ }
  const hex = Buffer.from(bytes.subarray(0, Math.min(bytes.length, MAX_HEX_BYTES))).toString("hex");
  return {
    text: `hex ${hex}${bytes.length > MAX_HEX_BYTES ? ` … (${bytes.length} bytes total)` : ""}`,
    truncated: bytes.length > MAX_HEX_BYTES,
  };
}

function escapeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,
    (character) => `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function zeroizeDecoded(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (isByteArray(value)) {
    value.fill(0);
    return;
  }
  for (const child of Object.values(value)) zeroizeDecoded(child, seen);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || isByteArray(value)) {
    throw new Error("Invalid response message");
  }
  return value as Record<string, unknown>;
}

function nonempty(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isByteArray(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && (value as Uint8Array).BYTES_PER_ELEMENT === 1;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function inline(text: string, truncated = false): HistoricalTaskResult {
  const disposition: OperationDisposition = { kind: "inline-text", text, truncated };
  return { disposition };
}

// Shared by the full-response viewer so saved task types and their pinned
// request/response codecs cannot drift from the historical preview decoder.
export {
  MESSAGE_SPECS as BEACON_TASK_MESSAGE_SPECS,
  checkRequestEnvelope as verifyHistoricalBeaconTaskRequest,
  responseCodec as historicalBeaconTaskResponseCodec,
  zeroizeDecoded as zeroizeBeaconTaskDecodedResponse,
};
