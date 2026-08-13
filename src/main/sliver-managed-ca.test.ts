// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseConfig, type SliverClientConfig } from "sliver-script";

const credentialSource = readFileSync(
  new URL("../../vendor/sliver-script/src/internal/credentials.ts", import.meta.url),
  "utf8",
);

describe("managed operator CA credentials", () => {
  it("pins gRPC TLS to the CA supplied by the Sliver operator config", () => {
    expect(credentialSource).toContain("const ca = Buffer.from(config.ca_certificate)");
    expect(credentialSource).toMatch(/createSsl\(ca, privateKey, certificate,/u);
    expect(credentialSource).toMatch(/rejectUnauthorized:\s*true/u);
    expect(credentialSource).not.toMatch(/getCACertificates|rootCertificates|systemCa/iu);
  });

  it("fails closed before creating TLS credentials when the managed CA is blank", () => {
    expect(() => parseConfig(Buffer.from(JSON.stringify(config({ ca_certificate: " \n\t" }))))).toThrow(
      "Invalid sliver config: missing/invalid ca_certificate",
    );
  });
});

function config(overrides: Partial<SliverClientConfig> = {}): SliverClientConfig {
  return {
    operator: "operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "MANAGED-SLIVER-CA",
    certificate: "CLIENT-CERTIFICATE",
    private_key: "CLIENT-PRIVATE-KEY",
    token: "token",
    ...overrides,
  };
}
