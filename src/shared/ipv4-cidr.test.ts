import { describe, expect, it } from "vitest";

import {
  firewallIpv4Accent,
  ipv4CidrContainsAddress,
  ipv4RangeContainsAddress,
  isAnyIpv4Cidr,
} from "./ipv4-cidr.js";

describe("IPv4 CIDR containment", () => {
  it.each([
    ["0.0.0.0/0", "203.0.113.42"],
    ["0.0.0.0/1", "127.255.255.255"],
    ["128.0.0.0/1", "128.0.0.0"],
    ["128.0.0.0/1", "255.255.255.255"],
    ["203.0.113.0/24", "203.0.113.0"],
    ["203.0.113.0/24", "203.0.113.255"],
    ["203.0.113.42/32", "203.0.113.42"],
  ])("recognizes %s as containing %s", (cidr, address) => {
    expect(ipv4CidrContainsAddress(cidr, address)).toBe(true);
  });

  it.each([
    ["0.0.0.0/1", "128.0.0.0"],
    ["128.0.0.0/1", "127.255.255.255"],
    ["203.0.113.0/24", "203.0.114.0"],
    ["203.0.113.42/32", "203.0.113.43"],
  ])("recognizes %s as excluding %s", (cidr, address) => {
    expect(ipv4CidrContainsAddress(cidr, address)).toBe(false);
  });

  it("masks host bits in the CIDR address before comparing", () => {
    expect(ipv4CidrContainsAddress("203.0.113.99/24", "203.0.113.1")).toBe(true);
    expect(ipv4CidrContainsAddress("203.0.113.99/24", "203.0.114.1")).toBe(false);
  });

  it.each([
    "203.0.113.0",
    " 203.0.113.0/24",
    "203.0.113.0/24 ",
    "203.0.113.0/024",
    "203.0.113.0/00",
    "203.0.113.0/33",
    "203.0.113.0/-1",
    "203.0.113/24",
    "203.0.113.256/24",
    "203.0.113.01/24",
    "2001:db8::/32",
    "::/0",
    "Internet",
    "*",
    "pl-0123456789abcdef0",
    "sg-0123456789abcdef0",
  ])("rejects invalid or non-IPv4 CIDR %j", (cidr) => {
    expect(ipv4CidrContainsAddress(cidr, "203.0.113.42")).toBe(false);
  });

  it.each([
    "203.0.113",
    "203.0.113.256",
    "203.0.113.042",
    " 203.0.113.42",
    "203.0.113.42 ",
    "203.0.113.42/32",
    "2001:db8::1",
  ])("rejects invalid or non-IPv4 address %j", (address) => {
    expect(ipv4CidrContainsAddress("0.0.0.0/0", address)).toBe(false);
  });
});

describe("IPv4 firewall range values", () => {
  it("accepts an exact bare IPv4 address as a single-address range", () => {
    expect(ipv4RangeContainsAddress("203.0.113.42", "203.0.113.42")).toBe(true);
    expect(ipv4RangeContainsAddress("203.0.113.42", "203.0.113.43")).toBe(false);
  });

  it("recognizes every valid IPv4 /0 spelling as the all-address range", () => {
    expect(isAnyIpv4Cidr("0.0.0.0/0")).toBe(true);
    expect(isAnyIpv4Cidr("203.0.113.42/0")).toBe(true);
    expect(isAnyIpv4Cidr("0.0.0.0/1")).toBe(false);
    expect(isAnyIpv4Cidr("::/0")).toBe(false);
  });
});

describe("firewall IPv4 accents", () => {
  it("gives an exact public IPv4 CIDR danger precedence over matching success ranges", () => {
    expect(firewallIpv4Accent(
      ["203.0.113.0/24", "0.0.0.0/0", "203.0.113.42/32"],
      "203.0.113.42",
    )).toBe("danger");
  });

  it("marks an exact public IPv4 CIDR as danger even without a current address", () => {
    expect(firewallIpv4Accent(["0.0.0.0/0"], null)).toBe("danger");
  });

  it("gives a noncanonical IPv4 /0 danger precedence too", () => {
    expect(firewallIpv4Accent(["203.0.113.42/0"], "203.0.113.42")).toBe("danger");
  });

  it.each([
    [["203.0.113.42/32"], "203.0.113.42"],
    [["198.51.100.0/24", "203.0.113.0/24"], "203.0.113.42"],
    [["203.0.113.99/24"], "203.0.113.42"],
    [["203.0.113.42"], "203.0.113.42"],
  ] as const)("returns success when %j contains %s", (cidrs, address) => {
    expect(firewallIpv4Accent(cidrs, address)).toBe("success");
  });

  it.each([
    [[], "203.0.113.42"],
    [["198.51.100.0/24"], "203.0.113.42"],
    [["203.0.113.0/24"], null],
    [["::/0", "Internet", "*"], "203.0.113.42"],
    [["00.0.0.0/0"], "203.0.113.42"],
  ] as const)("returns no accent for CIDRs %j and current address %j", (cidrs, address) => {
    expect(firewallIpv4Accent(cidrs, address)).toBeNull();
  });
});
