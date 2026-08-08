// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  LISTENER_PROTOCOLS,
  LISTENER_PROTOCOL_BY_KIND,
  createListenerDraft,
  isListenerKind,
  isStageCompression,
  listenerInputFromDraft,
  validateListenerDraft,
  type ListenerDraft,
  type ListenerKind,
} from "./operations-listener";

const DEFAULT_PORTS: Record<ListenerKind, number> = {
  dns: 53,
  http: 80,
  https: 443,
  mtls: 8888,
  stage: 8443,
  wireguard: 53,
};

function validDraft(kind: ListenerKind): ListenerDraft {
  const draft = createListenerDraft(kind, "stage-profile");
  if (kind === "dns") draft.domains = "c2.example.test";
  return draft;
}

describe("listener draft defaults", () => {
  it.each(Object.entries(DEFAULT_PORTS) as Array<[ListenerKind, number]>)
  ("uses the Sliver default port for %s", (kind, port) => {
    expect(createListenerDraft(kind)).toMatchObject({ kind, port });
  });

  it("enables OTP and JARM randomization for HTTPS without enabling ACME", () => {
    expect(createListenerDraft("https")).toMatchObject({
      acme: false,
      enforceOtp: true,
      port: 443,
      randomizeJarm: true,
    });

    expect(createListenerDraft("http")).toMatchObject({
      enforceOtp: true,
      randomizeJarm: false,
    });
  });

  it("returns independent state for each new draft", () => {
    const first = createListenerDraft("mtls");
    first.host = "127.0.0.1";

    expect(createListenerDraft("mtls").host).toBe("0.0.0.0");
  });
});

describe("listener input mapping", () => {
  it("exposes every supported listener protocol exactly once", () => {
    expect(LISTENER_PROTOCOLS.map(({ id }) => id)).toEqual([
      "mtls",
      "wireguard",
      "dns",
      "http",
      "https",
      "stage",
    ]);
    expect(new Set(LISTENER_PROTOCOLS.map(({ id }) => id)).size).toBe(LISTENER_PROTOCOLS.length);
    for (const protocol of LISTENER_PROTOCOLS) {
      expect(LISTENER_PROTOCOL_BY_KIND[protocol.id]).toBe(protocol);
    }
  });

  it("rejects values outside the first-party listener and compression option sets", () => {
    expect(isListenerKind("https")).toBe(true);
    expect(isListenerKind("smtp")).toBe(false);
    expect(isListenerKind(["https"])).toBe(false);
    expect(isListenerKind(null)).toBe(false);

    expect(isStageCompression("gzip")).toBe(true);
    expect(isStageCompression("brotli")).toBe(false);
    expect(isStageCompression(["gzip"])).toBe(false);
    expect(isStageCompression(undefined)).toBe(false);
  });

  it("maps mTLS and WireGuard fields to their typed bridge inputs", () => {
    expect(listenerInputFromDraft({
      ...validDraft("mtls"),
      host: " 127.0.0.1 ",
      port: 9443,
    })).toEqual({ kind: "mtls", host: "127.0.0.1", port: 9443 });

    expect(listenerInputFromDraft({
      ...validDraft("wireguard"),
      host: " 0.0.0.0 ",
      port: 51820,
      tunnelIp: " 100.64.0.8 ",
      tcpCommsPort: 8889,
      keyExchangePort: 1338,
    })).toEqual({
      kind: "wireguard",
      host: "0.0.0.0",
      port: 51820,
      tunnelIp: "100.64.0.8",
      tcpCommsPort: 8889,
      keyExchangePort: 1338,
    });
  });

  it("normalizes DNS lists and strips HTTPS-only settings from HTTP", () => {
    expect(listenerInputFromDraft({
      ...validDraft("dns"),
      domains: " alpha.example.test., beta.example.test\n gamma.example.test ",
      canaries: false,
      enforceOtp: true,
    })).toEqual({
      kind: "dns",
      host: "0.0.0.0",
      port: 53,
      domains: "alpha.example.test., beta.example.test, gamma.example.test",
      canaries: false,
      enforceOtp: true,
    });

    expect(listenerInputFromDraft({
      ...validDraft("http"),
      domain: " c2.example.test. ",
      website: " landing ",
      acme: true,
      randomizeJarm: true,
      certificateToken: "not-for-http",
    })).toEqual({
      kind: "http",
      host: "0.0.0.0",
      port: 80,
      domain: "c2.example.test",
      website: "landing",
      enforceOtp: true,
      longPollTimeoutSeconds: 1,
      longPollJitterSeconds: 2,
      acme: false,
      randomizeJarm: false,
      certificateToken: "",
    });
  });

  it("maps HTTPS certificate controls and TCP stage transforms", () => {
    expect(listenerInputFromDraft({
      ...validDraft("https"),
      domain: " secure.example.test. ",
      website: " decoy ",
      enforceOtp: false,
      longPollTimeoutSeconds: 5,
      longPollJitterSeconds: 3,
      acme: false,
      randomizeJarm: true,
      certificateToken: "certificate-token",
    })).toEqual({
      kind: "https",
      host: "0.0.0.0",
      port: 443,
      domain: "secure.example.test",
      website: "decoy",
      enforceOtp: false,
      longPollTimeoutSeconds: 5,
      longPollJitterSeconds: 3,
      acme: false,
      randomizeJarm: true,
      certificateToken: "certificate-token",
    });

    expect(listenerInputFromDraft({
      ...validDraft("stage"),
      profileName: " profile-one ",
      compression: "gzip",
      aesKey: "0123456789abcdef",
      aesIv: "fedcba9876543210",
    })).toEqual({
      kind: "stage",
      host: "0.0.0.0",
      port: 8443,
      profileName: "profile-one",
      compression: "gzip",
      aesKey: "0123456789abcdef",
      aesIv: "fedcba9876543210",
      rc4Key: "",
    });
  });
});

describe("listener validation", () => {
  it("accepts port boundaries and rejects out-of-range or fractional ports", () => {
    for (const port of [1, 65_534]) {
      expect(validateListenerDraft({ ...validDraft("mtls"), port }).port).toBeUndefined();
    }

    for (const port of [0, 65_535, 1.5, Number.NaN]) {
      expect(validateListenerDraft({ ...validDraft("mtls"), port }).port).toMatch(/1 to 65534/);
    }
  });

  it("applies the same boundaries and collision check to WireGuard auxiliary ports", () => {
    expect(validateListenerDraft({
      ...validDraft("wireguard"),
      tcpCommsPort: 1,
      keyExchangePort: 65_534,
    })).toEqual({});

    expect(validateListenerDraft({
      ...validDraft("wireguard"),
      tcpCommsPort: 0,
      keyExchangePort: 65_535,
    })).toMatchObject({
      tcpCommsPort: expect.stringMatching(/1 to 65534/),
      keyExchangePort: expect.stringMatching(/1 to 65534/),
    });

    expect(validateListenerDraft({
      ...validDraft("wireguard"),
      tcpCommsPort: 8888,
      keyExchangePort: 8888,
    }).keyExchangePort).toMatch(/different ports/);
  });

  it("requires valid authoritative DNS names and accepts common separators", () => {
    expect(validateListenerDraft({ ...validDraft("dns"), domains: "" }).domains).toMatch(
      /at least one/i,
    );
    expect(validateListenerDraft({
      ...validDraft("dns"),
      domains: "alpha.example.test., beta.example.test\nthird.example.test",
    }).domains).toBeUndefined();
    expect(validateListenerDraft({
      ...validDraft("dns"),
      domains: "-invalid.example.test",
    }).domains).toMatch(/comma-separated DNS names/);
  });

  it("validates stage profiles and mutually exclusive encryption", () => {
    expect(validateListenerDraft({ ...validDraft("stage"), profileName: "" }).profileName).toMatch(
      /implant profile/,
    );
    expect(validateListenerDraft({
      ...validDraft("stage"),
      aesKey: "0123456789abcdef",
      rc4Key: "rc4-key",
    }).form).toMatch(/cannot be enabled together/);
    expect(validateListenerDraft({
      ...validDraft("stage"),
      aesIv: "fedcba9876543210",
    }).aesIv).toMatch(/requires an AES key/);
  });

  it("measures AES and RC4 limits in UTF-8 bytes", () => {
    expect(validateListenerDraft({
      ...validDraft("stage"),
      aesKey: "é".repeat(8),
      aesIv: "é".repeat(8),
    })).toEqual({});
    expect(validateListenerDraft({
      ...validDraft("stage"),
      aesKey: "x".repeat(15),
    }).aesKey).toMatch(/16 or 32 UTF-8 bytes/);
    expect(validateListenerDraft({
      ...validDraft("stage"),
      aesKey: "x".repeat(32),
    }).aesKey).toBeUndefined();
    expect(validateListenerDraft({
      ...validDraft("stage"),
      rc4Key: "x".repeat(256),
    }).rc4Key).toBeUndefined();
    expect(validateListenerDraft({
      ...validDraft("stage"),
      rc4Key: "x".repeat(257),
    }).rc4Key).toMatch(/between 1 and 256 UTF-8 bytes/);
  });
});
