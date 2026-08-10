import { describe, expect, it } from "vitest";

import {
  MSG_RECONFIGURE_REQ,
  decodeReconfigureTaskRequest,
} from "./beacon-task-wire.js";

describe("Beacon task request wire decoding", () => {
  it("decodes the pinned nested ReconfigureReq golden envelope", () => {
    // Envelope{Type: MsgReconfigureReq(83), Data:
    // ReconfigureReq{ReconnectInterval: 3_000_000_000}}.
    const golden = Buffer.from("10531a060880bcc1960b", "hex");
    const decoded = decodeReconfigureTaskRequest(golden);
    try {
      expect(decoded.envelope.Type).toBe(MSG_RECONFIGURE_REQ);
      expect(decoded.reconfigure).toMatchObject({
        ReconnectInterval: "3000000000",
        BeaconInterval: "0",
        BeaconJitter: "0",
        C2URI: "",
      });
    } finally {
      decoded.envelope.Data.fill(0);
      golden.fill(0);
    }
  });

  it("fails closed for a different message type", () => {
    const nested = Buffer.from("0880bcc1960b", "hex");
    const envelope = Buffer.from([0x10, 0x03, 0x1a, nested.length, ...nested]);
    expect(() => decodeReconfigureTaskRequest(envelope)).toThrow(/expected Sliver message type 83/iu);
    nested.fill(0);
    envelope.fill(0);
  });
});
