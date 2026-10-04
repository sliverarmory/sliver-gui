// @vitest-environment node

import { describe, expect, it } from "vitest";

import { parseConfig, type SliverClientConfig } from "sliver-script";

describe("managed operator CA credentials", () => {
  it("rejects a blank managed CA in the public configuration parser", () => {
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
