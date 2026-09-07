import { describe, expect, it } from "vitest";

import { parseDiscoverAwsOptionsInput } from "./cloud-provider-inventory.js";

describe("cloud provider inventory contracts", () => {
  it("accepts a bounded AWS discovery request", () => {
    expect(parseDiscoverAwsOptionsInput({
      credentialId: "11111111-1111-4111-8111-111111111111",
      region: "us-west-2",
    })).toEqual({
      credentialId: "11111111-1111-4111-8111-111111111111",
      region: "us-west-2",
    });
  });

  it.each([
    null,
    {},
    { credentialId: "not-a-guid", region: "us-west-2" },
    { credentialId: "11111111-1111-4111-8111-111111111111", region: "west" },
    { credentialId: "11111111-1111-4111-8111-111111111111", region: "us-west-2", extra: true },
  ])("rejects an invalid AWS discovery request %#", (input) => {
    expect(() => parseDiscoverAwsOptionsInput(input)).toThrow("Invalid AWS option discovery request");
  });
});
