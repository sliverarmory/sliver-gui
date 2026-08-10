import { sliverpb } from "sliver-script";

/**
 * Sliver's append-only protobuf message number for sliverpb.ReconfigureReq.
 *
 * Message numbers are defined outside the protobuf schema in
 * protobuf/sliverpb/constants.go, so the generated TypeScript API does not
 * expose a symbolic constant. Keep the pinned value explicit at this wire
 * boundary instead of accepting an arbitrary nested task payload.
 */
export const MSG_RECONFIGURE_REQ = 83;

export interface DecodedReconfigureTaskRequest {
  envelope: sliverpb.Envelope;
  reconfigure: sliverpb.ReconfigureReq;
}

/**
 * Decode the database representation of BeaconTask.Request.
 *
 * Sliver stores an encoded Envelope here; Envelope.Data contains the encoded
 * operation request. The caller owns the returned envelope Data buffer and
 * must zero it after making assertions.
 */
export function decodeReconfigureTaskRequest(
  taskRequest: Uint8Array,
): DecodedReconfigureTaskRequest {
  const envelope = sliverpb.Envelope.decode(taskRequest);
  try {
    if (envelope.Type !== MSG_RECONFIGURE_REQ) {
      throw new Error(
        `Expected Sliver message type ${MSG_RECONFIGURE_REQ} (ReconfigureReq), received ${envelope.Type}`,
      );
    }
    if (envelope.UnknownMessageType) {
      throw new Error("Sliver marked the ReconfigureReq task envelope as an unknown message type");
    }
    if (envelope.Data.length === 0) {
      throw new Error("The ReconfigureReq task envelope has no nested request data");
    }
    return {
      envelope,
      reconfigure: sliverpb.ReconfigureReq.decode(envelope.Data),
    };
  } catch (error) {
    envelope.Data.fill(0);
    throw error;
  }
}
