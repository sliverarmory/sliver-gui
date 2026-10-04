import { describe, expect, it } from "vitest";
import { sliverpb } from "sliver-script";

import { parseTargetOperationInput, type TargetOperationInput } from "../shared/operation-contracts.js";
import { verifyBeaconReadRequest } from "./beacon-read-request.js";

const request = { Async: true, BeaconID: "", SessionID: "", Timeout: "30000000000" };

function envelope(type: number, data: Uint8Array): Buffer {
  return Buffer.from(sliverpb.Envelope.encode(sliverpb.Envelope.create({
    ID: "1", Type: type, Data: Buffer.from(data), UnknownMessageType: false,
  })).finish());
}

describe("BC-04 beacon read request verification", () => {
  it("binds the original M2 reads to their saved request options", () => {
    const ls = sliverpb.LsReq.encode(sliverpb.LsReq.create({ Path: "/tmp", Request: request })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.ls", path: "/tmp" },
      envelope(5, ls))).not.toThrow();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.ls", path: "/other" },
      envelope(5, ls))).toThrow(/path did not match/u);
    const ps = sliverpb.PsReq.encode(sliverpb.PsReq.create({ FullInfo: true, Request: request })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.process.list", fullInfo: false },
      envelope(18, ps))).toThrow(/option did not match/u);
  });

  it("accepts a server-saved environment request and rejects an option or unsanitized target mismatch", () => {
    const data = sliverpb.EnvReq.encode(sliverpb.EnvReq.create({ Name: "PATH", Request: request })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.environment.list", name: "PATH" },
      envelope(66, data))).not.toThrow();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.environment.list", name: "HOME" },
      envelope(66, data))).toThrow(/name did not match/u);
    const unsanitized = sliverpb.EnvReq.encode(sliverpb.EnvReq.create({
      Name: "PATH", Request: { ...request, BeaconID: "another_beacon" },
    })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.environment.list", name: "PATH" },
      envelope(66, unsanitized))).toThrow(/server's saved beacon task shape/u);
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.environment.list", name: "PATH" },
      envelope(49, data))).toThrow(/envelope did not match/u);
  });

  it("separates cat, head, and tail even though they share DownloadReq", () => {
    const cat = sliverpb.DownloadReq.encode(sliverpb.DownloadReq.create({
      Path: "/tmp/note", MaxBytes: "65537", MaxLines: "0", RestrictedToFile: true, Request: request,
    })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.cat", path: "/tmp/note" },
      envelope(7, cat))).not.toThrow();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.head", path: "/tmp/note", bytes: 16 },
      envelope(7, cat))).toThrow(/did not match/u);
    const tail = sliverpb.DownloadReq.encode(sliverpb.DownloadReq.create({
      Path: "/tmp/note", MaxBytes: "-16", MaxLines: "0", RestrictedToFile: true, Request: request,
    })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.tail", path: "/tmp/note", bytes: 16 },
      envelope(7, tail))).not.toThrow();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.head", path: "/tmp/note", bytes: 16 },
      envelope(7, tail))).toThrow(/did not match/u);
  });

  it("rejects malformed and unbound task bytes", () => {
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.mount" }, Buffer.from([0xff]))).toThrow();
    const data = sliverpb.MountReq.encode(sliverpb.MountReq.create({
      Request: { ...request, Async: false },
    })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.mount" },
      envelope(134, data))).toThrow(/server's saved beacon task shape/u);
  });

  it("binds every BC-08 Registry read and mutation to the saved hive, path, key, and hostname", () => {
    const location = { Hive: "HKCU", Path: "Software\\Acme", Hostname: "host01", Request: request };
    const expectedLocation = { hive: "HKCU", path: "Software\\Acme", hostname: "host01" } as const;
    const cases: { expected: TargetOperationInput; type: number; data: Uint8Array }[] = [
      { expected: { operationId: "beacon.registry.read", ...expectedLocation, key: "Name" }, type: 71,
        data: sliverpb.RegistryReadReq.encode(sliverpb.RegistryReadReq.create({ ...location, Key: "Name" })).finish() },
      { expected: { operationId: "beacon.registry.list-subkeys", ...expectedLocation }, type: 88,
        data: sliverpb.RegistrySubKeyListReq.encode(sliverpb.RegistrySubKeyListReq.create(location)).finish() },
      { expected: { operationId: "beacon.registry.list-values", ...expectedLocation }, type: 89,
        data: sliverpb.RegistryListValuesReq.encode(sliverpb.RegistryListValuesReq.create(location)).finish() },
      { expected: { operationId: "beacon.registry.create", ...expectedLocation, key: "Child" }, type: 73,
        data: sliverpb.RegistryCreateKeyReq.encode(sliverpb.RegistryCreateKeyReq.create({ ...location, Key: "Child" })).finish() },
      { expected: { operationId: "beacon.registry.delete", ...expectedLocation, key: "Child" }, type: 97,
        data: sliverpb.RegistryDeleteKeyReq.encode(sliverpb.RegistryDeleteKeyReq.create({ ...location, Key: "Child" })).finish() },
    ];
    for (const entry of cases) {
      expect(() => verifyBeaconReadRequest(entry.expected, envelope(entry.type, entry.data))).not.toThrow();
      expect(() => verifyBeaconReadRequest({ ...entry.expected, hostname: "host02" } as TargetOperationInput,
        envelope(entry.type, entry.data))).toThrow(/hostname did not match/u);
      expect(() => verifyBeaconReadRequest(entry.expected, envelope(12, entry.data)))
        .toThrow(/envelope did not match/u);
    }
    const read = cases[0]!;
    expect(() => verifyBeaconReadRequest({ ...read.expected, key: "Other" } as TargetOperationInput,
      envelope(read.type, read.data))).toThrow(/name did not match/u);
  });

  it("verifies exact Registry write type and value fields, including binary bytes", () => {
    const base = { operationId: "beacon.registry.write", hive: "HKCU", path: "Software\\Acme", key: "Name" } as const;
    const fields = { Hive: base.hive, Path: base.path, Key: base.key, Request: request };
    const cases = [
      { value: { type: "string", value: "hello" }, fields: { Type: sliverpb.RegistryType.String, StringValue: "hello" } },
      { value: { type: "binary", hex: "00ff" }, fields: { Type: sliverpb.RegistryType.Binary, ByteValue: Buffer.from("00ff", "hex") } },
      { value: { type: "dword", value: 0xfeedbeef }, fields: { Type: sliverpb.RegistryType.DWORD, DWordValue: 0xfeedbeef } },
      { value: { type: "qword", value: "18446744073709551615" }, fields: {
        Type: sliverpb.RegistryType.QWORD, QWordValue: "18446744073709551615",
      } },
    ] as const;
    for (const entry of cases) {
      const data = sliverpb.RegistryWriteReq.encode(sliverpb.RegistryWriteReq.create({ ...fields, ...entry.fields })).finish();
      const expected = { ...base, value: entry.value } as TargetOperationInput;
      expect(() => verifyBeaconReadRequest(expected, envelope(72, data))).not.toThrow();
      expect(() => verifyBeaconReadRequest({ ...expected, key: "Other" } as TargetOperationInput,
        envelope(72, data))).toThrow(/write request did not match/u);
    }
    const wrongType = sliverpb.RegistryWriteReq.encode(sliverpb.RegistryWriteReq.create({
      ...fields, Type: sliverpb.RegistryType.DWORD, StringValue: "hello",
    })).finish();
    expect(() => verifyBeaconReadRequest({ ...base, value: { type: "string", value: "hello" } },
      envelope(72, wrongType))).toThrow(/reviewed value/u);
  });

  it("binds a normalized leading-zero QWORD to the saved decimal protobuf value", () => {
    const input = parseTargetOperationInput({
      operationId: "beacon.registry.write",
      hive: "HKCU",
      path: "Software\\Acme",
      key: "Count",
      value: { type: "qword", value: "0001" },
    });
    expect(input).toMatchObject({ value: { type: "qword", value: "1" } });
    if (input.operationId !== "beacon.registry.write") throw new Error("Expected Registry write input");
    const data = sliverpb.RegistryWriteReq.encode(sliverpb.RegistryWriteReq.create({
      Hive: "HKCU", Path: "Software\\Acme", Key: "Count", Type: sliverpb.RegistryType.QWORD,
      QWordValue: "1", Request: request,
    })).finish();
    expect(() => verifyBeaconReadRequest(input, envelope(72, data))).not.toThrow();
    expect(() => verifyBeaconReadRequest({ ...input, value: { type: "qword", value: "0001" } },
      envelope(72, data))).toThrow(/reviewed value/u);
  });

  it("rejects saved Registry requests whose UTF-8 fields replaced an unpaired surrogate", () => {
    const loneSurrogate = "\ud800";
    const readData = sliverpb.RegistryReadReq.encode(sliverpb.RegistryReadReq.create({
      Hive: "HKCU", Path: "\ufffd", Key: "Name", Request: request,
    })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.registry.read", hive: "HKCU",
      path: loneSurrogate, key: "Name" }, envelope(71, readData))).toThrow(/hive, path, or hostname did not match/u);

    const writeData = sliverpb.RegistryWriteReq.encode(sliverpb.RegistryWriteReq.create({
      Hive: "HKCU", Path: "Software", Key: "Name", Type: sliverpb.RegistryType.String,
      StringValue: "\ufffd", Request: request,
    })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.registry.write", hive: "HKCU",
      path: "Software", key: "Name", value: { type: "string", value: loneSurrogate } },
    envelope(72, writeData))).toThrow(/reviewed value/u);
  });

  it("binds each service command to its exact name and hostname", () => {
    const info = { ServiceName: "Spooler", Hostname: "host01" };
    const cases: { expected: TargetOperationInput; type: number; data: Uint8Array }[] = [
      { expected: { operationId: "beacon.service.list", hostname: "host01" }, type: 130,
        data: sliverpb.ServicesReq.encode(sliverpb.ServicesReq.create({ Hostname: "host01", Request: request })).finish() },
      { expected: { operationId: "beacon.service.info", name: "Spooler", hostname: "host01" }, type: 131,
        data: sliverpb.ServiceDetailReq.encode(sliverpb.ServiceDetailReq.create({ ServiceInfo: info, Request: request })).finish() },
      { expected: { operationId: "beacon.service.start", name: "Spooler", hostname: "host01" }, type: 132,
        data: sliverpb.StartServiceByNameReq.encode(sliverpb.StartServiceByNameReq.create({ ServiceInfo: info, Request: request })).finish() },
      { expected: { operationId: "beacon.service.stop", name: "Spooler", hostname: "host01" }, type: 62,
        data: sliverpb.StopServiceReq.encode(sliverpb.StopServiceReq.create({ ServiceInfo: info, Request: request })).finish() },
    ];
    for (const entry of cases) {
      expect(() => verifyBeaconReadRequest(entry.expected, envelope(entry.type, entry.data))).not.toThrow();
      expect(() => verifyBeaconReadRequest({ ...entry.expected, hostname: "host02" } as TargetOperationInput,
        envelope(entry.type, entry.data))).toThrow(/hostname did not match/u);
      if ("name" in entry.expected) {
        expect(() => verifyBeaconReadRequest({ ...entry.expected, name: "Other" } as TargetOperationInput,
          envelope(entry.type, entry.data))).toThrow(/name or hostname did not match/u);
      }
    }
  });
});
