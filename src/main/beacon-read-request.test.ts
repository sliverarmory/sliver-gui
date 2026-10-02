import { describe, expect, it } from "vitest";
import { sliverpb } from "sliver-script";

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
});
