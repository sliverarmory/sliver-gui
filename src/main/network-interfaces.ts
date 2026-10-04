import { isIP } from "node:net";
import {
  hostname as nodeHostname,
  networkInterfaces as nodeNetworkInterfaces,
} from "node:os";

import type {
  LocalNetworkInterfaceAddress,
  LocalNetworkInterfaceInventory,
  NetworkInterfaceAddressScope,
} from "../shared/contracts.js";

type NetworkInterfaceSource = ReturnType<typeof nodeNetworkInterfaces>;

const MAX_INTERFACE_ADDRESSES = 256;
const MAX_INTERFACE_NAME_LENGTH = 128;
const MAX_HOSTNAME_LENGTH = 255;

const scopeRank: Record<NetworkInterfaceAddressScope, number> = {
  global: 0,
  private: 1,
  loopback: 2,
};

export function localNetworkInterfaceInventory(
  source: NetworkInterfaceSource = nodeNetworkInterfaces(),
  machineHostname: string = nodeHostname(),
): LocalNetworkInterfaceInventory {
  const addresses: LocalNetworkInterfaceAddress[] = [];
  const seen = new Set<string>();

  for (const [rawName, entries] of Object.entries(source).sort(([left], [right]) =>
    left.localeCompare(right, undefined, { numeric: true }),
  )) {
    const name = rawName.trim().slice(0, MAX_INTERFACE_NAME_LENGTH);
    if (!name || !entries) continue;

    for (const entry of entries) {
      const address = entry.address.trim().toLowerCase();
      const family = normalizedFamily(address, entry.family);
      if (!family) continue;
      const scope = addressScope(address, family);
      if (!scope) continue;

      const identity = `${family}:${address}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      addresses.push({ name, address, family, scope });
      if (addresses.length >= MAX_INTERFACE_ADDRESSES) break;
    }
    if (addresses.length >= MAX_INTERFACE_ADDRESSES) break;
  }

  addresses.sort((left, right) =>
    scopeRank[left.scope] - scopeRank[right.scope] ||
    left.name.localeCompare(right.name, undefined, { numeric: true }) ||
    familyRank(left.family) - familyRank(right.family) ||
    left.address.localeCompare(right.address, undefined, { numeric: true }),
  );

  return {
    hostname: machineHostname.trim().slice(0, MAX_HOSTNAME_LENGTH),
    addresses,
  };
}

export function connectionServerIsLocal(
  connectionServer: string | undefined,
  inventory: LocalNetworkInterfaceInventory,
): boolean {
  const host = connectionHost(connectionServer);
  if (!host) return false;
  if (host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host)) return true;
  if (inventory.hostname && host === inventory.hostname.toLowerCase().replace(/\.+$/u, "")) return true;
  return inventory.addresses.some(({ address }) => address.toLowerCase() === host);
}

function normalizedFamily(
  address: string,
  reportedFamily: string | number,
): LocalNetworkInterfaceAddress["family"] | undefined {
  const parsedFamily = isIP(address);
  if (parsedFamily === 4 && (reportedFamily === "IPv4" || reportedFamily === 4)) return "IPv4";
  if (parsedFamily === 6 && (reportedFamily === "IPv6" || reportedFamily === 6)) return "IPv6";
  return undefined;
}

function addressScope(
  address: string,
  family: LocalNetworkInterfaceAddress["family"],
): NetworkInterfaceAddressScope | undefined {
  return family === "IPv4" ? ipv4Scope(address) : ipv6Scope(address);
}

function ipv4Scope(address: string): NetworkInterfaceAddressScope | undefined {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return undefined;
  }
  const [first = 0, second = 0, third = 0] = octets;

  if (first === 127) return "loopback";
  if (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  ) return "private";

  if (
    first === 0 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  ) return undefined;

  return "global";
}

function ipv6Scope(address: string): NetworkInterfaceAddressScope | undefined {
  if (address === "::1") return "loopback";
  if (address === "::") return undefined;
  if (/^f[cd][0-9a-f]{2}:/u.test(address)) return "private";
  if (/^fe[89ab][0-9a-f]:/u.test(address) || address.startsWith("ff")) return undefined;
  if (address.startsWith("2001:db8:")) return undefined;
  return /^[23][0-9a-f]{3}:/u.test(address) ? "global" : undefined;
}

function familyRank(family: LocalNetworkInterfaceAddress["family"]): number {
  return family === "IPv4" ? 0 : 1;
}

function connectionHost(connectionServer: string | undefined): string | undefined {
  const value = connectionServer?.trim();
  if (!value) return undefined;
  try {
    const parsed = new URL(value.includes("://") ? value : `tcp://${value}`);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/gu, "").replace(/\.+$/u, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}
