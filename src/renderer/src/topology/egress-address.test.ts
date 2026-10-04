import { describe, expect, it } from "vitest";

import { egressIpAddress } from "./egress-address";

describe("reported egress IP addresses", () => {
  it.each([
    "192.0.2.10", "192.0.2.10:4444", "192.0.2.10:65535", "192.0.2.10:0",
    "tcp://192.0.2.10:4444", "MTLS://192.0.2.10:8888", "https://192.0.2.10:443",
    "udp://192.0.2.10:53", "wg://192.0.2.10:51820", "  192.0.2.10:49152  ",
  ])("groups the same IPv4 address independently of scheme and port: %s", (address) => {
    expect(egressIpAddress(address)).toBe("192.0.2.10");
  });

  it.each([
    "2001:db8::a", "2001:0DB8:0:0:0:0:0:000A", "[2001:db8::a]",
    "[2001:DB8::a]:4444", "tcp://[2001:0db8::000a]:443",
  ])("canonicalizes equivalent IPv6 addresses: %s", (address) => {
    expect(egressIpAddress(address)).toBe("2001:db8::a");
  });

  it.each([
    "::ffff:192.0.2.10", "::FFFF:c000:20a", "[::ffff:192.0.2.10]:4444",
    "tcp://[0:0:0:0:0:ffff:c000:020a]:443",
  ])("groups IPv4-mapped IPv6 with the corresponding IPv4 address: %s", (address) => {
    expect(egressIpAddress(address)).toBe("192.0.2.10");
  });

  it("keeps distinct IPs separate without guessing an unbracketed IPv6 port", () => {
    expect(egressIpAddress("192.0.2.11:4444")).toBe("192.0.2.11");
    expect(egressIpAddress("2001:db8::a:4444")).toBe("2001:db8::a:4444");
    expect(egressIpAddress("::")).toBe("::");
    expect(egressIpAddress("::1")).toBe("::1");
  });

  it.each([
    "", " ", "[redacted endpoint]", "mtls://[redacted]", "example.test:443", "https://example.test",
    "256.0.2.10", "192.0.2", "127.1", "0xc000020a", "3221225994", "192.000.2.10",
    "192.0.2.10:", "192.0.2.10:65536", "192.0.2.10:-1", "192.0.2.10:port",
    "[192.0.2.10]:443", "[2001:db8::a]:", "[2001:db8::a]:65536", "2001:db8:::a",
    "[2001:db8::a", "[2001:db8::a]extra", "2001:db8::g", "fe80::1%eth0", "tcp://2001:db8::a",
    "tcp://user:password@192.0.2.10:443", "tcp://192.0.2.10:443/path", "https://192.0.2.10/",
    "192.0.2.10?token=value", "192.0.2.10#fragment", "192.0.2.10\\pipe", "192.0.2. 10",
    "namedpipe://192.0.2.10", "file://192.0.2.10", "\\\\192.0.2.10\\pipe\\example",
  ])("leaves unavailable, ambiguous, or non-IP endpoints ungrouped: %s", (address) => {
    expect(egressIpAddress(address)).toBeUndefined();
  });
});
