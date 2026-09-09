import { describe, expect, it } from "vitest";

import {
  NETWORK_FORWARDING_DEFAULTS,
  parseListNetworkForwardsInput,
  parsePortForwardId,
  parseSocks5ProxyId,
  parseStartPortForwardInput,
  parseStartReversePortForwardInput,
  parseStartSocks5ProxyInput,
  parseStopReversePortForwardInput,
} from "./network-forwarding-contracts.js";

const session = Object.freeze({
  mode: "session" as const,
  id: "session-1",
  backendEpoch: 3,
  domainRevision: 7,
  fingerprint: "a".repeat(64),
});

const portForwardInput = () => ({
  session,
  bind: { host: "127.0.0.1", port: 0 },
  destination: { host: "10.0.0.9", port: 443 },
  keepAliveSeconds: NETWORK_FORWARDING_DEFAULTS.keepAliveSeconds,
  connectTimeoutSeconds: NETWORK_FORWARDING_DEFAULTS.connectTimeoutSeconds,
  closeTimeoutSeconds: NETWORK_FORWARDING_DEFAULTS.closeTimeoutSeconds,
  maxConnections: NETWORK_FORWARDING_DEFAULTS.portForwardConnections,
  maxBufferedBytesPerConnection: NETWORK_FORWARDING_DEFAULTS.portForwardBufferBytes,
});

describe("Network forwarding contracts", () => {
  it("accepts automatic local ports, bracketed IPv6, and disabled keepalive", () => {
    const parsed = parseStartPortForwardInput({
      ...portForwardInput(),
      bind: { host: "[::1]", port: 0 },
      destination: { host: "2001:db8::7", port: 65_535 },
      keepAliveSeconds: -1,
    });
    expect(parsed.bind).toEqual({ host: "::1", port: 0 });
    expect(parsed.destination).toEqual({ host: "2001:db8::7", port: 65_535 });
    expect(parsed.keepAliveSeconds).toBe(-1);
  });

  it("rejects invalid destination ports and fractional numeric fields", () => {
    expect(() => parseStartPortForwardInput({
      ...portForwardInput(),
      destination: { host: "localhost", port: 0 },
    })).toThrow(/destination port/iu);
    expect(() => parseStartPortForwardInput({
      ...portForwardInput(),
      bind: { host: "localhost", port: 65_536 },
    })).toThrow(/bind port/iu);
    expect(() => parseStartPortForwardInput({
      ...portForwardInput(),
      maxConnections: 1.5,
    })).toThrow(/connection limit/iu);
  });

  it("enforces the aggregate port-forward buffer ceiling", () => {
    expect(() => parseStartPortForwardInput({
      ...portForwardInput(),
      maxConnections: 64,
      maxBufferedBytesPerConnection: 1024 * 1024,
    })).toThrow(/aggregate buffer/iu);
    expect(parseStartPortForwardInput({
      ...portForwardInput(),
      maxConnections: 64,
      maxBufferedBytesPerConnection: 512 * 1024,
    }).maxConnections).toBe(64);
  });

  it("requires nonzero implant and destination ports for reverse forwarding", () => {
    const valid = {
      session,
      bind: { host: "0.0.0.0", port: 8080 },
      destination: { host: "127.0.0.1", port: 9000 },
      keepAliveSeconds: 30,
    };
    expect(parseStartReversePortForwardInput(valid)).toMatchObject(valid);
    expect(() => parseStartReversePortForwardInput({
      ...valid,
      bind: { host: "0.0.0.0", port: 0 },
    })).toThrow(/bind port/iu);
  });

  it("measures SOCKS credentials in UTF-8 bytes and rejects unknown keys", () => {
    const base = {
      session,
      bind: { host: "127.0.0.1", port: 0 },
      connectTimeoutSeconds: 30,
      closeTimeoutSeconds: 5,
      maxConnections: 256,
      maxBufferedBytesPerConnection: 8 * 1024 * 1024,
    };
    expect(parseStartSocks5ProxyInput({
      ...base,
      authentication: { username: `${"é".repeat(127)}a`, password: "secret" },
    }).authentication?.username).toHaveLength(128);
    expect(() => parseStartSocks5ProxyInput({
      ...base,
      authentication: { username: "é".repeat(128), password: "secret" },
    })).toThrow(/255 UTF-8 bytes/iu);
    expect(() => parseStartSocks5ProxyInput({ ...base, rawRpc: "forbidden" })).toThrow(/invalid SOCKS5 proxy input/iu);
  });

  it("accepts only main-issued session references", () => {
    expect(parseListNetworkForwardsInput({ reverseTargets: [session] })).toEqual({ reverseTargets: [session] });
    expect(() => parseListNetworkForwardsInput({
      reverseTargets: [{ ...session, mode: "beacon" }],
    })).toThrow(/session reference/iu);
    expect(() => parseListNetworkForwardsInput({
      reverseTargets: [{ ...session, fingerprint: "a".repeat(63) }],
    })).toThrow(/session reference/iu);
    expect(() => parseListNetworkForwardsInput({ reverseTargets: [session, session] }))
      .toThrow(/must be unique/iu);
  });

  it("binds reverse-stop confirmation to complete listener identity", () => {
    const parsed = parseStopReversePortForwardInput({
      session,
      listenerId: 42,
      expectedBind: null,
      expectedDestination: null,
    });
    expect(parsed.listenerId).toBe(42);
    expect(() => parseStopReversePortForwardInput({
      session,
      listenerId: 42,
      expectedBind: { host: "0.0.0.0", port: 8080 },
      expectedDestination: null,
    })).toThrow(/identity metadata/iu);
  });

  it("accepts only the rc4 handle identifier shapes", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    expect(parsePortForwardId(uuid)).toBe(uuid);
    expect(parseSocks5ProxyId(`socks5-${uuid}`)).toBe(`socks5-${uuid}`);
    expect(() => parsePortForwardId(`socks5-${uuid}`)).toThrow(/port forward ID/iu);
    expect(() => parseSocks5ProxyId(uuid)).toThrow(/SOCKS5 proxy ID/iu);
  });
});
