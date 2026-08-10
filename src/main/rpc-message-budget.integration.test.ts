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
  it("rejects oversized control messages before either receiver deserializes them", async () => {
    let serverDecodedRequest = false;
    let clientDecodedResponse = false;
    const definition: grpc.MethodDefinition<Buffer, Buffer> = {
      path: METHOD_PATH,
      originalName: "probe",
      requestStream: false,
      responseStream: false,
      requestSerialize: identity,
      requestDeserialize: (value) => {
        serverDecodedRequest = true;
        return value;
      },
      responseSerialize: identity,
      responseDeserialize: identity,
    };

    server = new grpc.Server();
    server.addService(
      { probe: definition },
      {
        probe(
          _call: grpc.ServerUnaryCall<Buffer, Buffer>,
          callback: grpc.sendUnaryData<Buffer>,
        ): void {
          callback(null, Buffer.alloc(RPC_MESSAGE_BUDGETS.control.maxReceiveBytes + 1));
        },
      },
    );
    const port = await bind(server);
    client = new grpc.Client(
      `127.0.0.1:${port}`,
      grpc.credentials.createInsecure(),
      rpcMessageChannelOptions("control"),
    );

    const inbound = await unary(client, Buffer.alloc(0), () => {
      clientDecodedResponse = true;
    });
    expect(inbound.error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    expect(serverDecodedRequest).toBe(true);
    expect(clientDecodedResponse).toBe(false);

    serverDecodedRequest = false;
    clientDecodedResponse = false;
    const outbound = await unary(
      client,
      Buffer.alloc(RPC_MESSAGE_BUDGETS.control.maxSendBytes + 1),
      () => {
        clientDecodedResponse = true;
      },
    );
    expect(outbound.error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    expect(serverDecodedRequest).toBe(false);
    expect(clientDecodedResponse).toBe(false);
  });

  it("rejects oversized task content on its dedicated channel before protobuf decode", async () => {
    let clientDecodedResponse = false;
    const definition: grpc.MethodDefinition<Buffer, Buffer> = {
      path: METHOD_PATH,
      originalName: "probe",
      requestStream: false,
      responseStream: false,
      requestSerialize: identity,
      requestDeserialize: identity,
      responseSerialize: identity,
      responseDeserialize: identity,
    };
    server = new grpc.Server();
    server.addService(
      { probe: definition },
      {
        probe(
          _call: grpc.ServerUnaryCall<Buffer, Buffer>,
          callback: grpc.sendUnaryData<Buffer>,
        ): void {
          callback(null, Buffer.alloc(RPC_MESSAGE_BUDGETS["task-content"].maxReceiveBytes + 1));
        },
      },
    );
    const port = await bind(server);
    client = new grpc.Client(
      `127.0.0.1:${port}`,
      grpc.credentials.createInsecure(),
      rpcMessageChannelOptions("task-content"),
    );

    const inbound = await unary(client, Buffer.alloc(0), () => {
      clientDecodedResponse = true;
    });
    expect(inbound.error?.code).toBe(grpc.status.RESOURCE_EXHAUSTED);
    expect(clientDecodedResponse).toBe(false);
  });
});

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
