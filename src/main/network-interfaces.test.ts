// @vitest-environment node

import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";

import {
  connectionServerIsLocal,
  localNetworkInterfaceInventory,
} from "./network-interfaces.js";

function interfaceAddress(
  address: string,
  family: "IPv4" | "IPv6",
  internal = false,
): NetworkInterfaceInfo {
  const common = {
    address,
    internal,
    mac: "00:00:00:00:00:00",
    netmask: family === "IPv4" ? "255.255.255.0" : "ffff:ffff:ffff:ffff::",
    cidr: family === "IPv4" ? `${address}/24` : `${address}/64`,
  };
  return family === "IPv4"
    ? { ...common, family }
    : { ...common, family, scopeid: 0 };
}

describe("local network interface inventory", () => {
  it("orders globally routable addresses before private addresses and localhost", () => {
    const inventory = localNetworkInterfaceInventory({
      lo0: [
        interfaceAddress("::1", "IPv6", true),
        interfaceAddress("127.0.0.1", "IPv4", true),
      ],
      en1: [
        interfaceAddress("2001:4860:4860::8888", "IPv6"),
        interfaceAddress("8.8.8.8", "IPv4"),
      ],
      en0: [
        interfaceAddress("fd12:3456::10", "IPv6"),
        interfaceAddress("192.168.50.10", "IPv4"),
        interfaceAddress("10.10.10.10", "IPv4"),
      ],
    }, "sliver-host");

    expect(inventory.hostname).toBe("sliver-host");
    expect(inventory.addresses.map(({ address, scope }) => `${scope}:${address}`)).toEqual([
      "global:8.8.8.8",
      "global:2001:4860:4860::8888",
      "private:10.10.10.10",
      "private:192.168.50.10",
      "private:fd12:3456::10",
      "loopback:127.0.0.1",
      "loopback:::1",
    ]);
  });

  it("deduplicates addresses and excludes wildcard, link-local, multicast, and reserved ranges", () => {
    const inventory = localNetworkInterfaceInventory({
      en0: [
        interfaceAddress("0.0.0.0", "IPv4"),
        interfaceAddress("169.254.1.10", "IPv4"),
        interfaceAddress("192.0.2.10", "IPv4"),
        interfaceAddress("224.0.0.1", "IPv4"),
        interfaceAddress("fe80::1", "IPv6"),
        interfaceAddress("ff02::1", "IPv6"),
        interfaceAddress("2001:db8::1", "IPv6"),
        interfaceAddress("1.1.1.1", "IPv4"),
      ],
      en1: [interfaceAddress("1.1.1.1", "IPv4")],
    }, "host");

    expect(inventory.addresses).toEqual([
      { name: "en0", address: "1.1.1.1", family: "IPv4", scope: "global" },
    ]);
  });

  it("recognizes only literal local connection targets, the machine hostname, and configured addresses", () => {
    const inventory = localNetworkInterfaceInventory({
      en0: [interfaceAddress("192.168.50.10", "IPv4")],
    }, "sliver-host.local");

    expect(connectionServerIsLocal("127.0.0.1:53137", inventory)).toBe(true);
    expect(connectionServerIsLocal("[::1]:53137", inventory)).toBe(true);
    expect(connectionServerIsLocal("sliver-host.local:53137", inventory)).toBe(true);
    expect(connectionServerIsLocal("192.168.50.10:53137", inventory)).toBe(true);
    expect(connectionServerIsLocal("remote.example:53137", inventory)).toBe(false);
    expect(connectionServerIsLocal(undefined, inventory)).toBe(false);
  });
});
