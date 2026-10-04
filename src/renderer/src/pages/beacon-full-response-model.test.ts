import { describe, expect, it } from "vitest";

import type { BeaconTaskSummary } from "../../../shared/operation-contracts.js";
import { buildBeaconFullResponse, type BeaconFullResponseModel } from "./beacon-full-response-model.js";

function task(description: string): BeaconTaskSummary {
  return { taskId: "task-1", beaconId: "beacon-1", description, state: "completed", resultAvailable: true,
    cancellation: { available: false }, ownership: { origin: "unknown", actor: { attribution: "unknown" } } };
}

function build(description: string, value: unknown): BeaconFullResponseModel {
  return buildBeaconFullResponse(task(description), { format: "json", text: JSON.stringify(value) });
}

function textBytes(data: string) { return { encoding: "utf-8", bytes: data.length, data }; }

describe("complete beacon response presentation", () => {
  it("renders every directory row as a table with full names and readable metadata", () => {
    const longName = "full-name".repeat(1_000);
    const model = build("LsReq", {
      Path: "/tmp", Files: Array.from({ length: 300 }, (_, index) => ({
        Name: index === 299 ? longName : `file-${index}`, IsDir: index === 0,
        Size: "9007199254740993", ModTime: "1700000000", Mode: "-rw-r--r--",
      })), Response: { Async: false, BeaconID: "", TaskID: "", Err: "" },
    });
    expect(model.title).toBe("Directory listing");
    const files = model.sections.find((section) => section.kind === "table");
    expect(files?.kind).toBe("table");
    if (files?.kind !== "table") throw new Error("Expected files table");
    expect(files.columns).toEqual(["Name", "Type", "Size", "Modified", "Mode"]);
    expect(files.rows).toHaveLength(300);
    expect(files.rows[0]).toEqual(["file-0", "Directory", "9,007,199,254,740,993 B", "2023-11-14 22:13:20 UTC", "-rw-r--r--"]);
    expect(files.rows[299]?.[0]).toBe(longName);
    expect(JSON.stringify(model)).not.toContain("Async");
  });

  it("renders the complete file as literal multiline text without transport plumbing", () => {
    const contents = `\uFEFFfirst\r\n${"line with \"quoted\" content\n".repeat(10_000)}last\r\n`;
    const model = build("DownloadReq", { Path: "/tmp/file.txt", Encoder: "gzip", Data: textBytes(contents), Response: {} });
    expect(model.title).toBe("File contents");
    expect(model.sections[0]).toEqual({ kind: "text", title: "File contents", text: contents });
    expect(model.sections).toContainEqual({ kind: "fields", title: "Response details", fields: [{ label: "Path", value: "/tmp/file.txt" }] });
    expect(JSON.stringify(model)).not.toContain("encoding");
    expect(JSON.stringify(model)).not.toContain("gzip");
  });

  it("renders both full execution streams and readable process information", () => {
    const stdout = "output\r\n".repeat(15_000);
    const stderr = "error\n".repeat(20_000);
    const model = build("ExecuteReq", { Pid: 19, Status: 2, Stdout: textBytes(stdout), Stderr: textBytes(stderr) });
    expect(model.title).toBe("Process execution");
    expect(model.sections).toEqual([
      { kind: "fields", title: "Process", fields: [{ label: "PID", value: "19" }, { label: "Exit code", value: "2" }] },
      { kind: "text", title: "Standard output", text: stdout },
      { kind: "text", title: "Standard error", text: stderr },
    ]);
  });

  it("recovers ANSI streams as safely escaped text while retaining actual binary output", () => {
    const model = build("ExecuteWindowsReq", {
      Stdout: { encoding: "hex", data: "1b5b33316d7265641b5b306d0a" },
      Stderr: { encoding: "hex", data: "00ff01" },
    });
    expect(model.sections).toContainEqual({ kind: "text", title: "Standard output", text: "\\u001b[31mred\\u001b[0m\n" });
    expect(model.sections).toContainEqual({ kind: "bytes", title: "Standard error", hex: "00ff01" });
  });

  it("keeps BOF record order, channels, and long output", () => {
    const output = "message".repeat(2_000);
    const model = build("CallExtensionReq", { BOFOutputs: [
      { Type: 0, Data: textBytes(output) }, { Type: 13, Data: textBytes("error") },
      { Type: 7, Data: { encoding: "hex", data: "00ff" } },
    ], Output: textBytes(""), ServerStore: true });
    expect(model.sections).toEqual([
      { kind: "text", title: "Standard output · 1", text: output },
      { kind: "text", title: "Standard error · 2", text: "error" },
      { kind: "bytes", title: "Channel 7 · 3", hex: "00ff" },
    ]);
  });

  it("presents unknown nested response values as fields and tables without object serialization", () => {
    const model = build("FutureNestedReq", {
      DisplayName: "Future result", Settings: { IsEnabled: true, NestedGroup: { Message: "line one\nline two" } },
      Records: [
        { Name: "first", Address: { IP: "10.0.0.1", Port: 80 }, Children: [{ Name: "nested", Values: ["alpha", "beta"] }] },
        { Name: "last", ExtraField: "preserved" },
      ],
    });
    expect(model.title).toBe("Beacon task");
    const rows = model.sections.find((section) => section.kind === "table" && section.title === "Records");
    expect(rows?.kind).toBe("table");
    if (rows?.kind !== "table") throw new Error("Expected records table");
    expect(rows.rows).toHaveLength(2);
    expect(rows.columns).toContain("Address · Port");
    expect(rows.rows[1]).toContain("preserved");
    expect(model.sections).toContainEqual({ kind: "text", title: "Message", text: "line one\nline two" });
    expect(model.sections.some((section) => section.kind === "table" && section.rows.some((row) => row.includes("nested") && row.includes("alpha\nbeta")))).toBe(true);
    for (const section of model.sections) {
      const values = section.kind === "fields" ? section.fields.map((field) => field.value)
        : section.kind === "table" ? section.rows.flat() : section.kind === "text" ? [section.text] : [];
      expect(values.some((value) => value.includes("[object Object]") || value.includes('"NestedGroup"'))).toBe(false);
    }
  });

  it.each([
    ["PsReq", "Processes", [{ Pid: 1, CmdLine: ["program", "--option"] }], "Processes"],
    ["IfconfigReq", "NetInterfaces", [{ Name: "eth0", IPAddresses: ["10.0.0.1", "::1"] }], "Interfaces"],
    ["EnvReq", "Variables", [{ Key: "API_TOKEN", Value: "[redacted]" }], "Environment variables"],
    ["NetstatReq", "Entries", [{ Protocol: "tcp", LocalAddr: { Ip: "127.0.0.1", Port: 80 } }], "Connections"],
    ["MountReq", "Info", [{ MountPoint: "/", VolumeName: "root" }], "Mounts"],
    ["MemfilesListReq", "Files", [{ Name: "memfile", Size: "10" }], "Memory files"],
    ["GetPrivsReq", "PrivInfo", [{ Name: "SeDebugPrivilege", Enabled: true }], "Privileges"],
    ["ExecuteChildrenReq", "Children", [{ Pid: 12, Path: "/bin/child" }], "Background processes"],
  ])("renders %s as its familiar table", (description, key, rows, title) => {
    const model = build(description, { [key]: rows });
    expect(model.sections.some((section) => section.kind === "table" && section.title === title && section.rows.length === 1)).toBe(true);
  });

  it("preserves all grep matches and multiline context", () => {
    const model = build("GrepReq", { SearchPathAbsolute: "/tmp", Results: { "/tmp/a": {
      IsBinary: false, FileResults: Array.from({ length: 300 }, (_, index) => ({
        LineNumber: String(index + 1), Line: "match", LinesBefore: ["one", "two"], LinesAfter: ["three"],
      })),
    } } });
    const section = model.sections.find((section) => section.kind === "table");
    if (section?.kind !== "table") throw new Error("Expected matches table");
    expect(section.rows).toHaveLength(300);
    expect(section.rows[299]).toEqual(["/tmp/a", "300", "match", "one\ntwo", "three", "No"]);
  });

  it("labels registry types and service states using the pinned protocol values", () => {
    expect(build("RegistryReadReq", { Type: 1, Binary: { encoding: "hex", data: "00ff" } }).sections)
      .toContainEqual({ kind: "fields", title: "Registry value details", fields: [{ label: "Type", value: "Binary" }] });
    const service = build("ServicesReq", { Details: [{ Name: "service", Status: 4, StartupType: 2 }] });
    expect(service.sections[0]).toEqual({ kind: "table", title: "Services", columns: ["Name", "Status", "Startup"], rows: [["service", "Running", "Automatic"]] });
  });

  it("retains grep files without matches and their binary status and additional metadata", () => {
    const model = build("GrepReq", { Results: {
      "/tmp/binary": { FileResults: [], IsBinary: true, ScanDetails: { Reason: "Binary file skipped" } },
      "/tmp/empty": { FileResults: [], IsBinary: false },
      "/tmp/matched": { FileResults: [{ LineNumber: "1", Line: "match" }], IsBinary: false },
    } });
    expect(model.sections).toContainEqual({ kind: "table", title: "Files without matches",
      columns: ["Path", "Binary"], rows: [["/tmp/binary", "Yes"], ["/tmp/empty", "No"]] });
    expect(model.sections).toContainEqual({ kind: "fields", title: "Scan details",
      fields: [{ label: "Reason", value: "Binary file skipped" }] });
    const matches = model.sections.find((section) => section.kind === "table");
    expect(matches?.title).toBe("Matches");
    expect(matches?.kind === "table" ? matches.rows[0] : undefined).toContain("/tmp/matched");
  });

  it("renders target errors and empty confirmations without exposing response envelope fields", () => {
    expect(build("SetEnvReq", { Response: { Err: "The target refused the change", Async: false } }).sections)
      .toEqual([{ kind: "text", title: "Target error", text: "The target refused the change" }]);
    expect(build("RegistryWriteReq", { Response: {} }).sections)
      .toEqual([{ kind: "text", title: "Result", text: "The target returned a completed response without additional output." }]);
  });
});
