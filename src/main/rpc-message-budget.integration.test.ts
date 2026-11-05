// @vitest-environment node

import * as grpc from "@grpc/grpc-js";
import { RPC_MESSAGE_BUDGETS, rpcMessageChannelOptions } from "sliver-script";
import { afterEach, describe, expect, it } from "vitest";

const METHOD_PATH = "/sliver.gui.test.MessageBudget/Probe";

let client: grpc.Client | undefined;
let server: grpc.Server | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  if (server) {
    const activeServer = server;
    server = undefined;
    await new Promise<void>((resolve) => activeServer.tryShutdown(() => resolve()));
  }
});

describe("grpc-js allocation enforcement", () => {
  it("accepts the control send boundary and rejects oversized requests before server decode", async () => {
    const limit = RPC_MESSAGE_BUDGETS.control.maxSendBytes;
    let decodedRequests = 0;
    // The receiver must accept the probe; otherwise its own limit can hide a missing client limit.
    server = new grpc.Server({ "grpc.max_receive_message_length": limit + 1 });
    server.addService({ probe: probeDefinition((value) => {
      decodedRequests += 1;
      return value;
    }) }, {
      probe(_call: grpc.ServerUnaryCall<Buffer, Buffer>, callback: grpc.sendUnaryData<Buffer>): void {
        callback(null, Buffer.alloc(0));
      },
    });
    const port = await bind(server);
    client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), rpcMessageChannelOptions("control"));

    const accepted = await unary(client, Buffer.alloc(limit), () => undefined);
    expect(accepted.error).toBeNull();
    expect(decodedRequests).toBe(1);

    const rejected = await unary(client, Buffer.alloc(limit + 1), () => undefined);
    expect(rejected.error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    expect(decodedRequests).toBe(1);
  });

  it.each(["control", "task-content", "tunnel-stream"] as const)(
    "accepts the %s receive boundary and rejects oversized responses before decode",
    async (domain) => {
      const limit = RPC_MESSAGE_BUDGETS[domain].maxReceiveBytes;
      let responseBytes = limit;
      let decodedResponses = 0;
      server = new grpc.Server({ "grpc.max_send_message_length": limit + 1 });
      server.addService({ probe: probeDefinition(identity) }, {
        probe(_call: grpc.ServerUnaryCall<Buffer, Buffer>, callback: grpc.sendUnaryData<Buffer>): void {
          callback(null, Buffer.alloc(responseBytes));
        },
      });
      const port = await bind(server);
      client = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), rpcMessageChannelOptions(domain));
      const beforeDecode = () => { decodedResponses += 1; };

      const accepted = await unary(client, Buffer.alloc(0), beforeDecode);
      expect(accepted.error).toBeNull();
      expect(accepted.response?.byteLength).toBe(limit);
      expect(decodedResponses).toBe(1);

      responseBytes = limit + 1;
      const rejected = await unary(client, Buffer.alloc(0), beforeDecode);
      expect(rejected.error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
      expect(decodedResponses).toBe(1);
    },
  );
});

function probeDefinition(requestDeserialize: (value: Buffer) => Buffer): grpc.MethodDefinition<Buffer, Buffer> {
  return {
    path: METHOD_PATH,
    originalName: "probe",
    requestStream: false,
    responseStream: false,
    requestSerialize: identity,
    requestDeserialize,
    responseSerialize: identity,
    responseDeserialize: identity,
  };
}

function identity(value: Buffer): Buffer {
  return value;
}

async function bind(activeServer: grpc.Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    activeServer.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, port) => error ? reject(error) : resolve(port),
    );
  });
}

async function unary(
  activeClient: grpc.Client,
  request: Buffer,
  beforeDecode: () => void,
): Promise<{ error: grpc.ServiceError | null; response?: Buffer }> {
  return new Promise((resolve) => {
    activeClient.makeUnaryRequest(
      METHOD_PATH,
      identity,
      (value) => {
        beforeDecode();
        return value;
      },
      request,
      (error, response) => resolve({ error, ...(response ? { response } : {}) }),
    );
  });
}
