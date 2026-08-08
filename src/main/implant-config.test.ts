// @vitest-environment node

import { describe, expect, it } from "vitest";
import { clientpb } from "sliver-script";

import type { GenerateInput, ShellcodeOptions } from "../shared/contracts.js";
import {
  artifactFormatFromProto,
  artifactFormatToProto,
  buildImplantConfig,
  ensureTrailingDot,
  isValidPort,
  normalizeProfileName,
  parseC2Endpoints,
  secondsToNanoseconds,
  splitList,
  validateImplantName,
} from "./implant-config.js";

type GenerateOverrides = Partial<Omit<GenerateInput, "shellcode">> & {
  shellcode?: Partial<ShellcodeOptions>;
};

function generateInput(overrides: GenerateOverrides = {}): GenerateInput {
  const shellcode: ShellcodeOptions = {
    compress: true,
    entropy: 3,
    exitOption: 1,
    bypass: 3,
    headers: 1,
    runInThread: false,
    unicode: false,
    originalEntryPoint: 0,
    ...overrides.shellcode,
  };

  return {
    name: "operator-build",
    implantType: "session",
    os: "windows",
    arch: "amd64",
    format: "executable",
    templateName: "sliver",
    c2: "mtls://c2.example.test",
    connectionStrategy: "r",
    reconnectSeconds: 60,
    pollTimeoutSeconds: 120,
    maxConnectionErrors: 10,
    beaconIntervalSeconds: 60,
    beaconJitterSeconds: 10,
    debug: false,
    evasion: true,
    obfuscateSymbols: true,
    netGo: true,
    runAtLoad: false,
    exports: "",
    canaryDomains: "one.example.test, two.example.test.",
    httpC2Profile: "default",
    wgPeerTunIp: "100.64.0.2",
    wgKeyExchangePort: 1337,
    wgTcpCommsPort: 8889,
    limitDomainJoined: false,
    limitDatetime: "",
    limitHostname: "",
    limitUsername: "",
    limitFileExists: "",
    limitLocale: "",
    ...overrides,
    shellcode,
  };
}

describe("implant input validation", () => {
  it("normalizes safe names and rejects traversal or shell-like names", () => {
    expect(validateImplantName("  Operator.Build_1  ")).toBe("operator.build_1");
    expect(validateImplantName("")).toBe("");
    expect(normalizeProfileName("  Production-Profile ")).toBe("production-profile");

    expect(() => validateImplantName("../escape")).toThrow(/alphanumeric|cannot be/);
    expect(() => validateImplantName("bad/name")).toThrow(/alphanumeric/);
    expect(() => validateImplantName("name;command")).toThrow(/alphanumeric/);
    expect(() => normalizeProfileName("   ")).toThrow("Profile name is required");
  });

  it("validates integer time and listener-port boundaries", () => {
    expect(secondsToNanoseconds(15, "Delay")).toBe("15000000000");
    expect(() => secondsToNanoseconds(-1, "Delay")).toThrow(/non-negative whole number/);
    expect(() => secondsToNanoseconds(1.5, "Delay")).toThrow(/non-negative whole number/);

    expect(isValidPort(1)).toBe(true);
    expect(isValidPort(65_534)).toBe(true);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(65_535)).toBe(false);
    expect(isValidPort(1.5)).toBe(false);
  });

  it("normalizes C2 aliases, default ports, and stable priorities", () => {
    const endpoints = parseC2Endpoints(
      "c2.example.test\nwg://wireguard.example.test, tcp-pivot://pivot.example.test",
      "windows",
    );

    expect(endpoints.map(({ Priority, URL }) => ({ Priority, URL }))).toEqual([
      { Priority: 0, URL: "mtls://c2.example.test:8888" },
      { Priority: 1, URL: "wg://wireguard.example.test:53" },
      { Priority: 2, URL: "tcppivot://pivot.example.test:9898" },
    ]);
  });

  it("enforces C2 protocol and named-pipe target constraints", () => {
    expect(() => parseC2Endpoints("", "windows")).toThrow("At least one C2 endpoint is required");
    expect(() => parseC2Endpoints("ftp://example.test", "windows")).toThrow(/Unsupported C2 protocol/);
    expect(() => parseC2Endpoints("namedpipe://./pipe/sliver", "linux")).toThrow(/only for Windows/);
    expect(() => parseC2Endpoints("namedpipe://./not-pipe/sliver", "windows")).toThrow(/\/pipe\/ path/);

    expect(parseC2Endpoints("namedpipe://./pipe/sliver", "windows")[0]?.URL).toBe(
      "namedpipe://./pipe/sliver",
    );
  });

  it("rejects invalid generation combinations", () => {
    expect(() => buildImplantConfig(generateInput({ implantType: "beacon", beaconIntervalSeconds: 4 }))).toThrow(
      /at least 5 seconds/,
    );
    expect(() => buildImplantConfig(generateInput({ beaconIntervalSeconds: 10, beaconJitterSeconds: 11 }))).toThrow(
      /cannot exceed/,
    );
    expect(() => buildImplantConfig(generateInput({ format: "shared", exports: "" }))).toThrow(
      /require at least one export/,
    );
    expect(() => buildImplantConfig(generateInput({ format: "shellcode", os: "freebsd" }))).toThrow(
      /not supported/,
    );
    expect(() => buildImplantConfig(generateInput({ wgKeyExchangePort: 0 }))).toThrow(
      /WireGuard key exchange port/,
    );
  });
});

describe("implant protobuf mapping", () => {
  it("maps target, timings, transports, limits, and lists", () => {
    const config = buildImplantConfig(
      generateInput({
        name: " Mixed.Case ",
        implantType: "beacon",
        os: " Windows ",
        arch: " AMD64 ",
        templateName: " custom-template ",
        c2: [
          "mtls://mtls.example.test",
          "https://https.example.test:8443",
          "dns://dns.example.test",
          "wg://wg.example.test",
          "tcp-pivot://pivot.example.test",
        ].join("\n"),
        reconnectSeconds: 7,
        pollTimeoutSeconds: 8,
        beaconIntervalSeconds: 30,
        beaconJitterSeconds: 5,
        exports: "First, Second",
        canaryDomains: "alpha.test, beta.test.",
        httpC2Profile: " web-profile ",
        limitDomainJoined: true,
        limitDatetime: " 2027-01-01T00:00:00Z ",
        limitHostname: " host-a ",
        limitUsername: " alice ",
        limitFileExists: " /tmp/marker ",
        limitLocale: " en-US ",
      }),
      "100.64.0.99",
    );

    expect(config).toMatchObject({
      IsBeacon: true,
      BeaconInterval: "30000000000",
      BeaconJitter: "5000000000",
      GOOS: "windows",
      GOARCH: "amd64",
      TemplateName: "custom-template",
      IncludeMTLS: true,
      IncludeHTTP: true,
      IncludeWG: true,
      IncludeDNS: true,
      IncludeNamePipe: false,
      IncludeTCP: true,
      WGPeerTunIP: "100.64.0.99",
      WGKeyExchangePort: 1337,
      WGTcpCommsPort: 8889,
      ReconnectInterval: "7000000000",
      PollTimeout: "8000000000",
      MaxConnectionErrors: 10,
      ConnectionStrategy: "r",
      CanaryDomains: ["alpha.test.", "beta.test."],
      LimitDomainJoined: true,
      LimitDatetime: "2027-01-01T00:00:00Z",
      LimitHostname: "host-a",
      LimitUsername: "alice",
      LimitFileExists: "/tmp/marker",
      LimitLocale: "en-US",
      exports: ["First", "Second"],
      HTTPC2ConfigName: "web-profile",
      NetGoEnabled: true,
    });
    expect(config.C2.map((endpoint) => endpoint.Priority)).toEqual([0, 1, 2, 3, 4]);
  });

  it("maps shellcode settings and disables symbol obfuscation for debug builds", () => {
    const config = buildImplantConfig(
      generateInput({
        format: "shellcode",
        os: "darwin",
        arch: "arm64",
        debug: true,
        obfuscateSymbols: true,
        shellcode: {
          compress: false,
          entropy: 2,
          exitOption: 2,
          bypass: 1,
          headers: 2,
          runInThread: true,
          unicode: true,
          originalEntryPoint: 4096,
        },
      }),
    );

    expect(config.Format).toBe(clientpb.OutputFormat.SHELLCODE);
    expect(config.IsShellcode).toBe(true);
    expect(config.IsSharedLib).toBe(false);
    expect(config.ObfuscateSymbols).toBe(false);
    expect(config.ShellcodeConfig).toMatchObject({
      Compress: 1,
      Entropy: 2,
      ExitOpt: 2,
      Bypass: 1,
      Headers: 2,
      Thread: true,
      Unicode: true,
      OEP: 4096,
    });
  });

  it("round-trips supported artifact format enums", () => {
    for (const format of ["executable", "shared", "shellcode", "service", "archive"] as const) {
      expect(artifactFormatFromProto(artifactFormatToProto(format))).toBe(format);
    }
  });

  it("normalizes general list and domain helpers", () => {
    expect(splitList("one, two\nthree")).toEqual(["one", "two", "three"]);
    expect(ensureTrailingDot("example.test")).toBe("example.test.");
    expect(ensureTrailingDot("example.test.")).toBe("example.test.");
  });
});
