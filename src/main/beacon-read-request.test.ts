import { describe, expect, it } from "vitest";
import { sliverpb } from "sliver-script";

import { verifyBeaconReadRequest } from "./beacon-read-request.js";

const beaconId = "beacon_exact";
const request = { Async: true, BeaconID: beaconId, SessionID: "", Timeout: "30000000000" };

function envelope(type: number, data: Uint8Array): Buffer {
  return Buffer.from(sliverpb.Envelope.encode(sliverpb.Envelope.create({
    ID: "1", Type: type, Data: Buffer.from(data), UnknownMessageType: false,
  })).finish());
}

describe("BC-04 beacon read request verification", () => {
  it("accepts a genuine typed environment request and rejects an option or target mismatch", () => {
    const data = sliverpb.EnvReq.encode(sliverpb.EnvReq.create({ Name: "PATH", Request: request })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.environment.list", name: "PATH" },
      envelope(66, data), beaconId)).not.toThrow();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.environment.list", name: "HOME" },
      envelope(66, data), beaconId)).toThrow(/name did not match/u);
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.environment.list", name: "PATH" },
      envelope(66, data), "beacon_other")).toThrow(/selected beacon/u);
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.environment.list", name: "PATH" },
      envelope(49, data), beaconId)).toThrow(/envelope did not match/u);
  });

  it("separates cat, head, and tail even though they share DownloadReq", () => {
    const cat = sliverpb.DownloadReq.encode(sliverpb.DownloadReq.create({
      Path: "/tmp/note", MaxBytes: "65537", MaxLines: "0", RestrictedToFile: true, Request: request,
    })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.cat", path: "/tmp/note" },
      envelope(7, cat), beaconId)).not.toThrow();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.head", path: "/tmp/note", bytes: 16 },
      envelope(7, cat), beaconId)).toThrow(/did not match/u);
    const tail = sliverpb.DownloadReq.encode(sliverpb.DownloadReq.create({
      Path: "/tmp/note", MaxBytes: "-16", MaxLines: "0", RestrictedToFile: true, Request: request,
    })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.tail", path: "/tmp/note", bytes: 16 },
      envelope(7, tail), beaconId)).not.toThrow();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.head", path: "/tmp/note", bytes: 16 },
      envelope(7, tail), beaconId)).toThrow(/did not match/u);
  });

  it("rejects malformed and unbound task bytes", () => {
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.mount" }, Buffer.from([0xff]), beaconId)).toThrow();
    const data = sliverpb.MountReq.encode(sliverpb.MountReq.create({
      Request: { ...request, Async: false },
    })).finish();
    expect(() => verifyBeaconReadRequest({ operationId: "beacon.filesystem.mount" },
      envelope(134, data), beaconId)).toThrow(/selected beacon/u);
  });
});
