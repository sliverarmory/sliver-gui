const NETWORK_SCHEMES = new Set(["tcp", "udp", "mtls", "http", "https", "dns", "wg", "wireguard", "tcppivot"]);

function validPort(port: string | undefined): boolean {
  return port === undefined || (/^[0-9]{1,5}$/u.test(port) && Number(port) <= 65_535);
}

function ipv4Address(host: string): string | undefined {
  const octets = host.split(".");
  // Do not reinterpret abbreviated, hexadecimal, or octal-looking hosts as IPs.
  return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9][0-9]{0,2})$/u.test(octet) && Number(octet) <= 255)
    ? octets.join(".") : undefined;
}

function ipv6Address(host: string): string | undefined {
  if (!host.includes(":") || !/^[0-9a-f:.]+$/iu.test(host)) return undefined;
  try {
    // The browser URL parser validates IPv6 and produces one compressed form.
    const normalized = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalized);
    if (!mapped) return normalized;
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
  } catch {
    return undefined;
  }
}

/** Extract a reported IP for visual grouping without resolving names or inferring routes. */
export function egressIpAddress(remoteAddress: string): string | undefined {
  let authority = remoteAddress.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(authority);
  if (scheme) {
    if (!NETWORK_SCHEMES.has(scheme[1]!.toLowerCase())) return undefined;
    authority = authority.slice(scheme[0].length);
  }
  // Main supplies authority-only endpoints. Reject extra URL data rather than
  // accepting a different interpretation or using credentials as a group key.
  if (!authority || /[\s\\/@?#]/u.test(authority)) return undefined;
  if (authority.startsWith("[")) {
    const bracketed = /^\[([^\]]+)\](?::([^:]*))?$/u.exec(authority);
    return bracketed && validPort(bracketed[2]) ? ipv6Address(bracketed[1]!) : undefined;
  }
  const colonCount = authority.split(":").length - 1;
  if (colonCount > 1) return scheme ? undefined : ipv6Address(authority);
  if (colonCount === 1) {
    const [host, port] = authority.split(":");
    return validPort(port) ? ipv4Address(host!) : undefined;
  }
  return ipv4Address(authority);
}
