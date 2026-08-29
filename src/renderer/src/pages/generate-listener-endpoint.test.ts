// @vitest-environment node

import { describe, expect, it } from "vitest";

import type { JobSummary } from "../../../shared/contracts";
import {
  appendListenerEndpoint,
  listenerEndpointAlreadyAdded,
  listenerEndpointOptions,
  resolveWildcardListenerEndpoints,
} from "./generate-listener-endpoint";

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 1,
    name: "HTTP",
    description: "HTTP listener",
    protocol: "tcp",
    port: 80,
    domains: ["c2.example.test"],
    profileName: "",
    ...overrides,
  };
}

describe("running listener endpoint derivation", () => {
  it("derives DNS endpoints from every advertised domain without the listener port", () => {
    expect(
      listenerEndpointOptions([
        job({ name: "DNS", protocol: "udp", port: 53, domains: ["one.example.", "two.example"] }),
      ]).map((option) => option.endpoint),
    ).toEqual(["dns://one.example", "dns://two.example"]);
  });

  it("omits HTTP defaults and retains custom listener ports", () => {
    expect(
      listenerEndpointOptions([
        job({ id: 1, name: "HTTP", port: 80 }),
        job({ id: 2, name: "HTTPS", port: 443 }),
        job({ id: 3, name: "HTTPS", port: 8443 }),
      ]).map((option) => option.endpoint),
    ).toEqual([
      "http://c2.example.test",
      "https://c2.example.test",
      "https://c2.example.test:8443",
    ]);
  });

  it("uses a concrete mTLS bind host from Sliver job metadata", () => {
    expect(
      listenerEndpointOptions([
        job({
          name: "mTLS",
          description: "mutual tls listener 10.10.10.4:8888",
          domains: [],
          port: 8888,
        }),
        job({
          id: 2,
          name: "mTLS",
          description: "mutual tls listener [2001:db8::4]:9443",
          domains: [],
          port: 9443,
        }),
      ]).map((option) => option.endpoint),
    ).toEqual(["mtls://10.10.10.4:8888", "mtls://[2001:db8::4]:9443"]);
  });

  it("keeps wildcard listeners selectable, underspecified listeners visible, and excludes stage jobs", () => {
    const options = listenerEndpointOptions([
      job({ id: 1, name: "mTLS", description: "mutual tls listener 0.0.0.0:8888", domains: [], port: 8888 }),
      job({ id: 2, name: "WG", protocol: "udp", domains: [], port: 53 }),
      job({ id: 3, name: "TCP", protocol: "tcp", profileName: "stage", domains: [], port: 8080 }),
      job({ id: 4, name: "mystery", protocol: "tcp", domains: [], port: 9999 }),
    ]);

    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({
      protocol: "mtls",
      wildcardBinding: { family: "IPv4", port: 8888 },
    });
    expect(options[0]?.endpoint).toBeUndefined();
    expect(options[0]?.unavailableReason).toBeUndefined();
    expect(options[1]).toMatchObject({ protocol: "wireguard" });
    expect(options[1]?.endpoint).toBeUndefined();
    expect(options[1]?.unavailableReason).toMatch(/auxiliary ports/i);
  });

  it("treats an asterisk mTLS bind as an IPv4 wildcard", () => {
    expect(listenerEndpointOptions([
      job({ name: "mTLS", description: "mutual tls listener *:8888", domains: [], port: 8888 }),
    ])).toMatchObject([{
      protocol: "mtls",
      wildcardBinding: { family: "IPv4", port: 8888 },
    }]);
  });

  it("resolves local wildcard listeners in global, private, then localhost order", () => {
    const [wildcard] = listenerEndpointOptions([
      job({ name: "mTLS", description: "mutual tls listener 0.0.0.0:8888", domains: [], port: 8888 }),
    ]);
    if (!wildcard) throw new Error("Expected wildcard listener option");

    const resolution = resolveWildcardListenerEndpoints(wildcard, {
      hostname: "sliver-host",
      addresses: [
        { name: "lo0", address: "127.0.0.1", family: "IPv4", scope: "loopback" },
        { name: "en0", address: "192.168.50.10", family: "IPv4", scope: "private" },
        { name: "en1", address: "8.8.8.8", family: "IPv4", scope: "global" },
        { name: "en2", address: "2001:4860:4860::8888", family: "IPv6", scope: "global" },
      ],
    }, "localhost:53137");

    expect(resolution.unavailableReason).toBeUndefined();
    expect(resolution.options.map(({ endpoint, scope }) => `${scope}:${endpoint}`)).toEqual([
      "global:mtls://8.8.8.8:8888",
      "private:mtls://192.168.50.10:8888",
      "loopback:mtls://127.0.0.1:8888",
    ]);
  });

  it("matches IPv6 wildcard families, brackets endpoints, and rejects operator interfaces for remote servers", () => {
    const [wildcard] = listenerEndpointOptions([
      job({ name: "mTLS", description: "mutual tls listener [::]:9443", domains: [], port: 9443 }),
    ]);
    if (!wildcard) throw new Error("Expected wildcard listener option");
    const inventory = {
      hostname: "operator-host",
      addresses: [
        { name: "en0", address: "10.10.10.10", family: "IPv4" as const, scope: "private" as const },
        { name: "en0", address: "2001:4860:4860::8888", family: "IPv6" as const, scope: "global" as const },
        { name: "lo0", address: "::1", family: "IPv6" as const, scope: "loopback" as const },
      ],
    };

    expect(resolveWildcardListenerEndpoints(wildcard, inventory, "operator-host:53137").options)
      .toMatchObject([
        { endpoint: "mtls://[2001:4860:4860::8888]:9443", family: "IPv6" },
        { endpoint: "mtls://[::1]:9443", family: "IPv6" },
      ]);
    expect(resolveWildcardListenerEndpoints(wildcard, inventory, "remote.example:53137"))
      .toMatchObject({ options: [], unavailableReason: expect.stringMatching(/remote.*does not expose/i) });
  });

  it("does not produce endpoints from invalid ports or malformed domains", () => {
    const options = listenerEndpointOptions([
      job({ id: 1, name: "HTTPS", domains: ["https://not-a-domain.test"], port: 443 }),
      job({ id: 2, name: "HTTP", port: 70_000 }),
    ]);

    expect(options).toHaveLength(2);
    expect(options.every((option) => option.endpoint === undefined)).toBe(true);
  });

  it("rejects wildcard domains instead of adding unroutable callback URLs", () => {
    const options = listenerEndpointOptions([
      job({ id: 1, name: "DNS", domains: ["*.example.test"], port: 53 }),
      job({ id: 2, name: "HTTPS", domains: ["api.*.example.test"], port: 443 }),
    ]);

    expect(options).toHaveLength(2);
    expect(options.every((option) => option.endpoint === undefined)).toBe(true);
    expect(options.every((option) => option.unavailableReason?.includes("usable callback domain")))
      .toBe(true);
  });
});

describe("listener endpoint insertion", () => {
  it("preserves current content and appends a selected endpoint on a new line", () => {
    expect(
      appendListenerEndpoint("mtls://existing.example:8888", "https://new.example", "linux"),
    ).toEqual({
      value: "mtls://existing.example:8888\nhttps://new.example",
      added: true,
    });
  });

  it("canonically deduplicates endpoints while tolerating unrelated invalid input", () => {
    expect(
      listenerEndpointAlreadyAdded(
        "ftp://invalid.example\nhttps://new.example:443",
        "https://new.example",
        "linux",
      ),
    ).toBe(true);
    expect(
      appendListenerEndpoint(
        "ftp://invalid.example\nhttps://new.example:443",
        "https://new.example",
        "linux",
      ),
    ).toEqual({
      value: "ftp://invalid.example\nhttps://new.example:443",
      added: false,
    });
  });

  it("recognizes Sliver's implicit default mTLS port", () => {
    expect(listenerEndpointAlreadyAdded("c2.example", "mtls://c2.example:8888", "linux")).toBe(true);
  });
});
