import * as grpc from "@grpc/grpc-js";

import type { SliverClientConfig } from "../config";

export function createSliverRpcCredentials(config: SliverClientConfig): grpc.ChannelCredentials {
  const ca = Buffer.from(config.ca_certificate);
  const privateKey = Buffer.from(config.private_key);
  const certificate = Buffer.from(config.certificate);

  return grpc.credentials.combineChannelCredentials(
    grpc.credentials.createSsl(ca, privateKey, certificate, {
      // Sliver configs are typically self-signed; we only verify the presented cert
      // chains up to the configured CA, not the hostname.
      checkServerIdentity: () => undefined,
    }),
    grpc.credentials.createFromMetadataGenerator((_, callback) => {
      const meta = new grpc.Metadata();
      meta.set("Authorization", `Bearer ${config.token}`);
      callback(null, meta);
    }),
  );
}

