import type { BeaconTaskSummary } from "../../../shared/operation-contracts.js";
import { escapeTerminalOutput } from "../../../shared/terminal-output.js";
import { getBeaconTaskPresentation } from "./beacon-task-presentation.js";

export type BeaconFullResponseSection =
  | { kind: "text"; title: string; text: string }
  | { kind: "table"; title: string; columns: string[]; rows: string[][] }
  | { kind: "fields"; title: string; fields: { label: string; value: string }[] }
  | { kind: "bytes"; title: string; hex: string };

export interface BeaconFullResponseModel {
  title: string;
  sections: BeaconFullResponseSection[];
}

type RecordValue = Record<string, unknown>;
type Column = readonly [key: string, title: string, format?: (value: unknown) => string];

const FILE_COLUMNS: readonly Column[] = [
  ["Name", "Name"], ["IsDir", "Type", (value) => value ? "Directory" : "File"],
  ["Size", "Size", byteCount], ["ModTime", "Modified", modificationTime], ["Mode", "Mode"], ["Link", "Link"], ["Uid", "UID"], ["Gid", "GID"],
];
const SERVICE_COLUMNS: readonly Column[] = [
  ["Name", "Name"], ["DisplayName", "Display name"], ["Status", "Status", serviceStatus],
  ["StartupType", "Startup", serviceStartup], ["BinPath", "Binary path"], ["Account", "Account"], ["Description", "Description"],
];

/** Converts main-decoded response data into ordinary output, tables, and fields.
 * Transport JSON stays internal, and no preview row or text limits are applied. */
export function buildBeaconFullResponse(
  task: BeaconTaskSummary,
  response: { format: "text" | "json" | "hex"; text: string },
): BeaconFullResponseModel {
  const title = getBeaconTaskPresentation(task).label;
  const builder = new ResponseBuilder(title);
  if (response.format === "text") {
    builder.text(title, response.text);
    return builder.model;
  }
  if (response.format === "hex") {
    builder.bytes(title, response.text);
    return builder.model;
  }
  const decoded: unknown = JSON.parse(response.text);
  if (!isRecord(decoded)) {
    builder.value(title, decoded);
    return builder.model;
  }
  const source = { ...decoded };
  const take = (key: string): unknown => {
    const value = source[key];
    delete source[key];
    return value;
  };
  const responseEnvelope = take("Response");
  if (isRecord(responseEnvelope) && typeof responseEnvelope["Err"] === "string" && responseEnvelope["Err"]) {
    builder.text("Target error", responseEnvelope["Err"]);
  }

  switch (task.description) {
    case "LsReq":
    case "MemfilesListReq":
      builder.table(task.description === "LsReq" ? "Files" : "Memory files", list(take("Files")), FILE_COLUMNS);
      break;
    case "PsReq":
      builder.table("Processes", list(take("Processes")), [
        ["Pid", "PID"], ["Ppid", "PPID"], ["Executable", "Executable"], ["Owner", "Owner"],
        ["Architecture", "Architecture"], ["SessionID", "Session"], ["CmdLine", "Command line"],
      ]);
      break;
    case "IfconfigReq":
      builder.table("Interfaces", list(take("NetInterfaces")), [
        ["Index", "Index"], ["Name", "Name"], ["MAC", "MAC"], ["IPAddresses", "Addresses"],
      ]);
      break;
    case "EnvReq":
      builder.table("Environment variables", list(take("Variables")), [["Key", "Name"], ["Value", "Value"]]);
      break;
    case "NetstatReq":
      builder.table("Connections", list(take("Entries")), [
        ["Protocol", "Protocol"], ["LocalAddr.Ip", "Local IP"], ["LocalAddr.Port", "Local port"],
        ["RemoteAddr.Ip", "Remote IP"], ["RemoteAddr.Port", "Remote port"], ["SkState", "State"],
        ["UID", "UID"], ["Process.Pid", "PID"], ["Process.Executable", "Process"],
      ]);
      break;
    case "MountReq":
      builder.table("Mounts", list(take("Info")), [
        ["VolumeName", "Volume"], ["VolumeType", "Type"], ["MountPoint", "Mount point"], ["FileSystem", "Filesystem"],
        ["Label", "Label"], ["UsedSpace", "Used"], ["FreeSpace", "Free"], ["TotalSpace", "Total"], ["MountOptions", "Options"],
      ]);
      break;
    case "DownloadReq":
      builder.output("File contents", take("Data"));
      // These describe the transport representation, not the displayed file.
      take("Encoder");
      break;
    case "GrepReq": {
      const results = take("Results");
      const rows: RecordValue[] = [];
      const filesWithoutMatches: RecordValue[] = [];
      const fileDetails: [string, unknown][] = [];
      if (isRecord(results)) {
        for (const [path, file] of Object.entries(results)) {
          if (!isRecord(file)) { fileDetails.push([path, file]); continue; }
          const matches = list(file["FileResults"]);
          if (matches.length === 0) filesWithoutMatches.push({ Path: path, Binary: file["IsBinary"] ?? false });
          for (const match of matches) {
            rows.push({ Path: path, ...(isRecord(match) ? match : { Match: match }), Binary: file["IsBinary"] ?? false });
          }
          fileDetails.push([path, without(file, "FileResults", "IsBinary")]);
        }
      }
      builder.table("Matches", rows, [
        ["Path", "Path"], ["LineNumber", "Line"], ["Line", "Match"], ["LinesBefore", "Before"],
        ["LinesAfter", "After"], ["Binary", "Binary"],
      ]);
      if (filesWithoutMatches.length) {
        builder.table("Files without matches", filesWithoutMatches, [["Path", "Path"], ["Binary", "Binary"]]);
      }
      for (const [path, details] of fileDetails) builder.value(path, details);
      break;
    }
    case "RegistryReadReq":
      if (source["Value"] !== undefined) builder.output("Registry value", take("Value"));
      if (byteValue(source["Binary"]) && source["Binary"].data) builder.output("Binary value", take("Binary"));
      else take("Binary");
      if (source["Type"] !== undefined) {
        builder.fields("Registry value details", [{ label: "Type", value: registryType(take("Type")) }]);
      }
      break;
    case "RegistrySubKeyListReq":
      builder.table("Subkeys", list(take("Subkeys")).map((value) => ({ Subkey: value })), [["Subkey", "Subkey"]]);
      break;
    case "RegistryListValuesReq":
      builder.table("Value names", list(take("ValueNames")).map((value) => ({ Name: value })), [["Name", "Name"]]);
      break;
    case "ServicesReq":
      builder.table("Services", list(take("Details")), SERVICE_COLUMNS);
      break;
    case "ServiceDetailReq": {
      const detail = take("Detail");
      if (isRecord(detail)) {
        builder.fields("Service details", SERVICE_COLUMNS.filter(([key]) => Object.hasOwn(detail, key))
          .map(([key, title, format]) => ({ label: title, value: format ? format(detail[key]) : scalar(detail[key]) })));
        builder.value("Additional service details", without(detail, ...SERVICE_COLUMNS.map(([key]) => key)));
      }
      break;
    }
    case "ExecuteReq":
    case "ExecuteWindowsReq":
      builder.fields("Process", [
        ...(source["Pid"] !== undefined ? [{ label: "PID", value: scalar(take("Pid")) }] : []),
        ...(source["Status"] !== undefined ? [{ label: "Exit code", value: scalar(take("Status")) }] : []),
      ]);
      builder.stream("Standard output", take("Stdout"));
      builder.stream("Standard error", take("Stderr"));
      break;
    case "SSHCommandReq":
      builder.stream("Standard output", take("StdOut"));
      builder.stream("Standard error", take("StdErr"));
      break;
    case "InvokeExecuteAssemblyReq":
    case "InvokeInProcExecuteAssemblyReq":
    case "ExecuteAssemblyReq":
    case "RunAsReq":
      builder.stream("Output", take("Output"));
      break;
    case "SideloadReq":
    case "SpawnDllReq":
      builder.stream("Output", take("Result"));
      break;
    case "CurrentTokenOwnerReq":
      builder.output("Identity", take("Output"));
      break;
    case "CallExtensionReq": {
      const records = list(take("BOFOutputs"));
      records.forEach((entry, index) => {
        if (!isRecord(entry)) { builder.value(`Output ${index + 1}`, entry); return; }
        const channel = entry["Type"] === 0 ? "Standard output" : entry["Type"] === 0x0d ? "Standard error" : `Channel ${scalar(entry["Type"])}`;
        const sectionTitle = `${channel} · ${index + 1}`;
        builder.stream(sectionTitle, entry["Data"]);
        builder.value(`${sectionTitle} details`, without(entry, "Type", "Data"));
      });
      const legacy = take("Output");
      if (records.length === 0 || (byteValue(legacy) ? legacy.data.length > 0 : Boolean(legacy))) builder.stream("Output", legacy);
      take("ServerStore");
      break;
    }
    case "GetPrivsReq":
      builder.table("Privileges", list(take("PrivInfo")), [
        ["Name", "Name"], ["Description", "Description"], ["Enabled", "Enabled"], ["EnabledByDefault", "Enabled by default"],
      ]);
      break;
    case "ExecuteChildrenReq":
      builder.table("Background processes", list(take("Children")), [["Pid", "PID"], ["Path", "Path"]]);
      break;
  }
  builder.value(builder.model.sections.length ? "Response details" : title, source);
  if (builder.model.sections.length === 0) builder.text("Result", "The target returned a completed response without additional output.");
  return builder.model;
}

class ResponseBuilder {
  readonly model: BeaconFullResponseModel;

  constructor(title: string) { this.model = { title, sections: [] }; }

  text(title: string, text: string): void { this.model.sections.push({ kind: "text", title, text }); }
  bytes(title: string, hex: string): void { this.model.sections.push({ kind: "bytes", title, hex }); }
  fields(title: string, fields: { label: string; value: string }[]): void {
    if (fields.length) this.model.sections.push({ kind: "fields", title, fields });
  }

  output(title: string, value: unknown): void {
    if (byteValue(value)) {
      if (value.encoding === "hex") this.bytes(title, value.data);
      else this.text(title, value.data);
    } else if (value === undefined || value === null) this.text(title, "");
    else if (typeof value === "string") this.text(title, value);
    else this.value(title, value);
  }

  stream(title: string, value: unknown): void {
    if (byteValue(value) && value.encoding === "hex" && /^(?:[\da-f]{2})*$/iu.test(value.data)) {
      const bytes = Uint8Array.from(value.data.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        // ESC and backspace are common in captured terminal output. Keep these
        // streams readable with visible escapes; actual binary stays a hex view.
        if (!/[\u0000-\u0007\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/u.test(text)) {
          this.text(title, escapeTerminalOutput(text));
          return;
        }
      } catch { /* Invalid UTF-8 remains binary output. */ }
    }
    this.output(title, value);
  }

  value(title: string, value: unknown): void {
    if (value === undefined) return;
    if (byteValue(value)) { this.output(title, value); return; }
    if (Array.isArray(value)) {
      this.table(title, value.every(isRecord) ? value : value.map((item) => ({ Value: item })));
      return;
    }
    if (!isRecord(value)) { this.text(title, scalar(value)); return; }
    const fields: { label: string; value: string }[] = [];
    const nested: [string, unknown][] = [];
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined || key === "Response" || key === "Request") continue;
      if (child !== null && typeof child === "object") nested.push([key, child]);
      else if (typeof child === "string" && (child.includes("\n") || child.length > 160)) nested.push([key, child]);
      else fields.push({ label: label(key), value: scalar(child) });
    }
    this.fields(title, fields);
    for (const [key, child] of nested) this.value(label(key), child);
  }

  table(title: string, items: unknown[], preferred: readonly Column[] = []): void {
    const encountered = new Set<string>();
    const additional: (() => void)[] = [];
    const records = items.map((item, rowIndex) => {
      const result = new Map<string, unknown>();
      const flatten = (value: unknown, path: string): void => {
        if (byteValue(value)) {
          if (value.encoding === "utf-8") result.set(path, value.data);
          else {
            result.set(path, "Binary output");
            additional.push(() => this.bytes(`${title} ${rowIndex + 1} · ${pathLabel(path)}`, value.data));
          }
        } else if (Array.isArray(value)) {
          if (value.every((child) => child === null || typeof child !== "object")) result.set(path, value.map(scalar).join("\n"));
          else {
            result.set(path, `${value.length} entries`);
            additional.push(() => this.value(`${title} ${rowIndex + 1} · ${pathLabel(path)}`, value));
          }
        } else if (isRecord(value)) {
          for (const [key, child] of Object.entries(value)) {
            if (key !== "Response" && key !== "Request") flatten(child, path ? `${path}.${key}` : key);
          }
        } else if (value !== undefined) result.set(path || "Value", value);
      };
      flatten(item, "");
      for (const key of result.keys()) encountered.add(key);
      return result;
    });
    const columns: Column[] = preferred.filter(([key]) => encountered.has(key));
    const preferredKeys = new Set(columns.map(([key]) => key));
    for (const key of encountered) if (!preferredKeys.has(key)) columns.push([key, pathLabel(key)]);
    if (columns.length === 0) columns.push(...(preferred.length ? preferred : [["Value", "Value"] as const]));
    this.model.sections.push({ kind: "table", title,
      columns: columns.map(([, title]) => title),
      rows: records.map((record) => columns.map(([key, , format]) => record.has(key)
        ? format ? format(record.get(key)) : scalar(record.get(key)) : "")),
    });
    for (const add of additional) add();
  }
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function byteValue(value: unknown): value is { encoding: "utf-8" | "hex"; data: string; bytes?: number } {
  return isRecord(value) && (value["encoding"] === "utf-8" || value["encoding"] === "hex") && typeof value["data"] === "string";
}

function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function without(value: RecordValue, ...keys: string[]): RecordValue {
  const excluded = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}
function scalar(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
function pathLabel(path: string): string { return path.split(".").map(label).join(" · "); }
function label(value: string): string {
  const special: Readonly<Record<string, string>> = {
    Pid: "PID", Ppid: "PPID", Ip: "IP", Uid: "UID", Gid: "GID", ID: "ID", MAC: "MAC",
    ProcessIntegrity: "Process integrity", ProcessName: "Process name", SearchPathAbsolute: "Search path",
    Err: "Error", IsDir: "Directory", timezone: "Timezone", timezoneOffset: "Timezone offset",
  };
  if (Object.hasOwn(special, value)) return special[value]!;
  const words = value.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2").replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ");
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}
function serviceStatus(value: unknown): string {
  const values = ["Unknown", "Stopped", "Start pending", "Stop pending", "Running", "Continue pending", "Pause pending", "Paused"];
  return typeof value === "number" && values[value] !== undefined ? values[value]! : scalar(value);
}
function serviceStartup(value: unknown): string {
  const values = ["Boot", "System", "Automatic", "Manual", "Disabled"];
  return typeof value === "number" && values[value] !== undefined ? values[value]! : scalar(value);
}
function registryType(value: unknown): string {
  const values = ["Not reported by target", "Binary", "String", "DWORD", "QWORD"];
  return typeof value === "number" && values[value] !== undefined ? values[value]! : scalar(value);
}

function byteCount(value: unknown): string {
  const text = scalar(value);
  return /^-?\d+$/u.test(text) ? `${BigInt(text).toLocaleString("en-US")} B` : text;
}

function modificationTime(value: unknown): string {
  const text = scalar(value);
  if (!/^-?\d+$/u.test(text)) return text;
  const date = new Date(Number(text) * 1_000);
  return Number.isNaN(date.getTime()) ? text : date.toISOString().replace("T", " ").replace(".000Z", " UTC");
}
