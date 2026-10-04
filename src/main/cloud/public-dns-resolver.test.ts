import { describe, expect, it, vi } from "vitest";

import { publicDnsPointsToServer } from "./public-dns-resolver.js";

const domain = "c2.example.test";
const publicIp = "203.0.113.20";

function dnsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function resolvers(answers: Record<string, { a?: string[]; aaaa?: string[]; aError?: string; aaaaError?: string }>) {
  const queried = vi.fn((server: string) => ({
    resolve4: vi.fn(async () => {
      const answer = answers[server];
      if (answer?.aError) throw dnsError(answer.aError);
      return answer?.a ?? [];
    }),
    resolve6: vi.fn(async () => {
      const answer = answers[server];
      if (answer?.aaaaError) throw dnsError(answer.aaaaError);
      return answer?.aaaa ?? [];
    }),
  }));
  return queried;
}

describe("public DNS readiness", () => {
  it("accepts a public A answer despite another resolver's stale negative cache", async () => {
    const factory = resolvers({
      "1.1.1.1": { aError: "ENOTFOUND", aaaaError: "ENODATA" },
      "8.8.8.8": { a: [publicIp], aaaaError: "ENODATA" },
    });
    await expect(publicDnsPointsToServer(domain, publicIp, factory)).resolves.toBe(true);
    expect(factory.mock.calls.map(([server]) => server)).toEqual(["1.1.1.1", "8.8.8.8"]);
  });

  it("waits when public resolvers have no matching A answer", async () => {
    const factory = resolvers({
      "1.1.1.1": { aError: "ENOTFOUND", aaaaError: "ENODATA" },
      "8.8.8.8": { aError: "ENOTFOUND", aaaaError: "ENODATA" },
    });
    await expect(publicDnsPointsToServer(domain, publicIp, factory)).resolves.toBe(false);
  });

  it.each([
    { name: "A", answers: { "1.1.1.1": { a: [publicIp] }, "8.8.8.8": { a: ["198.51.100.7"] } } },
    { name: "AAAA", answers: { "1.1.1.1": { a: [publicIp] }, "8.8.8.8": { a: [publicIp], aaaa: ["2001:db8::7"] } } },
  ])("rejects a conflicting public $name answer", async ({ answers }) => {
    await expect(publicDnsPointsToServer(domain, publicIp, resolvers(answers)))
      .rejects.toThrow("must resolve only to this server's public IPv4 address");
  });

  it("requires a complete A and AAAA check from at least one resolver", async () => {
    const factory = resolvers({
      "1.1.1.1": { a: [publicIp], aaaaError: "ETIMEOUT" },
      "8.8.8.8": { aError: "ETIMEOUT", aaaaError: "ETIMEOUT" },
    });
    await expect(publicDnsPointsToServer(domain, publicIp, factory)).resolves.toBe(false);
  });
});
