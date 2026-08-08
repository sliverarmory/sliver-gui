// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { JobSummary } from "../../../shared/contracts";
import { nonBlankJobDomains, normalizedJobProtocol } from "./operations-job";

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 1,
    name: "job",
    description: "",
    protocol: "",
    port: 18_080,
    domains: [],
    profileName: "",
    ...overrides,
  };
}

describe("operations job presentation", () => {
  it.each(["http", "https"])(
    "uses a real Sliver %s job name instead of its generic TCP transport",
    (name) => {
      expect(normalizedJobProtocol(job({ name, protocol: "tcp" }))).toBe(name);
    },
  );

  it("preserves TCP staging jobs", () => {
    expect(
      normalizedJobProtocol(
        job({
          name: "TCP",
          description: "Raw TCP listener (stager only)",
          protocol: "tcp",
          profileName: "macos-stage",
        }),
      ),
    ).toBe("stage");
    expect(normalizedJobProtocol(job({ protocol: "stage-listener" }))).toBe("stage");
  });

  it("normalizes WireGuard names before generic transport values", () => {
    expect(normalizedJobProtocol(job({ name: "wg", protocol: "udp" }))).toBe("wireguard");
  });

  it("removes Sliver's blank HTTP domain placeholder", () => {
    expect(nonBlankJobDomains(job({ domains: ["", "  "] }))).toEqual([]);
    expect(nonBlankJobDomains(job({ domains: [" c2.example.test ", ""] }))).toEqual([
      "c2.example.test",
    ]);
  });
});
