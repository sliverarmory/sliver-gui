export type FirewallIpv4Accent = "danger" | "success" | null;

interface ParsedIpv4Cidr {
  readonly address: number;
  readonly prefix: number;
}

const IPV4_ADDRESS_PATTERN = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/u;
const IPV4_CIDR_PATTERN = /^(.+)\/(0|[1-9]|[12]\d|3[0-2])$/u;
export function ipv4CidrContainsAddress(cidr: string, address: string): boolean {
  const parsedCidr = parseIpv4Cidr(cidr);
  const parsedAddress = parseIpv4Address(address);
  if (!parsedCidr || parsedAddress === null) return false;

  const mask = parsedCidr.prefix === 0
    ? 0
    : (0xffff_ffff << (32 - parsedCidr.prefix)) >>> 0;
  return ((parsedCidr.address & mask) >>> 0) === ((parsedAddress & mask) >>> 0);
}

export function ipv4RangeContainsAddress(range: string, address: string): boolean {
  const parsedAddress = parseIpv4Address(address);
  if (parsedAddress === null) return false;
  const exactAddress = parseIpv4Address(range);
  return exactAddress === null
    ? ipv4CidrContainsAddress(range, address)
    : exactAddress === parsedAddress;
}

export function isAnyIpv4Cidr(cidr: string): boolean {
  return parseIpv4Cidr(cidr)?.prefix === 0;
}

export function firewallIpv4Accent(
  cidrs: readonly string[],
  currentAddress: string | null,
): FirewallIpv4Accent {
  if (cidrs.some(isAnyIpv4Cidr)) return "danger";
  if (currentAddress !== null && cidrs.some((cidr) => ipv4RangeContainsAddress(cidr, currentAddress))) {
    return "success";
  }
  return null;
}

function parseIpv4Cidr(value: string): ParsedIpv4Cidr | null {
  const match = IPV4_CIDR_PATTERN.exec(value);
  if (!match) return null;
  const address = parseIpv4Address(match[1] ?? "");
  if (address === null) return null;
  return { address, prefix: Number(match[2]) };
}

function parseIpv4Address(value: string): number | null {
  const match = IPV4_ADDRESS_PATTERN.exec(value);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets.reduce(
    (result, octet) => ((result << 8) | octet) >>> 0,
    0,
  );
}
